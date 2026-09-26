/**
 * Dashboard authentication, one login per household plus the deployment owner. Stateless: no
 * server-side sessions, just a signed cookie (SESSION_SECRET secret).
 *
 * - Households log in with `{ household, password }`; passwords are PBKDF2 hashes in `households`
 *   (src/lib/crypto.ts). The name `owner` logs in with the DASHBOARD_PASSWORD secret (hid 0, owner
 *   endpoints only). Owner passwords are compared as SHA-256 digests with the Workers-specific
 *   `crypto.subtle.timingSafeEqual`, so neither content nor length leaks through timing
 *   (https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/).
 * - Cookie: `__Host-session=<hid>.<expiresMs>.<hex HMAC-SHA-256>`; HttpOnly; Secure; SameSite=Lax;
 *   Path=/; Max-Age 30 days. The `__Host-` prefix pins the cookie to this exact host (no Domain
 *   attribute, Secure and Path=/ required — MDN "Using HTTP cookies"). SameSite=Lax keeps the cookie
 *   off cross-site POST/PUT requests (CSRF), while a link opened from WhatsApp still arrives signed in.
 * - The MAC covers `session.v2.<hid>.<expiresMs>.<fingerprint>`, the fingerprint being the SHA-256
 *   hex of the household's stored password hash (owner: of DASHBOARD_PASSWORD). Changing or resetting
 *   a password signs that household out; rotating SESSION_SECRET signs everybody out. Cookies of the
 *   single-household format (`<expiresMs>.<mac>`) do not parse and simply ask for a new login.
 * - Verification uses `crypto.subtle.verify`, which compares the MAC in constant time.
 * - Household 1 migrated with an empty password hash: its first login with the DASHBOARD_PASSWORD
 *   value stores that password as its own hash ("adoption").
 *
 * Missing SESSION_SECRET fails closed: every authenticated endpoint answers 503 NEEDS_SECRETS.
 */
import { type HouseholdRow, createHousehold, getHousehold, getHouseholdByName, updateHousehold } from '../db/households';
import { logRun } from '../db/repo';
import { getSetting } from '../db/settings';
import { GLOBAL_HID, tenant } from '../db/tenant';
import type { Env } from '../env';
import { pbkdf2Hash, pbkdf2Verify } from '../lib/crypto';
import { HttpError, errorJson, json, readJsonObject } from './http';

export const SESSION_COOKIE = '__Host-session';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
/** Constant pause before answering a failed login (slows down guessing). */
export const FAILED_LOGIN_DELAY_MS = 400;
export const NEEDS_SECRETS_MESSAGE =
	'Set the SESSION_SECRET secret (wrangler secret put SESSION_SECRET, or .dev.vars locally); DASHBOARD_PASSWORD is the owner login.';
/** Login name of the deployment owner (DASHBOARD_PASSWORD). */
export const OWNER_NAME = 'owner';
/** Household names signup accepts: lower-case, 2–32 chars, starting with a letter or digit. */
export const HOUSEHOLD_NAME = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const RESERVED_NAMES: readonly string[] = [OWNER_NAME, 'admin', 'global'];
export const MIN_PASSWORD_LENGTH = 8;
export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const ACTION = 'auth';
const encoder = new TextEncoder();

/** Alias kept for readability; the Turnstile secret/site key are declared in src/env.d.ts. */
export type AuthEnv = Env & {
	TURNSTILE_SECRET?: string;
	TURNSTILE_SITE_KEY?: string;
};

export interface AuthResult {
	/** households.id; GLOBAL_HID (0) for the owner. */
	hid: number;
	isOwner: boolean;
	/** The household row; null for the owner. */
	household: HouseholdRow | null;
}

export function secretsMissing(env: Pick<Env, 'SESSION_SECRET'>): boolean {
	return !env.SESSION_SECRET?.trim();
}

async function sha256(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest('SHA-256', encoder.encode(value));
}

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

/** Constant-time password check: equal-length digests, so no early exit on length or content. */
export async function passwordMatches(candidate: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/**
 * The secret-derived value a session is bound to: the household's password hash, or the owner's
 * DASHBOARD_PASSWORD. Null when that credential is not set (no session can be valid).
 */
function credentialFor(env: Pick<Env, 'DASHBOARD_PASSWORD'>, hid: number, household: HouseholdRow | null): string | null {
	if (hid === GLOBAL_HID) return env.DASHBOARD_PASSWORD?.trim() ? env.DASHBOARD_PASSWORD : null;
	return household?.passwordHash ? household.passwordHash : null;
}

async function signedPayload(hid: number, expiresMs: number, credential: string): Promise<Uint8Array> {
	return encoder.encode(`session.v2.${hid}.${expiresMs}.${toHex(await sha256(credential))}`);
}

/** Cookie value `<hid>.<expiresMs>.<hex hmac>`; `credential` is the password hash (owner: DASHBOARD_PASSWORD). */
export async function createSessionValue(
	env: Pick<Env, 'SESSION_SECRET'>,
	hid: number,
	credential: string,
	expiresMs: number,
): Promise<string> {
	const mac = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_SECRET!), await signedPayload(hid, expiresMs, credential));
	return `${hid}.${expiresMs}.${toHex(mac)}`;
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

