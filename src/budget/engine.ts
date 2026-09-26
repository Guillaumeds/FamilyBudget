/**
 * Budget engine — computes the budget table (spend, forecast, baselines, rollups) from synced
 * transactions and user-owned budget targets, replacing the POC's in-sheet formulas
 * (legacy/Code.gs setupFormulaDrivenBudgetsSheet and the formula* helpers, lines ~957–1055).
 *
 * CONTRACT FILE: other modules (whatsapp, ai, api, brief) import these types and functions.
 * Implementations may be replaced, but the exported signatures must stay stable.
 */
import {
	defaultIncludeInExpense,
	listCategories,
	listTargets,
	listTransactionsBetween,
	listTransactionsOnDate,
	type BudgetTargetRow,
	type CategoryRow,
	type TransactionRow,
} from '../db/repo';
import type { Settings } from '../db/settings';
import { roundCurrency } from '../lib/format';
import { elapsedDays, normalizeStartDay, periodForOffset, type BudgetPeriod } from '../lib/period';
import { addDays, localDate } from '../lib/tz';

export interface BudgetLine {
	rowType: 'OVERALL' | 'TYPE' | 'CATEGORY';
	/** Category id for CATEGORY rows, group id for TYPE rows, '' for OVERALL. */
	id: string;
	name: string;
	/** Full path for categories ("Food & Drinks > Groceries"), name for TYPE/OVERALL rows. */
	path: string;
	/** 0 for OVERALL/TYPE, 1 for top-level categories, 2+ for subcategories. */
	depth: number;
	groupId: string;
	groupName: string;
	forecastType: 'day_to_day' | 'recurring';
	/** Manual target for categories; filtered rollup of children for TYPE/OVERALL. */
	budget: number;
	/** Positive spend in base currency this period (expenses only; exact category match). */
	spent: number;
	remaining: number;
	/** spent / budget, 0 when budget is 0. */
	usedPct: number;
	forecast: number;
	forecastVsBudget: number;
	/** Spend in the 3 prior periods (offset -1, -2, -3). */
	baselines: [number, number, number];
	baselineAvg: number;
	includeInReport: boolean;
	includeInExpense: boolean;
}

export interface BudgetComputation {
	period: BudgetPeriod;
	todayLocal: string;
	/** OVERALL first, then TYPE rows each followed by their CATEGORY rows in display order. */
	lines: BudgetLine[];
	overall: BudgetLine;
	/** Transactions in the current period whose amount_base is NULL (missing FX rate). */
	missingFxCount: number;
}

export interface EngineInput {
	categories: CategoryRow[];
	targets: BudgetTargetRow[];
	/** Transactions in [period.startText, period.endExclusiveText). */
	current: TransactionRow[];
	/** Transactions for the three baseline periods (offset -1, -2, -3), same window semantics. */
	baselineTransactions: [TransactionRow[], TransactionRow[], TransactionRow[]];
	period: BudgetPeriod;
	todayLocal: string;
}

