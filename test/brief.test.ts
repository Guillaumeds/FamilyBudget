import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildBriefData, buildDailyBriefText, renderBriefText, renderTemplateParams, type BriefData } from '../src/budget/brief';
import type { BudgetLine, YesterdayExpense } from '../src/budget/engine';
import {
	type CashflowRow,
	type CategoryRow,
	type TransactionRow,
	upsertCashflowRows,
	upsertCategories,
	upsertTarget,
	upsertTransactions,
} from '../src/db/repo';
import { getSettings, setSettings } from '../src/db/settings';
import { HH1, resetDb } from './helpers';

function line(overrides: Partial<BudgetLine>): BudgetLine {
	return {
		rowType: 'CATEGORY',
		id: 'x',
		name: 'X',
		path: 'X',
		depth: 1,
		groupId: 'g',
		groupName: 'G',
		forecastType: 'day_to_day',
		budget: 0,
		spent: 0,
		remaining: 0,
		usedPct: 0,
		forecast: 0,
		forecastVsBudget: 0,
		baselines: [0, 0, 0],
		baselineAvg: 0,
		includeInReport: true,
		includeInExpense: true,
		...overrides,
	};
}

function expense(overrides: Partial<YesterdayExpense>): YesterdayExpense {
	return { date: '2026-09-25', account: 'Current', category: 'Groceries', path: 'Food & Drinks > Groceries', amountBase: 0, note: '', recordId: 'r', ...overrides };
}

const DATA: BriefData = {
	title: 'Family Budget Brief',
	dateLabel: 'Sat, 26 Sep 2026',
	periodLabel: '25 Sep to 24 Oct 2026',
	currency: 'EUR',
	yesterday: [
		expense({ amountBase: 45.6, note: 'Tesco' }),
		expense({ category: 'Restaurant', path: 'Food & Drinks > Restaurant', amountBase: 1234.5, account: 'Credit card' }),
	],
	overall: line({ rowType: 'OVERALL', id: '', name: 'Overall Budget', path: 'Overall Budget', depth: 0, groupId: '', groupName: '', budget: 3000, spent: 1280.1, remaining: 1719.9, forecast: 3500 }),
	reportLines: [
		line({ name: 'Groceries', groupName: 'Food & Drinks', budget: 600, spent: 45.6, forecast: 1414 }),
		line({ name: 'Organic', groupName: 'Food & Drinks', depth: 2, budget: 100 }),
		line({ name: 'Insurance', groupName: 'Vehicle', budget: 90, forecast: 90, forecastType: 'recurring' }),
	],
	cashflow: [
		{ label: '25 Aug to 24 Sep 2026', closing: 12345.67, change: -234.5, hasPrior: true },
		{ label: '25 Jul to 24 Aug 2026', closing: 12580.17, change: 1000, hasPrior: true },
		{ label: '25 Jun to 24 Jul 2026', closing: 11580.17, change: 0, hasPrior: false },
	],
};

