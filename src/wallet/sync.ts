/**
 * Wallet → D1 sync: categories, accounts and records (as transactions) with a windowed delete.
 *
 * Ported from syncWalletData / normalizeRecords / buildCategoryMap / buildAccountMap in
 * legacy/Code.gs. Field names follow the official OpenAPI schemas (Category, Account, Record) at
 * https://rest.budgetbakers.com/wallet/reference.
 *
 * Records: GET /v1/api/records silently applies a 3-month default window unless a `recordDate`
 * filter is given, so every request passes `recordDate=gte.<date>`. Date-only filter values mean
 * 00:00 UTC, while `transactions.date` is the local day, so records are requested from one day
 * before `windowStart` and only local rows dated ≥ `windowStart` are candidates for deletion.
 */
import {
	type AccountRow,
	type CategoryRow,
	type Flag,
	type TransactionRow,
	deleteTransactionsNotIn,
	ensureDefaultTargets,
	logRun,
	upsertAccounts,
	upsertCategories,
	upsertTransactions,
} from '../db/repo';
import { getSettings, setSetting } from '../db/settings';
import type { Env } from '../env';
import { convertToBase, ensureRates } from '../lib/fx';
import { addDays, isoNow, localDate } from '../lib/tz';
import { LAST_CHANGE_REV_HEADER, PAGE_LIMIT, WalletApiError, fetchAllPages, getLastChangeRev } from './client';

/** Incremental window: covers the current budget period plus the 3 baseline periods (≤ 124 days). */
export const RECENT_WINDOW_DAYS = 125;
const ACTION = 'walletSync';

export interface SyncResult {
	skipped: boolean;
	categories: number;
	accounts: number;
	recordsUpserted: number;
	recordsDeleted: number;
	/** First local date whose transactions mirror Wallet exactly (windowed-delete boundary). */
	windowStart: string | null;
	changeRev: string | null;
}

export interface SyncOptions {
	/** Re-sync everything since the `sync_backfill_from` setting (implies `force`). */
	full?: boolean;
	/** Sync even when X-Last-Data-Change-Rev is unchanged. */
	force?: boolean;
	/** Clock override (tests, or the cron's scheduledTime). */
	now?: Date;
}

// Wallet payloads — only the fields we read.
interface WalletMoney {
	value?: number;
	currencyCode?: string;
}
interface WalletCategory {
	id?: string;
	name?: string;
	/** Present for custom categories only (parent = a base category). */
	parentId?: string;
	group?: { id?: string; name?: string } | null;
	archived?: boolean;
}
interface WalletAccount {
	id?: string;
	name?: string;
	accountType?: string;
	currencyCode?: string;
	balance?: { currencyCode?: string; currentBalance?: number } | null;
	/** Not in the OpenAPI schema but present in real responses; POC currency fallback. */
	initialBalance?: WalletMoney;
	excludeFromStats?: boolean;
	archived?: boolean;
}
interface WalletRecord {
	id?: string;
	recordDate?: string;
	recordType?: string;
	amount?: WalletMoney;
	category?: { id?: string } | null;
	accountId?: string;
	accountName?: string;
	note?: string;
	paymentType?: string;
	recordState?: string;
}

const flag = (value: unknown): Flag => (value === true ? 1 : 0);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** Port of buildCategoryMap: fullPath joins the parent chain with ' > ' (cycle-guarded); level = depth. */
export function toCategoryRows(categories: readonly WalletCategory[], updatedAt: string): CategoryRow[] {
	const nodes = new Map<string, WalletCategory>();
	for (const category of categories) if (text(category.id)) nodes.set(String(category.id), category);
	const nameOf = (category: WalletCategory) => category.name || 'Uncategorized';

	const chains = new Map<string, string[]>();
	const chainOf = (id: string, seen: Set<string>): string[] => {
		const cached = chains.get(id);
		if (cached) return cached;
		const node = nodes.get(id)!;
		if (seen.has(id)) return [nameOf(node)];
		seen.add(id);
		const parentId = text(node.parentId);
		const chain = parentId && nodes.has(parentId) ? [...chainOf(parentId, seen), nameOf(node)] : [nameOf(node)];
		chains.set(id, chain);
		return chain;
	};

	return [...nodes].map(([id, category]) => {
		const chain = chainOf(id, new Set());
		return {
			id,
			parentId: text(category.parentId),
			name: nameOf(category),
			groupId: text(category.group?.id),
			groupName: text(category.group?.name),
			fullPath: chain.join(' > '),
			level: chain.length - 1,
			archived: flag(category.archived),
			updatedAt,
		};
	});
}

