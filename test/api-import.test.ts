import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, createSessionValue } from '../src/api/auth';
import { parseCsv } from '../src/api/csv';
import { parseAmount, slugify } from '../src/api/imports';
import { handleApiRequest } from '../src/api/routes';
import {
	type CashflowRow,
	type CategoryRow,
	getTarget,
	listCashflowRows,
	listRunLog,
	listTargets,
	upsertCashflowRows,
	upsertCategories,
	upsertFxRates,
	upsertTarget,
} from '../src/db/repo';
import { setSettings } from '../src/db/settings';
import type { Env } from '../src/env';
import { resetDb } from './helpers';

const db = env.DB;
const testEnv: Env = { ...env, DASHBOARD_PASSWORD: 'pw', SESSION_SECRET: 'import-test-secret' };
const stamp = '2026-09-26T10:00:00.000Z';
let cookie = '';

async function postCsv(path: string, csv: string): Promise<{ status: number; body: any }> {
	const request = new Request(`https://budget.example.com/api/admin/import/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'text/csv', Cookie: `${SESSION_COOKIE}=${cookie}` },
		body: csv,
	});
	const response = (await handleApiRequest(request, testEnv, createExecutionContext()))!;
	return { status: response.status, body: await response.json() };
}

function category(id: string, name: string, groupId: string, groupName: string, fullPath = name, extra: Partial<CategoryRow> = {}): CategoryRow {
	return { id, parentId: null, name, groupId, groupName, fullPath, level: fullPath.split(' > ').length - 1, archived: 0, updatedAt: stamp, ...extra };
}

const csvLine = (cells: Array<string | number>) => cells.map((cell) => (/[",\n]/.test(String(cell)) ? `"${String(cell).replace(/"/g, '""')}"` : cell)).join(',');

beforeEach(async () => {
	await resetDb();
	cookie = await createSessionValue(testEnv, Date.now() + 3_600_000);
	await setSettings(db, { timezone: 'Europe/Dublin', base_currency: 'EUR', budget_month_start_day: '25' });
	await upsertCategories(db, [
		category('c-food', 'Food & Drinks', 'food', 'Food & Drinks'),
		category('c-groc', 'Groceries', 'food', 'Food & Drinks', 'Food & Drinks > Groceries'),
		category('c-bar', 'Bar, "Café"', 'food', 'Food & Drinks', 'Food & Drinks > Bar, "Café"'),
		category('c-rent', 'Rent', 'housing', 'Housing', 'Housing > Rent'),
		category('c-energy', 'Energy, utilities', 'housing', 'Housing', 'Housing > Energy, utilities'),
		category('c-salary', 'Salary', 'income', 'Income', 'Income > Salary'),
	]);
});

afterEach(() => vi.restoreAllMocks());

describe('parseCsv', () => {
	it('handles quoted fields, doubled quotes, embedded newlines, CRLF, BOM and semicolons', () => {
		expect(parseCsv('﻿a,b,c\r\n1,"x, ""y""",3\r\n"multi\nline",,\r\n\r\n')).toEqual([
			['a', 'b', 'c'],
			['1', 'x, "y"', '3'],
			['multi\nline', '', ''],
		]);
		expect(parseCsv('a;b\n"1,5";2')).toEqual([
			['a', 'b'],
			['1,5', '2'],
		]);
		expect(parseCsv('a,b\n1,2')).toEqual([
			['a', 'b'],
			['1', '2'],
		]);
	});

	it('parses sheet-formatted amounts', () => {
		expect([parseAmount('1,200.50'), parseAmount('€ 80'), parseAmount('80,5'), parseAmount(''), parseAmount('abc')]).toEqual([1200.5, 80, 80.5, null, undefined]);
		expect(slugify('Revolut Joint (EUR) — Café')).toBe('revolut-joint-eur-cafe');
	});
});

