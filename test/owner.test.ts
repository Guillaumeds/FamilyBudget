import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AuthResult, SESSION_COOKIE, createSessionValue, requireAuth } from '../src/api/auth';
import { HttpError, httpErrorResponse } from '../src/api/http';
import {
	type OwnerEnv,
	type OwnerHandler,
	ownerActivate,
	ownerAdoptEnvToken,
	ownerApprove,
	ownerGlobalSettings,
	ownerListHouseholds,
	ownerLogs,
	ownerResetPassword,
	ownerRoutes,
	ownerSuspend,
} from '../src/api/owner';
import { getHousehold, secretAad, updateHousehold } from '../src/db/households';
import { insertMessageLog, logRun } from '../src/db/repo';
import { getSettings, setSetting } from '../src/db/settings';
import { GLOBAL_HID, tenant } from '../src/db/tenant';
import { decryptSecret, pbkdf2Verify } from '../src/lib/crypto';
import { HH1, HH2, TEST_TOKEN_ENCRYPTION_KEY, resetDb } from './helpers';

const ORIGIN = 'https://budget.example.com';
const ownerEnv: OwnerEnv = {
	...env,
	DASHBOARD_PASSWORD: 'owner-password',
	SESSION_SECRET: 'test-session-secret-0123456789abcdef',
	TOKEN_ENCRYPTION_KEY: TEST_TOKEN_ENCRYPTION_KEY,
};
const OWNER: AuthResult = { hid: 0, isOwner: true, household: null };

