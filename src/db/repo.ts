/**
 * Typed D1 access. Rows are camelCase objects mapped 1:1 onto the snake_case columns of
 * migrations/0001_init.sql.
 *
 * Bulk writes use one `INSERT ... SELECT ... FROM json_each(?)` statement per chunk of rows (one
 * bound JSON parameter) instead of one statement per row: D1 counts every statement — including
 * each one inside `db.batch()` — against the per-invocation query limit (50 on the Workers Free
 * plan), so a per-row upsert of a few hundred records would fail there.
 */
import { addDays, isoNow } from '../lib/tz';

export type Flag = 0 | 1;
type SqlValue = string | number | null;

/** Rows per json_each statement — keeps each JSON payload small (D1 statement/param limits). */
const ROWS_PER_STATEMENT = 100;
/** Ids per `DELETE ... IN (json_each(?))` statement. */
const IDS_PER_STATEMENT = 500;
/** Statements per db.batch() call. */
const STATEMENTS_PER_BATCH = 50;

// ---------------------------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------------------------

export interface CategoryRow {
	id: string;
	parentId: string | null;
	name: string;
	groupId: string | null;
	groupName: string | null;
	fullPath: string | null;
	level: number;
	archived: Flag;
	updatedAt: string;
}

export interface AccountRow {
	id: string;
	name: string;
	accountType: string | null;
	currency: string | null;
	balance: number | null;
	excludeFromStats: Flag;
	/** User-controlled: used on first insert only, never overwritten by upsertAccounts. */
	includeInCashflow: Flag;
	archived: Flag;
	updatedAt: string;
}

export interface TransactionRow {
	id: string;
	/** ISO instant as returned by Wallet. */
	recordDate: string;
	/** Local calendar day 'yyyy-mm-dd' (settings.timezone). */
	date: string;
	accountId: string | null;
	accountName: string | null;
	categoryId: string | null;
	/** 'expense' | 'income' as returned by Wallet. */
	recordType: string | null;
	paymentType: string | null;
	recordState: string | null;
	/** Signed native amount (expenses negative). */
	amount: number;
	currency: string;
	/** Signed amount in base currency; null when no FX rate was available. */
	amountBase: number | null;
	note: string | null;
	syncedAt: string;
}

export type EntityType = 'category' | 'group';
export type ForecastType = 'day_to_day' | 'recurring';

export interface BudgetTargetRow {
	entityType: EntityType;
	entityId: string;
	period: string;
	forecastType: ForecastType;
	/** Budget in base currency; null = no target set. */
	budget: number | null;
	includeInReport: Flag;
	includeInExpense: Flag;
}

export interface CashflowRow {
	periodStart: string;
	/** Inclusive last day of the budget period. */
	periodEnd: string;
	rowType: 'TOTAL' | 'ACCOUNT';
	accountKey: string;
	accountName: string | null;
	currency: string | null;
	closingBalance: number;
	closingBalanceBase: number | null;
	capturedAt: string;
	source: 'auto' | 'import';
	notes: string | null;
}

export interface FxRateRow {
	date: string;
	currency: string;
	/** Base-currency units per 1 unit of `currency`. */
	rateToBase: number;
	fetchedAt: string;
}

export type MessageDirection = 'in' | 'out';

export interface MessageLogRow {
	id: number;
	waMessageId: string | null;
	direction: MessageDirection;
	/** Masked number (see maskPhone) — never store the full number. */
	fromNumber: string | null;
	inboundTs: string | null;
	body: string | null;
	/** e.g. PROCESSING | COMPLETED | FAILED | STALE_IGNORED. */
	status: string;
	errorCode: string | null;
	errorMessage: string | null;
	outboundMessageId: string | null;
	outboundAt: string | null;
	createdAt: string;
}

export type MessageLogInsert = Pick<MessageLogRow, 'direction' | 'status'> &
	Partial<Omit<MessageLogRow, 'id' | 'direction' | 'status' | 'createdAt'>>;
