// Two households with IDENTICAL BudgetBakers ids (built-in category/group ids are the same in every
// Wallet account) must never see, merge or delete each other's rows.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	type AccountRow,
	type CashflowRow,
	type CategoryRow,
	type TransactionRow,
	clearFxRates,
	countCoreRows,
	deleteCashflowRows,
	deleteTransactionsNotIn,
	ensureDefaultTargets,
	getFxRateOnOrBefore,
	getTarget,
	insertMessageLog,
	latestRunLogByAction,
	listAccounts,
	listCashflowRows,
	listCashflowTotals,
	listCategories,
	listDistinctCurrencies,
	listMessageLog,
	listRunLog,
	listTargets,
	listTransactionsBetween,
	listTransactionsOnDate,
	logRun,
	reconvertTransactionsToBase,
	upsertAccounts,
	upsertCashflowRows,
	upsertCategories,
	upsertFxRates,
	upsertTarget,
	upsertTransactions,
} from '../src/db/repo';
import { GLOBAL_KEYS, getSetting, getSettings, setSetting, setSettings } from '../src/db/settings';
import { GLOBAL_HID, tenant } from '../src/db/tenant';
import { HH1, HH2, resetDb } from './helpers';

const db = env.DB;
const NOW = '2026-09-26T10:00:00.000Z';
const CATEGORY_ID = '3a1f9d7e-0000-4000-8000-000000000001'; // same UUID in both accounts
const GROUP_ID = 'financial_expenses';

function category(name: string): CategoryRow {
	return { id: CATEGORY_ID, parentId: null, name, groupId: GROUP_ID, groupName: 'Financial expenses', fullPath: name, level: 0, archived: 0, updatedAt: NOW };
}

function account(name: string, currency: string): AccountRow {
	return { id: 'acc-1', name, accountType: 'CurrentAccount', currency, balance: 1, excludeFromStats: 0, includeInCashflow: 1, archived: 0, updatedAt: NOW };
}

function transaction(id: string, date: string, amount: number, currency = 'EUR'): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-1',
		accountName: 'Current',
		categoryId: CATEGORY_ID,
		recordType: 'expense',
		paymentType: 'card',
		recordState: 'cleared',
		amount,
		currency,
		amountBase: currency === 'EUR' ? amount : null,
		note: null,
		syncedAt: NOW,
	};
}

function total(periodEnd: string, closingBalance: number): CashflowRow {
	return {
		periodStart: '2026-09-01',
		periodEnd,
		rowType: 'TOTAL',
		accountKey: 'TOTAL',
		accountName: 'Total',
		currency: 'EUR',
		closingBalance,
		closingBalanceBase: closingBalance,
		capturedAt: NOW,
		source: 'auto',
		notes: null,
	};
}

beforeEach(resetDb);

