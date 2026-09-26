/**
 * Exchange rates from Frankfurter (https://frankfurter.dev — free, no API key), cached in D1.
 *
 * Uses the v2 API (v1 is deprecated): GET /v2/rates?from&to&base&quotes returns
 * [{ date, base, quote, rate }] where `rate` = units of `quote` per 1 `base`. We store the inverse,
 * `rate_to_base` = base units per 1 unit of the foreign currency, so amount_base = amount × rate.
 * Default (blended) rates cover ~200 currencies and usually include weekends; days without a
 * published rate fall back to the latest earlier rate (see getFxRateOnOrBefore).
 */
import { getFxCoverage, getFxRateOnOrBefore, upsertFxRates } from '../db/repo';
import { addDays } from './tz';

export const FRANKFURTER_API_URL = 'https://api.frankfurter.dev/v2';

/** Days fetched before a missing range so the first days always have an earlier rate to fall back to. */
const LOOKBACK_DAYS = 7;

export interface FxRate {
	date: string;
	currency: string;
	/** Base-currency units per 1 unit of `currency`. */
	rateToBase: number;
}

interface FrankfurterRate {
	date: string;
	base: string;
	quote: string;
	rate: number;
}

/**
 * Fetches daily rates for `symbols` against `baseCurrency` between `from` and `to` (inclusive,
 * 'yyyy-mm-dd'). Symbols Frankfurter does not know (HTTP 422 "invalid currency: XYZ") are dropped
 * and the request retried, so one exotic currency cannot block the others.
 */
export async function fetchRatesRange(baseCurrency: string, symbols: readonly string[], from: string, to: string): Promise<FxRate[]> {
	const base = baseCurrency.toUpperCase();
	let quotes = [...new Set(symbols.map((s) => s.toUpperCase()))].filter((s) => s !== base);

	while (quotes.length > 0) {
		const url = `${FRANKFURTER_API_URL}/rates?${new URLSearchParams({ from, to, base, quotes: quotes.join(',') })}`;
		const response = await fetch(url, { headers: { Accept: 'application/json' } });
		if (response.ok) {
			const rows = (await response.json()) as FrankfurterRate[];
			return rows
				.filter((row) => row.base === base && quotes.includes(row.quote) && row.rate > 0)
				.map((row) => ({ date: row.date, currency: row.quote, rateToBase: 1 / row.rate }));
		}
		const body = await response.text();
		const invalid = response.status === 422 ? /invalid currency:\s*([A-Z]{3})/i.exec(body)?.[1]?.toUpperCase() : undefined;
		if (!invalid || !quotes.includes(invalid)) throw new Error(`Frankfurter ${response.status}: ${body.slice(0, 200)}`);
		console.warn(`Frankfurter does not support ${invalid}; skipping it.`);
		quotes = quotes.filter((q) => q !== invalid);
	}
	return [];
}

/**
 * Makes sure fx_rates covers `minDate`..`maxDate` for every currency in `currencies` (the base
 * currency is ignored). A currency has a gap when it has no stored rates, its earliest rate is after
 * `minDate`, or its latest rate is before `maxDate`. All gaps are fetched in ONE request spanning
 * the union of the gaps; nothing is requested when everything is covered. Returns the number of
 * rates stored.
 */
export async function ensureRates(
	db: D1Database,
	baseCurrency: string,
	currencies: readonly string[],
	minDate: string,
	maxDate: string,
): Promise<number> {
	const base = baseCurrency.toUpperCase();
	const wanted = [...new Set(currencies.map((c) => c.toUpperCase()))].filter((c) => c && c !== base);
	if (wanted.length === 0 || minDate > maxDate) return 0;

	const coverage = await getFxCoverage(db, wanted);
	const missing: string[] = [];
	let from = maxDate;
	let to = minDate;
	for (const currency of wanted) {
		const range = coverage.get(currency);
		const gapStart = !range || range.minDate > minDate ? minDate : range.maxDate < maxDate ? addDays(range.maxDate, 1) : null;
		if (gapStart === null) continue;
		const gapEnd = !range || range.maxDate < maxDate ? maxDate : addDays(range.minDate, -1);
		missing.push(currency);
		if (gapStart < from) from = gapStart;
		if (gapEnd > to) to = gapEnd;
	}
	if (missing.length === 0) return 0;

	const rates = await fetchRatesRange(base, missing, addDays(from, -LOOKBACK_DAYS), to);
	await upsertFxRates(db, rates);
	return rates.length;
}

/**
 * Converts a (signed) amount to the base currency using the rate on or before `date`.
 * Identity when `currency` is the base currency; null when no rate is available (store NULL).
 */
export async function convertToBase(
	db: D1Database,
	amount: number,
	currency: string,
	date: string,
	baseCurrency: string,
): Promise<number | null> {
	if (currency.toUpperCase() === baseCurrency.toUpperCase()) return amount;
	const rate = await getFxRateOnOrBefore(db, date, currency);
	return rate === null ? null : amount * rate;
}