export type MessageLogPatch = Partial<Omit<MessageLogRow, 'id' | 'waMessageId' | 'createdAt'>>;

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface RunLogRow {
	id: number;
	ts: string;
	level: string;
	action: string;
	message: string;
}

// ---------------------------------------------------------------------------------------------
// Column maps: [snake_case column, camelCase property]
// ---------------------------------------------------------------------------------------------

type FieldMap<T> = ReadonlyArray<readonly [column: string, property: keyof T & string]>;

const CATEGORY_FIELDS: FieldMap<CategoryRow> = [
	['id', 'id'],
	['parent_id', 'parentId'],
	['name', 'name'],
	['group_id', 'groupId'],
	['group_name', 'groupName'],
	['full_path', 'fullPath'],
	['level', 'level'],
	['archived', 'archived'],
	['updated_at', 'updatedAt'],
];

const ACCOUNT_FIELDS: FieldMap<AccountRow> = [
	['id', 'id'],
	['name', 'name'],
	['account_type', 'accountType'],
	['currency', 'currency'],
	['balance', 'balance'],
	['exclude_from_stats', 'excludeFromStats'],
	['include_in_cashflow', 'includeInCashflow'],
	['archived', 'archived'],
	['updated_at', 'updatedAt'],
];

const TRANSACTION_FIELDS: FieldMap<TransactionRow> = [
	['id', 'id'],
	['record_date', 'recordDate'],
	['date', 'date'],
	['account_id', 'accountId'],
	['account_name', 'accountName'],
	['category_id', 'categoryId'],
	['record_type', 'recordType'],
	['payment_type', 'paymentType'],
	['record_state', 'recordState'],
	['amount', 'amount'],
	['currency', 'currency'],
	['amount_base', 'amountBase'],
	['note', 'note'],
	['synced_at', 'syncedAt'],
];

const TARGET_FIELDS: FieldMap<BudgetTargetRow> = [
	['entity_type', 'entityType'],
	['entity_id', 'entityId'],
	['period', 'period'],
	['forecast_type', 'forecastType'],
	['budget', 'budget'],
	['include_in_report', 'includeInReport'],
	['include_in_expense', 'includeInExpense'],
];

const CASHFLOW_FIELDS: FieldMap<CashflowRow> = [
	['period_start', 'periodStart'],
	['period_end', 'periodEnd'],
	['row_type', 'rowType'],
	['account_key', 'accountKey'],
	['account_name', 'accountName'],
	['currency', 'currency'],
	['closing_balance', 'closingBalance'],
	['closing_balance_base', 'closingBalanceBase'],
	['captured_at', 'capturedAt'],
	['source', 'source'],
	['notes', 'notes'],
];

const FX_FIELDS: FieldMap<FxRateRow> = [
	['date', 'date'],
	['currency', 'currency'],
	['rate_to_base', 'rateToBase'],
	['fetched_at', 'fetchedAt'],
];

const MESSAGE_LOG_FIELDS: FieldMap<MessageLogRow> = [
	['id', 'id'],
	['wa_message_id', 'waMessageId'],
	['direction', 'direction'],
	['from_number', 'fromNumber'],
	['inbound_ts', 'inboundTs'],
	['body', 'body'],
	['status', 'status'],
	['error_code', 'errorCode'],
	['error_message', 'errorMessage'],
	['outbound_message_id', 'outboundMessageId'],
	['outbound_at', 'outboundAt'],
	['created_at', 'createdAt'],
];

const RUN_LOG_FIELDS: FieldMap<RunLogRow> = [
	['id', 'id'],
	['ts', 'ts'],
	['level', 'level'],
	['action', 'action'],
	['message', 'message'],
];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** "col AS prop, ..." so D1 returns camelCase objects directly. */
function selectList<T>(fields: FieldMap<T>): string {
	return fields.map(([column, property]) => (column === property ? column : `${column} AS ${property}`)).join(', ');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
	return chunks;
}

