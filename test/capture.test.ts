import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureClosingBalances } from '../src/cashflow/capture';
import {
	type AccountRow,
	type CashflowRow,
	type TransactionRow,
	deleteCashflowRows,
	listCashflowRows,
	listRunLog,
	upsertAccounts,
	upsertCashflowRows,
	upsertFxRates,
	upsertTransactions,
} from '../src/db/repo';
import { getSettings, setSettings } from '../src/db/settings';
import { resetDb } from './helpers';

const db = env.DB;
// 22:00 in Dublin on the last day of the 25 Aug – 24 Sep 2026 budget period.
const NOW = new Date('2026-09-24T21:00:00Z');
const stamp = NOW.toISOString();

function account(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
	return { id, name: `Account ${id}`, accountType: 'CurrentAccount', currency: 'EUR', balance: 0, excludeFromStats: 0, includeInCashflow: 1, archived: 0, updatedAt: stamp, ...overrides };
}

function tx(id: string, accountId: string | null, date: string, amount: number, currency = 'EUR'): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId,
		accountName: null,
		categoryId: 'cat',
		recordType: amount < 0 ? 'expense' : 'income',
		paymentType: 'card',
		recordState: 'cleared',
		amount,
		currency,
		amountBase: null,
		note: null,
		syncedAt: stamp,
	};
}

function importRow(periodEnd: string, rowType: CashflowRow['rowType'], accountKey: string, closingBalance: number): CashflowRow {
	return {
		periodStart: '2026-04-25',
		periodEnd,
		rowType,
		accountKey,
		accountName: 'Revolut (imported)',
		currency: 'EUR',
		closingBalance,
		closingBalanceBase: closingBalance,
		capturedAt: '2026-05-24T21:00:00.000Z',
		source: 'import',
		notes: 'historical',
	};
}

const summary = (rows: CashflowRow[]) => rows.map((r) => [r.rowType, r.accountKey, r.currency, r.closingBalance, r.closingBalanceBase, r.source]);

beforeEach(async () => {
	await resetDb();
	await setSettings(db, { timezone: 'Europe/Dublin', budget_month_start_day: '25', base_currency: 'EUR' });
	await upsertAccounts(db, [
		account('a-eur', { name: 'Current', balance: 1000 }),
		account('a-zar', { name: 'Rand savings', currency: 'ZAR', balance: 20000 }),
		account('a-cash', { name: 'Cash', balance: 300, includeInCashflow: 0 }),
		account('a-old', { name: 'Closed', balance: 999, archived: 1 }),
	]);
	await upsertFxRates(db, [
		{ date: '2026-09-23', currency: 'ZAR', rateToBase: 0.04 },
		{ date: '2026-09-24', currency: 'ZAR', rateToBase: 0.05 }, // period end → used
		{ date: '2026-09-25', currency: 'ZAR', rateToBase: 0.06 },
	]);
	await upsertTransactions(db, [
		tx('in-period', 'a-eur', '2026-09-20', -50), // inside the period: already in the balance
		tx('after-1', 'a-eur', '2026-09-25', -30.1), // after the period end (e.g. planned records)
		tx('after-2', 'a-eur', '2026-10-02', 200),
		tx('after-zar', 'a-zar', '2026-09-25', -1000, 'ZAR'),
		tx('after-cash', 'a-cash', '2026-09-26', -10),
		tx('after-none', null, '2026-09-26', -10),
	]);
	await upsertCashflowRows(db, [importRow('2026-05-24', 'TOTAL', 'TOTAL', 4321), importRow('2026-09-24', 'ACCOUNT', 'revolut-legacy', 77)]);
});