/** Verifies the request's session cookie: the signed-in identity, 'suspended', or null (no valid session). */
async function authenticate(request: Request, env: Env, now = Date.now()): Promise<AuthResult | 'suspended' | null> {
	const value = readCookie(request.headers.get('Cookie'), SESSION_COOKIE);
	const match = value === null ? null : /^(\d{1,10})\.(\d{1,16})\.([0-9a-f]{64})$/.exec(value);
	if (!match) return null;
	const hid = Number(match[1]);
	const expiresMs = Number(match[2]);
	if (!Number.isSafeInteger(expiresMs) || expiresMs <= now) return null;
	const household = hid === GLOBAL_HID ? null : await getHousehold(env.DB, hid);
	const credential = credentialFor(env, hid, household);
	if (credential === null) return null;
	const key = await hmacKey(env.SESSION_SECRET!);
	if (!(await crypto.subtle.verify('HMAC', key, fromHex(match[3]!), await signedPayload(hid, expiresMs, credential)))) return null;
	if (household?.status === 'suspended') return 'suspended';
	return { hid, isOwner: hid === GLOBAL_HID, household };
}

const suspendedResponse = (): Response => errorJson(403, 'This household is suspended. Contact the owner of this site.', 'SUSPENDED');

/**
 * Auth middleware for API routes: the signed-in identity, or the response to return (503 without
 * SESSION_SECRET, 401 when not signed in, 403 SUSPENDED for a suspended household).
 */
export async function requireAuth(request: Request, env: Env): Promise<AuthResult | Response> {
	if (secretsMissing(env)) return errorJson(503, NEEDS_SECRETS_MESSAGE, 'NEEDS_SECRETS');
	const result = await authenticate(request, env);
	if (result === 'suspended') return suspendedResponse();
	return result ?? errorJson(401, 'Please sign in.', 'UNAUTHENTICATED');
}

/** 200 with a fresh session cookie for `hid`. */
async function startSession(env: Env, hid: number, credential: string, body: Record<string, unknown>): Promise<Response> {
	const expiresMs = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
	const value = await createSessionValue(env, hid, credential, expiresMs);
	return json({ ok: true, ...body, expiresAt: new Date(expiresMs).toISOString() }, 200, {
		'Set-Cookie': sessionCookie(value, SESSION_MAX_AGE_SECONDS),
	});
}

async function loginFailed(): Promise<Response> {
	await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
	return errorJson(401, 'Wrong household or password.', 'BAD_PASSWORD');
}

/** POST /api/auth/login {household, password}. */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
	if (secretsMissing(env)) return errorJson(503, NEEDS_SECRETS_MESSAGE, 'NEEDS_SECRETS');
	const body = await readJsonObject(request);
	const name = typeof body.household === 'string' ? body.household.trim().toLowerCase() : '';
	const password = typeof body.password === 'string' ? body.password : '';

	if (name === OWNER_NAME) {
		if (!env.DASHBOARD_PASSWORD?.trim() || !(await passwordMatches(password, env.DASHBOARD_PASSWORD))) return loginFailed();
		const first = await getHousehold(env.DB, 1);
		if (first?.passwordHash && (await pbkdf2Verify(password, first.passwordHash))) {
			await logRun(
				env.DB,
				'WARN',
				ACTION,
				"The owner password equals household 1's password — rotate DASHBOARD_PASSWORD to an owner-only value.",
			);
		}
		return startSession(env, GLOBAL_HID, env.DASHBOARD_PASSWORD, {
			householdName: OWNER_NAME,
			isOwner: true,
		});
	}

	const household = name ? await getHouseholdByName(env.DB, name) : null;
	if (!household) return loginFailed();
	let passwordHash = household.passwordHash;
	if (passwordHash === '') {
		// Adoption: household 1 (migrated from the single-household app) takes over DASHBOARD_PASSWORD.
		const adopt = household.id === 1 && !!env.DASHBOARD_PASSWORD?.trim() && (await passwordMatches(password, env.DASHBOARD_PASSWORD));
		if (!adopt) return loginFailed();
		passwordHash = await pbkdf2Hash(password);
		await updateHousehold(env.DB, household.id, { passwordHash });
		await logRun(tenant(env.DB, household.id), 'INFO', ACTION, "Adopted DASHBOARD_PASSWORD as this household's password on first login.");
	} else if (!(await pbkdf2Verify(password, passwordHash))) {
		return loginFailed();
	}
	if (household.status === 'suspended') return suspendedResponse();
	return startSession(env, household.id, passwordHash, {
		householdName: household.name,
		isOwner: false,
	});
}

