import { describe, expect, it } from 'vitest';
import { addDays, briefDateLabel, diffDays, isoNow, localDate, localDayOfMonth, localHour } from '../src/lib/tz';

const DUBLIN = 'Europe/Dublin';
const at = (iso: string) => new Date(iso);

describe('localHour — Europe/Dublin DST transitions', () => {
	it('spring forward on 2026-03-29 (01:00 UTC: 01:00 GMT → 02:00 IST)', () => {
		expect(localHour(at('2026-03-28T09:00:00Z'), DUBLIN)).toBe(9); // winter: UTC+0
		expect(localHour(at('2026-03-29T00:30:00Z'), DUBLIN)).toBe(0);
		expect(localHour(at('2026-03-29T00:59:59Z'), DUBLIN)).toBe(0);
		expect(localHour(at('2026-03-29T01:00:00Z'), DUBLIN)).toBe(2); // 01:xx local never happens
		expect(localHour(at('2026-03-29T08:00:00Z'), DUBLIN)).toBe(9); // summer: 9am local is 08:00 UTC
	});

	it('fall back on 2026-10-25 (01:00 UTC: 02:00 IST → 01:00 GMT)', () => {
		expect(localHour(at('2026-10-24T08:00:00Z'), DUBLIN)).toBe(9); // summer
		expect(localHour(at('2026-10-25T00:30:00Z'), DUBLIN)).toBe(1); // 01:30 IST
		expect(localHour(at('2026-10-25T01:30:00Z'), DUBLIN)).toBe(1); // 01:30 GMT — the hour repeats
		expect(localHour(at('2026-10-25T09:00:00Z'), DUBLIN)).toBe(9); // winter: 9am local is 09:00 UTC
	});

	it('reports midnight as 0, never 24', () => {
		expect(localHour(at('2026-09-25T23:00:00Z'), DUBLIN)).toBe(0);
		expect(localHour(at('2026-01-01T00:00:00Z'), 'UTC')).toBe(0);
	});
});

describe('localDate / localDayOfMonth', () => {
	it('returns yyyy-mm-dd in the requested zone', () => {
		const instant = at('2026-09-25T23:30:00Z');
		expect(localDate(instant, 'UTC')).toBe('2026-09-25');
		expect(localDate(instant, DUBLIN)).toBe('2026-09-26');
		expect(localDate(instant, 'Pacific/Auckland')).toBe('2026-09-26');
		expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-09-25');
		expect(localDate(at('2026-01-05T12:00:00Z'), DUBLIN)).toBe('2026-01-05'); // zero-padded
	});

	it('returns the local day of month', () => {
		expect(localDayOfMonth(at('2026-09-30T23:30:00Z'), DUBLIN)).toBe(1);
		expect(localDayOfMonth(at('2026-09-30T23:30:00Z'), 'UTC')).toBe(30);
	});

	it('rejects unknown time zones', () => {
		expect(() => localDate(at('2026-09-25T00:00:00Z'), 'Not/AZone')).toThrow(RangeError);
	});
});

describe('briefDateLabel', () => {
	it("formats 'EEE, dd MMM yyyy' in the local zone", () => {
		expect(briefDateLabel(at('2026-09-25T08:00:00Z'), DUBLIN)).toBe('Fri, 25 Sep 2026');
		expect(briefDateLabel(at('2026-09-25T23:30:00Z'), DUBLIN)).toBe('Sat, 26 Sep 2026');
		expect(briefDateLabel(at('2026-03-01T10:00:00Z'), 'UTC')).toBe('Sun, 01 Mar 2026');
	});
});

describe('addDays / diffDays / isoNow', () => {
	it('adds calendar days across month, leap-day, year and DST boundaries', () => {
		expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
		expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
		expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
		expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
		expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
		expect(addDays('2026-09-26', 0)).toBe('2026-09-26');
	});

	it('diffDays counts whole days', () => {
		expect(diffDays('2026-08-25', '2026-09-25')).toBe(31);
		expect(diffDays('2026-09-25', '2026-08-25')).toBe(-31);
	});

	it('rejects malformed dates', () => {
		expect(() => addDays('26/09/2026', 1)).toThrow(/yyyy-mm-dd/);
	});

	it('isoNow is an ISO-8601 UTC timestamp', () => {
		expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});
