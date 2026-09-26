import { env } from 'cloudflare:workers';

const TABLES = [
	'categories',
	'accounts',
	'transactions',
	'budget_targets',
	'cashflow_balances',
	'fx_rates',
	'message_log',
	'run_log',
	'settings',
] as const;

/** Storage is isolated per test file, not per test — call in beforeEach for a clean database. */
export async function resetDb(): Promise<void> {
	await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
}
