/**
 * Dashboard authentication: one shared password (DASHBOARD_PASSWORD secret) exchanged for a signed,
 * stateless session cookie (SESSION_SECRET secret). No user table, no server-side sessions.
 *
 * - Password check: SHA-256 digests of both values compared with the Workers-specific
 *   `crypto.subtle.timingSafeEqual`, so neither content nor length leaks through timing
 *   (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/).
 * - Cookie: `__Host-session=<expiresMs>.<hex HMAC-SHA-256>`; HttpOnly; Secure; SameSite=Lax; Path=/;
 *   Max-Age 30 days. The `__Host-` prefix pins the cookie to this exact host (no Domain attribute,
 *   Secure and Path=/ required — MDN "Using HTTP cookies"). SameSite=Lax keeps the cookie off
 *   cross-site POST/PUT requests (CSRF), while a link opened from WhatsApp still arrives signed in.
 * - The HMAC also covers a fingerprint of DASHBOARD_PASSWORD: changing the password (or rotating
 *   SESSION_SECRET) signs everybody out.
 * - Verification uses `crypto.subtle.verify`, which compares the MAC in constant time.
 *
 * Missing secrets fail closed: every authenticated endpoint answers 503 NEEDS_SECRETS.
 */
import { getSetting } from '../db/settings';
import type { Env } from '../env';
import { errorJson, json, readJsonObject } from './http';

export const SESSION_COOKIE = '__Host-session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Constant pause before answering a wrong password (slows down guessing). */
export const FAILED_LOGIN_DELAY_MS = 400;
export const NEEDS_SECRETS_MESSAGE =
	'Set the DASHBOARD_PASSWORD and SESSION_SECRET secrets (wrangler secret put DASHBOARD_PASSWORD / SESSION_SECRET, or .dev.vars locally).';

const encoder = new TextEncoder();

type AuthEnv = Pick<Env, 'DASHBOARD_PASSWORD' | 'SESSION_SECRET'>;

export function secretsMissing(env: AuthEnv): boolean {
	return !env.DASHBOARD_PASSWORD?.trim() || !env.SESSION_SECRET?.trim();
}

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
	if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

/** Constant-time password check: equal-length digests, so no early exit on length or content. */
export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** What the session MAC covers: the expiry plus a password fingerprint (password change → logout). */
async function signedPayload(expiresMs: number, password: string): Promise<Uint8Array> {
	return encoder.encode(`session.v1.${expiresMs}.${toHex(await sha256(password))}`);
}

/** Cookie value `<expiresMs>.<hex hmac>` for a session ending at `expiresMs`. */
export async function createSessionValue(env: AuthEnv, expiresMs: number): Promise<string> {
	const key = await hmacKey(env.SESSION_SECRET!);
	const mac = await crypto.subtle.sign('HMAC', key, await signedPayload(expiresMs, env.DASHBOARD_PASSWORD!));
	return `${expiresMs}.${toHex(mac)}`;
}

export async function verifySessionValue(env: AuthEnv, value: string, now = Date.now()): Promise<boolean> {
	const match = /^(\d{1,16})\.([0-9a-f]{64})$/i.exec(value);
	if (!match) return false;
	const expiresMs = Number(match[1]);
	if (!Number.isSafeInteger(expiresMs) || expiresMs <= now) return false;
	const mac = fromHex(match[2]!);
	if (!mac) return false;
	const key = await hmacKey(env.SESSION_SECRET!);
	return crypto.subtle.verify('HMAC', key, mac, await signedPayload(expiresMs, env.DASHBOARD_PASSWORD!));
}

/** Value of cookie `name` from a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
	if (!header) return null;
	for (const part of header.split(';')) {
		const index = part.indexOf('=');
		if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
	}
	return null;
}

function sessionCookie(value: string, maxAgeSeconds: number): string {
	return `${SESSION_COOKIE}=${value}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function isAuthenticated(request: Request, env: AuthEnv): Promise<boolean> {
	if (secretsMissing(env)) return false;
	const value = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
	return value !== null && (await verifySessionValue(env, value));
}

/**
 * Auth middleware for API routes: null when the request carries a valid session, otherwise the
 * response to return (503 when the secrets are not configured, 401 when not signed in).
 */
export async function requireAuth(request: Request, env: AuthEnv): Promise<Response | null> {
	if (secretsMissing(env)) return errorJson(503, NEEDS_SECRETS_MESSAGE, 'NEEDS_SECRETS');
	if (await isAuthenticated(request, env)) return null;
	return errorJson(401, 'Please sign in.', 'UNAUTHENTICATED');
}

/** Handles /api/auth/* (reachable without a session). Returns null for unknown auth paths. */
export async function handleAuthRequest(request: Request, env: Env, pathname: string): Promise<Response | null> {
	const method = request.method.toUpperCase();

	if (pathname === '/api/auth/status') {
		if (method !== 'GET') return errorJson(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
		const needsSecrets = secretsMissing(env);
		const [authenticated, setupComplete] = await Promise.all([
			needsSecrets ? false : isAuthenticated(request, env),
			getSetting(env.DB, 'setup_complete'),
		]);
		return json({ authenticated, setupComplete: setupComplete === '1', needsSecrets });
	}

	if (pathname === '/api/auth/login') {
		if (method !== 'POST') return errorJson(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
		if (secretsMissing(env)) return errorJson(503, NEEDS_SECRETS_MESSAGE, 'NEEDS_SECRETS');
		const body = await readJsonObject(request);
		const password = typeof body.password === 'string' ? body.password : '';
		if (!(await passwordMatches(password, env.DASHBOARD_PASSWORD!))) {
			await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
			return errorJson(401, 'Wrong password.', 'BAD_PASSWORD');
		}
		const expiresMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
		const value = await createSessionValue(env, expiresMs);
		return json({ ok: true, expiresAt: new Date(expiresMs).toISOString() }, 200, {
			'Set-Cookie': sessionCookie(value, SESSION_MAX_AGE_SECONDS),
		});
	}

	if (pathname === '/api/auth/logout') {
		if (method !== 'POST') return errorJson(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
		return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
	}

	return null;
}