async function runBatched(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
	for (const group of chunk(statements, STATEMENTS_PER_BATCH)) await db.batch(group);
}

/**
 * Upserts `rows` with one INSERT ... SELECT FROM json_each(?) statement per ROWS_PER_STATEMENT rows.
 * Columns in `preserve` are written on insert but left untouched on conflict.
 */
async function bulkUpsert<T>(
	db: D1Database,
	table: string,
	fields: FieldMap<T>,
	conflictColumns: readonly string[],
	rows: readonly T[],
	preserve: readonly string[] = [],
): Promise<void> {
	if (rows.length === 0) return;
	const columns = fields.map(([column]) => column);
	const extract = columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ');
	const updates = columns
		.filter((column) => !conflictColumns.includes(column) && !preserve.includes(column))
		.map((column) => `${column} = excluded.${column}`)
		.join(', ');
	// `WHERE true` disambiguates INSERT ... SELECT from the ON CONFLICT clause (SQLite parser rule).
	const sql =
		`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${extract} FROM json_each(?) WHERE true ` +
		`ON CONFLICT (${conflictColumns.join(', ')}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`;
	const statement = db.prepare(sql);
	const statements = chunk(rows, ROWS_PER_STATEMENT).map((part) =>
		statement.bind(JSON.stringify(part.map((row) => fields.map(([, property]): SqlValue => (row[property] ?? null) as SqlValue)))),
	);
	await runBatched(db, statements);
}

// ---------------------------------------------------------------------------------------------
// Categories & accounts
// ---------------------------------------------------------------------------------------------

export async function upsertCategories(db: D1Database, rows: readonly CategoryRow[]): Promise<void> {
	await bulkUpsert(db, 'categories', CATEGORY_FIELDS, ['id'], rows);
}

export async function listCategories(db: D1Database): Promise<CategoryRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(CATEGORY_FIELDS)} FROM categories ORDER BY group_name, name`)
		.all<CategoryRow>();
	return results;
}

/** Upserts accounts; `include_in_cashflow` is only set on insert so user choices survive syncs. */
export async function upsertAccounts(db: D1Database, rows: readonly AccountRow[]): Promise<void> {
	await bulkUpsert(db, 'accounts', ACCOUNT_FIELDS, ['id'], rows, ['include_in_cashflow']);
}

export async function listAccounts(db: D1Database): Promise<AccountRow[]> {
	const { results } = await db.prepare(`SELECT ${selectList(ACCOUNT_FIELDS)} FROM accounts ORDER BY name`).all<AccountRow>();
	return results;
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

export async function upsertTransactions(db: D1Database, rows: readonly TransactionRow[]): Promise<void> {
	await bulkUpsert(db, 'transactions', TRANSACTION_FIELDS, ['id'], rows);
}

/**
 * Deletes local transactions dated on/after `startDate` (local 'yyyy-mm-dd') whose id is not in
 * `keepIds` — i.e. records edited away or deleted in Wallet. Returns the number deleted.
 *
 * `keepIds` must be the complete set of Wallet record ids for that window. `date` is the *local*
 * day while Wallet filters on the record instant, so fetch from at least one day before
 * `startDate` to avoid deleting records near the window edge in time zones ahead of UTC.
 */
export async function deleteTransactionsNotIn(db: D1Database, startDate: string, keepIds: Iterable<string>): Promise<number> {
	const keep = keepIds instanceof Set ? (keepIds as Set<string>) : new Set(keepIds);
	const { results } = await db.prepare('SELECT id FROM transactions WHERE date >= ?').bind(startDate).all<{ id: string }>();
	const staleIds = results.map((row) => row.id).filter((id) => !keep.has(id));
	if (staleIds.length === 0) return 0;
	const statement = db.prepare('DELETE FROM transactions WHERE id IN (SELECT value FROM json_each(?))');
	await runBatched(
		db,
		chunk(staleIds, IDS_PER_STATEMENT).map((ids) => statement.bind(JSON.stringify(ids))),
	);
	return staleIds.length;
}

/** Transactions with startInclusive <= date < endExclusive (local dates), oldest first. */
export async function listTransactionsBetween(
	db: D1Database,
	startInclusive: string,
	endExclusive: string,
): Promise<TransactionRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(TRANSACTION_FIELDS)} FROM transactions WHERE date >= ? AND date < ? ORDER BY date, record_date, id`)
		.bind(startInclusive, endExclusive)
		.all<TransactionRow>();
	return results;
}

