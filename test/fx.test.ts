import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFxRateOnOrBefore, upsertFxRates } from '../src/db/repo';
import { convertToBase, ensureRates, fetchRatesRange } from '../src/lib/fx';
import { addDays } from '../src/lib/tz';
import { resetDb } from './helpers';

interface FakeRate {
	date: string;
	base: string;
	quote: string;
	rate: number;
}

/** Fake Frankfurter v2: `rate` = units of quote per 1 base, one row per day per quote in [from, to]. */
function frankfurter(quoteRates: Record<string, number>) {
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(String(input));
		const base = url.searchParams.get('base')!;
		const quotes = url.searchParams.get('quotes')!.split(',');
		const unknown = quotes.find((q) => !(q in quoteRates));
		if (unknown) return Response.json({ status: 422, message: `invalid currency: ${unknown}` }, { status: 422 });
		const rows: FakeRate[] = [];
		for (let date = url.searchParams.get('from')!; date <= url.searchParams.get('to')!; date = addDays(date, 1)) {
			for (const quote of quotes) rows.push({ date, base, quote, rate: quoteRates[quote]! });
		}
		return Response.json(rows);
	});
}

function requestedUrls(spy: ReturnType<typeof frankfurter>): URL[] {
	return spy.mock.calls.map(([input]) => new URL(String(input)));
}

beforeEach(resetDb);
afterEach(() => {
	vi.restoreAllMocks();
});

describe('fetchRatesRange', () => {
	it('calls the v2 time-series endpoint and inverts the quote (rateToBase = 1 / rate)', async () => {
		const spy = frankfurter({ USD: 1.25, ZAR: 20 });
		const rates = await fetchRatesRange('eur', ['USD', 'zar', 'EUR', 'USD'], '2026-09-01', '2026-09-02');

		const [url] = requestedUrls(spy);
		expect(spy).toHaveBeenCalledOnce();
		expect(url!.origin + url!.pathname).toBe('https://api.frankfurter.dev/v2/rates');
		expect(Object.fromEntries(url!.searchParams)).toEqual({ from: '2026-09-01', to: '2026-09-02', base: 'EUR', quotes: 'USD,ZAR' });
		expect(rates).toEqual([
			{ date: '2026-09-01', currency: 'USD', rateToBase: 0.8 },
			{ date: '2026-09-01', currency: 'ZAR', rateToBase: 0.05 },
			{ date: '2026-09-02', currency: 'USD', rateToBase: 0.8 },
			{ date: '2026-09-02', currency: 'ZAR', rateToBase: 0.05 },
		]);
	});

	it('makes no request when there is nothing to fetch', async () => {
		const spy = frankfurter({});
		expect(await fetchRatesRange('EUR', [], '2026-09-01', '2026-09-02')).toEqual([]);
		expect(await fetchRatesRange('EUR', ['eur'], '2026-09-01', '2026-09-02')).toEqual([]);
		expect(spy).not.toHaveBeenCalled();
	});

	it('drops currencies Frankfurter rejects (422) and retries with the rest', async () => {
		const spy = frankfurter({ USD: 2 });
		const rates = await fetchRatesRange('EUR', ['XYZ', 'USD'], '2026-09-01', '2026-09-01');
		expect(spy).toHaveBeenCalledTimes(2);
		expect(requestedUrls(spy)[1]!.searchParams.get('quotes')).toBe('USD');
		expect(rates).toEqual([{ date: '2026-09-01', currency: 'USD', rateToBase: 0.5 }]);
	});

	it('throws on other HTTP errors', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
		await expect(fetchRatesRange('EUR', ['USD'], '2026-09-01', '2026-09-01')).rejects.toThrow(/Frankfurter 500/);
	});
});