/** New cash accounts default to include_in_cashflow = 0; upsertAccounts keeps the stored value on conflict. */
export function toAccountRows(accounts: readonly WalletAccount[], updatedAt: string): AccountRow[] {
	return accounts
		.filter((account) => text(account.id))
		.map((account) => {
			const balance = Number(account.balance?.currentBalance);
			return {
				id: String(account.id),
				name: account.name ?? '',
				accountType: text(account.accountType),
				currency: (account.balance?.currencyCode || account.currencyCode || account.initialBalance?.currencyCode || '').toUpperCase() || null,
				balance: account.balance?.currentBalance != null && Number.isFinite(balance) ? balance : null,
				excludeFromStats: flag(account.excludeFromStats),
				includeInCashflow: (account.accountType ?? '').toLowerCase().includes('cash') ? 0 : 1,
				archived: flag(account.archived),
				updatedAt,
			};
		});
}

/**
 * Syncs Wallet into D1. Skips (one request) when X-Last-Data-Change-Rev equals the stored
 * `wallet_last_change_rev`, unless `force`/`full`. Logs to run_log; WalletApiError (and any other
 * failure) is logged as ERROR and rethrown.
 */
export async function syncWallet(env: Env, db: D1Database, opts: SyncOptions = {}): Promise<SyncResult> {
	try {
		const settings = await getSettings(db);
		const now = opts.now ?? new Date();
		const timezone = settings.timezone;
		const base = settings.base_currency.toUpperCase();
		const today = localDate(now, timezone);

		// 1. Change detection.
		let precheckRev: string | null = null;
		if (!opts.force && !opts.full) {
			precheckRev = await getLastChangeRev(env);
			if (precheckRev !== null && precheckRev === settings.wallet_last_change_rev) {
				await logRun(db, 'INFO', ACTION, `Skipped: Wallet unchanged (rev ${precheckRev}).`);
				return { skipped: true, categories: 0, accounts: 0, recordsUpserted: 0, recordsDeleted: 0, windowStart: null, changeRev: precheckRev };
			}
		}

		// 2. Fetch everything before writing anything.
		const windowStart = opts.full ? settings.sync_backfill_from : addDays(today, -RECENT_WINDOW_DAYS);
		const categoryPages = await fetchAllPages<WalletCategory>(env, '/v1/api/categories', {}, ['categories']);
		const accountPages = await fetchAllPages<WalletAccount>(env, '/v1/api/accounts', {}, ['accounts']);
		const recordPages = await fetchAllPages<WalletRecord>(
			env,
			'/v1/api/records',
			{ limit: PAGE_LIMIT, recordDate: `gte.${addDays(windowStart, -1)}` },
			['records'],
		);
		const syncedAt = isoNow();

		// 3–4. Categories (+ default budget targets) and accounts.
		const categories = toCategoryRows(categoryPages.items, syncedAt);
		await upsertCategories(db, categories);
		await ensureDefaultTargets(db, categories);
		const accounts = toAccountRows(accountPages.items, syncedAt);
		await upsertAccounts(db, accounts);

		// 7. Normalize records (port of normalizeRecords). Later duplicates of an id win.
		const accountById = new Map(accounts.map((account) => [account.id, account]));
		const byId = new Map<string, WalletRecord>();
		for (const record of recordPages.items) if (text(record.id)) byId.set(String(record.id), record);
		const pending: Omit<TransactionRow, 'amountBase'>[] = [];
		for (const [id, record] of byId) {
			const instant = text(record.recordDate) ? new Date(record.recordDate!) : null;
			if (!instant || Number.isNaN(instant.getTime())) continue;
			const accountId = text(record.accountId);
			const account = accountId ? accountById.get(accountId) : undefined;
			const amount = Number(record.amount?.value);
			pending.push({
				id,
				recordDate: record.recordDate!,
				date: localDate(instant, timezone),
				accountId,
				accountName: text(record.accountName) ?? account?.name ?? null,
				categoryId: text(record.category?.id),
				recordType: text(record.recordType),
				paymentType: text(record.paymentType),
				recordState: text(record.recordState),
				amount: Number.isFinite(amount) ? amount : 0,
				currency: (record.amount?.currencyCode || account?.currency || base).toUpperCase(),
				note: text(record.note),
				syncedAt,
			});
		}

		// 6. FX coverage for every foreign currency; a Frankfurter outage must not block the sync
		// (rows then keep amount_base NULL until the next sync that has a rate).
		const currencies = [...new Set([...pending.map((row) => row.currency), ...accounts.map((a) => a.currency ?? base)])].filter(
			(currency) => currency !== base,
		);
		if (currencies.length > 0) {
			const minDate = pending.reduce((min, row) => (row.date < min ? row.date : min), today);
			try {
				await ensureRates(db, base, currencies, minDate, today);
			} catch (error) {
				await logRun(db, 'WARN', ACTION, `FX refresh failed, converting with cached rates only: ${errorMessage(error)}`);
			}
		}

		// convertToBase per distinct (currency, date): D1 counts every query (50 per invocation on Free).
		const rates = new Map<string, Promise<number | null>>();
		const transactions: TransactionRow[] = [];
		for (const row of pending) {
			const key = `${row.currency}|${row.date}`;
			let rate = rates.get(key);
			if (!rate) rates.set(key, (rate = convertToBase(db, 1, row.currency, row.date, base)));
			const rateToBase = await rate;
			transactions.push({ ...row, amountBase: rateToBase === null ? null : row.amount * rateToBase });
		}
		const missingFx = transactions.filter((row) => row.amountBase === null).length;

		// 8. Upsert, then delete local rows that vanished from Wallet — only with a complete, non-empty fetch.
		await upsertTransactions(db, transactions);
		let recordsDeleted = 0;
		if (recordPages.complete && byId.size > 0) {
			recordsDeleted = await deleteTransactionsNotIn(db, windowStart, byId.keys());
		} else if (!recordPages.complete) {
			await logRun(db, 'WARN', ACTION, 'Record pagination stopped early; skipped the windowed delete and kept the previous change rev.');
		}

		// 9. Remember the earliest revision seen this run: a change landing mid-sync then re-triggers a sync.
		const changeRev =
			precheckRev ??
			categoryPages.headers.get(LAST_CHANGE_REV_HEADER) ??
			accountPages.headers.get(LAST_CHANGE_REV_HEADER) ??
			recordPages.headers.get(LAST_CHANGE_REV_HEADER);
		if (changeRev !== null && recordPages.complete) await setSetting(db, 'wallet_last_change_rev', changeRev);

		await logRun(
			db,
			'INFO',
			ACTION,
			`${opts.full ? 'Full' : 'Incremental'} sync from ${windowStart}: ${categories.length} categories, ${accounts.length} accounts, ` +
				`${transactions.length} records upserted, ${recordsDeleted} deleted` +
				`${missingFx ? `, ${missingFx} without FX rate` : ''}${changeRev ? ` (rev ${changeRev})` : ''}.`,
		);
		return {
			skipped: false,
			categories: categories.length,
			accounts: accounts.length,
			recordsUpserted: transactions.length,
			recordsDeleted,
			windowStart,
			changeRev,
		};
	} catch (error) {
		const code = error instanceof WalletApiError ? error.code : 'SYNC_ERROR';
		await logRun(db, 'ERROR', ACTION, `${code}: ${errorMessage(error)}`);
		throw error;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