describe('renderBriefText', () => {
	it('renders the golden brief', () => {
		expect(renderBriefText(DATA)).toBe(
			[
				'💰 *Family Budget Brief*',
				'Sat, 26 Sep 2026 · *25 Sep to 24 Oct 2026*',
				'',
				'━━━━━━━━━━━━━━━━━━',
				'*Yesterday’s Expenses*',
				'',
				'• 2026-09-25 · Groceries — €45.60 from Current — Tesco',
				'• 2026-09-25 · Restaurant — €1,234.50 from Credit card',
				'',
				'━━━━━━━━━━━━━━━━━━',
				'📊 *Overall*',
				'Spent: *€1,280.10* / €3,000.00',
				'Remaining: €1,719.90 · Forecast: €3,500.00',
				'━━━━━━━━━━━━━━━━━━',
				'',
				'🛒 *Groceries*',
				'Spent: €45.60 / €600.00',
				'Forecast: €1,414.00',
				'',
				'  🍽️ *Organic*',
				'  Spent: €0.00 / €100.00',
				'  Forecast: €0.00',
				'',
				'🚘 *Insurance*',
				'Spent: €0.00 / €90.00',
				'Forecast: €90.00',
				'',
				'━━━━━━━━━━━━━━━━━━',
				'*Cash Flow*',
				'',
				'*25 Aug to 24 Sep 2026:* -€234.50 change · closing funds €12,345.67',
				'*25 Jul to 24 Aug 2026:* +€1,000.00 change · closing funds €12,580.17',
				'*25 Jun to 24 Jul 2026:* baseline captured · closing funds €11,580.17',
			].join('\n'),
		);
	});

	it('uses the placeholder lines when there is nothing to show', () => {
		const text = renderBriefText({ ...DATA, yesterday: [], reportLines: [], cashflow: [] });
		expect(text).toContain('*Yesterday’s Expenses*\n\nNo included expenses found for yesterday.\n\n━━━━━━━━━━━━━━━━━━\n📊 *Overall*');
		expect(text).toContain('━━━━━━━━━━━━━━━━━━\n\nNo budget lines are selected for the report yet.\n\n━━━━━━━━━━━━━━━━━━\n*Cash Flow*');
		expect(text.endsWith('*Cash Flow*\n\nNo captured cash-flow periods yet.')).toBe(true);
	});

	it('renders each empty section independently', () => {
		expect(renderBriefText({ ...DATA, yesterday: [] })).toContain('No included expenses found for yesterday.');
		expect(renderBriefText({ ...DATA, yesterday: [] })).toContain('🛒 *Groceries*');
		expect(renderBriefText({ ...DATA, cashflow: [] })).toMatch(/\*Cash Flow\*\n\nNo captured cash-flow periods yet\.$/);
		expect(renderBriefText({ ...DATA, reportLines: [] })).toContain('\n\nNo budget lines are selected for the report yet.\n\n');
	});

	it('uses the configured currency and title', () => {
		const text = renderBriefText({ ...DATA, title: 'Our Brief', currency: 'ZAR', reportLines: [], cashflow: [] });
		expect(text.startsWith('💰 *Our Brief*\n')).toBe(true);
		expect(text).toContain('Spent: *ZAR');
	});
});

describe('renderTemplateParams', () => {
	it('returns exactly the 14 named params, padding unused expense slots with "–"', () => {
		const params = renderTemplateParams(DATA);
		expect(params).toEqual({
			date: 'Sat, 26 Sep 2026',
			expense_1: '2026-09-25 · Groceries — €45.60 from Current',
			expense_2: '2026-09-25 · Restaurant — €1,234.50 from Credit card',
			expense_3: '–',
			expense_4: '–',
			expense_5: '–',
			expense_6: '–',
			expense_7: '–',
			expense_8: '–',
			expense_9: '–',
			expense_10: '–',
			overall_spent: '€1,280.10 of €3,000.00',
			overall_remaining: '€1,719.90',
			overall_forecast: '€3,500.00',
		});
	});

	it('uses only the first 10 expenses and keeps every value single-line and non-empty', () => {
		const many = Array.from({ length: 12 }, (_, i) =>
			expense({ category: `Cat\n${i}`, account: 'Acc\t\tB', note: 'evil\nnote', amountBase: i }),
		);
		const params = renderTemplateParams({ ...DATA, dateLabel: '', yesterday: many });
		expect(Object.keys(params)).toHaveLength(14);
		expect(params.expense_1).toBe('2026-09-25 · Cat · 0 — €0.00 from Acc B');
		expect(params.expense_10).toBe('2026-09-25 · Cat · 9 — €9.00 from Acc B');
		expect(params.date).toBe('–');
		for (const value of Object.values(params)) {
			expect(value).not.toBe('');
			expect(value).not.toMatch(/[\r\n\t]| {5}/);
			expect(value).not.toContain('evil');
		}
	});
});

