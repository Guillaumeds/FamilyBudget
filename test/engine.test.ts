import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { computeBudget, listYesterdayExpenses, loadBudgetComputation, type BudgetLine, type EngineInput } from '../src/budget/engine';
import {
	type BudgetTargetRow,
	type CategoryRow,
	type TransactionRow,
	upsertCategories,
	upsertTarget,
	upsertTransactions,
} from '../src/db/repo';
import { getSettings, setSettings } from '../src/db/settings';
import { periodForOffset } from '../src/lib/period';
import { resetDb } from './helpers';

const NOW = '2026-09-04T10:00:00.000Z';

function category(id: string, name: string, groupId: string, groupName: string, overrides: Partial<CategoryRow> = {}): CategoryRow {
	return { id, parentId: null, name, groupId, groupName, fullPath: `${groupName} > ${name}`, level: 1, archived: 0, updatedAt: NOW, ...overrides };
}

function target(entityType: BudgetTargetRow['entityType'], entityId: string, overrides: Partial<BudgetTargetRow> = {}): BudgetTargetRow {
	return { entityType, entityId, period: 'monthly', forecastType: 'day_to_day', budget: null, includeInReport: 0, includeInExpense: 1, ...overrides };
}

let seq = 0;
function tx(categoryId: string, amountBase: number | null, overrides: Partial<TransactionRow> = {}): TransactionRow {
	const date = overrides.date ?? '2026-09-01';
	return {
		id: `t${++seq}`,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-1',
		accountName: 'Current',
		categoryId,
		recordType: amountBase !== null && amountBase > 0 ? 'income' : 'expense',
		paymentType: 'card',
		recordState: 'cleared',
		amount: amountBase ?? -1,
		currency: 'EUR',
		amountBase,
		note: null,
		syncedAt: NOW,
		...overrides,
	};
}

// Budget period 25 Aug – 24 Sep 2026 (31 days); today 4 Sep → 11 days elapsed.
const PERIOD = periodForOffset('2026-09-04', 25, 0);
const TODAY = '2026-09-04';

const CATEGORIES: CategoryRow[] = [
	// Deliberately shuffled — the engine orders them.
	category('cat-transfer', 'Transfer', 'sys', 'System categories'),
	category('cat-rest', 'Restaurant', 'food', 'Food & Drinks'),
	category('cat-organic', 'Organic', 'food', 'Food & Drinks', { parentId: 'cat-groc', fullPath: 'Food & Drinks > Groceries > Organic', level: 2 }),
	category('cat-salary', 'Salary', 'inc', 'Income'),
	category('cat-ins', 'Insurance', 'veh', 'Vehicle'),
	category('cat-groc', 'Groceries', 'food', 'Food & Drinks'),
	category('cat-old', 'Old stuff', 'food', 'Food & Drinks', { archived: 1 }),
	category('cat-fuel', 'Fuel', 'veh', 'Vehicle'),
	category('cat-bar', 'Bar', 'food', 'Food & Drinks'),
];

const TARGETS: BudgetTargetRow[] = [
	target('category', 'cat-groc', { budget: 600, includeInReport: 1 }),
	target('category', 'cat-organic', { budget: 100, includeInReport: 1 }),
	target('category', 'cat-rest', { budget: 200 }),
	target('category', 'cat-bar', { budget: 50, includeInReport: 1, includeInExpense: 0 }),
	target('category', 'cat-ins', { budget: 90, forecastType: 'recurring', includeInReport: 1 }),
	// cat-fuel, cat-salary, cat-transfer: no target row → defaults.
	target('group', 'food', { includeInReport: 1 }),
	target('group', 'veh'),
	target('group', 'inc', { includeInExpense: 0 }),
	// 'sys' group: no target row → default excluded ("system").
];