describe('POST /api/admin/import/budgets — legacy Google Sheet export', () => {
	const HEADERS = [
		'Category', 'Period', 'Forecast Type', 'BudgetEUR', 'Include in Report?', 'Include in Expense Calculations', 'CurrentMonthSpentEUR',
		'RemainingEUR', 'UsedPercent', 'ForecastEUR', 'ForecastVsBudgetEUR', 'BaselineMonth1EUR', 'BaselineMonth2EUR', 'BaselineMonth3EUR',
		'3MonthBaselineAverageEUR', 'CategoryId', 'ParentCategoryId', 'CategoryType', 'Depth', 'Path', 'RowType', 'Effective in Total?',
	];
	const row = (name: string, forecast: string, budget: string, report: string, expense: string, id: string, type: string, depth: number, path: string, rowType: string) =>
		csvLine([name, 'Monthly', forecast, budget, report, expense, '12.3', '0', '0.5', '10', '-2', '1', '2', '3', '2', id, '', type, depth, path, rowType, 'TRUE']);

	const legacyCsv = [
		csvLine(HEADERS),
		row('Overall Budget', 'Day-to-day', '6890', 'TRUE', 'TRUE', '', 'Overall', 0, '__OVERALL_BUDGET__', 'OVERALL'),
		row('Food & Drinks', 'Day-to-day', '2000', 'TRUE', 'TRUE', '', 'Food & Drinks', 0, 'Food & Drinks', 'TYPE'),
		// Matched by CategoryId.
		row('  Groceries', 'Day-to-day', '1,200.50', 'TRUE', 'TRUE', 'c-groc', 'Food & Drinks', 1, 'Food & Drinks > Groceries', 'CATEGORY'),
		// Matched by Path (legacy id no longer exists); quoted cell with a comma and doubled quotes.
		row('  Bar, "Café"', 'Recurring Expense', '45', 'FALSE', 'TRUE', 'old-id', 'Food & Drinks', 1, 'Food & Drinks > Bar, "Café"', 'CATEGORY'),
		',,,,,,,,,,,,,,,,,,,,,', // blank separator row
		row('Housing', 'Recurring Expense', '', 'false', 'true', '', 'Housing', 0, 'Housing', 'TYPE'),
		// Path renamed in BudgetBakers → falls back to the trimmed Category name.
		row('    Rent', 'Recurring Expense', '1500', 'TRUE', 'TRUE', '', 'Housing', 1, 'Home > Rent', 'CATEGORY'),
		// Blank budget → null (no target).
		row('  Energy, utilities', 'Day-to-day', '', 'FALSE', 'TRUE', '', 'Housing', 1, 'Housing > Energy, utilities', 'CATEGORY'),
		row('  Vet', 'Day-to-day', '30', 'TRUE', 'TRUE', '', 'Pets', 1, 'Pets > Vet', 'CATEGORY'),
		row('Crypto', 'Day-to-day', '0', 'FALSE', 'FALSE', '', 'Crypto', 0, 'Crypto', 'TYPE'),
	].join('\r\n');

	it('writes category and group targets and reports unmatched rows', async () => {
		const { status, body } = await postCsv('budgets', legacyCsv);
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, format: 'legacy', imported: 6, skipped: 2 });
		expect(body.unmatched).toHaveLength(2);
		expect(body.unmatched[0]).toContain('Pets > Vet');
		expect(body.unmatched[1]).toContain('Crypto');

		const target = (type: 'category' | 'group', id: string) => getTarget(db, type, id);
		expect(await target('category', 'c-groc')).toEqual({
			entityType: 'category', entityId: 'c-groc', period: 'monthly', forecastType: 'day_to_day', budget: 1200.5, includeInReport: 1, includeInExpense: 1,
		});
		expect(await target('category', 'c-bar')).toMatchObject({ forecastType: 'recurring', budget: 45, includeInReport: 0, includeInExpense: 1 });
		expect(await target('category', 'c-rent')).toMatchObject({ forecastType: 'recurring', budget: 1500, includeInReport: 1 });
		expect(await target('category', 'c-energy')).toMatchObject({ budget: null, includeInReport: 0 });
		// TYPE rows: BudgetEUR becomes the manual group budget; a blank one stays null (auto-sum of the categories).
		expect(await target('group', 'food')).toMatchObject({ budget: 2000, includeInReport: 1, includeInExpense: 1 });
		expect(await target('group', 'housing')).toMatchObject({ budget: null, forecastType: 'recurring', includeInReport: 0, includeInExpense: 1 });
		expect(await target('category', 'c-salary')).toBeNull();
		expect((await listRunLog(db, 1))[0]).toMatchObject({ level: 'WARN', action: 'import.budgets' });
	});

	it('keeps stored values for blank cells', async () => {
		await upsertTarget(db, { entityType: 'category', entityId: 'c-groc', period: 'monthly', forecastType: 'recurring', budget: 99, includeInReport: 1, includeInExpense: 0 });
		const csv = [csvLine(HEADERS), row('  Groceries', '', '250', '', '', 'c-groc', 'Food & Drinks', 1, 'Food & Drinks > Groceries', 'CATEGORY')].join('\n');
		const { body } = await postCsv('budgets', csv);
		expect(body).toMatchObject({ imported: 1, skipped: 0, unmatched: [] });
		expect(await getTarget(db, 'category', 'c-groc')).toMatchObject({ budget: 250, forecastType: 'recurring', includeInReport: 1, includeInExpense: 0 });
	});
});