describe('identical BudgetBakers ids across households', () => {
	it('category, account and transaction upserts never merge', async () => {
		await upsertCategories(HH1, [category('Bank fees')]);
		await upsertCategories(HH2, [category('Frais bancaires')]);
		await upsertAccounts(HH1, [account('Current', 'EUR')]);
		await upsertAccounts(HH2, [account('Cheque', 'ZAR')]);
		await upsertTransactions(HH1, [transaction('t1', '2026-09-10', -10), transaction('t2', '2026-09-11', -20)]);
		await upsertTransactions(HH2, [transaction('t1', '2026-09-10', -99, 'ZAR')]);

		expect((await listCategories(HH1)).map((c) => c.name)).toEqual(['Bank fees']);
		expect((await listCategories(HH2)).map((c) => c.name)).toEqual(['Frais bancaires']);
		expect((await listAccounts(HH1)).map((a) => a.name)).toEqual(['Current']);
		expect((await listAccounts(HH2)).map((a) => a.name)).toEqual(['Cheque']);
		expect((await listTransactionsBetween(HH1, '2026-09-01', '2026-10-01')).map((t) => [t.id, t.amount])).toEqual([
			['t1', -10],
			['t2', -20],
		]);
		expect((await listTransactionsBetween(HH2, '2026-09-01', '2026-10-01')).map((t) => [t.id, t.amount])).toEqual([['t1', -99]]);
		expect((await listTransactionsOnDate(HH2, '2026-09-11')).length).toBe(0);
		expect(await countCoreRows(HH1)).toEqual({ transactions: 2, categories: 1, accounts: 1, missingFx: 0 });
		expect(await countCoreRows(HH2)).toEqual({ transactions: 1, categories: 1, accounts: 1, missingFx: 1 });
		expect(await listDistinctCurrencies(HH1)).toEqual(['EUR']);
		expect(await listDistinctCurrencies(HH2)).toEqual(['ZAR']);

		// Re-upserting HH1 does not touch HH2's row with the same id.
		await upsertTransactions(HH1, [transaction('t1', '2026-09-10', -11)]);
		expect((await listTransactionsOnDate(HH2, '2026-09-10'))[0]!.amount).toBe(-99);
	});

	it('ensureDefaultTargets works for both households and targets stay separate', async () => {
		expect(await ensureDefaultTargets(HH1, [category('Bank fees')])).toBe(2);
		expect(await ensureDefaultTargets(HH2, [category('Bank fees')])).toBe(2);
		expect(await ensureDefaultTargets(HH1, [category('Bank fees')])).toBe(0);

		const target = (await getTarget(HH1, 'group', GROUP_ID))!;
		await upsertTarget(HH1, { ...target, budget: 50, includeInReport: 1 });

		expect(await getTarget(HH1, 'group', GROUP_ID)).toMatchObject({ budget: 50, includeInReport: 1 });
		expect(await getTarget(HH2, 'group', GROUP_ID)).toMatchObject({ budget: null, includeInReport: 0 });
		expect(await listTargets(HH1)).toHaveLength(2);
		expect(await listTargets(HH2)).toHaveLength(2);
	});

	it('deleteTransactionsNotIn(HH1) never deletes HH2 rows', async () => {
		await upsertTransactions(HH1, [transaction('keep', '2026-09-10', -1), transaction('gone', '2026-09-10', -2)]);
		await upsertTransactions(HH2, [
			transaction('keep', '2026-09-10', -3),
			transaction('gone', '2026-09-10', -4),
			transaction('only-hh2', '2026-09-12', -5),
		]);

		expect(await deleteTransactionsNotIn(HH1, '2026-09-01', ['keep'])).toBe(1);
		expect((await listTransactionsBetween(HH1, '2000-01-01', '2100-01-01')).map((t) => t.id)).toEqual(['keep']);
		expect((await listTransactionsBetween(HH2, '2000-01-01', '2100-01-01')).map((t) => t.id).sort()).toEqual(['gone', 'keep', 'only-hh2']);

		// An empty keep-set for HH1 (e.g. a new, empty Wallet account) still leaves HH2 alone.
		expect(await deleteTransactionsNotIn(HH1, '2000-01-01', [])).toBe(1);
		expect(await countCoreRows(HH2)).toMatchObject({ transactions: 3 });
	});

	it('cash-flow rows are scoped, including deletes', async () => {
		await upsertCashflowRows(HH1, [total('2026-09-30', 100)]);
		await upsertCashflowRows(HH2, [total('2026-09-30', 200)]);

		expect((await listCashflowTotals(HH1, 10)).map((r) => r.closingBalance)).toEqual([100]);
		expect((await listCashflowRows(HH2, '2026-09-30')).map((r) => r.closingBalance)).toEqual([200]);
		expect(await deleteCashflowRows(HH1, '2026-09-30', 'auto')).toBe(1);
		expect(await listCashflowRows(HH1)).toEqual([]);
		expect(await listCashflowRows(HH2)).toHaveLength(1);
	});

	it('reconvertTransactionsToBase only rewrites the household and uses its base-currency rates', async () => {
		await upsertTransactions(HH1, [transaction('t1', '2026-09-10', -10, 'USD')]);
		await upsertTransactions(HH2, [transaction('t1', '2026-09-10', -10, 'USD')]);
		await upsertFxRates(db, 'EUR', [{ date: '2026-09-10', currency: 'USD', rateToBase: 0.9 }]);
		await upsertFxRates(db, 'ZAR', [{ date: '2026-09-10', currency: 'USD', rateToBase: 18 }]);

		expect(await reconvertTransactionsToBase(HH1, 'EUR')).toEqual({ updated: 1, stillMissing: 0 });
		expect((await listTransactionsOnDate(HH1, '2026-09-10'))[0]!.amountBase).toBeCloseTo(-9);
		expect((await listTransactionsOnDate(HH2, '2026-09-10'))[0]!.amountBase).toBeNull();

		expect(await reconvertTransactionsToBase(HH2, 'zar')).toEqual({ updated: 1, stillMissing: 0 });
		expect((await listTransactionsOnDate(HH2, '2026-09-10'))[0]!.amountBase).toBeCloseTo(-180);
	});
});

