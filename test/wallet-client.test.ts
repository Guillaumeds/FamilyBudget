import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { MAX_PAGES, WalletApiError, fetchAllPages, getLastChangeRev, testWalletAuth, walletFetch } from '../src/wallet/client';

const walletEnv: Env = { ...env, WALLET_API_TOKEN: 'test-token' };

function mockFetch(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => handler(new URL(String(input)), init));
}

function urls(spy: ReturnType<typeof mockFetch>): URL[] {
	return spy.mock.calls.map(([input]) => new URL(String(input)));
}

async function caught(promise: Promise<unknown>): Promise<WalletApiError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(WalletApiError);
	return error as WalletApiError;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('walletFetch', () => {
	it('sends a bearer-authenticated JSON GET to the configured base URL', async () => {
		const spy = mockFetch(() => Response.json({ ok: 1 }, { headers: { 'X-Last-Data-Change-Rev': 'r7' } }));
		const { body, headers } = await walletFetch(walletEnv, '/v1/api/records', { limit: 200, recordDate: 'gte.2026-01-01' });

		expect(body).toEqual({ ok: 1 });
		expect(headers.get('x-last-data-change-rev')).toBe('r7');
		const [url] = urls(spy);
		expect(url!.origin + url!.pathname).toBe('https://rest.budgetbakers.com/wallet/v1/api/records');
		expect(Object.fromEntries(url!.searchParams)).toEqual({ limit: '200', recordDate: 'gte.2026-01-01' });
		const init = spy.mock.calls[0]![1]!;
		expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
		expect(new Headers(init.headers).get('Accept')).toBe('application/json');
	});

	it('fails with WALLET_AUTH without calling the API when the token is missing', async () => {
		const spy = mockFetch(() => Response.json({}));
		const error = await caught(walletFetch({ ...walletEnv, WALLET_API_TOKEN: '  ' }, '/v1/api/accounts'));
		expect(error.code).toBe('WALLET_AUTH');
		expect(spy).not.toHaveBeenCalled();
	});

	it.each([401, 403])('maps HTTP %i to WALLET_AUTH with status and body excerpt', async (status) => {
		mockFetch(() => Response.json({ error: 'Invalid or expired token' }, { status }));
		const error = await caught(walletFetch(walletEnv, '/v1/api/accounts'));
		expect(error).toMatchObject({ code: 'WALLET_AUTH', status, bodyExcerpt: '{"error":"Invalid or expired token"}' });
		expect(error.message).toContain('Invalid or expired token');
	});

	it('maps 409 (initial sync in progress) to WALLET_SYNC_IN_PROGRESS with the suggested delay', async () => {
		mockFetch(() =>
			Response.json(
				{ error: 'init_sync_in_progress', message: 'Data synchronization in progress. Please retry later.', retry_after_minutes: 5 },
				{ status: 409 },
			),
		);
		const error = await caught(walletFetch(walletEnv, '/v1/api/records'));
		expect(error).toMatchObject({ code: 'WALLET_SYNC_IN_PROGRESS', status: 409, retryAfterSeconds: 300 });
	});

	it('maps other failures to WALLET_API and truncates the body excerpt to 500 chars', async () => {
		mockFetch(() => new Response('x'.repeat(2000), { status: 500 }));
		const error = await caught(walletFetch(walletEnv, '/v1/api/records'));
		expect(error).toMatchObject({ code: 'WALLET_API', status: 500 });
		expect(error.bodyExcerpt).toHaveLength(500);
	});

	it('wraps network errors as WALLET_API', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection reset'));
		const error = await caught(walletFetch(walletEnv, '/v1/api/records'));
		expect(error.code).toBe('WALLET_API');
		expect(error.message).toContain('connection reset');
	});

	it('on 429 waits Retry-After seconds, retries once, then fails with WALLET_RATE_LIMIT', async () => {
		vi.useFakeTimers();
		const spy = mockFetch(() => Response.json({ error: 'Rate limit exceeded.' }, { status: 429, headers: { 'Retry-After': '2' } }));
		const result = walletFetch(walletEnv, '/v1/api/records').catch((e: unknown) => e);

		await vi.advanceTimersByTimeAsync(1999);
		expect(spy).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(await result).toMatchObject({ code: 'WALLET_RATE_LIMIT', status: 429, retryAfterSeconds: 2 });
	});

	it('on 429 returns the retried response when the retry succeeds', async () => {
		vi.useFakeTimers();
		let calls = 0;
		mockFetch(() => (++calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({ ok: true })));
		const result = walletFetch(walletEnv, '/v1/api/accounts');
		await vi.advanceTimersByTimeAsync(1000);
		expect((await result).body).toEqual({ ok: true });
	});

	it('does not retry early when Retry-After exceeds the 30s cap (fair-use policy)', async () => {
		const spy = mockFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }));
		const error = await caught(walletFetch(walletEnv, '/v1/api/records'));
		expect(error).toMatchObject({ code: 'WALLET_RATE_LIMIT', retryAfterSeconds: 120 });
		expect(spy).toHaveBeenCalledOnce();
	});
});