describe('POST /api/admin/import/budgets — generic format', () => {
	it('matches by path, name or id and validates values', async () => {
		const csv = [
			'entity_type,name_or_path,budget,forecast_type,include_in_report,include_in_expense',
			'category,Food & Drinks > Groceries,300,recurring,true,1',
			'category,rent,,day_to_day,no,',
			'category,c-energy,80.5,,yes,',
			'group,Housing,,,yes,',
			'group,income,,,,1',
			'category,Nonexistent,5,,,',
			'group,Food & Drinks,abc,,,',
			'category,Salary,10,weekly,,',
		].join('\n');
		const { status, body } = await postCsv('budgets', csv);
		expect(status).toBe(200);
		expect(body).toMatchObject({ format: 'generic', imported: 5, skipped: 0 });
		expect(body.unmatched).toHaveLength(3);
		expect(body.unmatched.join('\n')).toMatch(/Nonexistent[\s\S]*invalid budget "abc"[\s\S]*invalid forecast type "weekly"/);

		const targets = new Map((await listTargets(db)).map((t) => [`${t.entityType}:${t.entityId}`, t]));
		expect(targets.get('category:c-groc')).toMatchObject({ budget: 300, forecastType: 'recurring', includeInReport: 1, includeInExpense: 1 });
		expect(targets.get('category:c-rent')).toMatchObject({ budget: null, forecastType: 'day_to_day', includeInReport: 0, includeInExpense: 1 });
		expect(targets.get('category:c-energy')).toMatchObject({ budget: 80.5, includeInReport: 1 });
		expect(targets.get('group:housing')).toMatchObject({ budget: null, includeInReport: 1, includeInExpense: 1 });
		// A new income group target keeps the income default unless the CSV says otherwise.
		expect(targets.get('group:income')).toMatchObject({ includeInReport: 0, includeInExpense: 1 });
		expect(targets.has('group:food')).toBe(false);
	});

	it('rejects unknown headers and empty bodies', async () => {
		expect(await postCsv('budgets', 'foo,bar\n1,2')).toMatchObject({ status: 400, body: { code: 'VALIDATION' } });
		expect(await postCsv('budgets', '')).toMatchObject({ status: 400, body: { code: 'VALIDATION' } });
	});
});

