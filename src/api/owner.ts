/**
 * Owner-only API (`/api/owner/*`): the deployment owner (login name `owner`, DASHBOARD_PASSWORD)
 * manages households — WhatsApp approval, suspension, password resets, adopting the transitional
 * env secrets into household 1 — plus the global settings and the unfiltered logs.
 *
 * Every handler takes the AuthResult from requireAuth and answers 403 FORBIDDEN unless it is the
 * owner. Validation errors are thrown as HttpError (the router turns them into JSON responses).
 * `ownerRoutes` lists the endpoints relative to /api/owner/ for the router to mount.
 */
import { type HouseholdPatch, getHousehold, listHouseholds, secretAad, updateHousehold } from '../db/households';
import { countCoreRows, latestRunLogByAction, listMessageLog, listRunLog, logRun } from '../db/repo';
import { GLOBAL_KEYS, getSettings, setSettings } from '../db/settings';
import { GLOBAL_HID, tenant } from '../db/tenant';
import type { Env } from '../env';
import { encryptSecret, pbkdf2Hash } from '../lib/crypto';
import { type AuthResult, MIN_PASSWORD_LENGTH } from './auth';
import { HttpError, errorJson, intParam, json, readJsonObject } from './http';

/** Env plus TOKEN_ENCRYPTION_KEY (not yet part of src/env.d.ts). */
export type OwnerEnv = Env & { TOKEN_ENCRYPTION_KEY?: string };
export type OwnerParams = Record<string, string>;
export type OwnerHandler = (request: Request, env: OwnerEnv, auth: AuthResult, params?: OwnerParams) => Promise<Response>;

const ACTION = 'owner';
/** run_log action of a Wallet sync (src/wallet/sync.ts). */
const SYNC_ACTION = 'walletSync';

const forbidden = (): Response => errorJson(403, 'Only the site owner can do this.', 'FORBIDDEN');

/** Wraps a handler with the owner check. */
function ownerOnly(handler: OwnerHandler): OwnerHandler {
	return async (request, env, auth, params = {}) => (auth.isOwner ? handler(request, env, auth, params) : forbidden());
}

/** The existing household named by the `:id` route parameter; 400/404 otherwise. */
async function householdParam(env: Env, params: OwnerParams = {}) {
	const id = Number(params.id);
	if (!/^\d+$/.test(params.id ?? '') || !Number.isSafeInteger(id) || id === GLOBAL_HID) {
		throw new HttpError(400, 'Invalid household id.', 'VALIDATION');
	}
	const household = await getHousehold(env.DB, id);
	if (!household) throw new HttpError(404, `Unknown household ${id}.`, 'NOT_FOUND');
	return household;
}

/** Applies `patch`, logs `note` to the household's run log and answers `{ ok, household, ...extra }`. */
async function patchHousehold(
	env: Env,
	id: number,
	patch: HouseholdPatch,
	note: string,
	extra: Record<string, unknown> = {},
): Promise<Response> {
	await updateHousehold(env.DB, id, patch);
	await logRun(tenant(env.DB, id), 'INFO', ACTION, note);
	return json({
		ok: true,
		household: await describeHousehold(env, id),
		...extra,
	});
}

async function describeHousehold(env: Env, id: number) {
	const row = (await getHousehold(env.DB, id))!;
	const t = tenant(env.DB, id);
	const [counts, latest] = await Promise.all([countCoreRows(t), latestRunLogByAction(t, [SYNC_ACTION])]);
	const sync = latest.get(SYNC_ACTION);
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		waApproved: row.waApproved === 1,
		createdAt: row.createdAt,
		counts,
		lastSync: sync ? { ts: sync.ts, level: sync.level, message: sync.message } : null,
		walletConfigured: !!row.walletTokenEnc,
		aiConfigured: !!row.anthropicKeyEnc,
	};
}