export async function listTransactionsOnDate(db: D1Database, date: string): Promise<TransactionRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(TRANSACTION_FIELDS)} FROM transactions WHERE date = ? ORDER BY record_date, id`)
		.bind(date)
		.all<TransactionRow>();
	return results;
}

// ---------------------------------------------------------------------------------------------
// Budget targets
// ---------------------------------------------------------------------------------------------

export async function listTargets(db: D1Database): Promise<BudgetTargetRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(TARGET_FIELDS)} FROM budget_targets ORDER BY entity_type, entity_id`)
		.all<BudgetTargetRow>();
	return results;
}

export async function upsertTarget(db: D1Database, row: BudgetTargetRow): Promise<void> {
	await bulkUpsert(db, 'budget_targets', TARGET_FIELDS, ['entity_type', 'entity_id'], [row]);
}

/** Income, transfers and BudgetBakers "System categories" are excluded from expense totals by default. */
function defaultIncludeInExpense(groupName: string | null | undefined): Flag {
	return /income|transfer|system/i.test(groupName ?? '') ? 0 : 1;
}

/**
 * Inserts a default target row for every category and every distinct category group that has none
 * yet (INSERT OR IGNORE — existing, user-edited rows are never touched). Defaults: period 'monthly',
 * forecast 'day_to_day', no budget, not in report, included in expenses unless the group name
 * contains "income", "transfer" or "system". Returns the number of rows inserted.
 */
export async function ensureDefaultTargets(
	db: D1Database,
	categories: ReadonlyArray<Pick<CategoryRow, 'id' | 'groupId' | 'groupName'>>,
): Promise<number> {
	const defaults: [EntityType, string, Flag][] = categories.map((c) => ['category', c.id, defaultIncludeInExpense(c.groupName)]);
	const groups = new Map<string, string | null>();
	for (const c of categories) if (c.groupId && !groups.has(c.groupId)) groups.set(c.groupId, c.groupName);
	for (const [groupId, groupName] of groups) defaults.push(['group', groupId, defaultIncludeInExpense(groupName)]);
	if (defaults.length === 0) return 0;

	const statement = db.prepare(
		`INSERT OR IGNORE INTO budget_targets (entity_type, entity_id, period, forecast_type, budget, include_in_report, include_in_expense)
		 SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), 'monthly', 'day_to_day', NULL, 0, json_extract(value, '$[2]')
		 FROM json_each(?)`,
	);
	let inserted = 0;
	for (const group of chunk(chunk(defaults, ROWS_PER_STATEMENT), STATEMENTS_PER_BATCH)) {
		const results = await db.batch(group.map((part) => statement.bind(JSON.stringify(part))));
		for (const result of results) inserted += result.meta.changes;
	}
	return inserted;
}

// ---------------------------------------------------------------------------------------------
// Cash-flow balances
// ---------------------------------------------------------------------------------------------