describe('POST /api/admin/import/cashflow', () => {
	const summary = (rows: CashflowRow[]) => rows.map((r) => [r.periodEnd, r.rowType, r.accountKey, r.currency, r.closingBalance, r.closingBalanceBase, r.source]);

	it('imports account rows, converts missing base amounts and writes a TOTAL per period', async () => {
		await upsertFxRates(db, [{ date: '2026-04-24', currency: 'ZAR', rateToBase: 0.05 }]);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const csv = [
			'period_start,period_end,account_name,currency,closing_balance,closing_balance_base',
			'2026-03-25,2026-04-24,Revolut Joint,EUR,1234.56,',
			'2026-03-25,2026-04-24,Rand Savings,zar,20000,',
			'2026-03-25,2026-04-24,US Broker,USD,"1,000.00",900',
			'2026-04-25,2026-05-24,Revolut Joint,EUR,1500,',
		].join('\n');
		const { status, body } = await postCsv('cashflow', csv);
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true, periods: 2, accounts: 4, totalsWritten: 2, totalsSkipped: 0, missingFx: 0 });
		expect(fetchSpy).not.toHaveBeenCalled(); // the seeded rate covers the only conversion

		expect(summary(await listCashflowRows(db))).toEqual([
			['2026-05-24', 'TOTAL', 'TOTAL', 'EUR', 1500, 1500, 'import'],
			['2026-05-24', 'ACCOUNT', 'revolut-joint', 'EUR', 1500, 1500, 'import'],
			['2026-04-24', 'TOTAL', 'TOTAL', 'EUR', 3134.56, 3134.56, 'import'],
			['2026-04-24', 'ACCOUNT', 'rand-savings', 'ZAR', 20000, 1000, 'import'],
			['2026-04-24', 'ACCOUNT', 'revolut-joint', 'EUR', 1234.56, 1234.56, 'import'],
			['2026-04-24', 'ACCOUNT', 'us-broker', 'USD', 1000, 900, 'import'],
		]);
		const [total] = await listCashflowRows(db, '2026-04-24');
		expect(total).toMatchObject({ periodStart: '2026-03-25', accountName: 'All included accounts', notes: 'Sum of 3 imported account row(s)' });
	});

	it('works without a closing_balance_base column; rows without a rate count as 0 in the TOTAL', async () => {
		// Frankfurter has no GBP rows for the range → no rate → NULL base.
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json([]));
		const csv = ['period_start,period_end,account_name,currency,closing_balance', '2026-04-25,2026-05-24,Current,EUR,100', '2026-04-25,2026-05-24,UK Savings,GBP,50'].join('\n');
		const { body } = await postCsv('cashflow', csv);
		expect(body).toMatchObject({ periods: 1, accounts: 2, totalsWritten: 1, missingFx: 1 });
		expect(summary(await listCashflowRows(db, '2026-05-24'))).toEqual([
			['2026-05-24', 'TOTAL', 'TOTAL', 'EUR', 100, 100, 'import'],
			['2026-05-24', 'ACCOUNT', 'current', 'EUR', 100, 100, 'import'],
			['2026-05-24', 'ACCOUNT', 'uk-savings', 'GBP', 50, null, 'import'],
		]);
	});

	it('leaves the TOTAL alone when an automatic capture exists for the period', async () => {
		const auto = (rowType: 'TOTAL' | 'ACCOUNT', accountKey: string, value: number): CashflowRow => ({
			periodStart: '2026-04-25', periodEnd: '2026-05-24', rowType, accountKey, accountName: accountKey, currency: 'EUR',
			closingBalance: value, closingBalanceBase: value, capturedAt: stamp, source: 'auto', notes: null,
		});
		await upsertCashflowRows(db, [auto('TOTAL', 'TOTAL', 5000), auto('ACCOUNT', 'acc-1', 5000)]);
		const csv = [
			'period_start,period_end,account_name,currency,closing_balance',
			'2026-04-25,2026-05-24,Old Bank,EUR,10',
			'2026-03-25,2026-04-24,Old Bank,EUR,20',
		].join('\n');
		const { body } = await postCsv('cashflow', csv);
		expect(body).toMatchObject({ periods: 2, accounts: 2, totalsWritten: 1, totalsSkipped: 1 });
		expect(summary(await listCashflowRows(db, '2026-05-24'))).toEqual([
			['2026-05-24', 'TOTAL', 'TOTAL', 'EUR', 5000, 5000, 'auto'],
			['2026-05-24', 'ACCOUNT', 'old-bank', 'EUR', 10, 10, 'import'], // "Old Bank" < "acc-1" (binary collation)
			['2026-05-24', 'ACCOUNT', 'acc-1', 'EUR', 5000, 5000, 'auto'],
		]);
		expect((await listCashflowRows(db, '2026-04-24'))[0]).toMatchObject({ rowType: 'TOTAL', closingBalance: 20, source: 'import' });
	});

	it('re-importing replaces rows and recomputes the import TOTAL', async () => {
		const header = 'period_start,period_end,account_name,currency,closing_balance';
		await postCsv('cashflow', [header, '2026-04-25,2026-05-24,A,EUR,10', '2026-04-25,2026-05-24,B,EUR,20'].join('\n'));
		await postCsv('cashflow', [header, '2026-04-25,2026-05-24,A,EUR,15'].join('\n'));
		expect(summary(await listCashflowRows(db, '2026-05-24'))[0]).toEqual(['2026-05-24', 'TOTAL', 'TOTAL', 'EUR', 35, 35, 'import']);
	});

	it('rejects invalid files without writing anything', async () => {
		const missing = await postCsv('cashflow', 'period_end,account_name\n2026-05-24,A');
		expect(missing.status).toBe(400);
		expect(missing.body.error).toContain('period_start');

		const bad = await postCsv(
			'cashflow',
			['period_start,period_end,account_name,currency,closing_balance', '2026-04-25,2026-05-24,A,EUR,10', '2026-05-30,2026-05-24,,EURO,x'].join('\n'),
		);
		expect(bad.status).toBe(400);
		expect(bad.body.details[0]).toMatch(/^Line 3: .*after period_end.*account_name is empty.*3-letter.*closing_balance/);
		expect(await listCashflowRows(db)).toEqual([]);
	});
});