function input(overrides: Partial<EngineInput> = {}): EngineInput {
	return {
		categories: CATEGORIES,
		targets: TARGETS,
		current: [
			tx('cat-groc', -80),
			tx('cat-groc', -30),
			tx('cat-groc', 10, { note: 'refund (income) — not an expense' }),
			tx('cat-organic', -22),
			tx('cat-rest', -33),
			tx('cat-rest', null, { amount: -200, currency: 'ZAR' }), // missing FX rate → 0
			tx('cat-bar', -11),
			tx('cat-ins', -45),
			tx('cat-fuel', -55),
			tx('cat-salary', 3000),
			tx('cat-transfer', -500),
			tx('cat-old', -7),
		],
		baselineTransactions: [
			[tx('cat-groc', -100), tx('cat-bar', -20), tx('cat-fuel', -40)],
			[tx('cat-groc', -200), tx('cat-organic', -10)],
			[tx('cat-groc', -300)],
		],
		period: PERIOD,
		todayLocal: TODAY,
		...overrides,
	};
}

function byId(lines: BudgetLine[], rowType: BudgetLine['rowType'], id: string): BudgetLine {
	const line = lines.find((l) => l.rowType === rowType && l.id === id);
	if (!line) throw new Error(`no ${rowType} line ${id}`);
	return line;
}

