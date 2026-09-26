import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	type AuthResult,
	SESSION_COOKIE,
	SESSION_MAX_AGE_SECONDS,
	createSessionValue,
	handleAuthRequest,
	handleAuthStatus,
	handleLogin,
	handleLogout,
	passwordMatches,
	readCookie,
	requireAuth,
} from '../src/api/auth';
import { HttpError, httpErrorResponse } from '../src/api/http';
import { getHousehold, updateHousehold } from '../src/db/households';
import { listRunLog } from '../src/db/repo';
import { setSetting } from '../src/db/settings';
import type { Env } from '../src/env';
import { pbkdf2Hash, pbkdf2Verify } from '../src/lib/crypto';
import { HH1, HH2, TEST_PASSWORD, TEST_PASSWORD_HASH, resetDb } from './helpers';

const ORIGIN = 'https://budget.example.com';
const OWNER_PASSWORD = 'correct horse battery staple';
const securedEnv: Env = {
	...env,
	DASHBOARD_PASSWORD: OWNER_PASSWORD,
	SESSION_SECRET: 'test-session-secret-0123456789abcdef',
};

/** Runs a handler like the router does: thrown HttpErrors become JSON responses. */
async function run(handler: () => Promise<Response>): Promise<Response> {
	try {
		return await handler();
	} catch (error) {
		if (error instanceof HttpError) return httpErrorResponse(error);
		throw error;
	}
}

function login(household: string, password: string, testEnv: Env = securedEnv): Promise<Response> {
	const request = new Request(`${ORIGIN}/api/auth/login`, {
		method: 'POST',
		body: JSON.stringify({ household, password }),
	});
	return run(() => handleLogin(request, testEnv));
}

function cookieValue(response: Response): string {
	return readCookie(response.headers.get('Set-Cookie')!.split(';')[0]!, SESSION_COOKIE)!;
}

function requestWith(value: string | null, path = '/api/status'): Request {
	return new Request(`${ORIGIN}${path}`, value === null ? {} : { headers: { Cookie: `theme=dark; ${SESSION_COOKIE}=${value}` } });
}

async function auth(value: string | null, testEnv: Env = securedEnv): Promise<AuthResult | Response> {
	return requireAuth(requestWith(value), testEnv);
}

async function statusOf(value: string | null, testEnv: Env = securedEnv): Promise<unknown> {
	return (await handleAuthStatus(requestWith(value, '/api/auth/status'), testEnv)).json();
}

async function mint(hid: number, expiresMs = Date.now() + 60_000): Promise<string> {
	const household = await getHousehold(env.DB, hid);
	return createSessionValue(securedEnv, hid, household!.passwordHash, expiresMs);
}

beforeEach(resetDb);

describe('household login', () => {
	it('sets a signed, hardened cookie carrying the household id on the right password', async () => {
		const response = await login('  Guillaume ', TEST_PASSWORD);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			householdName: 'guillaume',
			isOwner: false,
		});
		const cookie = response.headers.get('Set-Cookie')!;
		expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=1\\.\\d+\\.[0-9a-f]{64}; `));
		for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${SESSION_MAX_AGE_SECONDS}`]) {
			expect(cookie).toContain(attribute);
		}
		expect(cookie).not.toContain('Domain=');
		const expires = Number(/=\d+\.(\d+)\./.exec(cookie)![1]);
		expect(expires).toBeGreaterThan(Date.now() + (SESSION_MAX_AGE_SECONDS - 60) * 1000);

		expect(await auth(cookieValue(response))).toMatchObject({
			hid: 1,
			isOwner: false,
			household: { id: 1, name: 'guillaume' },
		});
	});

	it('rejects a wrong password, an unknown household and a missing body with 401 after a delay', async () => {
		const started = Date.now();
		const response = await login('guillaume', 'wrong');
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			error: 'Wrong household or password.',
			code: 'BAD_PASSWORD',
		});
		expect(response.headers.get('Set-Cookie')).toBeNull();
		expect(Date.now() - started).toBeGreaterThanOrEqual(300);
		expect((await login('nobody', TEST_PASSWORD)).status).toBe(401);
		expect(
			(
				await run(() =>
					handleLogin(
						new Request(`${ORIGIN}/api/auth/login`, {
							method: 'POST',
							body: '{}',
						}),
						securedEnv,
					),
				)
			).status,
		).toBe(401);
	});

	it('refuses a suspended household at login (after the password check) and on its existing cookie', async () => {
		const value = await mint(2);
		await updateHousehold(env.DB, 2, { status: 'suspended' });
		const response = await login('testers', TEST_PASSWORD);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ code: 'SUSPENDED' });
		expect((await login('testers', 'wrong')).status).toBe(401);
		const denied = (await auth(value)) as Response;
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ code: 'SUSPENDED' });
		expect(await statusOf(value)).toMatchObject({
			authenticated: false,
			suspended: true,
		});
	});
});