async function signupEnabled(db: D1Database): Promise<boolean> {
	return (await getSetting(tenant(db, GLOBAL_HID), 'signup_enabled')) === '1';
}

/** Cloudflare Turnstile server-side validation (https://developers.cloudflare.com/turnstile/get-started/server-side-validation/). */
async function turnstileOk(secret: string, token: string, ip: string | null): Promise<boolean> {
	if (!token) return false;
	const form = new FormData();
	form.append('secret', secret);
	form.append('response', token);
	if (ip) form.append('remoteip', ip);
	try {
		const response = await fetch(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			body: form,
		});
		const outcome = (await response.json()) as { success?: boolean };
		return outcome.success === true;
	} catch {
		return false;
	}
}

/** POST /api/auth/signup {household, password, turnstileToken?} — creates a household (WhatsApp not approved) and signs it in. */
export async function handleSignup(request: Request, env: AuthEnv): Promise<Response> {
	if (secretsMissing(env)) return errorJson(503, NEEDS_SECRETS_MESSAGE, 'NEEDS_SECRETS');
	if (!(await signupEnabled(env.DB))) return errorJson(403, 'Signup is closed on this site.', 'SIGNUP_DISABLED');
	const body = await readJsonObject(request);
	const name = typeof body.household === 'string' ? body.household.trim().toLowerCase() : '';
	const password = typeof body.password === 'string' ? body.password : '';
	if (!HOUSEHOLD_NAME.test(name) || RESERVED_NAMES.includes(name)) {
		throw new HttpError(
			400,
			'Choose a household name of 2–32 lower-case letters, digits, "-" or "_" (not owner, admin or global).',
			'INVALID_NAME',
		);
	}
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new HttpError(400, `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`, 'WEAK_PASSWORD');
	}
	const secret = env.TURNSTILE_SECRET?.trim();
	if (secret) {
		const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
		if (!(await turnstileOk(secret, token, request.headers.get('CF-Connecting-IP')))) {
			throw new HttpError(400, 'The anti-bot check failed. Please try again.', 'CAPTCHA_FAILED');
		}
	}
	const household = await createHousehold(env.DB, {
		name,
		passwordHash: await pbkdf2Hash(password),
		waApproved: 0,
	});
	const t = tenant(env.DB, household.id);
	if (!secret) await logRun(t, 'WARN', ACTION, 'Signup without Turnstile — set TURNSTILE_SECRET.');
	await logRun(t, 'INFO', ACTION, `Household "${household.name}" signed up.`);
	return startSession(env, household.id, household.passwordHash, {
		householdName: household.name,
	});
}

/** POST /api/auth/logout. */
export function handleLogout(): Response {
	return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

/**
 * GET /api/auth/status (no session needed). `setupComplete` is only reported to a signed-in
 * household; `suspended: true` when the cookie belongs to a suspended household.
 */
export async function handleAuthStatus(request: Request, env: AuthEnv): Promise<Response> {
	const needsSecrets = secretsMissing(env);
	const [result, signup] = await Promise.all([needsSecrets ? null : authenticate(request, env), signupEnabled(env.DB)]);
	const base = {
		needsSecrets,
		signupEnabled: signup,
		turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? '',
	};
	if (result === null || result === 'suspended') {
		return json({
			authenticated: false,
			isOwner: false,
			...base,
			...(result === 'suspended' ? { suspended: true } : {}),
		});
	}
	if (result.isOwner)
		return json({
			authenticated: true,
			isOwner: true,
			householdName: OWNER_NAME,
			...base,
		});
	const setupComplete = (await getSetting(tenant(env.DB, result.hid), 'setup_complete')) === '1';
	return json({
		authenticated: true,
		isOwner: false,
		householdName: result.household!.name,
		...base,
		setupComplete,
	});
}

/** Dispatches /api/auth/* (reachable without a session). Returns null for unknown auth paths. */
export async function handleAuthRequest(request: Request, env: AuthEnv, pathname: string): Promise<Response | null> {
	const handlers: Record<string, [method: string, handler: () => Response | Promise<Response>]> = {
		'/api/auth/status': ['GET', () => handleAuthStatus(request, env)],
		'/api/auth/login': ['POST', () => handleLogin(request, env)],
		'/api/auth/signup': ['POST', () => handleSignup(request, env)],
		'/api/auth/logout': ['POST', handleLogout],
	};
	const entry = handlers[pathname];
	if (!entry) return null;
	if (request.method.toUpperCase() !== entry[0]) return errorJson(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
	return entry[1]();
}