describe('ensureRates', () => {
	it('fetches the whole range (plus a 7-day lookback) when nothing is cached', async () => {
		const spy = frankfurter({ USD: 1.25, ZAR: 20 });
		const stored = await ensureRates(env.DB, 'EUR', ['USD', 'ZAR', 'EUR'], '2026-09-10', '2026-09-20');

		const [url] = requestedUrls(spy);
		expect(spy).toHaveBeenCalledOnce();
		expect(url!.searchParams.get('from')).toBe('2026-09-03');
		expect(url!.searchParams.get('to')).toBe('2026-09-20');
		expect(url!.searchParams.get('quotes')).toBe('USD,ZAR');
		expect(stored).toBe(18 * 2);
		expect(await getFxRateOnOrBefore(env.DB, 'EUR', '2026-09-15', 'USD')).toBe(0.8);
	});

	it('does not call the API when the range is already covered', async () => {
		frankfurter({ USD: 1.25 });
		await ensureRates(env.DB, 'EUR', ['USD'], '2026-09-10', '2026-09-20');
		vi.restoreAllMocks();

		const spy = frankfurter({ USD: 1.25 });
		expect(await ensureRates(env.DB, 'EUR', ['USD'], '2026-09-12', '2026-09-20')).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it('fetches only the missing tail, and only for currencies with a gap', async () => {
		await upsertFxRates(env.DB, 'EUR', [
			{ date: '2026-09-01', currency: 'USD', rateToBase: 0.8 },
			{ date: '2026-09-20', currency: 'USD', rateToBase: 0.8 },
			{ date: '2026-09-01', currency: 'ZAR', rateToBase: 0.05 },
			{ date: '2026-09-23', currency: 'ZAR', rateToBase: 0.05 },
		]);
		const spy = frankfurter({ USD: 1.25, ZAR: 20 });
		await ensureRates(env.DB, 'EUR', ['USD', 'ZAR'], '2026-09-05', '2026-09-23');

		const [url] = requestedUrls(spy);
		expect(spy).toHaveBeenCalledOnce();
		expect(url!.searchParams.get('quotes')).toBe('USD');
		expect(url!.searchParams.get('from')).toBe(addDays('2026-09-21', -7));
		expect(url!.searchParams.get('to')).toBe('2026-09-23');
	});

	it('fetches a missing head when the range starts before the cached rates', async () => {
		await upsertFxRates(env.DB, 'EUR', [{ date: '2026-09-10', currency: 'USD', rateToBase: 0.8 }]);
		const spy = frankfurter({ USD: 1.25 });
		await ensureRates(env.DB, 'EUR', ['USD'], '2026-08-01', '2026-09-10');

		const [url] = requestedUrls(spy);
		expect(url!.searchParams.get('from')).toBe('2026-07-25');
		expect(url!.searchParams.get('to')).toBe('2026-09-09');
	});

	it('skips the request entirely when only the base currency (or nothing) is needed', async () => {
		const spy = frankfurter({});
		expect(await ensureRates(env.DB, 'EUR', [], '2026-09-01', '2026-09-20')).toBe(0);
		expect(await ensureRates(env.DB, 'EUR', ['eur', 'EUR'], '2026-09-01', '2026-09-20')).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('convertToBase', () => {
	it('is the identity for the base currency (no lookup needed)', async () => {
		expect(await convertToBase(env.DB, -42.5, 'eur', '2026-09-01', 'EUR')).toBe(-42.5);
	});

	it('multiplies by the rate on or before the date (e.g. Friday rate for a Sunday)', async () => {
		await upsertFxRates(env.DB, 'EUR', [
			{ date: '2026-09-18', currency: 'ZAR', rateToBase: 0.05 }, // Friday
			{ date: '2026-09-21', currency: 'ZAR', rateToBase: 0.04 }, // Monday
		]);
		expect(await convertToBase(env.DB, -200, 'ZAR', '2026-09-20', 'EUR')).toBeCloseTo(-10);
		expect(await convertToBase(env.DB, -200, 'zar', '2026-09-21', 'EUR')).toBeCloseTo(-8);
	});

	it('returns null when no rate is available (or only a stale one)', async () => {
		expect(await convertToBase(env.DB, 100, 'USD', '2026-09-20', 'EUR')).toBeNull();
		await upsertFxRates(env.DB, 'EUR', [{ date: '2026-08-01', currency: 'USD', rateToBase: 0.8 }]);
		expect(await convertToBase(env.DB, 100, 'USD', '2026-09-20', 'EUR')).toBeNull();
		expect(await convertToBase(env.DB, 100, 'USD', '2026-07-31', 'EUR')).toBeNull();
	});
});
