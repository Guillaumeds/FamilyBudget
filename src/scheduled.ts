/**
 * Hourly cron entry point ("0 * * * *", UTC — https://developers.cloudflare.com/workers/configuration/cron-triggers/).
 * Local-time work is dispatched here from the `timezone` setting, which keeps it DST-safe: the cron
 * never changes, only the local hour each tick maps to does.
 *
 * Steps run in order, each in its own try/catch so one failure never blocks the next:
 *   1. Wallet sync — incremental every hour, full re-sync on Sunday at 03:00 local.
 *   2. Daily brief — first tick at/after `brief_hour_local` each local day (guard: brief_last_sent_date).
 *   3. Cash-flow capture — on the period's last day at/after `capture_hour_local` (guard:
 *      capture_last_period_end), plus a retroactive capture of the previous period if it has no TOTAL row.
 *   4. Housekeeping — prune run_log at 04:00 local.
 * The guards make every step idempotent under cron retries/replays.
 */
import { captureClosingBalances } from './cashflow/capture';
import { listCashflowRows, listTransactionsBetween, logRun, pruneRunLog } from './db/repo';
import { getSettings, SETTING_DEFAULTS, setSetting, type Settings } from './db/settings';
import type { Env } from './env';
import { normalizeStartDay, periodForOffset } from './lib/period';
import { dateTextToUtcMs, localDate, localHour } from './lib/tz';
import { WalletApiError } from './wallet/client';
import { syncWallet } from './wallet/sync';
import { sendDailyBrief } from './whatsapp/client';

const ACTION = 'scheduled';
const FULL_SYNC_WEEKDAY = 0; // Sunday
const FULL_SYNC_HOUR = 3;
const PRUNE_HOUR = 4;
const RUN_LOG_KEEP_DAYS = 90;

/** An hour setting (0–23); falls back to its default when the stored value is not a valid hour. */
function hourSetting(settings: Settings, key: 'brief_hour_local' | 'capture_hour_local'): number {
	const hour = Number(settings[key]);
	return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : Number(SETTING_DEFAULTS[key]);
}

function describeError(error: unknown): string {
	if (error instanceof WalletApiError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

export async function runScheduled(env: Env, _ctx: ExecutionContext, now: Date = new Date()): Promise<void> {
	const db = env.DB;

	let settings: Settings;
	let today: string;
	let hour: number;
	try {
		settings = await getSettings(db);
		today = localDate(now, settings.timezone);
		hour = localHour(now, settings.timezone);
	} catch (error) {
		await logRun(db, 'ERROR', ACTION, `Tick at ${now.toISOString()} aborted: could not read settings/timezone: ${describeError(error)}`);
		return;
	}

	// 1. Wallet sync.
	const full = new Date(dateTextToUtcMs(today)).getUTCDay() === FULL_SYNC_WEEKDAY && hour === FULL_SYNC_HOUR;
	try {
		await syncWallet(env, db, full ? { full: true, now } : { now });
	} catch (error) {
		// Expected right after a Wallet token is created (BudgetBakers' initial sync); retried next hour.
		const inProgress = error instanceof WalletApiError && error.code === 'WALLET_SYNC_IN_PROGRESS';
		await logRun(db, inProgress ? 'WARN' : 'ERROR', ACTION, `${full ? 'Full' : 'Incremental'} Wallet sync failed: ${describeError(error)}`);
	}

	// 2. Daily brief — reads D1 only, so it runs even when the sync failed. `>=` (not `===`) lets a
	// failed attempt retry on the next tick the same day, and covers DST days where the hour is skipped.
	if (hour >= hourSetting(settings, 'brief_hour_local') && settings.brief_last_sent_date !== today) {
		try {
			const outcome = await sendDailyBrief(env, db, now);
			// Set the guard even on a skip (nothing to retry) or per-recipient failures (already logged by
			// the client; retrying would double-send to the recipients that succeeded). Only a thrown error
			// — the brief could not be built — leaves it unset for the next tick.
			await setSetting(db, 'brief_last_sent_date', today);
			const failed = outcome.results.filter((result) => result.error).length;
			const detail = outcome.skippedReason
				? `skipped (${outcome.skippedReason})`
				: outcome.results.map((result) => `${result.to}: ${result.mode}${result.error ? ' FAILED' : ''}`).join(', ');
			await logRun(db, failed ? 'WARN' : 'INFO', ACTION, `Daily brief for ${today}: ${detail}.`);
		} catch (error) {
			await logRun(db, 'ERROR', ACTION, `Daily brief for ${today} failed, retrying next hour: ${describeError(error)}`);
		}
	}

	// 3. Cash-flow capture of the period that ends today.
	const startDay = normalizeStartDay(Number(settings.budget_month_start_day));
	const current = periodForOffset(today, startDay, 0);
	if (today === current.endText && hour >= hourSetting(settings, 'capture_hour_local') && settings.capture_last_period_end !== current.endText) {
		try {
			await captureClosingBalances(db, settings, now);
			await setSetting(db, 'capture_last_period_end', current.endText);
		} catch (error) {
			await logRun(db, 'ERROR', ACTION, `Cash-flow capture for ${current.label} failed, retrying next hour: ${describeError(error)}`);
		}
	}

	// 3b. Catch-up: the previous period was never captured (Worker down on its last day, fresh install
	// with synced history). Balance − movements after the period end holds for past periods too.
	// Guarded by the TOTAL row the capture writes (an imported TOTAL counts as captured).
	const previous = periodForOffset(today, startDay, -1);
	try {
		const hasTotal = (await listCashflowRows(db, previous.endText)).some((row) => row.rowType === 'TOTAL');
		if (!hasTotal && (await listTransactionsBetween(db, previous.startText, previous.endExclusiveText)).length > 0) {
			await captureClosingBalances(db, settings, now, -1);
		}
	} catch (error) {
		await logRun(db, 'ERROR', ACTION, `Retroactive cash-flow capture for ${previous.label} failed: ${describeError(error)}`);
	}

	// 4. Housekeeping.
	if (hour === PRUNE_HOUR) {
		try {
			const pruned = await pruneRunLog(db, RUN_LOG_KEEP_DAYS);
			if (pruned > 0) await logRun(db, 'INFO', ACTION, `Pruned ${pruned} run_log row(s) older than ${RUN_LOG_KEEP_DAYS} days.`);
		} catch (error) {
			await logRun(db, 'ERROR', ACTION, `run_log pruning failed: ${describeError(error)}`);
		}
	}
}