/** Latest TOTAL rows, newest period first. */
export async function listCashflowTotals(db: D1Database, limit: number): Promise<CashflowRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(CASHFLOW_FIELDS)} FROM cashflow_balances WHERE row_type = 'TOTAL' ORDER BY period_end DESC LIMIT ?`)
		.bind(limit)
		.all<CashflowRow>();
	return results;
}

/** All rows (optionally for one period), newest period first, TOTAL before ACCOUNT rows. */
export async function listCashflowRows(db: D1Database, periodEnd?: string): Promise<CashflowRow[]> {
	const where = periodEnd ? 'WHERE period_end = ?' : '';
	const statement = db.prepare(
		`SELECT ${selectList(CASHFLOW_FIELDS)} FROM cashflow_balances ${where} ORDER BY period_end DESC, row_type DESC, account_name, account_key`,
	);
	const { results } = await (periodEnd ? statement.bind(periodEnd) : statement).all<CashflowRow>();
	return results;
}

export async function upsertCashflowRows(db: D1Database, rows: readonly CashflowRow[]): Promise<void> {
	await bulkUpsert(db, 'cashflow_balances', CASHFLOW_FIELDS, ['period_end', 'row_type', 'account_key'], rows);
}

// ---------------------------------------------------------------------------------------------
// FX rates
// ---------------------------------------------------------------------------------------------

/**
 * The most recent stored rate for `currency` on or before `date` (rates are missing on days a
 * provider does not publish), looking back at most `maxLookbackDays`. Null when none is found.
 */
export async function getFxRateOnOrBefore(
	db: D1Database,
	date: string,
	currency: string,
	maxLookbackDays = 14,
): Promise<number | null> {
	return db
		.prepare('SELECT rate_to_base FROM fx_rates WHERE currency = ? AND date <= ? AND date >= ? ORDER BY date DESC LIMIT 1')
		.bind(currency.toUpperCase(), date, addDays(date, -maxLookbackDays))
		.first<number>('rate_to_base');
}

export async function upsertFxRates(
	db: D1Database,
	rows: ReadonlyArray<Omit<FxRateRow, 'fetchedAt'> & { fetchedAt?: string }>,
): Promise<void> {
	const fetchedAt = isoNow();
	await bulkUpsert(
		db,
		'fx_rates',
		FX_FIELDS,
		['date', 'currency'],
		rows.map((row) => ({ ...row, currency: row.currency.toUpperCase(), fetchedAt: row.fetchedAt ?? fetchedAt })),
	);
}

/** Earliest and latest stored rate date per currency (currencies without rates are absent). */
export async function getFxCoverage(
	db: D1Database,
	currencies: readonly string[],
): Promise<Map<string, { minDate: string; maxDate: string }>> {
	const coverage = new Map<string, { minDate: string; maxDate: string }>();
	if (currencies.length === 0) return coverage;
	const { results } = await db
		.prepare(
			'SELECT currency, MIN(date) AS minDate, MAX(date) AS maxDate FROM fx_rates WHERE currency IN (SELECT value FROM json_each(?)) GROUP BY currency',
		)
		.bind(JSON.stringify(currencies.map((c) => c.toUpperCase())))
		.all<{ currency: string; minDate: string; maxDate: string }>();
	for (const row of results) coverage.set(row.currency, { minDate: row.minDate, maxDate: row.maxDate });
	return coverage;
}

/** Drops all cached rates — required after changing the base_currency setting. */
export async function clearFxRates(db: D1Database): Promise<void> {
	await db.prepare('DELETE FROM fx_rates').run();
}

// ---------------------------------------------------------------------------------------------
// WhatsApp message log
// ---------------------------------------------------------------------------------------------

/**
 * Inserts a message log row. With a `waMessageId` this doubles as inbound de-duplication:
 * returns false (and writes nothing) when that id was already logged.
 */
export async function insertMessageLog(db: D1Database, row: MessageLogInsert): Promise<boolean> {
	const values: Partial<MessageLogRow> = row;
	const fields = MESSAGE_LOG_FIELDS.filter(([, property]) => property !== 'id' && property !== 'createdAt' && values[property] !== undefined);
	const result = await db
		.prepare(
			`INSERT OR IGNORE INTO message_log (${fields.map(([column]) => column).join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
		)
		.bind(...fields.map(([, property]) => values[property] ?? null))
		.run();
	return result.meta.changes > 0;
}

