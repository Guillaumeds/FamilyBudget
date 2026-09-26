/**
 * Per-household scheduled work — the consumer side of the `household-tasks` queue
 * (https://developers.cloudflare.com/queues/configuration/javascript-apis/#consumer).
 *
 * The hourly cron (src/scheduled.ts) decides, per household and in that household's timezone, which
 * tasks are due and enqueues one message per household. This module runs them. Without a queue
 * binding (Workers Free plan, local dev) the producer calls `runHouseholdTasks` inline instead.
 *
 * Tasks run in order, each in its own try/catch (logged to the household's run_log) so one failure
 * never blocks the next:
 *   1. sync | full-sync — Wallet sync (incremental / full re-sync).
 *   2. brief — daily brief (guard: brief_last_sent_date).
 *   3. capture — cash-flow capture of the period ending today (guard: capture_last_period_end).
 *   4. after a sync: retroactive capture of the previous period when it has no TOTAL row.
 * Task errors are logged, never thrown: the message is acked and the next hourly tick re-enqueues
 * anything still due (the same cadence as the single-household cron). The guards are re-checked here
 * against fresh settings, so an at-least-once re-delivery of the same message is a no-op for the brief
 * and the capture. Only failures BEFORE any task runs (loading the household or its settings) throw,
 * which makes the queue retry the message and finally dead-letter it.
 */
import { captureClosingBalances } from './cashflow/capture';
import { getHousehold } from './db/households';
import { listCashflowRows, listTransactionsBetween, logRun } from './db/repo';
import { getSettings, SETTING_DEFAULTS, setSetting, type Settings } from './db/settings';
import { tenant } from './db/tenant';
import type { Env } from './env';
import { normalizeStartDay, periodForOffset } from './lib/period';
import { localDate } from './lib/tz';
import { WalletApiError } from './wallet/client';
import { syncWallet } from './wallet/sync';
import { sendDailyBrief } from './whatsapp/client';

/** run_log action of the cron dispatcher and its tasks (the dashboard's "last scheduled run"). */
export const SCHEDULED_ACTION = 'scheduled';
export const TASKS_QUEUE = 'household-tasks';
export const TASKS_DLQ = 'household-tasks-dlq';

export type HouseholdTask = 'sync' | 'full-sync' | 'brief' | 'capture';
const TASK_NAMES: readonly HouseholdTask[] = ['sync', 'full-sync', 'brief', 'capture'];

/** Body of one `household-tasks` message (JSON). */
export interface HouseholdTaskMessage {
	v: 1;
	householdId: number;
	tasks: HouseholdTask[];
	/** ISO instant of the cron tick that produced the message; the tasks run "as of" this time. */
	scheduledFor: string;
}

export function describeError(error: unknown): string {
	if (error instanceof WalletApiError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}

/** `timeZone` when the runtime knows it, else the default timezone. */
export function effectiveTimezone(timeZone: string, now: Date): string {
	try {
		localDate(now, timeZone);
		return timeZone;
	} catch {
		return SETTING_DEFAULTS.timezone;
	}
}

/** The message body when it is a valid v1 HouseholdTaskMessage, else null. */
export function parseTaskMessage(body: unknown): HouseholdTaskMessage | null {
	if (typeof body !== 'object' || body === null) return null;
	const { v, householdId, tasks, scheduledFor } = body as Record<string, unknown>;
	if (v !== 1) return null;
	if (typeof householdId !== 'number' || !Number.isInteger(householdId) || householdId <= 0) return null;
	if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every((task) => TASK_NAMES.includes(task as HouseholdTask))) return null;
	if (typeof scheduledFor !== 'string' || Number.isNaN(Date.parse(scheduledFor))) return null;
	return { v, householdId, tasks: [...new Set(tasks as HouseholdTask[])], scheduledFor };
}