describe('captureClosingBalances', () => {
	it('captures balance minus post-period movements per included account, converted at the period end, plus a TOTAL', async () => {
		const result = await captureClosingBalances(db, await getSettings(db), NOW);

		// a-eur: 1000 − (−30.10 + 200) = 830.10; a-zar: 20000 − (−1000) = 21000 ZAR × 0.05 = 1050.
		expect(result).toEqual({ periodEnd: '2026-09-24', accounts: 2, totalBase: 1880.1 });
		const rows = await listCashflowRows(db, '2026-09-24');
		expect(summary(rows)).toEqual([
			['TOTAL', 'TOTAL', 'EUR', 1880.1, 1880.1, 'auto'],
			['ACCOUNT', 'a-eur', 'EUR', 830.1, 830.1, 'auto'],
			['ACCOUNT', 'a-zar', 'ZAR', 21000, 1050, 'auto'],
			['ACCOUNT', 'revolut-legacy', 'EUR', 77, 77, 'import'],
		]);
		expect(rows.find((r) => r.rowType === 'TOTAL')).toMatchObject({ periodStart: '2026-08-25', accountName: 'All included accounts', notes: null });
		expect(rows.find((r) => r.accountKey === 'a-zar')).toMatchObject({ accountName: 'Rand savings', periodStart: '2026-08-25' });
		expect((await listRunLog(db, 1))[0]).toMatchObject({ level: 'INFO', action: 'capture' });
	});

	it('is idempotent, drops accounts no longer included, and never touches imported rows', async () => {
		const settings = await getSettings(db);
		await captureClosingBalances(db, settings, NOW);
		await captureClosingBalances(db, settings, NOW);
		expect(await listCashflowRows(db, '2026-09-24')).toHaveLength(4);

		await db.prepare("UPDATE accounts SET include_in_cashflow = 0 WHERE id = 'a-zar'").run();
		await upsertAccounts(db, [account('a-eur', { name: 'Current', balance: 1100 })]);
		const result = await captureClosingBalances(db, settings, NOW);

		expect(result).toEqual({ periodEnd: '2026-09-24', accounts: 1, totalBase: 930.1 });
		expect(summary(await listCashflowRows(db))).toEqual([
			['TOTAL', 'TOTAL', 'EUR', 930.1, 930.1, 'auto'],
			['ACCOUNT', 'a-eur', 'EUR', 930.1, 930.1, 'auto'],
			['ACCOUNT', 'revolut-legacy', 'EUR', 77, 77, 'import'],
			['TOTAL', 'TOTAL', 'EUR', 4321, 4321, 'import'],
		]);
		expect((await listCashflowRows(db, '2026-05-24'))[0]).toEqual(importRow('2026-05-24', 'TOTAL', 'TOTAL', 4321));
	});

	it('keeps an imported row that has the same key as a captured one', async () => {
		await upsertCashflowRows(db, [importRow('2026-09-24', 'ACCOUNT', 'a-eur', 12.34)]);
		await captureClosingBalances(db, await getSettings(db), NOW);
		expect((await listCashflowRows(db, '2026-09-24')).find((r) => r.accountKey === 'a-eur')).toEqual(
			importRow('2026-09-24', 'ACCOUNT', 'a-eur', 12.34),
		);
	});

	it('stores a NULL base value (counted as 0 in the TOTAL) when no FX rate is available', async () => {
		await db.prepare('DELETE FROM fx_rates').run();
		const result = await captureClosingBalances(db, await getSettings(db), NOW);
		expect(result.totalBase).toBe(830.1);
		expect((await listCashflowRows(db, '2026-09-24')).find((r) => r.accountKey === 'a-zar')).toMatchObject({
			closingBalance: 21000,
			closingBalanceBase: null,
		});
	});
});

describe('deleteCashflowRows', () => {
	it('deletes only the given period and source', async () => {
		await captureClosingBalances(db, await getSettings(db), NOW);
		expect(await deleteCashflowRows(db, '2026-09-24', 'auto')).toBe(3);
		expect(summary(await listCashflowRows(db))).toEqual([
			['ACCOUNT', 'revolut-legacy', 'EUR', 77, 77, 'import'],
			['TOTAL', 'TOTAL', 'EUR', 4321, 4321, 'import'],
		]);
	});
});