describe('buildBriefData (D1)', () => {
	const db = env.DB;
	const NOW = new Date('2026-09-26T08:00:00Z'); // 09:00 in Dublin
	const stamp = '2026-09-26T08:00:00.000Z';

	const categories: CategoryRow[] = [
		{ id: 'cat-groc', parentId: null, name: 'Groceries', groupId: 'food', groupName: 'Food & Drinks', fullPath: 'Food & Drinks > Groceries', level: 1, archived: 0, updatedAt: stamp },
		{ id: 'cat-rest', parentId: null, name: 'Restaurant', groupId: 'food', groupName: 'Food & Drinks', fullPath: 'Food & Drinks > Restaurant', level: 1, archived: 0, updatedAt: stamp },
	];
	const tx = (id: string, date: string, categoryId: string, amountBase: number, note: string | null = null): TransactionRow => ({
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-1',
		accountName: 'Current',
		categoryId,
		recordType: 'expense',
		paymentType: 'card',
		recordState: 'cleared',
		amount: amountBase,
		currency: 'EUR',
		amountBase,
		note,
		syncedAt: stamp,
	});
	const total = (periodStart: string, periodEnd: string, closingBalance: number, closingBalanceBase: number | null, source: CashflowRow['source'] = 'auto'): CashflowRow => ({
		periodStart,
		periodEnd,
		rowType: 'TOTAL',
		accountKey: 'TOTAL',
		accountName: 'All included accounts',
		currency: 'EUR',
		closingBalance,
		closingBalanceBase,
		capturedAt: stamp,
		source,
		notes: null,
	});

	beforeEach(async () => {
		await resetDb();
		await setSettings(HH1, { timezone: 'Europe/Dublin', budget_month_start_day: '25', base_currency: 'EUR', brief_title: 'Our Brief' });
		await upsertCategories(HH1, categories);
		const base = { entityType: 'category' as const, period: 'monthly', forecastType: 'day_to_day' as const, includeInExpense: 1 as const };
		await upsertTarget(HH1, { ...base, entityId: 'cat-groc', budget: 600, includeInReport: 1 });
		await upsertTarget(HH1, { ...base, entityId: 'cat-rest', budget: 200, includeInReport: 0 });
		await upsertTransactions(HH1, [
			tx('t1', '2026-09-25', 'cat-groc', -40, 'Tesco'),
			tx('t2', '2026-09-25', 'cat-rest', -20),
			tx('t3', '2026-09-24', 'cat-groc', -500), // previous period
		]);
	});

	it('wires settings, engine, yesterday and the cash-flow trail together', async () => {
		await upsertCashflowRows(HH1, [
			total('2026-05-25', '2026-06-24', 900, 900, 'import'),
			total('2026-06-25', '2026-07-24', 1000, 1000, 'import'),
			total('2026-07-25', '2026-08-24', 5000, 1250.5), // base value wins over native
			total('2026-08-25', '2026-09-24', 1100, null), // no base value → native
		]);
		const data = await buildBriefData(HH1, await getSettings(HH1), NOW);

		expect(data).toMatchObject({ title: 'Our Brief', dateLabel: 'Sat, 26 Sep 2026', periodLabel: '25 Sep to 24 Oct 2026', currency: 'EUR' });
		expect(data.overall).toMatchObject({ budget: 800, spent: 60 });
		expect(data.reportLines.map((l) => l.name)).toEqual(['Groceries']);
		expect(data.yesterday.map((e) => [e.category, e.amountBase, e.note])).toEqual([
			['Groceries', 40, 'Tesco'],
			['Restaurant', 20, ''],
		]);
		expect(data.cashflow).toEqual([
			{ label: '25 Aug to 24 Sep 2026', closing: 1100, change: -150.5, hasPrior: true },
			{ label: '25 Jul to 24 Aug 2026', closing: 1250.5, change: 250.5, hasPrior: true },
			{ label: '25 Jun to 24 Jul 2026', closing: 1000, change: 100, hasPrior: true },
		]);

		const text = await buildDailyBriefText(HH1, await getSettings(HH1), NOW);
		expect(text).toBe(renderBriefText(data));
		expect(text).toContain('• 2026-09-25 · Groceries — €40.00 from Current — Tesco');
		expect(text).toContain('*25 Jun to 24 Jul 2026:* +€100.00 change · closing funds €1,000.00');
	});

	it('marks the only captured period as the baseline', async () => {
		await upsertCashflowRows(HH1, [total('2026-08-25', '2026-09-24', 1100, 1100)]);
		const data = await buildBriefData(HH1, await getSettings(HH1), NOW);
		expect(data.cashflow).toEqual([{ label: '25 Aug to 24 Sep 2026', closing: 1100, change: 0, hasPrior: false }]);
		expect(renderBriefText(data)).toContain('*25 Aug to 24 Sep 2026:* baseline captured · closing funds €1,100.00');
	});

	it('works on an empty database', async () => {
		await resetDb();
		const text = await buildDailyBriefText(HH1, await getSettings(HH1), NOW);
		expect(text).toContain('💰 *Family Budget Brief*');
		expect(text).toContain('No included expenses found for yesterday.');
		expect(text).toContain('No budget lines are selected for the report yet.');
		expect(text).toContain('No captured cash-flow periods yet.');
	});
});