/** Runs `tasks` for household `hid` as of `now`. Task errors are logged, never thrown (see file header). */
export async function runHouseholdTasks(env: Env, hid: number, tasks: readonly HouseholdTask[], now: Date): Promise<void> {
	const household = await getHousehold(env.DB, hid);
	if (!household) {
		await logRun(env.DB, 'WARN', SCHEDULED_ACTION, `Household ${hid} not found — tasks [${tasks.join(', ')}] skipped.`);
		return;
	}
	const t = tenant(env.DB, hid);
	if (household.status !== 'active') {
		await logRun(t, 'WARN', SCHEDULED_ACTION, `Household is ${household.status} — tasks [${tasks.join(', ')}] skipped.`);
		return;
	}

	const stored = await getSettings(t);
	const timezone = effectiveTimezone(stored.timezone, now);
	const settings: Settings = timezone === stored.timezone ? stored : { ...stored, timezone };
	const today = localDate(now, timezone);
	const startDay = normalizeStartDay(Number(settings.budget_month_start_day));

	// 1. Wallet sync.
	const full = tasks.includes('full-sync');
	const synced = full || tasks.includes('sync');
	if (synced) {
		try {
			await syncWallet(env, t, full ? { full: true, now } : { now });
		} catch (error) {
			const kind = `${full ? 'Full' : 'Incremental'} Wallet sync failed`;
			if (error instanceof WalletApiError && error.code === 'WALLET_SYNC_IN_PROGRESS') {
				// Expected right after a Wallet token is created (BudgetBakers' initial sync); retried next hour.
				await logRun(t, 'WARN', SCHEDULED_ACTION, `${kind}: ${describeError(error)}`);
			} else if (error instanceof WalletApiError && error.code === 'WALLET_AUTH') {
				// Expected for a new household that has not pasted its Wallet token yet.
				await logRun(t, 'WARN', SCHEDULED_ACTION, `${kind} (no token yet / auth failed): ${describeError(error)}`);
			} else {
				await logRun(t, 'ERROR', SCHEDULED_ACTION, `${kind}: ${describeError(error)}`);
			}
		}
	}

	// 2. Daily brief — reads D1 only, so it runs even when the sync failed. The producer only enqueues
	// it at/after brief_hour_local; the guard is re-checked here so a re-delivered message is a no-op.
	if (tasks.includes('brief') && settings.brief_last_sent_date !== today) {
		try {
			const outcome = await sendDailyBrief(env, t, now);
			const failed = outcome.results.filter((result) => result.error).length;
			// Set the guard on a skip (nothing to retry) or on any successful send (retrying would
			// double-send to the recipients that succeeded). When EVERY recipient failed nobody got the
			// brief, so the guard stays unset and the next tick retries — as it does when building the
			// brief threw.
			const allFailed = outcome.results.length > 0 && failed === outcome.results.length;
			if (!allFailed) await setSetting(t, 'brief_last_sent_date', today);
			const detail = outcome.skippedReason
				? `skipped (${outcome.skippedReason})`
				: outcome.results.map((result) => `${result.to}: ${result.mode}${result.error ? ' FAILED' : ''}`).join(', ');
			await logRun(t, failed ? 'WARN' : 'INFO', SCHEDULED_ACTION, `Daily brief for ${today}: ${detail}${allFailed ? ' — all sends failed, retrying next hour' : ''}.`);
		} catch (error) {
			await logRun(t, 'ERROR', SCHEDULED_ACTION, `Daily brief for ${today} failed, retrying next hour: ${describeError(error)}`);
		}
	}

	// 3. Cash-flow capture of the period that ends today (guard re-checked for re-deliveries).
	const current = periodForOffset(today, startDay, 0);
	if (tasks.includes('capture') && settings.capture_last_period_end !== current.endText) {
		try {
			await captureClosingBalances(t, settings, now);
			await setSetting(t, 'capture_last_period_end', current.endText);
		} catch (error) {
			await logRun(t, 'ERROR', SCHEDULED_ACTION, `Cash-flow capture for ${current.label} failed, retrying next hour: ${describeError(error)}`);
		}
	}

	// 3b. Catch-up after a sync: the previous period was never captured (Worker down on its last day,
	// fresh household with synced history). Balance − movements after the period end holds for past
	// periods too. Guarded by the TOTAL row the capture writes (an imported TOTAL counts as captured).
	if (synced) {
		const previous = periodForOffset(today, startDay, -1);
		try {
			const hasTotal = (await listCashflowRows(t, previous.endText)).some((row) => row.rowType === 'TOTAL');
			if (!hasTotal && (await listTransactionsBetween(t, previous.startText, previous.endExclusiveText)).length > 0) {
				await captureClosingBalances(t, settings, now, -1);
			}
		} catch (error) {
			await logRun(t, 'ERROR', SCHEDULED_ACTION, `Retroactive cash-flow capture for ${previous.label} failed: ${describeError(error)}`);
		}
	}
}

/** Queue consumer (src/index.ts `queue`): the task queue and its dead-letter queue. */
export async function queueHandler(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
	if (batch.queue === TASKS_DLQ) {
		const summary = batch.messages
			.map((message) => {
				const body = parseTaskMessage(message.body);
				return body ? `hh${body.householdId}[${body.tasks.join(',')}]@${body.scheduledFor}` : `malformed(${message.id})`;
			})
			.join(', ');
		await logRun(env.DB, 'ERROR', SCHEDULED_ACTION, `${batch.messages.length} household task message(s) dead-lettered after retries: ${summary}`);
		batch.ackAll();
		return;
	}

	// Sequential: a batch is at most a few households, and each run already issues many D1 queries.
	for (const message of batch.messages) {
		const body = parseTaskMessage(message.body);
		if (!body) {
			await logRun(env.DB, 'ERROR', SCHEDULED_ACTION, `Malformed household task message ${message.id} dropped: ${JSON.stringify(message.body)?.slice(0, 200)}`);
			message.ack();
			continue;
		}
		try {
			await runHouseholdTasks(env, body.householdId, body.tasks, new Date(body.scheduledFor));
			message.ack();
		} catch (error) {
			// Could not even load the household/settings (e.g. D1 unavailable): let the queue retry,
			// then dead-letter it.
			await logRun(env.DB, 'ERROR', SCHEDULED_ACTION, `Household ${body.householdId} tasks failed before running (attempt ${message.attempts}), retrying: ${describeError(error)}`);
			message.retry();
		}
	}
}