describe('owner login', () => {
	it('logs the owner in with DASHBOARD_PASSWORD as hid 0', async () => {
		const response = await login('OWNER', OWNER_PASSWORD);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			householdName: 'owner',
			isOwner: true,
		});
		expect(response.headers.get('Set-Cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=0\\.`));
		expect(await auth(cookieValue(response))).toEqual({
			hid: 0,
			isOwner: true,
			household: null,
		});
	});

	it('rejects a wrong owner password and an unset DASHBOARD_PASSWORD', async () => {
		expect((await login('owner', 'wrong')).status).toBe(401);
		expect(
			(
				await login('owner', '', {
					...securedEnv,
					DASHBOARD_PASSWORD: undefined,
				})
			).status,
		).toBe(401);
	});

	it("warns when the owner password equals household 1's password", async () => {
		await updateHousehold(env.DB, 1, {
			passwordHash: await pbkdf2Hash(OWNER_PASSWORD),
		});
		expect((await login('owner', OWNER_PASSWORD)).status).toBe(200);
		expect((await listRunLog(env.DB, 10)).some((row) => row.level === 'WARN' && row.message.includes('rotate DASHBOARD_PASSWORD'))).toBe(
			true,
		);
	});

	it('owner cookie dies when DASHBOARD_PASSWORD changes', async () => {
		const value = cookieValue(await login('owner', OWNER_PASSWORD));
		expect(await auth(value)).toMatchObject({ isOwner: true });
		expect(
			(
				(await auth(value, {
					...securedEnv,
					DASHBOARD_PASSWORD: 'rotated',
				})) as Response
			).status,
		).toBe(401);
		expect(
			(
				(await auth(value, {
					...securedEnv,
					DASHBOARD_PASSWORD: undefined,
				})) as Response
			).status,
		).toBe(401);
	});
});

describe('password adoption (household 1 migrated with an empty hash)', () => {
	beforeEach(() => updateHousehold(env.DB, 1, { passwordHash: '' }));

	it('adopts DASHBOARD_PASSWORD on the first login and stores it as a PBKDF2 hash', async () => {
		const response = await login('guillaume', OWNER_PASSWORD);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			householdName: 'guillaume',
			isOwner: false,
		});
		const stored = (await getHousehold(env.DB, 1))!.passwordHash;
		expect(stored).toMatch(/^pbkdf2\$/);
		expect(await pbkdf2Verify(OWNER_PASSWORD, stored)).toBe(true);
		expect(await auth(cookieValue(response))).toMatchObject({ hid: 1 });
		expect((await listRunLog(env.DB, 10, 1)).some((row) => row.action === 'auth' && row.message.includes('Adopted'))).toBe(true);
		// Once adopted, the normal PBKDF2 path answers.
		expect((await login('guillaume', OWNER_PASSWORD)).status).toBe(200);
	});

	it('stores nothing on a wrong candidate', async () => {
		expect((await login('guillaume', 'wrong')).status).toBe(401);
		expect((await getHousehold(env.DB, 1))!.passwordHash).toBe('');
	});

	it('never applies to other households', async () => {
		await updateHousehold(env.DB, 2, { passwordHash: '' });
		expect((await login('testers', OWNER_PASSWORD)).status).toBe(401);
		expect((await getHousehold(env.DB, 2))!.passwordHash).toBe('');
	});
});

