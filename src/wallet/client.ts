/**
 * BudgetBakers Wallet REST API client.
 *
 * Reference: https://rest.budgetbakers.com/wallet/reference (OpenAPI 2.0.0: /wallet/openapi).
 * - Auth: `Authorization: Bearer <token>` (Premium plan). 401 = invalid/expired token; 403 = token
 *   not valid for the wallet surface (e.g. a Board token).
 * - Pagination: `limit` (1–200, default 30) / `offset`; the envelope carries `nextOffset` only
 *   while more pages exist.
 * - Rate limit: 300 requests/hour (REST + MCP share it); 429 with `Retry-After` in seconds. The fair
 *   use policy asks clients not to keep sending after a refusal, so we retry at most once and only
 *   after waiting the full Retry-After.
 * - 409 `{"error":"init_sync_in_progress","retry_after_minutes":5}` while BudgetBakers' initial
 *   data sync runs after the first token is created.
 * - `X-Last-Data-Change-Rev` header: revision counter for cheap change detection.
 *
 * Ported from walletFetch / fetchAllPages / fetchWalletRecords / testWalletAuth in legacy/Code.gs.
 */
import type { Env } from '../env';

export type WalletErrorCode = 'WALLET_AUTH' | 'WALLET_API' | 'WALLET_SYNC_IN_PROGRESS' | 'WALLET_RATE_LIMIT';

export class WalletApiError extends Error {
	readonly code: WalletErrorCode;
	readonly status?: number;
	/** First 500 characters of the response body. */
	readonly bodyExcerpt?: string;
	/** When the API said how long to wait (429 Retry-After, 409 retry_after_minutes). */
	readonly retryAfterSeconds?: number;

	constructor(
		code: WalletErrorCode,
		message: string,
		details: { status?: number; bodyExcerpt?: string; retryAfterSeconds?: number } = {},
	) {
		super(message);
		this.name = 'WalletApiError';
		this.code = code;
		this.status = details.status;
		this.bodyExcerpt = details.bodyExcerpt;
		this.retryAfterSeconds = details.retryAfterSeconds;
	}
}

export type QueryParams = Record<string, string | number>;

/** Maximum page size allowed by the API. */
export const PAGE_LIMIT = 200;
/** Loop guard: never follow more pages than this (200 × 200 = 40,000 items). */
export const MAX_PAGES = 200;
/** Longest Retry-After we wait in-process before retrying once; longer waits fail immediately. */
export const MAX_RETRY_WAIT_SECONDS = 30;
export const LAST_CHANGE_REV_HEADER = 'X-Last-Data-Change-Rev';