/** GET /api/owner/households */
export const ownerListHouseholds: OwnerHandler = ownerOnly(async (_request, env) => {
	const rows = await listHouseholds(env.DB);
	return json({
		households: await Promise.all(rows.map((row) => describeHousehold(env, row.id))),
	});
});

/** POST /api/owner/households/:id/approve {whatsapp?: boolean (default true)} */
export const ownerApprove: OwnerHandler = ownerOnly(async (request, env, _auth, params) => {
	const household = await householdParam(env, params);
	const body = await readJsonObject(request);
	if (body.whatsapp !== undefined && typeof body.whatsapp !== 'boolean')
		throw new HttpError(400, '"whatsapp" must be true or false.', 'VALIDATION');
	const approved = body.whatsapp !== false;
	return patchHousehold(env, household.id, { waApproved: approved ? 1 : 0 }, `WhatsApp ${approved ? 'approved' : 'revoked'} by the owner.`);
});

/** POST /api/owner/households/:id/suspend */
export const ownerSuspend: OwnerHandler = ownerOnly(async (_request, env, _auth, params) => {
	const household = await householdParam(env, params);
	return patchHousehold(env, household.id, { status: 'suspended' }, 'Suspended by the owner.');
});

/** POST /api/owner/households/:id/activate */
export const ownerActivate: OwnerHandler = ownerOnly(async (_request, env, _auth, params) => {
	const household = await householdParam(env, params);
	return patchHousehold(env, household.id, { status: 'active' }, 'Activated by the owner.');
});

/** POST /api/owner/households/:id/reset-password {password} — also signs the household out everywhere. */
export const ownerResetPassword: OwnerHandler = ownerOnly(async (request, env, _auth, params) => {
	const household = await householdParam(env, params);
	const body = await readJsonObject(request);
	const password = typeof body.password === 'string' ? body.password : '';
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new HttpError(400, `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`, 'WEAK_PASSWORD');
	}
	return patchHousehold(env, household.id, { passwordHash: await pbkdf2Hash(password) }, 'Password reset by the owner.');
});

/**
 * POST /api/owner/households/:id/adopt-env-token — encrypts the transitional WALLET_API_TOKEN /
 * ANTHROPIC_API_KEY secrets into the household (meant for household 1), after which they can be
 * deleted with `wrangler secret delete`.
 */
export const ownerAdoptEnvToken: OwnerHandler = ownerOnly(async (_request, env, _auth, params) => {
	const household = await householdParam(env, params);
	const walletToken = env.WALLET_API_TOKEN?.trim();
	const aiKey = env.ANTHROPIC_API_KEY?.trim();
	if (!walletToken && !aiKey) throw new HttpError(400, 'Neither WALLET_API_TOKEN nor ANTHROPIC_API_KEY is set.', 'NOTHING_TO_ADOPT');
	const patch: HouseholdPatch = {};
	if (walletToken)
		patch.walletTokenEnc = await encryptSecret(walletToken, env.TOKEN_ENCRYPTION_KEY, secretAad('wallet-token', household.id));
	if (aiKey) patch.anthropicKeyEnc = await encryptSecret(aiKey, env.TOKEN_ENCRYPTION_KEY, secretAad('anthropic-key', household.id));
	const adopted = { walletToken: !!walletToken, anthropicKey: !!aiKey };
	const names = [walletToken && 'WALLET_API_TOKEN', aiKey && 'ANTHROPIC_API_KEY'].filter(Boolean).join(', ');
	return patchHousehold(env, household.id, patch, `Adopted env secret(s) ${names}.`, { adopted });
});

