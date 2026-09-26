import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, createSessionValue, passwordMatches, readCookie } from '../src/api/auth';
import { handleApiRequest } from '../src/api/routes';
import { setSetting } from '../src/db/settings';
import type { Env } from '../src/env';
import { resetDb } from './helpers';

const ORIGIN = 'https://budget.example.com';
const securedEnv: Env = { ...env, DASHBOARD_PASSWORD: 'correct horse battery staple', SESSION_SECRET: 'test-session-secret-0123456789abcdef' };

async function call(path: string, init: RequestInit = {}, testEnv: Env = securedEnv): Promise<Response> {
	const response = await handleApiRequest(new Request(`${ORIGIN}${path}`, init), testEnv, createExecutionContext());
	if (!response) throw new Error(`handleApiRequest returned null for ${path}`);
	return response;
}

function login(password: string, testEnv: Env = securedEnv): Promise<Response> {
	return call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }, testEnv);
}

function withCookie(value: string): RequestInit {
	return { headers: { Cookie: `theme=dark; ${SESSION_COOKIE}=${value}` } };
}

beforeEach(resetDb);

describe('handleApiRequest routing', () => {
	it('returns null outside /api so the caller can fall through', async () => {
		expect(await handleApiRequest(new Request(`${ORIGIN}/index.html`), securedEnv, createExecutionContext())).toBeNull();
		expect(await handleApiRequest(new Request(`${ORIGIN}/apiary`), securedEnv, createExecutionContext())).toBeNull();
	});
});

describe('login', () => {
	it('rejects a wrong password with 401 after a delay and sets no cookie', async () => {
		const started = Date.now();
		const response = await login('wrong');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Wrong password.', code: 'BAD_PASSWORD' });
		expect(response.headers.get('Set-Cookie')).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(300);
	});

	it('rejects a missing password field', async () => {
		const response = await call('/api/auth/login', { method: 'POST', body: '{}' });
		expect(response.status).toBe(401);
	});

	it('sets a signed, hardened session cookie on the right password', async () => {
		const response = await login('correct horse battery staple');
		expect(response.status).toBe(200);
		const cookie = response.headers.get('Set-Cookie')!;
		expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=\\d+\\.[0-9a-f]{64}; `));
		for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_MAX_AGE_SECONDS}`]) {
			expect(cookie).toContain(attribute);
		}
		expect(cookie).not.toContain('Domain=');
		const expires = Number(/=(\d+)\./.exec(cookie)![1]);
		expect(expires).toBeGreaterThan(Date.now() + (SESSION_MAX_AGE_SECONDS - 60) * 1000);
	});

	it('compares passwords of different lengths without throwing', async () => {
		expect(await passwordMatches('a', 'a much longer secret')).toBe(false);
		expect(await passwordMatches('same', 'same')).toBe(true);
	});
});

describe('session cookie', () => {
	it('round-trips: the cookie from login opens authenticated endpoints', async () => {
		const setCookie = (await login('correct horse battery staple')).headers.get('Set-Cookie')!;
		const value = readCookie(setCookie.split(';')[0]!, SESSION_COOKIE)!;

		const status = await call('/api/status', withCookie(value));
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({ dashboardSecured: true, setupComplete: false });

		const auth = await call('/api/auth/status', withCookie(value));
		expect(await auth.json()).toEqual({ authenticated: true, setupComplete: false, needsSecrets: false });
	});

	it('401s without a cookie, and reports unauthenticated status', async () => {
		const response = await call('/api/status');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Please sign in.', code: 'UNAUTHENTICATED' });
		await setSetting(env.DB, 'setup_complete', '1');
		expect(await (await call('/api/auth/status')).json()).toEqual({ authenticated: false, setupComplete: true, needsSecrets: false });
	});

	it('401s on a tampered cookie', async () => {
		const value = await createSessionValue(securedEnv, Date.now() + 60_000);
		const [expires, mac] = value.split('.') as [string, string];
		const flipped = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`;
		for (const bad of [`${expires}.${flipped}`, `${Number(expires) + 1000}.${mac}`, `${expires}.zz`, 'garbage', '']) {
			expect((await call('/api/status', withCookie(bad))).status).toBe(401);
		}
	});

	it('401s on an expired cookie', async () => {
		const value = await createSessionValue(securedEnv, Date.now() - 1000);
		expect((await call('/api/status', withCookie(value))).status).toBe(401);
	});

	it('401s once the password or the session secret changes', async () => {
		const value = await createSessionValue(securedEnv, Date.now() + 60_000);
		expect((await call('/api/status', withCookie(value))).status).toBe(200);
		expect((await call('/api/status', withCookie(value), { ...securedEnv, DASHBOARD_PASSWORD: 'new password' })).status).toBe(401);
		expect((await call('/api/status', withCookie(value), { ...securedEnv, SESSION_SECRET: 'rotated-secret' })).status).toBe(401);
	});

	it('logout clears the cookie', async () => {
		const response = await call('/api/auth/logout', { method: 'POST' });
		expect(response.status).toBe(200);
		expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax$`));
	});

	it('refuses cross-origin state-changing requests', async () => {
		const value = await createSessionValue(securedEnv, Date.now() + 60_000);
		const response = await call('/api/admin/capture', { method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${value}`, Origin: 'https://evil.example' } });
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: 'BAD_ORIGIN' });
	});
});

describe('missing secrets', () => {
	const openEnv: Env = { ...env, DASHBOARD_PASSWORD: undefined, SESSION_SECRET: '  ' };

	it('fails closed with 503 and a helpful message', async () => {
		const response = await call('/api/status', {}, openEnv);
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: string; code: string };
		expect(body.code).toBe('NEEDS_SECRETS');
		expect(body.error).toContain('Set the DASHBOARD_PASSWORD and SESSION_SECRET secrets');
		expect((await login('anything', openEnv)).status).toBe(503);
	});

	it('reports needsSecrets on the auth status endpoint', async () => {
		const response = await call('/api/auth/status', {}, openEnv);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authenticated: false, setupComplete: false, needsSecrets: true });
	});
});
