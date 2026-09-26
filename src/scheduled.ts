/**
 * Hourly cron entry point ("0 * * * *", UTC — https://developers.cloudflare.com/workers/configuration/cron-triggers/)
 * — the PRODUCER of per-household work.
 *
 * The tick itself only reads D1 (active households + one bulk read of the gating settings) and
 * decides, per household and in THAT household's timezone, which tasks are due. Local-time gating
 * keeps it DST-safe: the cron never changes, only the local hour each tick maps to does.
 *   - sync every tick; full-sync instead on Sunday at 03:00 local.
 *   - brief at/after `brief_hour_local` while brief_last_sent_date ≠ today (local).
 *   - capture on the budget period's last day at/after `capture_hour_local` while
 *     capture_last_period_end ≠ that period end.
 * The tasks themselves run in src/tasks.ts: one `household-tasks` queue message per household when
 * the HOUSEHOLD_TASKS binding exists (Workers Paid), else inline, one household after another (Free
 * plan / local dev). The consumer re-checks the guards, so replays and re-deliveries stay idempotent.
 *
 * Housekeeping (run_log pruning) is global and runs here at 04:00 UTC.
 */
import { listHouseholds } from './db/households';
import { listSettingsRows, logRun, pruneRunLog } from './db/repo';
import { SETTING_DEFAULTS } from './db/settings';
import { GLOBAL_HID, tenant } from './db/tenant';
import type { Env } from './env';
import { normalizeStartDay, periodForOffset } from './lib/period';
import { dateTextToUtcMs, localDate, localHour } from './lib/tz';
import { describeError, effectiveTimezone, type HouseholdTask, type HouseholdTaskMessage, runHouseholdTasks, SCHEDULED_ACTION } from './tasks';

const ACTION = SCHEDULED_ACTION;
const FULL_SYNC_WEEKDAY = 0; // Sunday
const FULL_SYNC_HOUR = 3;
// UTC, not local: pruning is global now that households have different timezones (it used to run at
// 04:00 in the single household's timezone).
const PRUNE_HOUR_UTC = 4;
const RUN_LOG_KEEP_DAYS = 90;
/** Queue.sendBatch accepts at most 100 messages per call. */
const SEND_BATCH_MAX = 100;

/** The settings the producer gates on, read for every household in one query. */
export const GATING_KEYS = ['timezone', 'brief_hour_local', 'capture_hour_local', 'budget_month_start_day', 'brief_last_sent_date', 'capture_last_period_end'] as const;
export type GatingSettings = Record<(typeof GATING_KEYS)[number], string | undefined>;

/** An hour setting (0–23); falls back to its default when the stored value is not a valid hour. */
function hourSetting(settings: GatingSettings, key: 'brief_hour_local' | 'capture_hour_local'): number {
	const hour = Number(settings[key]);
	return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : Number(SETTING_DEFAULTS[key]);
}

/** Tasks due for one household at `now`, evaluated in its (valid) timezone. */
export function dueTasks(settings: GatingSettings, timezone: string, now: Date): HouseholdTask[] {
	const today = localDate(now, timezone);
	const hour = localHour(now, timezone);
	const full = new Date(dateTextToUtcMs(today)).getUTCDay() === FULL_SYNC_WEEKDAY && hour === FULL_SYNC_HOUR;
	const tasks: HouseholdTask[] = [full ? 'full-sync' : 'sync'];

	// `>=` (not `===`) lets a failed attempt retry on the next tick the same day, and covers DST days
	// where the hour is skipped.
	if (hour >= hourSetting(settings, 'brief_hour_local') && settings.brief_last_sent_date !== today) tasks.push('brief');

	const current = periodForOffset(today, normalizeStartDay(Number(settings.budget_month_start_day)), 0);
	if (today === current.endText && hour >= hourSetting(settings, 'capture_hour_local') && settings.capture_last_period_end !== current.endText) {
		tasks.push('capture');
	}
	return tasks;
}