/** Applies `patch` to the row with `waMessageId`. Returns false when no such row exists. */
export async function updateMessageLogByWaId(db: D1Database, waMessageId: string, patch: MessageLogPatch): Promise<boolean> {
	const values: Partial<MessageLogRow> = patch;
	const fields = MESSAGE_LOG_FIELDS.filter(
		([, property]) => property !== 'id' && property !== 'waMessageId' && property !== 'createdAt' && values[property] !== undefined,
	);
	if (fields.length === 0) return (await getMessageLogByWaId(db, waMessageId)) !== null;
	const result = await db
		.prepare(`UPDATE message_log SET ${fields.map(([column]) => `${column} = ?`).join(', ')} WHERE wa_message_id = ?`)
		.bind(...fields.map(([, property]) => values[property] ?? null), waMessageId)
		.run();
	return result.meta.changes > 0;
}

export async function getMessageLogByWaId(db: D1Database, waMessageId: string): Promise<MessageLogRow | null> {
	return db
		.prepare(`SELECT ${selectList(MESSAGE_LOG_FIELDS)} FROM message_log WHERE wa_message_id = ?`)
		.bind(waMessageId)
		.first<MessageLogRow>();
}

/** Newest first. */
export async function listMessageLog(db: D1Database, limit: number): Promise<MessageLogRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(MESSAGE_LOG_FIELDS)} FROM message_log ORDER BY id DESC LIMIT ?`)
		.bind(limit)
		.all<MessageLogRow>();
	return results;
}

// ---------------------------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------------------------

/** Appends to run_log and mirrors to the console (Workers Logs). Never throws. */
export async function logRun(db: D1Database, level: LogLevel, action: string, message: string): Promise<void> {
	const line = `[${level}] ${action}: ${message}`;
	if (level === 'ERROR') console.error(line);
	else if (level === 'WARN') console.warn(line);
	else console.log(line);
	try {
		await db.prepare('INSERT INTO run_log (ts, level, action, message) VALUES (?, ?, ?, ?)').bind(isoNow(), level, action, message).run();
	} catch (error) {
		console.error(`run_log insert failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Newest first. */
export async function listRunLog(db: D1Database, limit: number): Promise<RunLogRow[]> {
	const { results } = await db
		.prepare(`SELECT ${selectList(RUN_LOG_FIELDS)} FROM run_log ORDER BY id DESC LIMIT ?`)
		.bind(limit)
		.all<RunLogRow>();
	return results;
}

/** Deletes run_log rows older than `keepDays`. Returns the number deleted. */
export async function pruneRunLog(db: D1Database, keepDays = 90): Promise<number> {
	const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
	const result = await db.prepare('DELETE FROM run_log WHERE ts < ?').bind(cutoff).run();
	return result.meta.changes;
}

// ---------------------------------------------------------------------------------------------
// Appended for budget/engine.ts and cashflow/capture.ts
// ---------------------------------------------------------------------------------------------

/** Re-exported so the budget engine applies the same default flag as ensureDefaultTargets. */
export { defaultIncludeInExpense };

/**
 * Deletes the cash-flow rows of one period written by `source` (e.g. the previous 'auto' capture
 * before re-capturing, so accounts no longer included disappear). Returns the number deleted.
 */
export async function deleteCashflowRows(db: D1Database, periodEnd: string, source: CashflowRow['source']): Promise<number> {
	const result = await db.prepare('DELETE FROM cashflow_balances WHERE period_end = ? AND source = ?').bind(periodEnd, source).run();
	return result.meta.changes;
}

// ---------------------------------------------------------------------------------------------
// Appended for api/routes.ts (dashboard)
// ---------------------------------------------------------------------------------------------

export async function getTarget(db: D1Database, entityType: EntityType, entityId: string): Promise<BudgetTargetRow | null> {
	return db
		.prepare(`SELECT ${selectList(TARGET_FIELDS)} FROM budget_targets WHERE entity_type = ? AND entity_id = ?`)
		.bind(entityType, entityId)
		.first<BudgetTargetRow>();
}