/** Validators of the global settings; each returns the value to store or throws a message. */
const GLOBAL_VALIDATORS: Record<(typeof GLOBAL_KEYS)[number], (value: unknown) => string> = {
	wa_template_name: (value) => {
		if (typeof value !== 'string' || !/^[A-Za-z0-9_]{0,512}$/.test(value.trim()))
			throw new Error('Template names only contain letters, digits and underscores.');
		return value.trim();
	},
	wa_template_lang: (value) => {
		if (typeof value !== 'string' || !/^[a-z]{2,3}(_[A-Za-z]{2,4})?$/.test(value.trim()))
			throw new Error('Use a WhatsApp language code such as en or en_US.');
		return value.trim();
	},
	signup_enabled: (value) => {
		if (typeof value === 'boolean') return value ? '1' : '0';
		if (value !== '0' && value !== '1') throw new Error("Must be '0' or '1'.");
		return value;
	},
};

async function globalSettings(env: Env): Promise<Record<string, string>> {
	const settings = await getSettings(tenant(env.DB, GLOBAL_HID));
	return Object.fromEntries(GLOBAL_KEYS.map((key) => [key, settings[key]]));
}

/** GET|PUT /api/owner/settings — the settings shared by every household (GLOBAL_KEYS). */
export const ownerGlobalSettings: OwnerHandler = ownerOnly(async (request, env) => {
	if (request.method.toUpperCase() === 'PUT') {
		const body = await readJsonObject(request);
		const values: Record<string, string> = {};
		const errors: Record<string, string> = {};
		for (const [key, raw] of Object.entries(body)) {
			const validate = (GLOBAL_VALIDATORS as Record<string, ((value: unknown) => string) | undefined>)[key];
			try {
				if (!validate) throw new Error('Unknown global setting.');
				values[key] = validate(raw);
			} catch (error) {
				errors[key] = error instanceof Error ? error.message : String(error);
			}
		}
		if (Object.keys(errors).length > 0) {
			throw new HttpError(
				400,
				Object.entries(errors)
					.map(([key, message]) => `${key}: ${message}`)
					.join(' '),
				'VALIDATION',
				{ fields: errors },
			);
		}
		if (Object.keys(values).length === 0) throw new HttpError(400, 'Nothing to update.', 'VALIDATION');
		await setSettings(tenant(env.DB, GLOBAL_HID), values);
		await logRun(env.DB, 'INFO', ACTION, `Global settings updated: ${Object.keys(values).join(', ')}.`);
	}
	return json({ settings: await globalSettings(env) });
});

/** GET /api/owner/logs?type=run|message&limit=1..200&household=<id> — every household's logs unless filtered. */
export const ownerLogs: OwnerHandler = ownerOnly(async (request, env) => {
	const url = new URL(request.url);
	const type = url.searchParams.get('type') ?? 'run';
	if (type !== 'run' && type !== 'message') throw new HttpError(400, 'type must be "run" or "message".', 'VALIDATION');
	const limit = intParam(url, 'limit', 50, 1, 200);
	const hid = url.searchParams.get('household')?.trim() ? intParam(url, 'household', 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
	const rows = type === 'run' ? await listRunLog(env.DB, limit, hid) : await listMessageLog(env.DB, limit, hid);
	return json({ type, rows });
});

/** Endpoints under /api/owner/ (`:id` = household id, passed in `params`). */
export const ownerRoutes: ReadonlyArray<{
	method: 'GET' | 'POST' | 'PUT';
	path: string;
	handler: OwnerHandler;
}> = [
	{ method: 'GET', path: 'households', handler: ownerListHouseholds },
	{ method: 'POST', path: 'households/:id/approve', handler: ownerApprove },
	{ method: 'POST', path: 'households/:id/suspend', handler: ownerSuspend },
	{ method: 'POST', path: 'households/:id/activate', handler: ownerActivate },
	{
		method: 'POST',
		path: 'households/:id/reset-password',
		handler: ownerResetPassword,
	},
	{
		method: 'POST',
		path: 'households/:id/adopt-env-token',
		handler: ownerAdoptEnvToken,
	},
	{ method: 'GET', path: 'settings', handler: ownerGlobalSettings },
	{ method: 'PUT', path: 'settings', handler: ownerGlobalSettings },
	{ method: 'GET', path: 'logs', handler: ownerLogs },
];