describe('computeBudget', () => {
	const result = computeBudget(input());
	const cat = (id: string) => byId(result.lines, 'CATEGORY', id);
	const type = (id: string) => byId(result.lines, 'TYPE', id);

	it('sanity-checks the fixture period', () => {
		expect(PERIOD).toMatchObject({ startText: '2026-08-25', endExclusiveText: '2026-09-25', periodDays: 31 });
		expect(result.period).toBe(PERIOD);
		expect(result.todayLocal).toBe(TODAY);
	});

	it('orders lines: OVERALL, expense groups A–Z, income, transfer/system; roots by path with children depth-first', () => {
		expect(result.lines.map((l) => [l.rowType, l.name, l.depth])).toEqual([
			['OVERALL', 'Overall Budget', 0],
			['TYPE', 'Food & Drinks', 0],
			['CATEGORY', 'Bar', 1],
			['CATEGORY', 'Groceries', 1],
			['CATEGORY', 'Organic', 2],
			['CATEGORY', 'Restaurant', 1],
			['TYPE', 'Vehicle', 0],
			['CATEGORY', 'Fuel', 1],
			['CATEGORY', 'Insurance', 1],
			['TYPE', 'Income', 0],
			['CATEGORY', 'Salary', 1],
			['TYPE', 'System categories', 0],
			['CATEGORY', 'Transfer', 1],
		]);
		expect(result.lines[0]).toBe(result.overall);
		expect(result.lines.some((l) => l.id === 'cat-old')).toBe(false); // archived: skipped entirely
	});

	it('fills identity fields for each row type', () => {
		expect(cat('cat-organic')).toMatchObject({ path: 'Food & Drinks > Groceries > Organic', groupId: 'food', groupName: 'Food & Drinks' });
		expect(type('veh')).toMatchObject({ id: 'veh', name: 'Vehicle', path: 'Vehicle', groupId: 'veh', groupName: 'Vehicle', depth: 0 });
		expect(result.overall).toMatchObject({ id: '', name: 'Overall Budget', path: 'Overall Budget', forecastType: 'day_to_day', includeInReport: true, includeInExpense: true });
	});

	it('counts expense spend by exact category id only (no parent aggregation, income ignored, NULL FX as 0)', () => {
		expect(cat('cat-groc').spent).toBe(110); // −80 −30; the +10 income row does not count
		expect(cat('cat-organic').spent).toBe(22); // not rolled into Groceries
		expect(cat('cat-rest').spent).toBe(33); // ZAR row without amount_base counts 0
		expect(cat('cat-salary').spent).toBe(0);
		expect(result.missingFxCount).toBe(1);
	});

	it('derives remaining, used % and forecast vs budget on category lines', () => {
		expect(cat('cat-groc')).toMatchObject({ budget: 600, remaining: 490, usedPct: 110 / 600, forecast: 310, forecastVsBudget: -290 });
		expect(cat('cat-fuel')).toMatchObject({ budget: 0, usedPct: 0, remaining: -55 });
	});

	it('forecasts day-to-day lines as spent / elapsed days × period days, recurring lines as the budget', () => {
		// 11 days elapsed of 31.
		expect(cat('cat-groc').forecast).toBe(310); // 110 / 11 × 31
		expect(cat('cat-organic').forecast).toBe(62); // 22 / 11 × 31
		expect(cat('cat-transfer').forecast).toBe(1409.09); // 500 / 11 × 31 = 1409.0909…
		expect(cat('cat-ins')).toMatchObject({ forecastType: 'recurring', spent: 45, forecast: 90, forecastVsBudget: 0 });

		// After the period has ended the elapsed days are capped at the full period → forecast = spent.
		const closed = computeBudget(input({ todayLocal: '2026-10-10' }));
		expect(byId(closed.lines, 'CATEGORY', 'cat-groc').forecast).toBe(110);
		// On the first day, one day has elapsed.
		const firstDay = computeBudget(input({ todayLocal: '2026-08-25' }));
		expect(byId(firstDay.lines, 'CATEGORY', 'cat-groc').forecast).toBe(3410);
	});

	it('computes baselines from the three prior periods and their average', () => {
		expect(cat('cat-groc')).toMatchObject({ baselines: [100, 200, 300], baselineAvg: 200 });
		expect(cat('cat-organic')).toMatchObject({ baselines: [0, 10, 0], baselineAvg: 3.33 });
		expect(cat('cat-fuel')).toMatchObject({ baselines: [40, 0, 0], baselineAvg: 13.33 });
	});

	it('uses target flags, and defaults (not in report; expense unless income/transfer/system) without a target', () => {
		expect(cat('cat-groc')).toMatchObject({ includeInReport: true, includeInExpense: true });
		expect(cat('cat-bar')).toMatchObject({ includeInReport: true, includeInExpense: false });
		expect(cat('cat-fuel')).toMatchObject({ includeInReport: false, includeInExpense: true, budget: 0, forecastType: 'day_to_day' });
		expect(cat('cat-salary')).toMatchObject({ includeInReport: false, includeInExpense: false });
		expect(cat('cat-transfer')).toMatchObject({ includeInReport: false, includeInExpense: false });
		expect(type('food')).toMatchObject({ includeInReport: true, includeInExpense: true });
		expect(type('inc')).toMatchObject({ includeInReport: false, includeInExpense: false });
		expect(type('sys')).toMatchObject({ includeInReport: false, includeInExpense: false });
	});

	it('rolls TYPE budget/spent/baselines over expense-included categories, but forecast over all of them', () => {
		// Bar (budget 50, spent 11, forecast 31, baseline 20) is excluded from expense calculations.
		expect(type('food')).toMatchObject({
			budget: 900, // 600 + 100 + 200
			spent: 165, // 110 + 22 + 33
			remaining: 735,
			usedPct: 165 / 900,
			forecast: 496, // 310 + 62 + 93 + 31 (Bar included)
			forecastVsBudget: -404,
			baselines: [100, 210, 300],
			baselineAvg: 203.33,
		});
		expect(type('veh')).toMatchObject({ budget: 90, spent: 100, forecast: 245, baselines: [40, 0, 0] });
		// Transfer is excluded → nothing in budget/spent, but its forecast still rolls up.
		expect(type('sys')).toMatchObject({ budget: 0, spent: 0, forecast: 1409.09, usedPct: 0 });
	});

	it('rolls OVERALL over expense-included TYPE lines only', () => {
		expect(result.overall).toMatchObject({
			budget: 990, // Food 900 + Vehicle 90
			spent: 265, // 165 + 100
			remaining: 725,
			usedPct: 265 / 990,
			forecast: 741, // 496 + 245 — System categories' 1409.09 excluded
			forecastVsBudget: -249,
			baselines: [140, 210, 300],
			baselineAvg: 216.67,
		});
	});

	it('treats a category whose parent is in another group as a root, and handles empty input', () => {
		const moved = computeBudget(
			input({ categories: [...CATEGORIES, category('cat-kids', 'Kids food', 'veh', 'Vehicle', { parentId: 'cat-groc', fullPath: 'Vehicle > Kids food' })] }),
		);
		expect(byId(moved.lines, 'CATEGORY', 'cat-kids')).toMatchObject({ depth: 1, groupId: 'veh' });

		const empty = computeBudget(input({ categories: [], targets: [], current: [], baselineTransactions: [[], [], []] }));
		expect(empty.lines).toEqual([empty.overall]);
		expect(empty.overall).toMatchObject({ budget: 0, spent: 0, forecast: 0, usedPct: 0, baselines: [0, 0, 0] });
		expect(empty.missingFxCount).toBe(0);
	});
});

