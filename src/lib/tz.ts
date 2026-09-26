/**
 * Time-zone and calendar-date helpers.
 *
 * Calendar days are passed around as 'yyyy-mm-dd' strings. Arithmetic on them is done in UTC so the
 * result never depends on the runtime's own time zone (Workers run in UTC, test machines may not).
 * Only `localDate`/`localHour`/`localDayOfMonth`/`briefDateLabel` look at a real IANA time zone.
 */

export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const DAY_MS = 86_400_000;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function localParts(now: Date, timeZone: string): Record<'year' | 'month' | 'day' | 'hour', number> {
	let formatter = formatterCache.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			hourCycle: 'h23',
		});
		formatterCache.set(timeZone, formatter);
	}
	const parts = { year: 0, month: 0, day: 0, hour: 0 };
	for (const part of formatter.formatToParts(now)) {
		if (part.type in parts) parts[part.type as keyof typeof parts] = Number(part.value);
	}
	return parts;
}

function pad2(value: number): string {
	return String(value).padStart(2, '0');
}

/** Splits 'yyyy-mm-dd' into numbers (month 1-12). Throws on malformed input. */
export function parseDateText(dateText: string): { year: number; month: number; day: number } {
	const match = DATE_TEXT.exec(dateText);
	if (!match) throw new Error(`Invalid date text (expected yyyy-mm-dd): ${dateText}`);
	return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Formats a UTC-midnight timestamp as 'yyyy-mm-dd'. */
export function utcDateText(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10);
}

/** 'yyyy-mm-dd' → epoch ms at UTC midnight (for pure day arithmetic). */
export function dateTextToUtcMs(dateText: string): number {
	const { year, month, day } = parseDateText(dateText);
	return Date.UTC(year, month - 1, day);
}

/** The calendar date ('yyyy-mm-dd') of `now` in `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
	const { year, month, day } = localParts(now, timeZone);
	return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The wall-clock hour (0-23) of `now` in `timeZone`. */
export function localHour(now: Date, timeZone: string): number {
	return localParts(now, timeZone).hour;
}

/** The day of month (1-31) of `now` in `timeZone`. */
export function localDayOfMonth(now: Date, timeZone: string): number {
	return localParts(now, timeZone).day;
}

/** Brief header date, e.g. "Fri, 26 Sep 2026" ('EEE, dd MMM yyyy' in `timeZone`). */
export function briefDateLabel(now: Date, timeZone: string): string {
	const date = localDate(now, timeZone);
	const { year, month, day } = parseDateText(date);
	const weekday = new Date(dateTextToUtcMs(date)).getUTCDay();
	return `${WEEKDAY_SHORT[weekday]}, ${pad2(day)} ${MONTH_SHORT[month - 1]} ${year}`;
}

/** Adds `n` calendar days (may be negative) to a 'yyyy-mm-dd' date. */
export function addDays(dateText: string, n: number): string {
	return utcDateText(dateTextToUtcMs(dateText) + n * DAY_MS);
}

/** Whole calendar days from `from` to `to` (positive when `to` is later). */
export function diffDays(from: string, to: string): number {
	return Math.round((dateTextToUtcMs(to) - dateTextToUtcMs(from)) / DAY_MS);
}

/** Current instant as an ISO-8601 UTC string. */
export function isoNow(): string {
	return new Date().toISOString();
}
