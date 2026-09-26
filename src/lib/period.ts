/**
 * Budget-month math. A budget month starts on `startDay` and ends the day before `startDay` of the
 * next month (start day 25 → "25 Aug to 24 Sep"). Start days beyond a month's length clamp to the
 * month's last day (start day 31 → 28/29 Feb, 30 Apr, ...).
 *
 * Pure string/UTC arithmetic — independent of the runtime time zone. Callers pass the *local* date
 * (see `localDate` in ./tz) so the period follows the user's `timezone` setting.
 * Ported from getBudgetPeriodForOffset / the elapsedDays sheet formula in legacy/Code.gs.
 */
import { addDays, dateTextToUtcMs, diffDays, MONTH_SHORT, parseDateText, utcDateText } from './tz';

export interface BudgetPeriod {
	/** First day of the period, inclusive ('yyyy-mm-dd'). */
	startText: string;
	/** Last day of the period, inclusive. */
	endText: string;
	/** First day of the next period (exclusive end) — use for `date >= start AND date < endExclusive`. */
	endExclusiveText: string;
	/** Human label, e.g. "25 Aug to 24 Sep 2026". */
	label: string;
	/** Number of days in the period (endExclusive − start). */
	periodDays: number;
}

/** Normalises the `budget_month_start_day` setting to an integer 1–31 (default 1). */
export function normalizeStartDay(startDay: number): number {
	const day = Math.trunc(Number(startDay));
	return Number.isFinite(day) && day >= 1 ? Math.min(day, 31) : 1;
}

function daysInMonth(year: number, monthIndex: number): number {
	// Day 0 of the following month is the last day of `monthIndex` (0-based; overflow is normalised).
	return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** 'yyyy-mm-dd' for `day` (clamped to the month length) of month `monthIndex` (0-based, may overflow). */
function clampedMonthDate(year: number, monthIndex: number, day: number): string {
	const first = new Date(Date.UTC(year, monthIndex, 1));
	const y = first.getUTCFullYear();
	const m = first.getUTCMonth();
	return utcDateText(Date.UTC(y, m, Math.min(day, daysInMonth(y, m))));
}

function formatLabel(startText: string, endText: string): string {
	const start = parseDateText(startText);
	const end = parseDateText(endText);
	const dd = (d: number) => String(d).padStart(2, '0');
	return `${dd(start.day)} ${MONTH_SHORT[start.month - 1]} to ${dd(end.day)} ${MONTH_SHORT[end.month - 1]} ${end.year}`;
}

/**
 * The budget period `offset` months away from the one containing `todayLocal`
 * (0 = current, -1 = previous, ...).
 *
 * The anchor month is the previous calendar month while today is before this month's (clamped)
 * start day. Note: the POC compared against the unclamped start day, which for start day 31 put
 * e.g. 28 Feb outside the "current" period; comparing with the clamped day keeps today inside it.
 */
export function periodForOffset(todayLocal: string, startDay: number, offset: number): BudgetPeriod {
	const sd = normalizeStartDay(startDay);
	const today = parseDateText(todayLocal);
	const monthIndex = today.month - 1;
	const effectiveStart = Math.min(sd, daysInMonth(today.year, monthIndex));
	const anchor = monthIndex - (today.day < effectiveStart ? 1 : 0) + Math.trunc(offset || 0);

	const startText = clampedMonthDate(today.year, anchor, sd);
	const endExclusiveText = clampedMonthDate(today.year, anchor + 1, sd);
	const endText = addDays(endExclusiveText, -1);
	return {
		startText,
		endText,
		endExclusiveText,
		label: formatLabel(startText, endText),
		periodDays: diffDays(startText, endExclusiveText),
	};
}

/** The budget period containing `dateLocal`. */
export function periodForDate(dateLocal: string, startDay: number): BudgetPeriod {
	return periodForOffset(dateLocal, startDay, 0);
}

/**
 * Days elapsed in `period` as of `todayLocal`, counting today: max(1, min(today, end) − start + 1).
 * Mirrors the POC sheet formula MAX(1, MIN(TODAY(), periodEnd−1) − periodStart + 1).
 */
export function elapsedDays(period: BudgetPeriod, todayLocal: string): number {
	const until = dateTextToUtcMs(todayLocal) < dateTextToUtcMs(period.endText) ? todayLocal : period.endText;
	return Math.max(1, diffDays(period.startText, until) + 1);
}

/**
 * All fully completed periods from the one containing `firstDate` up to (excluding) the period
 * containing `todayLocal`, oldest first.
 */
export function listCompletedPeriodsBetween(firstDate: string, todayLocal: string, startDay: number): BudgetPeriod[] {
	const current = periodForDate(todayLocal, startDay);
	const periods: BudgetPeriod[] = [];
	for (let period = periodForDate(firstDate, startDay); period.startText < current.startText; ) {
		periods.push(period);
		period = periodForDate(period.endExclusiveText, startDay);
	}
	return periods;
}