/** Bulk variant of upsertTarget (one statement per 100 rows) — used by the CSV importer. */
export async function upsertTargets(db: D1Database, rows: readonly BudgetTargetRow[]): Promise<void> {
	await bulkUpsert(db, 'budget_targets', TARGET_FIELDS, ['entity_type', 'entity_id'], rows);
}

export interface CoreCounts {
	transactions: number;
	categories: number;
	accounts: number;
	/** Transactions whose amount_base is NULL (no FX rate yet). */
	missingFx: number;
}

/** Row counts for the dashboard status page, in one query. */
export async function countCoreRows(db: D1Database): Promise<CoreCounts> {
	const row = await db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM transactions) AS transactions, (SELECT COUNT(*) FROM categories) AS categories,
			        (SELECT COUNT(*) FROM accounts) AS accounts, (SELECT COUNT(*) FROM transactions WHERE amount_base IS NULL) AS missingFx`,
		)
		.first<CoreCounts>();
	return row ?? { transactions: 0, categories: 0, accounts: 0, missingFx: 0 };
}

/** The newest run_log row for each of `actions` (actions without rows are absent), in one query. */
export async function latestRunLogByAction(db: D1Database, actions: readonly string[]): Promise<Map<string, RunLogRow>> {
	const latest = new Map<string, RunLogRow>();
	if (actions.length === 0) return latest;
	const { results } = await db
		.prepare(
			`SELECT ${selectList(RUN_LOG_FIELDS)} FROM run_log WHERE id IN
			 (SELECT MAX(id) FROM run_log WHERE action IN (SELECT value FROM json_each(?)) GROUP BY action)`,
		)
		.bind(JSON.stringify(actions))
		.all<RunLogRow>();
	for (const row of results) latest.set(row.action, row);
	return latest;
}

/** Distinct upper-cased currencies used by transactions and accounts. */
export async function listDistinctCurrencies(db: D1Database): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT upper(currency) AS currency FROM transactions WHERE currency IS NOT NULL AND currency <> ''
			 UNION SELECT DISTINCT upper(currency) FROM accounts WHERE currency IS NOT NULL AND currency <> '' ORDER BY 1`,
		)
		.all<{ currency: string }>();
	return results.map((row) => row.currency);
}

/**
 * Recomputes `amount_base` in SQL for transactions whose amount_base IS NULL (or for every
 * transaction when `all`), with exactly the semantics of lib/fx.ts convertToBase +
 * getFxRateOnOrBefore: identity for the base currency, else amount × the latest rate on or before
 * the transaction date within `maxLookbackDays`, else NULL. A single UPDATE instead of one
 * convertToBase query per (currency, date) keeps a multi-year backfill within D1's per-invocation
 * query limit. Returns rows written and rows still without a rate afterwards.
 */
export async function reconvertTransactionsToBase(
	db: D1Database,
	baseCurrency: string,
	opts: { all?: boolean; maxLookbackDays?: number } = {},
): Promise<{ updated: number; stillMissing: number }> {
	const lookback = `-${Math.max(0, Math.trunc(opts.maxLookbackDays ?? 14))} days`;
	const [update, missing] = await db.batch([
		db
			.prepare(
				`UPDATE transactions SET amount_base = CASE
				   WHEN upper(currency) = ?1 THEN amount
				   ELSE amount * (SELECT f.rate_to_base FROM fx_rates f
				                  WHERE f.currency = upper(transactions.currency) AND f.date <= transactions.date
				                    AND f.date >= date(transactions.date, ?2)
				                  ORDER BY f.date DESC LIMIT 1)
				 END
				 WHERE ?3 = 1 OR amount_base IS NULL`,
			)
			.bind(baseCurrency.toUpperCase(), lookback, opts.all ? 1 : 0),
		db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE amount_base IS NULL'),
	]);
	return { updated: update!.meta.changes, stillMissing: (missing!.results[0] as { n: number } | undefined)?.n ?? 0 };
}