async function call(
	handler: OwnerHandler,
	options: {
		method?: string;
		path?: string;
		body?: unknown;
		params?: Record<string, string>;
		auth?: AuthResult;
		env?: OwnerEnv;
	} = {},
): Promise<Response> {
	const request = new Request(`${ORIGIN}/api/owner/${options.path ?? ''}`, {
		method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	try {
		return await handler(request, options.env ?? ownerEnv, options.auth ?? OWNER, options.params ?? {});
	} catch (error) {
		if (error instanceof HttpError) return httpErrorResponse(error);
		throw error;
	}
}

async function bodyOf<T = Record<string, unknown>>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

beforeEach(resetDb);

describe('owner-only guard', () => {
	it('answers 403 FORBIDDEN to a household session on every endpoint', async () => {
		const household: AuthResult = {
			hid: 1,
			isOwner: false,
			household: await getHousehold(env.DB, 1),
		};
		for (const { method, handler } of ownerRoutes) {
			const response = await call(handler, {
				method,
				auth: household,
				params: { id: '2' },
				...(method === 'GET' ? {} : { body: {} }),
			});
			expect(response.status).toBe(403);
			expect(await bodyOf(response)).toMatchObject({ code: 'FORBIDDEN' });
		}
		expect((await getHousehold(env.DB, 2))!.status).toBe('active');
	});

	it('mounts every handler once per method/path', () => {
		expect(ownerRoutes.map(({ method, path }) => `${method} ${path}`)).toEqual([
			'GET households',
			'POST households/:id/approve',
			'POST households/:id/suspend',
			'POST households/:id/activate',
			'POST households/:id/reset-password',
			'POST households/:id/adopt-env-token',
			'GET settings',
			'PUT settings',
			'GET logs',
		]);
	});
});

describe('households', () => {
	it('lists households with counts, last sync and configured secrets', async () => {
		await logRun(HH1, 'INFO', 'walletSync', 'hh1 synced');
		const response = await call(ownerListHouseholds);
		expect(response.status).toBe(200);
		const { households } = await bodyOf<{
			households: Array<Record<string, unknown>>;
		}>(response);
		expect(households).toHaveLength(2);
		expect(households[0]).toMatchObject({
			id: 1,
			name: 'guillaume',
			status: 'active',
			waApproved: true,
			counts: { transactions: 0, categories: 0 },
			lastSync: { level: 'INFO', message: 'hh1 synced' },
			walletConfigured: true,
			aiConfigured: true,
		});
		expect(typeof households[0]!.createdAt).toBe('string');
		expect(households[1]).toMatchObject({
			id: 2,
			name: 'testers',
			waApproved: false,
			lastSync: null,
			walletConfigured: false,
			aiConfigured: false,
		});
	});

	it('approves and revokes WhatsApp', async () => {
		const response = await call(ownerApprove, {
			params: { id: '2' },
			body: {},
		});
		expect(response.status).toBe(200);
		expect(await bodyOf(response)).toMatchObject({
			ok: true,
			household: { id: 2, waApproved: true },
		});
		expect((await getHousehold(env.DB, 2))!.waApproved).toBe(1);
		await call(ownerApprove, {
			params: { id: '2' },
			body: { whatsapp: false },
		});
		expect((await getHousehold(env.DB, 2))!.waApproved).toBe(0);
		expect(
			(
				await call(ownerApprove, {
					params: { id: '2' },
					body: { whatsapp: 'yes' },
				})
			).status,
		).toBe(400);
	});

	it('suspends and activates', async () => {
		expect(await bodyOf(await call(ownerSuspend, { params: { id: '2' }, body: {} }))).toMatchObject({ household: { status: 'suspended' } });
		expect((await getHousehold(env.DB, 2))!.status).toBe('suspended');
		await call(ownerActivate, { params: { id: '2' }, body: {} });
		expect((await getHousehold(env.DB, 2))!.status).toBe('active');
	});

	it('404s an unknown household and 400s a bad id', async () => {
		expect((await call(ownerSuspend, { params: { id: '99' }, body: {} })).status).toBe(404);
		for (const id of ['0', 'abc', '-1', '']) expect((await call(ownerSuspend, { params: { id }, body: {} })).status).toBe(400);
	});

	it('resets a password, which kills existing sessions', async () => {
		const before = (await getHousehold(env.DB, 2))!;
		const value = await createSessionValue(ownerEnv, 2, before.passwordHash, Date.now() + 60_000);
		const cookieRequest = () =>
			new Request(`${ORIGIN}/api/status`, {
				headers: { Cookie: `${SESSION_COOKIE}=${value}` },
			});
		expect(await requireAuth(cookieRequest(), ownerEnv)).toMatchObject({
			hid: 2,
		});

		expect(
			(
				await call(ownerResetPassword, {
					params: { id: '2' },
					body: { password: 'short' },
				})
			).status,
		).toBe(400);
		expect(
			(
				await call(ownerResetPassword, {
					params: { id: '2' },
					body: { password: 'fresh password' },
				})
			).status,
		).toBe(200);
		expect(await pbkdf2Verify('fresh password', (await getHousehold(env.DB, 2))!.passwordHash)).toBe(true);
		expect(((await requireAuth(cookieRequest(), ownerEnv)) as Response).status).toBe(401);
	});

	it('adopts the env Wallet token and Anthropic key into household 1', async () => {
		await updateHousehold(env.DB, 1, {
			walletTokenEnc: null,
			anthropicKeyEnc: null,
		});
		const response = await call(ownerAdoptEnvToken, {
			params: { id: '1' },
			body: {},
			env: {
				...ownerEnv,
				WALLET_API_TOKEN: 'env-wallet-token',
				ANTHROPIC_API_KEY: 'env-ai-key',
			},
		});
		expect(response.status).toBe(200);
		expect(await bodyOf(response)).toMatchObject({
			adopted: { walletToken: true, anthropicKey: true },
			household: { walletConfigured: true, aiConfigured: true },
		});
		const row = (await getHousehold(env.DB, 1))!;
		expect(await decryptSecret(row.walletTokenEnc!, TEST_TOKEN_ENCRYPTION_KEY, secretAad('wallet-token', 1))).toBe('env-wallet-token');
		expect(await decryptSecret(row.anthropicKeyEnc!, TEST_TOKEN_ENCRYPTION_KEY, secretAad('anthropic-key', 1))).toBe('env-ai-key');
	});

	it('adopts only the secrets that are set, and 400s when neither is', async () => {
		const response = await call(ownerAdoptEnvToken, {
			params: { id: '1' },
			body: {},
			env: {
				...ownerEnv,
				WALLET_API_TOKEN: 'only-wallet',
				ANTHROPIC_API_KEY: undefined,
			},
		});
		expect(await bodyOf(response)).toMatchObject({
			adopted: { walletToken: true, anthropicKey: false },
		});
		const row = (await getHousehold(env.DB, 1))!;
		expect(await decryptSecret(row.walletTokenEnc!, TEST_TOKEN_ENCRYPTION_KEY, secretAad('wallet-token', 1))).toBe('only-wallet');
		expect(row.anthropicKeyEnc).not.toBeNull(); // the seeded key is left alone

		const none = await call(ownerAdoptEnvToken, {
			params: { id: '1' },
			body: {},
			env: { ...ownerEnv, WALLET_API_TOKEN: undefined, ANTHROPIC_API_KEY: ' ' },
		});
		expect(none.status).toBe(400);
	});
});

describe('global settings', () => {
	it('reads and writes the global keys at hid 0, visible through every household merge', async () => {
		expect(await bodyOf(await call(ownerGlobalSettings))).toEqual({
			settings: {
				wa_template_name: '',
				wa_template_lang: 'en',
				signup_enabled: '1',
			},
		});
		const response = await call(ownerGlobalSettings, {
			method: 'PUT',
			body: {
				wa_template_name: 'daily_brief',
				wa_template_lang: 'en_US',
				signup_enabled: false,
			},
		});
		expect(response.status).toBe(200);
		expect(await bodyOf(response)).toEqual({
			settings: {
				wa_template_name: 'daily_brief',
				wa_template_lang: 'en_US',
				signup_enabled: '0',
			},
		});
		const rows = await env.DB.prepare("SELECT household_id FROM settings WHERE key = 'wa_template_name'").all<{ household_id: number }>();
		expect(rows.results).toEqual([{ household_id: GLOBAL_HID }]);
		expect(await getSettings(HH2)).toMatchObject({
			wa_template_name: 'daily_brief',
			wa_template_lang: 'en_US',
			signup_enabled: '0',
		});
	});

	it('rejects non-global keys and invalid values without writing', async () => {
		for (const body of [
			{ timezone: 'Europe/Paris' },
			{ wa_template_lang: 'english-please' },
			{ signup_enabled: 'yes' },
			{ wa_template_name: 'bad name!' },
			{},
		]) {
			const response = await call(ownerGlobalSettings, { method: 'PUT', body });
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		expect((await getSettings(tenant(env.DB, GLOBAL_HID))).timezone).toBe('UTC');
		expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first('n')).toBe(0);
	});

	it('does not leak household settings into the global view', async () => {
		await setSetting(HH1, 'wa_template_lang', 'de');
		expect(await bodyOf(await call(ownerGlobalSettings))).toMatchObject({
			settings: { wa_template_lang: 'en' },
		});
	});
});

describe('logs', () => {
	beforeEach(async () => {
		await logRun(HH1, 'INFO', 'walletSync', 'hh1 row');
		await logRun(HH2, 'INFO', 'walletSync', 'hh2 row');
		await logRun(env.DB, 'INFO', 'scheduled', 'system row');
		await insertMessageLog(env.DB, {
			direction: 'out',
			status: 'sent',
			waMessageId: 'wamid.1',
			householdId: 2,
		});
	});

	it("returns every household's run log by default and filters by household", async () => {
		const all = await bodyOf<{
			type: string;
			rows: Array<{ message: string }>;
		}>(await call(ownerLogs, { path: 'logs?limit=10' }));
		expect(all.type).toBe('run');
		expect(all.rows.map((row) => row.message)).toEqual(['system row', 'hh2 row', 'hh1 row']);
		const hh2 = await bodyOf<{ rows: Array<{ message: string }> }>(await call(ownerLogs, { path: 'logs?household=2' }));
		expect(hh2.rows.map((row) => row.message)).toEqual(['hh2 row']);
	});

	it('returns the message log, filtered by household', async () => {
		const response = await call(ownerLogs, {
			path: 'logs?type=message&household=2',
		});
		expect(await bodyOf(response)).toMatchObject({
			type: 'message',
			rows: [{ waMessageId: 'wamid.1' }],
		});
		expect(await bodyOf(await call(ownerLogs, { path: 'logs?type=message&household=1' }))).toMatchObject({ rows: [] });
	});

	it('validates type and limit', async () => {
		expect((await call(ownerLogs, { path: 'logs?type=nope' })).status).toBe(400);
		expect((await call(ownerLogs, { path: 'logs?limit=500' })).status).toBe(400);
		expect((await call(ownerLogs, { path: 'logs?household=x' })).status).toBe(400);
	});
});