describe('settings', () => {
	it('runtime guards and household settings are independent', async () => {
		await setSetting(HH1, 'wallet_last_change_rev', '42');
		await setSettings(HH1, { timezone: 'Europe/Dublin', brief_last_sent_date: '2026-09-26' });

		expect(await getSetting(HH1, 'wallet_last_change_rev')).toBe('42');
		expect(await getSetting(HH2, 'wallet_last_change_rev')).toBeNull();
		expect(await getSetting(HH2, 'brief_last_sent_date')).toBeNull();
		expect((await getSettings(HH1)).timezone).toBe('Europe/Dublin');
		expect((await getSettings(HH2)).timezone).toBe('UTC');
	});

	it('merges defaults ← global rows ← household rows', async () => {
		const global = tenant(db, GLOBAL_HID);
		await setSettings(global, { wa_template_name: 'daily_brief', wa_template_lang: 'en_US' });
		await setSetting(HH2, 'wa_template_lang', 'fr');

		expect(await getSettings(HH1)).toMatchObject({ wa_template_name: 'daily_brief', wa_template_lang: 'en_US', signup_enabled: '1' });
		expect(await getSettings(HH2)).toMatchObject({ wa_template_name: 'daily_brief', wa_template_lang: 'fr' });
		expect(await getSetting(HH1, 'wa_template_name')).toBe('daily_brief');
		expect(await getSetting(HH2, 'wa_template_lang')).toBe('fr');
		expect(await getSetting(global, 'wa_template_lang')).toBe('en_US');

		await setSetting(global, 'signup_enabled', '0');
		expect(await getSetting(HH1, 'signup_enabled')).toBe('0');
		expect(await getSetting(global, 'timezone')).toBe('UTC');
		expect(GLOBAL_KEYS).toEqual(['wa_template_name', 'wa_template_lang', 'signup_enabled']);
	});
});

describe('shared FX cache', () => {
	it('is keyed by base currency; clearing one base keeps the others', async () => {
		await upsertFxRates(db, 'eur', [{ date: '2026-09-10', currency: 'usd', rateToBase: 0.9 }]);
		await upsertFxRates(db, 'USD', [{ date: '2026-09-10', currency: 'EUR', rateToBase: 1.1 }]);
		await upsertFxRates(db, 'ZAR', [{ date: '2026-09-10', currency: 'USD', rateToBase: 18 }]);

		expect(await getFxRateOnOrBefore(db, 'EUR', '2026-09-10', 'USD')).toBe(0.9);
		expect(await getFxRateOnOrBefore(db, 'ZAR', '2026-09-10', 'USD')).toBe(18);

		await clearFxRates(db, 'EUR');
		expect(await getFxRateOnOrBefore(db, 'EUR', '2026-09-10', 'USD')).toBeNull();
		expect(await getFxRateOnOrBefore(db, 'USD', '2026-09-10', 'EUR')).toBe(1.1);
		expect(await getFxRateOnOrBefore(db, 'ZAR', '2026-09-10', 'USD')).toBe(18);
	});
});

describe('logs', () => {
	it('message_log de-duplication stays global; listing filters by household', async () => {
		expect(await insertMessageLog(db, { waMessageId: 'wamid.1', direction: 'in', status: 'PROCESSING', householdId: 1 })).toBe(true);
		expect(await insertMessageLog(db, { waMessageId: 'wamid.1', direction: 'in', status: 'PROCESSING', householdId: 2 })).toBe(false);
		await insertMessageLog(db, { direction: 'out', status: 'SENT', householdId: 2 });
		await insertMessageLog(db, { direction: 'in', status: 'IGNORED_SENDER' });

		expect((await listMessageLog(db, 10, 1)).map((r) => r.waMessageId)).toEqual(['wamid.1']);
		expect((await listMessageLog(db, 10, 2)).map((r) => r.status)).toEqual(['SENT']);
		expect((await listMessageLog(db, 10)).map((r) => r.householdId)).toEqual([null, 2, 1]);
	});

	it('logRun attributes rows to a Tenant or to the system; latestRunLogByAction is scoped', async () => {
		await logRun(HH1, 'INFO', 'walletSync', 'hh1 sync');
		await logRun(HH2, 'ERROR', 'walletSync', 'hh2 sync');
		await logRun(db, 'INFO', 'prune', 'system');

		expect((await listRunLog(db, 10)).map((r) => [r.householdId, r.message])).toEqual([
			[null, 'system'],
			[2, 'hh2 sync'],
			[1, 'hh1 sync'],
		]);
		expect((await listRunLog(db, 10, 1)).map((r) => r.message)).toEqual(['hh1 sync']);
		expect((await latestRunLogByAction(HH1, ['walletSync', 'prune'])).get('walletSync')?.message).toBe('hh1 sync');
		expect((await latestRunLogByAction(HH1, ['walletSync', 'prune'])).has('prune')).toBe(false);
		expect((await latestRunLogByAction(HH2, ['walletSync'])).get('walletSync')?.level).toBe('ERROR');
	});
});

describe('migration 0002 schema', () => {
	it('household-scoped tables reject rows without a household_id and allow the same key per household', async () => {
		await expect(db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run()).rejects.toThrow(/NOT NULL/);
		await db.batch([
			db.prepare("INSERT INTO settings (household_id, key, value) VALUES (1, 'k', 'a')"),
			db.prepare("INSERT INTO settings (household_id, key, value) VALUES (2, 'k', 'b')"),
		]);
		expect(await getSetting(HH1, 'k')).toBe('a');
		expect(await getSetting(HH2, 'k')).toBe('b');
		await expect(db.prepare("INSERT INTO household_recipients (e164, household_id) VALUES ('+1', 1), ('+1', 2)").run()).rejects.toThrow(/UNIQUE/);
	});
});
