import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthEnv, SESSION_COOKIE, TURNSTILE_VERIFY_URL, handleSignup, readCookie, requireAuth } from '../src/api/auth';
import { HttpError, httpErrorResponse } from '../src/api/http';
import { getHouseholdByName } from '../src/db/households';
import { listRunLog } from '../src/db/repo';
import { setSetting } from '../src/db/settings';
import { GLOBAL_HID, tenant } from '../src/db/tenant';
import { pbkdf2Verify } from '../src/lib/crypto';
import { resetDb } from './helpers';

const ORIGIN = 'https://budget.example.com';
const securedEnv: AuthEnv = {
	...env,
	DASHBOARD_PASSWORD: 'owner-password',
	SESSION_SECRET: 'test-session-secret-0123456789abcdef',
};
const turnstileEnv: AuthEnv = {
	...securedEnv,
	TURNSTILE_SECRET: 'turnstile-secret',
};

async function signup(body: Record<string, unknown>, testEnv: AuthEnv = securedEnv): Promise<Response> {
	const request = new Request(`${ORIGIN}/api/auth/signup`, {
		method: 'POST',
		body: JSON.stringify(body),
		headers: { 'CF-Connecting-IP': '203.0.113.7' },
	});
	try {
		return await handleSignup(request, testEnv);
	} catch (error) {
		if (error instanceof HttpError) return httpErrorResponse(error);
		throw error;
	}
}

async function codeOf(response: Response): Promise<string | undefined> {
	return ((await response.json()) as { code?: string }).code;
}

function mockSiteverify(success: boolean) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
		Response.json({
			success,
			'error-codes': success ? [] : ['invalid-input-response'],
		}),
	);
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('signup without Turnstile configured', () => {
	it('creates a household with WhatsApp locked, signs it in and logs a WARN', async () => {
		const response = await signup({
			household: ' Brother ',
			password: 'long enough',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			householdName: 'brother',
		});

		const household = (await getHouseholdByName(env.DB, 'brother'))!;
		expect(household).toMatchObject({
			status: 'active',
			waApproved: 0,
			walletTokenEnc: null,
			anthropicKeyEnc: null,
		});
		expect(await pbkdf2Verify('long enough', household.passwordHash)).toBe(true);

		const value = readCookie(response.headers.get('Set-Cookie')!.split(';')[0]!, SESSION_COOKIE)!;
		const request = new Request(`${ORIGIN}/api/status`, {
			headers: { Cookie: `${SESSION_COOKIE}=${value}` },
		});
		expect(await requireAuth(request, securedEnv)).toMatchObject({
			hid: household.id,
			isOwner: false,
			household: { name: 'brother' },
		});

		const warnings = (await listRunLog(env.DB, 10, household.id)).filter((row) => row.level === 'WARN');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.message).toContain('TURNSTILE_SECRET');
	});
});

describe('signup with Turnstile', () => {
	it('verifies the token with siteverify and creates the household on success', async () => {
		const fetchSpy = mockSiteverify(true);
		const response = await signup(
			{
				household: 'brother',
				password: 'long enough',
				turnstileToken: 'token-123',
			},
			turnstileEnv,
		);
		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(String(url)).toBe(TURNSTILE_VERIFY_URL);
		expect(init?.method).toBe('POST');
		const form = init!.body as FormData;
		expect(form.get('secret')).toBe('turnstile-secret');
		expect(form.get('response')).toBe('token-123');
		expect(form.get('remoteip')).toBe('203.0.113.7');
		const household = (await getHouseholdByName(env.DB, 'brother'))!;
		expect((await listRunLog(env.DB, 10, household.id)).some((row) => row.level === 'WARN')).toBe(false);
	});

	it('rejects a failed or missing token with 400 CAPTCHA_FAILED and creates nothing', async () => {
		mockSiteverify(false);
		const response = await signup({ household: 'brother', password: 'long enough', turnstileToken: 'bad' }, turnstileEnv);
		expect(response.status).toBe(400);
		expect(await codeOf(response)).toBe('CAPTCHA_FAILED');
		expect(await codeOf(await signup({ household: 'brother', password: 'long enough' }, turnstileEnv))).toBe('CAPTCHA_FAILED');
		expect(await getHouseholdByName(env.DB, 'brother')).toBeNull();
	});

	it('treats a siteverify network error as a failed check', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
		expect(
			await codeOf(
				await signup(
					{
						household: 'brother',
						password: 'long enough',
						turnstileToken: 't',
					},
					turnstileEnv,
				),
			),
		).toBe('CAPTCHA_FAILED');
	});
});

describe('signup validation', () => {
	it('rejects reserved and invalid names with 400 INVALID_NAME', async () => {
		for (const household of ['owner', 'Admin', 'global', 'a', '-dash', '_under', 'has space', 'émile', 'x'.repeat(33), '', 42]) {
			const response = await signup({ household, password: 'long enough' });
			expect(response.status, String(household)).toBe(400);
			expect(await codeOf(response)).toBe('INVALID_NAME');
		}
		expect((await signup({ household: 'ok-name_2', password: 'long enough' })).status).toBe(200);
		expect((await signup({ household: 'x'.repeat(32), password: 'long enough' })).status).toBe(200);
	});

	it('rejects a duplicate name (case-insensitive) with 409 NAME_TAKEN', async () => {
		const response = await signup({
			household: 'Guillaume',
			password: 'long enough',
		});
		expect(response.status).toBe(409);
		expect(await codeOf(response)).toBe('NAME_TAKEN');
	});

	it('rejects a password under 8 characters with 400 WEAK_PASSWORD', async () => {
		const response = await signup({ household: 'brother', password: 'short' });
		expect(response.status).toBe(400);
		expect(await codeOf(response)).toBe('WEAK_PASSWORD');
		expect(await codeOf(await signup({ household: 'brother' }))).toBe('WEAK_PASSWORD');
	});

	it('answers 403 SIGNUP_DISABLED when the owner closed signup', async () => {
		await setSetting(tenant(env.DB, GLOBAL_HID), 'signup_enabled', '0');
		const response = await signup({
			household: 'brother',
			password: 'long enough',
		});
		expect(response.status).toBe(403);
		expect(await codeOf(response)).toBe('SIGNUP_DISABLED');
		expect(await getHouseholdByName(env.DB, 'brother')).toBeNull();
	});

	it('answers 503 NEEDS_SECRETS without SESSION_SECRET', async () => {
		expect((await signup({ household: 'brother', password: 'long enough' }, { ...securedEnv, SESSION_SECRET: undefined })).status).toBe(
			503,
		);
	});
});