describe('session cookie', () => {
	it('dies when the household password is reset (fingerprint)', async () => {
		const value = cookieValue(await login('guillaume', TEST_PASSWORD));
		expect(await auth(value)).toMatchObject({ hid: 1 });
		await updateHousehold(env.DB, 1, {
			passwordHash: await pbkdf2Hash('a brand new password'),
		});
		expect(((await auth(value)) as Response).status).toBe(401);
	});

	it('cannot be re-pointed to another household', async () => {
		const value = cookieValue(await login('testers', TEST_PASSWORD));
		expect(value.startsWith('2.')).toBe(true);
		expect(((await auth(`1${value.slice(1)}`)) as Response).status).toBe(401);
		// Same password hash on both households still does not help: the hid is signed.
		expect(TEST_PASSWORD_HASH).toBe((await getHousehold(env.DB, 1))!.passwordHash);
	});

	it('401s on tampered, malformed, expired, v1-format, rotated-secret or deleted-household cookies', async () => {
		const value = await mint(1);
		const [hid, expires, mac] = value.split('.') as [string, string, string];
		const flipped = `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`;
		for (const bad of [
			`${hid}.${expires}.${flipped}`,
			`${hid}.${Number(expires) + 1000}.${mac}`,
			`${expires}.${mac}`,
			`${hid}.${expires}.zz`,
			'garbage',
			'',
		]) {
			expect(((await auth(bad)) as Response).status).toBe(401);
		}
		expect(((await auth(await mint(1, Date.now() - 1000))) as Response).status).toBe(401);
		expect(
			(
				(await auth(value, {
					...securedEnv,
					SESSION_SECRET: 'rotated-secret',
				})) as Response
			).status,
		).toBe(401);
		expect(((await auth(null)) as Response).status).toBe(401);
		await env.DB.prepare('DELETE FROM households WHERE id = 1').run();
		const gone = (await auth(value)) as Response;
		expect(gone.status).toBe(401);
		expect(await gone.json()).toEqual({
			error: 'Please sign in.',
			code: 'UNAUTHENTICATED',
		});
	});

	it('logout clears the cookie', async () => {
		const response = handleLogout();
		expect(response.status).toBe(200);
		expect(response.headers.get('Set-Cookie')).toMatch(
			new RegExp(`^${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax$`),
		);
	});

	it('compares passwords of different lengths without throwing', async () => {
		expect(await passwordMatches('a', 'a much longer secret')).toBe(false);
		expect(await passwordMatches('same', 'same')).toBe(true);
	});
});

describe('auth status', () => {
	it('reports signup and Turnstile info but no setupComplete before sign-in', async () => {
		await setSetting(HH1, 'setup_complete', '1');
		expect(
			await statusOf(null, {
				...securedEnv,
				TURNSTILE_SITE_KEY: 'site-key',
			} as Env),
		).toEqual({
			authenticated: false,
			isOwner: false,
			needsSecrets: false,
			signupEnabled: true,
			turnstileSiteKey: 'site-key',
		});
	});

	it('reports the household and its own setupComplete once signed in', async () => {
		await setSetting(HH1, 'setup_complete', '1');
		expect(await statusOf(await mint(1))).toEqual({
			authenticated: true,
			isOwner: false,
			householdName: 'guillaume',
			needsSecrets: false,
			signupEnabled: true,
			turnstileSiteKey: '',
			setupComplete: true,
		});
		expect(await statusOf(await mint(2))).toMatchObject({
			householdName: 'testers',
			setupComplete: false,
		});
		await setSetting(HH2, 'setup_complete', '1');
		expect(await statusOf(await mint(2))).toMatchObject({
			setupComplete: true,
		});
	});

	it('reports the owner without setupComplete', async () => {
		const value = await createSessionValue(securedEnv, 0, OWNER_PASSWORD, Date.now() + 60_000);
		const body = await statusOf(value);
		expect(body).toEqual({
			authenticated: true,
			isOwner: true,
			householdName: 'owner',
			needsSecrets: false,
			signupEnabled: true,
			turnstileSiteKey: '',
		});
	});

	it('dispatches /api/auth/* and rejects wrong methods', async () => {
		expect((await handleAuthRequest(new Request(`${ORIGIN}/api/auth/status`), securedEnv, '/api/auth/status'))!.status).toBe(200);
		expect((await handleAuthRequest(new Request(`${ORIGIN}/api/auth/login`), securedEnv, '/api/auth/login'))!.status).toBe(405);
		expect(await handleAuthRequest(new Request(`${ORIGIN}/api/auth/nope`), securedEnv, '/api/auth/nope')).toBeNull();
	});
});

describe('missing SESSION_SECRET', () => {
	const openEnv: Env = {
		...env,
		DASHBOARD_PASSWORD: OWNER_PASSWORD,
		SESSION_SECRET: '  ',
	};

	it('fails closed with 503 NEEDS_SECRETS', async () => {
		const response = (await auth('anything', openEnv)) as Response;
		expect(response.status).toBe(503);
		const body = (await response.json()) as { error: string; code: string };
		expect(body.code).toBe('NEEDS_SECRETS');
		expect(body.error).toContain('SESSION_SECRET');
		expect((await login('guillaume', TEST_PASSWORD, openEnv)).status).toBe(503);
	});

	it('reports needsSecrets on the status endpoint', async () => {
		expect(await statusOf(null, openEnv)).toMatchObject({
			authenticated: false,
			needsSecrets: true,
		});
	});
});