describe('fetchAllPages', () => {
	it('follows nextOffset with limit 200 until it is absent and returns the first page headers', async () => {
		const pages: Record<string, unknown> = {
			'0': { limit: 200, offset: 0, nextOffset: 200, records: [{ id: 'a' }, { id: 'b' }] },
			'200': { limit: 200, offset: 200, nextOffset: 400, records: [{ id: 'c' }] },
			'400': { limit: 200, offset: 400, records: [{ id: 'd' }] },
		};
		const spy = mockFetch((url) =>
			Response.json(pages[url.searchParams.get('offset')!], { headers: { 'X-Last-Data-Change-Rev': `rev-${url.searchParams.get('offset')}` } }),
		);
		const result = await fetchAllPages<{ id: string }>(walletEnv, '/v1/api/records', { recordDate: 'gte.2020-01-01' }, ['records']);

		expect(result.items.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(result.complete).toBe(true);
		expect(result.headers.get('X-Last-Data-Change-Rev')).toBe('rev-0');
		expect(urls(spy).map((u) => [u.searchParams.get('offset'), u.searchParams.get('limit'), u.searchParams.get('recordDate')])).toEqual([
			['0', '200', 'gte.2020-01-01'],
			['200', '200', 'gte.2020-01-01'],
			['400', '200', 'gte.2020-01-01'],
		]);
	});

	it('stops (incomplete) when nextOffset repeats', async () => {
		const spy = mockFetch((url) => Response.json({ nextOffset: 200, records: [{ id: `r${url.searchParams.get('offset')}` }] }));
		const result = await fetchAllPages(walletEnv, '/v1/api/records', {}, ['records']);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(result.items).toHaveLength(2);
		expect(result.complete).toBe(false);
	});

	it('stops (incomplete) on an empty page that still announces a next page', async () => {
		mockFetch(() => Response.json({ nextOffset: 200, records: [] }));
		const result = await fetchAllPages(walletEnv, '/v1/api/records', {}, ['records']);
		expect(result).toMatchObject({ items: [], complete: false });
	});

	it(`stops (incomplete) after ${MAX_PAGES} pages`, async () => {
		const spy = mockFetch((url) => {
			const offset = Number(url.searchParams.get('offset'));
			return Response.json({ nextOffset: offset + 1, accounts: [{ id: offset }] });
		});
		const result = await fetchAllPages(walletEnv, '/v1/api/accounts', {}, ['accounts']);
		expect(spy).toHaveBeenCalledTimes(MAX_PAGES);
		expect(result.complete).toBe(false);
	});

	it('treats a single page without nextOffset as complete', async () => {
		mockFetch(() => Response.json({ limit: 200, offset: 0, categories: [{ id: 'x' }] }));
		expect(await fetchAllPages(walletEnv, '/v1/api/categories', {}, ['categories'])).toMatchObject({ items: [{ id: 'x' }], complete: true });
	});

	it('throws WALLET_API when the envelope has none of the expected arrays', async () => {
		mockFetch(() => Response.json({ limit: 200, offset: 0, something: [] }));
		const error = await caught(fetchAllPages(walletEnv, '/v1/api/records', {}, ['records']));
		expect(error.code).toBe('WALLET_API');
	});
});

describe('getLastChangeRev', () => {
	it('reads X-Last-Data-Change-Rev (any case) from a limit-1 accounts request', async () => {
		const spy = mockFetch(() => Response.json({ accounts: [] }, { headers: { 'x-last-data-change-rev': 'r1234' } }));
		expect(await getLastChangeRev(walletEnv)).toBe('r1234');
		const [url] = urls(spy);
		expect(url!.pathname).toBe('/wallet/v1/api/accounts');
		expect(url!.searchParams.get('limit')).toBe('1');
	});

	it('returns null when the header is absent', async () => {
		mockFetch(() => Response.json({ accounts: [] }));
		expect(await getLastChangeRev(walletEnv)).toBeNull();
	});
});

describe('testWalletAuth', () => {
	it('calls api-usage/stats for the last 30 days', async () => {
		const spy = mockFetch(() => Response.json({ period: '30days', granularity: 'daily', total: 3, usage: [] }));
		expect(await testWalletAuth(walletEnv)).toEqual({ ok: true });
		const [url] = urls(spy);
		expect(url!.pathname).toBe('/wallet/v1/api/api-usage/stats');
		expect(url!.searchParams.get('period')).toBe('30days');
	});

	it('reports the error code instead of throwing', async () => {
		mockFetch(() => Response.json({ error: 'init_sync_in_progress', retry_after_minutes: 5 }, { status: 409 }));
		expect(await testWalletAuth(walletEnv)).toMatchObject({ ok: false, code: 'WALLET_SYNC_IN_PROGRESS' });
		expect(await testWalletAuth({ ...walletEnv, WALLET_API_TOKEN: undefined })).toMatchObject({ ok: false, code: 'WALLET_AUTH' });
	});
});