async function planMessages(env: Env, now: Date): Promise<HouseholdTaskMessage[]> {
	const [households, rows] = await Promise.all([listHouseholds(env.DB), listSettingsRows(env.DB, GATING_KEYS)]);

	// SETTING_DEFAULTS ← global rows ← household rows (same merge as getSettings, for every household).
	const defaults: GatingSettings = Object.fromEntries(GATING_KEYS.map((key) => [key, (SETTING_DEFAULTS as Record<string, string>)[key]])) as GatingSettings;
	const global: Record<string, string> = {};
	const own = new Map<number, Record<string, string>>();
	for (const row of rows) {
		if (row.householdId === GLOBAL_HID) global[row.key] = row.value;
		else {
			const values = own.get(row.householdId) ?? {};
			values[row.key] = row.value;
			own.set(row.householdId, values);
		}
	}

	const scheduledFor = now.toISOString();
	const messages: HouseholdTaskMessage[] = [];
	for (const household of households) {
		if (household.status !== 'active') continue;
		const settings: GatingSettings = { ...defaults, ...global, ...own.get(household.id) };
		const timezone = effectiveTimezone(settings.timezone ?? SETTING_DEFAULTS.timezone, now);
		if (timezone !== settings.timezone) {
			await logRun(tenant(env.DB, household.id), 'WARN', ACTION, `Invalid timezone "${settings.timezone}" — scheduling in ${timezone}.`);
		}
		messages.push({ v: 1, householdId: household.id, tasks: dueTasks(settings, timezone, now), scheduledFor });
	}
	return messages;
}

const describeMessages = (messages: readonly HouseholdTaskMessage[]) => messages.map((m) => `hh${m.householdId}[${m.tasks.join(',')}]`).join(', ');

export async function runScheduled(env: Env, _ctx: ExecutionContext, now: Date = new Date()): Promise<void> {
	const db = env.DB;

	let messages: HouseholdTaskMessage[] = [];
	try {
		messages = await planMessages(env, now);
	} catch (error) {
		await logRun(db, 'ERROR', ACTION, `Tick at ${now.toISOString()}: could not plan household tasks: ${describeError(error)}`);
	}

	if (messages.length > 0) {
		const queue = env.HOUSEHOLD_TASKS;
		if (queue) {
			try {
				for (let i = 0; i < messages.length; i += SEND_BATCH_MAX) {
					await queue.sendBatch(messages.slice(i, i + SEND_BATCH_MAX).map((body) => ({ body, contentType: 'json' as const })));
				}
				await logRun(db, 'INFO', ACTION, `Enqueued ${messages.length} household task message(s): ${describeMessages(messages)}.`);
			} catch (error) {
				// Everything still due is re-planned on the next tick.
				await logRun(db, 'ERROR', ACTION, `Enqueueing household tasks failed, retrying next hour: ${describeError(error)}`);
			}
		} else {
			for (const message of messages) {
				try {
					await runHouseholdTasks(env, message.householdId, message.tasks, now);
				} catch (error) {
					await logRun(tenant(db, message.householdId), 'ERROR', ACTION, `Household tasks failed before running: ${describeError(error)}`);
				}
			}
			await logRun(db, 'INFO', ACTION, `Queue binding absent — ran ${messages.length} household(s) inline: ${describeMessages(messages)}.`);
		}
	}

	// Housekeeping.
	if (now.getUTCHours() === PRUNE_HOUR_UTC) {
		try {
			const pruned = await pruneRunLog(db, RUN_LOG_KEEP_DAYS);
			if (pruned > 0) await logRun(db, 'INFO', ACTION, `Pruned ${pruned} run_log row(s) older than ${RUN_LOG_KEEP_DAYS} days.`);
		} catch (error) {
			await logRun(db, 'ERROR', ACTION, `run_log pruning failed: ${describeError(error)}`);
		}
	}
}
