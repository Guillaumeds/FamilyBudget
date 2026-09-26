/**
 * Hourly cron entry point ("0 * * * *", UTC). Local-time work (daily brief, cash-flow capture, weekly
 * full re-sync) is dispatched from here using the `timezone` setting, which keeps it DST-safe.
 *
 * TODO: wallet/sync.ts (+ lib/fx.ts refresh), budget/brief.ts + whatsapp/client.ts (daily brief),
 * cash-flow capture — plugged in by later phases. For now this only records the tick.
 */
import { logRun } from './db/repo';
import type { Env } from './env';

export async function runScheduled(env: Env, _ctx: ExecutionContext, now: Date = new Date()): Promise<void> {
	await logRun(env.DB, 'INFO', 'scheduled', `Hourly tick at ${now.toISOString()} (dispatcher not implemented yet).`);
}