export interface YesterdayExpense {
	date: string;
	account: string;
	category: string;
	path: string;
	/** Positive amount in base currency (0 when the FX rate was missing). */
	amountBase: number;
	note: string;
	recordId: string;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

type Baselines = BudgetLine['baselines'];
/** The fields a line is built from; the derived ones (remaining, usedPct, ...) are computed. */
type LineBase = Omit<BudgetLine, 'remaining' | 'usedPct' | 'forecastVsBudget' | 'baselineAvg'>;

const targetKey = (entityType: BudgetTargetRow['entityType'], entityId: string) => `${entityType}:${entityId}`;

function isExpense(row: TransactionRow): boolean {
	return row.recordType?.toLowerCase() === 'expense';
}

/** Positive expense spend per category id (exact match; NULL amount_base counts as 0). Unrounded. */
function spendByCategory(rows: readonly TransactionRow[]): Map<string, number> {
	const spend = new Map<string, number>();
	for (const row of rows) {
		if (!row.categoryId || !isExpense(row)) continue;
		spend.set(row.categoryId, (spend.get(row.categoryId) ?? 0) - (row.amountBase ?? 0));
	}
	return spend;
}

/** Adds the derived columns (POC columns H, I, K, O). */
function finishLine(base: LineBase): BudgetLine {
	const [b1, b2, b3] = base.baselines;
	return {
		...base,
		remaining: roundCurrency(base.budget - base.spent),
		usedPct: base.budget > 0 ? base.spent / base.budget : 0,
		forecastVsBudget: roundCurrency(base.forecast - base.budget),
		baselineAvg: roundCurrency((b1 + b2 + b3) / 3),
	};
}

function sum(lines: readonly BudgetLine[], pick: (line: BudgetLine) => number): number {
	return roundCurrency(lines.reduce((total, line) => total + pick(line), 0));
}

/**
 * TYPE/OVERALL rollup: budget, spent and baselines over `included` lines; forecast over
 * `forecastLines` (POC formulaTypeColumnRollupExpression with requireExpenseCalculation=false for J).
 */
function rollup(included: readonly BudgetLine[], forecastLines: readonly BudgetLine[]) {
	return {
		budget: sum(included, (line) => line.budget),
		spent: sum(included, (line) => line.spent),
		forecast: sum(forecastLines, (line) => line.forecast),
		baselines: [0, 1, 2].map((i) => sum(included, (line) => line.baselines[i]!)) as Baselines,
	};
}

/**
 * Group display order: expense groups alphabetically, then income group(s), then transfer/system
 * groups. Deliberate small deviation from the POC's budgetTypeSortKey (which only special-cased
 * names containing "expense"/"income"/"transfer" and so sorted e.g. "System categories" first).
 */
function groupRank(groupName: string): number {
	if (/income/i.test(groupName)) return 1;
	if (/transfer|system/i.test(groupName)) return 2;
	return 0;
}

function categoryPath(category: CategoryRow): string {
	return category.fullPath || category.name;
}

/** Categories of one group in display order: roots by path, each followed depth-first by its descendants. */
function orderGroupCategories(categories: readonly CategoryRow[]): Array<[CategoryRow, number]> {
	const ids = new Set(categories.map((category) => category.id));
	const children = new Map<string, CategoryRow[]>();
	const roots: CategoryRow[] = [];
	for (const category of categories) {
		// A parent in another group (or archived/unknown) makes the category a root — as in the POC.
		if (category.parentId && category.parentId !== category.id && ids.has(category.parentId)) {
			children.set(category.parentId, [...(children.get(category.parentId) ?? []), category]);
		} else {
			roots.push(category);
		}
	}
	const byPath = (a: CategoryRow, b: CategoryRow) => categoryPath(a).localeCompare(categoryPath(b));
	const ordered: Array<[CategoryRow, number]> = [];
	const visit = (category: CategoryRow, depth: number) => {
		ordered.push([category, depth]);
		for (const child of (children.get(category.id) ?? []).sort(byPath)) visit(child, depth + 1);
	};
	for (const root of roots.sort(byPath)) visit(root, 1);
	return ordered;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/** Pure computation over pre-loaded rows (unit-testable without D1). */
export function computeBudget(input: EngineInput): BudgetComputation {
	const { period, todayLocal } = input;
	const targets = new Map(input.targets.map((target) => [targetKey(target.entityType, target.entityId), target]));
	const currentSpend = spendByCategory(input.current);
	const baselineSpend = input.baselineTransactions.map(spendByCategory);
	const elapsed = elapsedDays(period, todayLocal);

	// Group the active categories by BudgetBakers category group (the POC's "TYPE").
	const groups = new Map<string, { id: string; name: string; categories: CategoryRow[] }>();
	for (const category of input.categories) {
		if (category.archived) continue;
		const id = category.groupId ?? '';
		let group = groups.get(id);
		if (!group) groups.set(id, (group = { id, name: category.groupName || category.groupId || 'Other', categories: [] }));
		group.categories.push(category);
	}
	const sortedGroups = [...groups.values()].sort(
		(a, b) => groupRank(a.name) - groupRank(b.name) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
	);

	const typeLines: BudgetLine[] = [];
	const blocks: BudgetLine[][] = [];
	for (const group of sortedGroups) {
		const categoryLines = orderGroupCategories(group.categories).map(([category, depth]) => {
			const target = targets.get(targetKey('category', category.id));
			const budget = target?.budget ?? 0;
			const forecastType = target?.forecastType ?? 'day_to_day';
			const spent = roundCurrency(currentSpend.get(category.id) ?? 0);
			return finishLine({
				rowType: 'CATEGORY',
				id: category.id,
				name: category.name,
				path: categoryPath(category),
				depth,
				groupId: group.id,
				groupName: group.name,
				forecastType,
				budget,
				spent,
				// POC formulaForecast: recurring → budget; day-to-day → spent / elapsedDays × periodDays.
				forecast: forecastType === 'recurring' ? roundCurrency(budget) : roundCurrency((spent / elapsed) * period.periodDays),
				baselines: baselineSpend.map((spend) => roundCurrency(spend.get(category.id) ?? 0)) as Baselines,
				includeInReport: target ? target.includeInReport === 1 : false,
				includeInExpense: target ? target.includeInExpense === 1 : defaultIncludeInExpense(category.groupName) === 1,
			});
		});

		const target = targets.get(targetKey('group', group.id));
		const typeLine = finishLine({
			rowType: 'TYPE',
			id: group.id,
			name: group.name,
			path: group.name,
			depth: 0,
			groupId: group.id,
			groupName: group.name,
			forecastType: target?.forecastType ?? 'day_to_day',
			...rollup(
				categoryLines.filter((line) => line.includeInExpense),
				categoryLines,
			),
			includeInReport: target ? target.includeInReport === 1 : false,
			includeInExpense: target ? target.includeInExpense === 1 : defaultIncludeInExpense(group.name) === 1,
		});
		typeLines.push(typeLine);
		blocks.push([typeLine, ...categoryLines]);
	}

	const includedTypes = typeLines.filter((line) => line.includeInExpense);
	const overall = finishLine({
		rowType: 'OVERALL',
		id: '',
		name: 'Overall Budget',
		path: 'Overall Budget',
		depth: 0,
		groupId: '',
		groupName: '',
		forecastType: 'day_to_day',
		...rollup(includedTypes, includedTypes),
		includeInReport: true,
		includeInExpense: true,
	});

	return {
		period,
		todayLocal,
		lines: [overall, ...blocks.flat()],
		overall,
		missingFxCount: input.current.filter((row) => row.amountBase === null).length,
	};
}

/** Loads rows from D1 for the period at `offset` months from now, then runs computeBudget. */
export async function loadBudgetComputation(
	db: D1Database,
	settings: Settings,
	now: Date,
	offset = 0,
): Promise<BudgetComputation> {
	const startDay = normalizeStartDay(Number(settings.budget_month_start_day));
	const todayLocal = localDate(now, settings.timezone);
	const period = periodForOffset(todayLocal, startDay, offset);
	const window = (p: BudgetPeriod) => listTransactionsBetween(db, p.startText, p.endExclusiveText);
	const [categories, targets, current, b1, b2, b3] = await Promise.all([
		listCategories(db),
		listTargets(db),
		window(period),
		window(periodForOffset(todayLocal, startDay, offset - 1)),
		window(periodForOffset(todayLocal, startDay, offset - 2)),
		window(periodForOffset(todayLocal, startDay, offset - 3)),
	]);
	return computeBudget({ categories, targets, current, baselineTransactions: [b1, b2, b3], period, todayLocal });
}

/**
 * Yesterday's expense transactions (local time) whose category — or its group — has
 * include_in_expense set, sorted by category. Ports setupYesterdayExpensesSheet (~line 1099).
 */
export async function listYesterdayExpenses(
	db: D1Database,
	settings: Settings,
	now: Date,
): Promise<YesterdayExpense[]> {
	const yesterday = addDays(localDate(now, settings.timezone), -1);
	const [transactions, categories, targets] = await Promise.all([
		listTransactionsOnDate(db, yesterday),
		listCategories(db),
		listTargets(db),
	]);
	const categoriesById = new Map(categories.map((category) => [category.id, category]));
	const included = new Set(targets.filter((target) => target.includeInExpense === 1).map((t) => targetKey(t.entityType, t.entityId)));
	// POC parity (~line 1118): with no targets configured at all, every expense is listed.
	const includeAll = targets.length === 0;

	return transactions
		.filter((row) => {
			if (!isExpense(row)) return false;
			if (includeAll) return true;
			const category = row.categoryId ? categoriesById.get(row.categoryId) : undefined;
			return (
				(!!row.categoryId && included.has(targetKey('category', row.categoryId))) ||
				(!!category?.groupId && included.has(targetKey('group', category.groupId)))
			);
		})
		.map((row): YesterdayExpense => {
			const category = row.categoryId ? categoriesById.get(row.categoryId) : undefined;
			const name = category?.name ?? 'Unknown';
			return {
				date: row.date,
				account: row.accountName ?? '',
				category: name,
				path: category?.fullPath || name,
				amountBase: Math.abs(row.amountBase ?? 0),
				note: row.note ?? '',
				recordId: row.id,
			};
		})
		.sort((a, b) => a.category.localeCompare(b.category) || a.note.localeCompare(b.note));
}