const BODY_EXCERPT_LENGTH = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After as documented by the API: an integer number of seconds. Null when absent/unparseable. */
function retryAfterSeconds(headers: Headers): number | null {
	const value = headers.get('Retry-After');
	const seconds = value === null || value.trim() === '' ? NaN : Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

async function toError(response: Response, path: string): Promise<WalletApiError> {
	const text = await response.text().catch(() => '');
	const bodyExcerpt = text.slice(0, BODY_EXCERPT_LENGTH);
	let json: { error?: unknown; message?: unknown; retry_after_minutes?: unknown } = {};
	try {
		json = JSON.parse(text) ?? {};
	} catch {
		// Plain-text body (e.g. the 403 wrong-app message).
	}
	const status = response.status;
	const detail = String(json.message ?? json.error ?? (bodyExcerpt || response.statusText)).slice(0, 200);
	const details = { status, bodyExcerpt };

	if (status === 401 || status === 403) {
		return new WalletApiError('WALLET_AUTH', `Wallet API authentication/permission failed (HTTP ${status}) on ${path}: ${detail}`, details);
	}
	if (status === 409) {
		const minutes = Number(json.retry_after_minutes);
		const retry = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : undefined;
		return new WalletApiError(
			'WALLET_SYNC_IN_PROGRESS',
			`BudgetBakers is still running its initial data sync; retry later${retry ? ` (in ~${minutes} min)` : ''}.`,
			{ ...details, retryAfterSeconds: retry },
		);
	}
	if (status === 429) {
		const retry = retryAfterSeconds(response.headers) ?? undefined;
		return new WalletApiError(
			'WALLET_RATE_LIMIT',
			`Wallet API rate limit exceeded on ${path}${retry !== undefined ? ` (Retry-After ${retry}s)` : ''}.`,
			{ ...details, retryAfterSeconds: retry },
		);
	}
	return new WalletApiError('WALLET_API', `Wallet API failed (HTTP ${status}) on ${path}: ${detail}`, details);
}

/**
 * GET `path` (e.g. '/v1/api/records') relative to env.WALLET_API_BASE_URL with the household's
 * `token` (see ./token.ts) and parse the JSON body.
 * On 429 waits Retry-After (≤ MAX_RETRY_WAIT_SECONDS) and retries once. Throws WalletApiError.
 */
export async function walletFetch(env: Env, token: string, path: string, params?: QueryParams): Promise<{ body: unknown; headers: Headers }> {
	const bearer = token?.trim();
	if (!bearer) throw new WalletApiError('WALLET_AUTH', 'No BudgetBakers Wallet API token is configured for this household.');

	const url = new URL(env.WALLET_API_BASE_URL.replace(/\/+$/, '') + path);
	for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
	const init: RequestInit = { headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' } };

	const send = async (): Promise<Response> => {
		try {
			return await fetch(url.toString(), init);
		} catch (error) {
			throw new WalletApiError('WALLET_API', `Wallet API request to ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	let response = await send();
	if (response.status === 429) {
		const wait = retryAfterSeconds(response.headers);
		if (wait !== null && wait <= MAX_RETRY_WAIT_SECONDS) {
			await response.body?.cancel();
			await sleep(wait * 1000);
			response = await send();
		}
	}
	if (!response.ok) throw await toError(response, path);

	const text = await response.text();
	try {
		return { body: text ? (JSON.parse(text) as unknown) : {}, headers: response.headers };
	} catch {
		throw new WalletApiError('WALLET_API', `Wallet API returned invalid JSON on ${path}.`, {
			status: response.status,
			bodyExcerpt: text.slice(0, BODY_EXCERPT_LENGTH),
		});
	}
}

export interface PagedResult<T> {
	items: T[];
	/** Headers of the first page. */
	headers: Headers;
	/**
	 * False when a loop guard stopped pagination early (non-advancing nextOffset, empty page that
	 * still announces a next page, or MAX_PAGES). Callers must not treat `items` as the full set then.
	 */
	complete: boolean;
}

/**
 * Fetches every page of a list endpoint: `limit` defaults to PAGE_LIMIT, `offset` follows
 * `nextOffset` until it is absent. `itemsKeys` names the envelope array (e.g. ['records']).
 */
export async function fetchAllPages<T>(env: Env, token: string, path: string, params: QueryParams, itemsKeys: string[]): Promise<PagedResult<T>> {
	const items: T[] = [];
	let headers: Headers | undefined;
	let offset = 0;

	for (let page = 0; page < MAX_PAGES; page++) {
		const response = await walletFetch(env, token, path, { limit: PAGE_LIMIT, ...params, offset });
		headers ??= response.headers;
		const body = response.body as Record<string, unknown> | unknown[];
		const key = Array.isArray(body) ? undefined : itemsKeys.find((k) => Array.isArray(body?.[k]));
		const pageItems = Array.isArray(body) ? body : key ? (body[key] as unknown[]) : undefined;
		if (!pageItems) {
			throw new WalletApiError('WALLET_API', `Unexpected Wallet response on ${path}: no ${itemsKeys.join('/')} array.`, {
				bodyExcerpt: JSON.stringify(body).slice(0, BODY_EXCERPT_LENGTH),
			});
		}
		items.push(...(pageItems as T[]));

		const next = Array.isArray(body) ? undefined : body.nextOffset;
		if (next === undefined || next === null || next === '') return { items, headers, complete: true };
		const nextOffset = Number(next);
		if (pageItems.length === 0 || !Number.isInteger(nextOffset) || nextOffset <= offset) {
			console.warn(`Wallet pagination on ${path} stopped: nextOffset ${String(next)} after offset ${offset} (${pageItems.length} items).`);
			return { items, headers, complete: false };
		}
		offset = nextOffset;
	}
	console.warn(`Wallet pagination on ${path} stopped after ${MAX_PAGES} pages.`);
	return { items, headers: headers!, complete: false };
}

/** Current `X-Last-Data-Change-Rev` via one minimal request (accounts, limit 1). Null when absent. */
export async function getLastChangeRev(env: Env, token: string): Promise<string | null> {
	const { headers } = await walletFetch(env, token, '/v1/api/accounts', { limit: 1 });
	return headers.get(LAST_CHANGE_REV_HEADER);
}

/**
 * Checks the token with GET /v1/api/api-usage/stats?period=30days (not counted in usage stats).
 * Never throws; `code` is a WalletErrorCode (WALLET_SYNC_IN_PROGRESS → ask the user to retry later).
 */
export async function testWalletAuth(env: Env, token: string): Promise<{ ok: boolean; code?: string; message?: string }> {
	try {
		await walletFetch(env, token, '/v1/api/api-usage/stats', { period: '30days' });
		return { ok: true };
	} catch (error) {
		if (error instanceof WalletApiError) return { ok: false, code: error.code, message: error.message };
		return { ok: false, code: 'WALLET_API', message: error instanceof Error ? error.message : String(error) };
	}
}