describe('with D1', () => {
	const db = env.DB;

	beforeEach(async () => {
		await resetDb();
		await setSettings(db, { timezone: 'Europe/Dublin', budget_month_start_day: '25' });
		await upsertCategories(db, CATEGORIES);
		for (const row of TARGETS) await upsertTarget(db, row);
	});

	it('loadBudgetComputation loads the current and three baseline periods from the settings', async () => {
		await upsertTransactions(db, [
			tx('cat-groc', -110, { date: '2026-08-25' }), // first day of the current period
			tx('cat-groc', -1, { date: '2026-09-25' }), // next period: ignored
			tx('cat-groc', -100, { date: '2026-08-24' }), // offset −1 (25 Jul – 24 Aug)
			tx('cat-groc', -200, { date: '2026-06-25' }), // offset −2 (25 Jun – 24 Jul)
			tx('cat-groc', -300, { date: '2026-05-25' }), // offset −3 (25 May – 24 Jun)
			tx('cat-groc', -999, { date: '2026-05-24' }), // offset −4: ignored
			tx('cat-rest', null, { date: '2026-09-01', currency: 'ZAR' }),
		]);
		const result = await loadBudgetComputation(db, await getSettings(db), new Date(NOW));

		expect(result.todayLocal).toBe('2026-09-04');
		expect(result.period.label).toBe('25 Aug to 24 Sep 2026');
		expect(byId(result.lines, 'CATEGORY', 'cat-groc')).toMatchObject({ spent: 110, forecast: 310, baselines: [100, 200, 300] });
		expect(result.missingFxCount).toBe(1);

		const previous = await loadBudgetComputation(db, await getSettings(db), new Date(NOW), -1);
		expect(previous.period.label).toBe('25 Jul to 24 Aug 2026');
		expect(byId(previous.lines, 'CATEGORY', 'cat-groc')).toMatchObject({ spent: 100, forecast: 100, baselines: [200, 300, 999] });
	});

	it('listYesterdayExpenses keeps included expenses of the local yesterday, sorted by category then note', async () => {
		await upsertTransactions(db, [
			tx('cat-rest', -12.5, { date: '2026-09-26', note: 'Lunch', accountName: 'Card' }),
			tx('cat-groc', -40, { date: '2026-09-26', note: 'Tesco' }),
			tx('cat-groc', null, { date: '2026-09-26', note: 'Aldi', currency: 'ZAR', amount: -100 }),
			tx('cat-bar', -6, { date: '2026-09-26' }), // category excluded, group included → listed
			tx('cat-transfer', -500, { date: '2026-09-26' }), // no category target, group has none either → excluded
			tx('cat-salary', 3000, { date: '2026-09-26' }), // income
			tx('cat-groc', -99, { date: '2026-09-25' }), // not yesterday
			tx('cat-groc', -98, { date: '2026-09-27' }), // today
		]);
		// 23:30 UTC on 26 Sep is already 27 Sep in Dublin (UTC+1) → yesterday is 26 Sep.
		const expenses = await listYesterdayExpenses(db, await getSettings(db), new Date('2026-09-26T23:30:00Z'));

		expect(expenses.map((e) => [e.category, e.note, e.amountBase])).toEqual([
			['Bar', '', 6],
			['Groceries', 'Aldi', 0],
			['Groceries', 'Tesco', 40],
			['Restaurant', 'Lunch', 12.5],
		]);
		expect(expenses[3]).toMatchObject({ date: '2026-09-26', account: 'Card', path: 'Food & Drinks > Restaurant' });
		expect(expenses[3]!.recordId).toMatch(/^t\d+$/);
	});

	it('listYesterdayExpenses includes every expense when no targets exist at all', async () => {
		await db.prepare('DELETE FROM budget_targets').run();
		await upsertTransactions(db, [tx('cat-transfer', -500, { date: '2026-09-03' }), tx('cat-salary', 3000, { date: '2026-09-03' })]);
		const expenses = await listYesterdayExpenses(db, await getSettings(db), new Date(NOW));
		expect(expenses.map((e) => e.category)).toEqual(['Transfer']);
	});
});
