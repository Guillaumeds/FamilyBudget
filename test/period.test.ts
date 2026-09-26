import { describe, expect, it } from 'vitest';
import { elapsedDays, listCompletedPeriodsBetween, normalizeStartDay, periodForDate, periodForOffset } from '../src/lib/period';
import { addDays } from '../src/lib/tz';

describe('periodForOffset — start day 25', () => {
	it('on the 24th the current period is still the one that started last month', () => {
		expect(periodForOffset('2026-09-24', 25, 0)).toEqual({
			startText: '2026-08-25',
			endText: '2026-09-24',
			endExclusiveText: '2026-09-25',
			label: '25 Aug to 24 Sep 2026',
			periodDays: 31,
		});
	});

	it('on the 25th a new period starts', () => {
		expect(periodForOffset('2026-09-25', 25, 0)).toEqual({
			startText: '2026-09-25',
			endText: '2026-10-24',
			endExclusiveText: '2026-10-25',
			label: '25 Sep to 24 Oct 2026',
			periodDays: 30,
		});
	});

	it.each([
		[0, '2026-09-25', '2026-10-24', '25 Sep to 24 Oct 2026'],
		[-1, '2026-08-25', '2026-09-24', '25 Aug to 24 Sep 2026'],
		[-2, '2026-07-25', '2026-08-24', '25 Jul to 24 Aug 2026'],
		[-3, '2026-06-25', '2026-07-24', '25 Jun to 24 Jul 2026'],
		[1, '2026-10-25', '2026-11-24', '25 Oct to 24 Nov 2026'],
	])('offset %i from 2026-09-26', (offset, startText, endText, label) => {
		const period = periodForOffset('2026-09-26', 25, offset);
		expect(period.startText).toBe(startText);
		expect(period.endText).toBe(endText);
		expect(period.label).toBe(label);
	});

	it('crosses the year boundary', () => {
		expect(periodForOffset('2026-01-10', 25, 0)).toMatchObject({
			startText: '2025-12-25',
			endText: '2026-01-24',
			label: '25 Dec to 24 Jan 2026',
			periodDays: 31,
		});
		expect(periodForOffset('2026-01-10', 25, -1)).toMatchObject({
			startText: '2025-11-25',
			endText: '2025-12-24',
			label: '25 Nov to 24 Dec 2025',
		});
	});
});

describe('periodForOffset — start day clamping', () => {
	it('start day 31 clamps to the end of February', () => {
		expect(periodForOffset('2026-02-27', 31, 0)).toMatchObject({
			startText: '2026-01-31',
			endText: '2026-02-27',
			endExclusiveText: '2026-02-28',
			periodDays: 28,
		});
		// 28 Feb is the clamped start day, so it opens the next period (the POC excluded it).
		expect(periodForOffset('2026-02-28', 31, 0)).toMatchObject({
			startText: '2026-02-28',
			endText: '2026-03-30',
			endExclusiveText: '2026-03-31',
			label: '28 Feb to 30 Mar 2026',
			periodDays: 31,
		});
		expect(periodForOffset('2026-03-31', 31, 0)).toMatchObject({ startText: '2026-03-31', endText: '2026-04-29' });
	});

	it('handles leap years', () => {
		expect(periodForOffset('2028-02-29', 31, 0)).toMatchObject({ startText: '2028-02-29', endText: '2028-03-30' });
		expect(periodForOffset('2028-02-28', 30, 0)).toMatchObject({ startText: '2028-01-30', endText: '2028-02-28', periodDays: 30 });
		expect(periodForOffset('2026-03-15', 30, -1)).toMatchObject({ startText: '2026-01-30', endText: '2026-02-27', periodDays: 29 });
	});

	it('start day 1 gives calendar months', () => {
		expect(periodForOffset('2026-09-26', 1, 0)).toEqual({
			startText: '2026-09-01',
			endText: '2026-09-30',
			endExclusiveText: '2026-10-01',
			label: '01 Sep to 30 Sep 2026',
			periodDays: 30,
		});
		expect(periodForOffset('2026-03-01', 1, -1)).toMatchObject({ startText: '2026-02-01', endText: '2026-02-28', periodDays: 28 });
	});

	it('normalises out-of-range start days', () => {
		expect(normalizeStartDay(0)).toBe(1);
		expect(normalizeStartDay(Number.NaN)).toBe(1);
		expect(normalizeStartDay(40)).toBe(31);
		expect(normalizeStartDay(25.7)).toBe(25);
	});

	it('always contains today, and consecutive periods tile without gaps', () => {
		for (const startDay of [1, 15, 25, 28, 29, 30, 31]) {
			for (let day = '2026-01-01'; day <= '2028-12-31'; day = addDays(day, 7)) {
				const current = periodForOffset(day, startDay, 0);
				expect(current.startText <= day && day <= current.endText, `${day} sd=${startDay}`).toBe(true);
				expect(periodForOffset(day, startDay, -1).endExclusiveText).toBe(current.startText);
				expect(periodForOffset(day, startDay, 1).startText).toBe(current.endExclusiveText);
			}
		}
	});
});

describe('elapsedDays', () => {
	const period = periodForOffset('2026-09-10', 25, 0); // 25 Aug – 24 Sep 2026, 31 days

	it('counts today, from 1 on the first day to periodDays on the last', () => {
		expect(elapsedDays(period, '2026-08-25')).toBe(1);
		expect(elapsedDays(period, '2026-09-09')).toBe(16);
		expect(elapsedDays(period, '2026-09-24')).toBe(31);
	});

	it('is capped at the period end and floored at 1', () => {
		expect(elapsedDays(period, '2026-10-10')).toBe(period.periodDays);
		expect(elapsedDays(period, '2026-08-01')).toBe(1);
	});
});

describe('periodForDate / listCompletedPeriodsBetween', () => {
	it('periodForDate returns the period containing the date', () => {
		expect(periodForDate('2026-06-24', 25).startText).toBe('2026-05-25');
		expect(periodForDate('2026-06-25', 25).startText).toBe('2026-06-25');
	});

	it('lists completed periods oldest first, excluding the current one', () => {
		const periods = listCompletedPeriodsBetween('2026-06-10', '2026-09-26', 25);
		expect(periods.map((p) => p.label)).toEqual([
			'25 May to 24 Jun 2026',
			'25 Jun to 24 Jul 2026',
			'25 Jul to 24 Aug 2026',
			'25 Aug to 24 Sep 2026',
		]);
	});

	it('is empty when the first date is in the current period', () => {
		expect(listCompletedPeriodsBetween('2026-09-25', '2026-09-26', 25)).toEqual([]);
		expect(listCompletedPeriodsBetween('2026-10-01', '2026-09-26', 25)).toEqual([]);
	});

	it('works with clamped start days', () => {
		const periods = listCompletedPeriodsBetween('2026-01-31', '2026-04-15', 31);
		expect(periods.map((p) => [p.startText, p.endText])).toEqual([
			['2026-01-31', '2026-02-27'],
			['2026-02-28', '2026-03-30'],
		]);
	});
});
