/**
 * CSV importers for POST /api/admin/import/budgets and /api/admin/import/cashflow.
 *
 * Budgets accept two formats, detected from the header row:
 *  (a) legacy — the Google Sheet "Budgets" tab export of the Apps Script POC (headers Category,
 *      Period, Forecast Type, BudgetEUR, Include in Report?, Include in Expense Calculations, ...,
 *      CategoryId, ..., Path, RowType). CATEGORY rows match by CategoryId, then Path (= our
 *      categories.full_path), then the trimmed Category name; TYPE rows match a category group name;
 *      OVERALL rows are skipped (the overall line is always a rollup).
 *  (b) generic — entity_type,name_or_path,budget,forecast_type,include_in_report,include_in_expense
 *      (entity_type 'category' or 'group'; optional period column).
 * Blank cells keep the stored value (except budget, where blank means "no target"); unspecified
 * fields fall back to the existing target, then to the defaults of ensureDefaultTargets.
 */
import {
	type BudgetTargetRow,
	type CashflowRow,
	type CategoryRow,
	type EntityType,
	type Flag,
	defaultIncludeInExpense,
	listCashflowRows,
	listCategories,
	listTargets,
	logRun,
	upsertCashflowRows,
	upsertTargets,
} from '../db/repo';
import type { Settings } from '../db/settings';
import { roundCurrency } from '../lib/format';
import { convertToBase, ensureRates } from '../lib/fx';
import { isoNow } from '../lib/tz';
import { normalizeHeader, parseCsv } from './csv';
import { HttpError, errorMessage, isDateText } from './http';

// ---------------------------------------------------------------------------------------------
// Shared cell parsers
// ---------------------------------------------------------------------------------------------

/** Parses "1,234.50", "€ 80", "80,5" (decimal comma), "" → null. Undefined when unparseable. */
export function parseAmount(raw: string): number | null | undefined {
	const text = raw.trim();
	if (text === '' || text === '-' || text === '–') return null;
	let cleaned = text.replace(/[^\d.,-]/g, '');
	if (/^-?\d+,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(',', '.');
	else cleaned = cleaned.replace(/,/g, '');
	if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
	return Number(cleaned);
}

/** TRUE/FALSE, 1/0, yes/no → flag; blank → undefined (keep); anything else → 'invalid'. */
function parseFlag(raw: string | undefined): Flag | undefined | 'invalid' {
	const text = (raw ?? '').trim().toLowerCase();
	if (text === '') return undefined;
	if (['true', '1', 'yes', 'y', 'x', '✓'].includes(text)) return 1;
	if (['false', '0', 'no', 'n'].includes(text)) return 0;
	return 'invalid';
}

/** 'Day-to-day' → day_to_day, anything matching /recur/ → recurring; blank → undefined. */
function parseForecastType(raw: string | undefined): BudgetTargetRow['forecastType'] | undefined | 'invalid' {
	const text = (raw ?? '').trim();
	if (text === '') return undefined;
	if (/recur/i.test(text)) return 'recurring';
	if (/day/i.test(text)) return 'day_to_day';
	return 'invalid';
}

function normalizePath(value: string): string {
	return value.trim().toLowerCase().replace(/\s*>\s*/g, ' > ').replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

export interface BudgetImportResult {
	format: 'legacy' | 'generic';
	imported: number;
	skipped: number;
	/** Human-readable descriptions of rows that matched nothing or had invalid values. */
	unmatched: string[];
}

interface TargetPatch {
	budget?: number | null;
	forecastType?: BudgetTargetRow['forecastType'];
	includeInReport?: Flag;
	includeInExpense?: Flag;
	period?: string;
}

class CategoryIndex {
	private readonly byId = new Map<string, CategoryRow>();
	private readonly byPath = new Map<string, CategoryRow[]>();
	private readonly byName = new Map<string, CategoryRow[]>();
	private readonly groups = new Map<string, string>(); // lower name or id → group id
	private readonly groupNames = new Map<string, string | null>(); // group id → group name

	constructor(categories: readonly CategoryRow[]) {
		// Active categories first so an archived duplicate never shadows a live one.
		const sorted = [...categories].sort((a, b) => a.archived - b.archived);
		const push = (map: Map<string, CategoryRow[]>, key: string, row: CategoryRow) => map.set(key, [...(map.get(key) ?? []), row]);
		for (const row of sorted) {
			this.byId.set(row.id, row);
			push(this.byPath, normalizePath(row.fullPath || row.name), row);
			push(this.byName, row.name.trim().toLowerCase(), row);
			if (row.groupId) {
				this.groupNames.set(row.groupId, row.groupName);
				this.groups.set(row.groupId.toLowerCase(), row.groupId);
				if (row.groupName && !this.groups.has(row.groupName.trim().toLowerCase())) this.groups.set(row.groupName.trim().toLowerCase(), row.groupId);
			}
		}
	}

	/** First unambiguous match among id, full path, name. */
	category(id: string | undefined, path: string | undefined, name: string | undefined): CategoryRow | undefined {
		if (id && this.byId.has(id.trim())) return this.byId.get(id.trim());
		for (const [map, key] of [
			[this.byPath, path ? normalizePath(path) : ''],
			[this.byName, name ? name.trim().toLowerCase() : ''],
		] as const) {
			const hits = key ? map.get(key) : undefined;
			if (hits && (hits.length === 1 || hits[0]!.archived !== hits[1]!.archived)) return hits[0];
		}
		return undefined;
	}

	group(nameOrId: string): string | undefined {
		return this.groups.get(nameOrId.trim().toLowerCase());
	}

	groupName(groupId: string): string | null {
		return this.groupNames.get(groupId) ?? null;
	}
}

function findColumn(headers: string[], ...candidates: Array<string | RegExp>): number {
	for (const candidate of candidates) {
		const index = headers.findIndex((header) => (typeof candidate === 'string' ? header === candidate : candidate.test(header)));
		if (index >= 0) return index;
	}
	return -1;
}

export async function importBudgetsCsv(db: D1Database, csv: string): Promise<BudgetImportResult> {
	const rows = parseCsv(csv);
	if (rows.length === 0) throw new HttpError(400, 'The CSV file is empty.', 'VALIDATION');
	const headers = rows[0]!.map(normalizeHeader);
	const legacy = headers.includes('rowtype') && headers.includes('category');
	const generic = headers.includes('entity_type') && headers.includes('name_or_path');
	if (!legacy && !generic) {
		throw new HttpError(
			400,
			'Unrecognised CSV header. Use entity_type,name_or_path,budget,forecast_type,include_in_report,include_in_expense — or the legacy Google Sheet Budgets tab export (with Path and RowType columns).',
			'VALIDATION',
		);
	}

	const [categories, existingTargets] = await Promise.all([listCategories(db), listTargets(db)]);
	const index = new CategoryIndex(categories);
	const existing = new Map(existingTargets.map((target) => [`${target.entityType}:${target.entityId}`, target]));

	const col = legacy
		? {
				rowType: findColumn(headers, 'rowtype'),
				name: findColumn(headers, 'category'),
				path: findColumn(headers, 'path'),
				id: findColumn(headers, 'categoryid'),
				period: findColumn(headers, 'period'),
				forecast: findColumn(headers, 'forecast type', 'expense type'),
				budget: findColumn(headers, /^budget[a-z]{0,3}$/),
				report: findColumn(headers, 'include in report'),
				expense: findColumn(headers, 'include in expense calculations', 'include in expense'),
			}
		: {
				rowType: findColumn(headers, 'entity_type'),
				name: findColumn(headers, 'name_or_path'),
				path: findColumn(headers, 'name_or_path'),
				id: -1,
				period: findColumn(headers, 'period'),
				forecast: findColumn(headers, 'forecast_type'),
				budget: findColumn(headers, 'budget'),
				report: findColumn(headers, 'include_in_report'),
				expense: findColumn(headers, 'include_in_expense'),
			};

	const patches = new Map<string, { entityType: EntityType; entityId: string; groupName: string | null; patch: TargetPatch }>();
	const unmatched: string[] = [];
	let skipped = 0;

	rows.slice(1).forEach((cells, rowIndex) => {
		const line = rowIndex + 2; // 1-based, after the header
		const cell = (column: number) => (column >= 0 ? (cells[column] ?? '') : '');
		const kind = cell(col.rowType).trim().toLowerCase();
		const name = cell(col.name).trim();
		const path = cell(col.path).trim();
		const label = path || name || `row ${line}`;

		let entityType: EntityType;
		let entityId: string | undefined;
		let groupName: string | null = null;
		if (kind === 'category') {
			entityType = 'category';
			// Generic rows may also name a category by its BudgetBakers id.
			const category = index.category((legacy ? cell(col.id) : path).trim() || undefined, path, legacy ? name : path);
			entityId = category?.id;
			groupName = category?.groupName ?? null;
		} else if (kind === 'type' || kind === 'group') {
			entityType = 'group';
			entityId = index.group(name) ?? (path ? index.group(path) : undefined);
			groupName = entityId ? index.groupName(entityId) : null;
		} else {
			skipped++; // OVERALL, blank separator rows, unknown row kinds
			return;
		}
		if (!entityId) {
			unmatched.push(`${entityType === 'group' ? 'Group' : 'Category'} "${label}" (line ${line}): no matching ${entityType} in BudgetBakers.`);
			return;
		}

		const patch: TargetPatch = {};
		const problems: string[] = [];
		if (col.budget >= 0) {
			const budget = parseAmount(cell(col.budget));
			if (budget === undefined || (budget !== null && budget < 0)) problems.push(`invalid budget "${cell(col.budget)}"`);
			else patch.budget = budget === null ? null : roundCurrency(budget);
		}
		const forecastType = parseForecastType(cell(col.forecast));
		if (forecastType === 'invalid') problems.push(`invalid forecast type "${cell(col.forecast)}"`);
		else if (forecastType) patch.forecastType = forecastType;
		const report = parseFlag(cell(col.report));
		if (report === 'invalid') problems.push(`invalid report flag "${cell(col.report)}"`);
		else if (report !== undefined) patch.includeInReport = report;
		const expense = parseFlag(cell(col.expense));
		if (expense === 'invalid') problems.push(`invalid expense flag "${cell(col.expense)}"`);
		else if (expense !== undefined) patch.includeInExpense = expense;
		const period = cell(col.period).trim().toLowerCase();
		if (period) patch.period = period.slice(0, 32);

		if (problems.length > 0) {
			unmatched.push(`"${label}" (line ${line}): ${problems.join('; ')}.`);
			return;
		}
		const key = `${entityType}:${entityId}`;
		const previous = patches.get(key)?.patch ?? {};
		patches.set(key, { entityType, entityId, groupName, patch: { ...previous, ...patch } });
	});

	const targets: BudgetTargetRow[] = [...patches.values()].map(({ entityType, entityId, groupName, patch }) => {
		const base = existing.get(`${entityType}:${entityId}`) ?? {
			entityType,
			entityId,
			period: 'monthly',
			forecastType: 'day_to_day' as const,
			budget: null,
			includeInReport: 0 as Flag,
			includeInExpense: defaultIncludeInExpense(groupName),
		};
		return { ...base, ...patch, entityType, entityId };
	});
	await upsertTargets(db, targets);

	const result: BudgetImportResult = { format: legacy ? 'legacy' : 'generic', imported: targets.length, skipped, unmatched };
	await logRun(
		db,
		unmatched.length ? 'WARN' : 'INFO',
		'import.budgets',
		`Imported ${targets.length} budget target(s) from a ${result.format} CSV; ${skipped} row(s) skipped, ${unmatched.length} unmatched/invalid.`,
	);
	return result;
}

// ---------------------------------------------------------------------------------------------
// Cash flow
// ---------------------------------------------------------------------------------------------

export interface CashflowImportResult {
	/** Distinct period_end values imported. */
	periods: number;
	/** ACCOUNT rows written. */
	accounts: number;
	/** Periods that got an 'import' TOTAL row. */
	totalsWritten: number;
	/** Periods whose TOTAL was left alone because an automatic capture exists. */
	totalsSkipped: number;
	/** ACCOUNT rows stored without a base-currency amount (no FX rate). */
	missingFx: number;
}

/** "Revolut Joint (EUR)" → "revolut-joint-eur". */
export function slugify(value: string): string {
	return value
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

const CASHFLOW_COLUMNS = ['period_start', 'period_end', 'account_name', 'currency', 'closing_balance'] as const;

export async function importCashflowCsv(db: D1Database, settings: Settings, csv: string): Promise<CashflowImportResult> {
	const rows = parseCsv(csv);
	if (rows.length < 2) throw new HttpError(400, 'The CSV file has no data rows.', 'VALIDATION');
	const headers = rows[0]!.map(normalizeHeader);
	const missingColumns = CASHFLOW_COLUMNS.filter((column) => !headers.includes(column));
	if (missingColumns.length > 0) {
		throw new HttpError(
			400,
			`Missing column(s): ${missingColumns.join(', ')}. Expected period_start,period_end,account_name,currency,closing_balance[,closing_balance_base][,notes].`,
			'VALIDATION',
		);
	}
	const at = (name: string) => headers.indexOf(name);
	const baseColumn = at('closing_balance_base');
	const notesColumn = at('notes');
	const base = settings.base_currency.toUpperCase();
	const capturedAt = isoNow();

	interface Parsed extends Omit<CashflowRow, 'closingBalanceBase'> {
		closingBalanceBase: number | null | undefined;
	}
	const parsed = new Map<string, Parsed>();
	const errors: string[] = [];
	rows.slice(1).forEach((cells, rowIndex) => {
		const line = rowIndex + 2;
		const cell = (column: number) => (column >= 0 ? (cells[column] ?? '').trim() : '');
		const periodStart = cell(at('period_start'));
		const periodEnd = cell(at('period_end'));
		const accountName = cell(at('account_name'));
		const currency = cell(at('currency')).toUpperCase();
		const closing = parseAmount(cell(at('closing_balance')));
		const closingBase = baseColumn >= 0 ? parseAmount(cell(baseColumn)) : null;
		const problems: string[] = [];
		if (!isDateText(periodStart)) problems.push('period_start must be yyyy-mm-dd');
		if (!isDateText(periodEnd)) problems.push('period_end must be yyyy-mm-dd');
		if (isDateText(periodStart) && isDateText(periodEnd) && periodStart > periodEnd) problems.push('period_start is after period_end');
		if (!slugify(accountName)) problems.push('account_name is empty');
		if (!/^[A-Z]{3}$/.test(currency)) problems.push('currency must be a 3-letter code');
		if (closing === undefined || closing === null) problems.push('closing_balance must be a number');
		if (closingBase === undefined) problems.push('closing_balance_base must be a number or blank');
		if (problems.length > 0) {
			errors.push(`Line ${line}: ${problems.join('; ')}.`);
			return;
		}
		const accountKey = slugify(accountName);
		parsed.set(`${periodEnd}|${accountKey}`, {
			periodStart,
			periodEnd,
			rowType: 'ACCOUNT',
			accountKey,
			accountName,
			currency,
			closingBalance: roundCurrency(closing!),
			closingBalanceBase: closingBase === null ? (currency === base ? roundCurrency(closing!) : undefined) : roundCurrency(closingBase!),
			capturedAt,
			source: 'import',
			notes: cell(notesColumn) || null,
		});
	});
	if (errors.length > 0) {
		throw new HttpError(400, `The CSV has ${errors.length} invalid row(s); nothing was imported.`, 'VALIDATION', { details: errors.slice(0, 20) });
	}

	// Convert rows without an explicit base amount at their period end (fetching missing rates first).
	const toConvert = [...parsed.values()].filter((row) => row.closingBalanceBase === undefined);
	if (toConvert.length > 0) {
		const dates = toConvert.map((row) => row.periodEnd).sort();
		try {
			await ensureRates(db, base, [...new Set(toConvert.map((row) => row.currency!))], dates[0]!, dates[dates.length - 1]!);
		} catch (error) {
			await logRun(db, 'WARN', 'import.cashflow', `FX fetch failed, converting with cached rates only: ${errorMessage(error)}`);
		}
		const rates = new Map<string, Promise<number | null>>();
		for (const row of toConvert) {
			const key = `${row.currency}|${row.periodEnd}`;
			let rate = rates.get(key);
			if (!rate) rates.set(key, (rate = convertToBase(db, 1, row.currency!, row.periodEnd, base)));
			const rateToBase = await rate;
			row.closingBalanceBase = rateToBase === null ? null : roundCurrency(row.closingBalance * rateToBase);
		}
	}
	const accountRows: CashflowRow[] = [...parsed.values()].map((row) => ({ ...row, closingBalanceBase: row.closingBalanceBase ?? null }));
	await upsertCashflowRows(db, accountRows);

	// One TOTAL per imported period — unless an automatic capture already owns that period's TOTAL.
	const periodStarts = new Map<string, string>();
	for (const row of accountRows) if (!periodStarts.has(row.periodEnd)) periodStarts.set(row.periodEnd, row.periodStart);
	const stored = await listCashflowRows(db);
	const totals: CashflowRow[] = [];
	let totalsSkipped = 0;
	for (const [periodEnd, periodStart] of periodStarts) {
		const periodRows = stored.filter((row) => row.periodEnd === periodEnd);
		if (periodRows.some((row) => row.rowType === 'TOTAL' && row.source === 'auto')) {
			totalsSkipped++;
			continue;
		}
		const accounts = periodRows.filter((row) => row.rowType === 'ACCOUNT');
		const total = roundCurrency(accounts.reduce((sum, row) => sum + (row.closingBalanceBase ?? 0), 0));
		totals.push({
			periodStart,
			periodEnd,
			rowType: 'TOTAL',
			accountKey: 'TOTAL',
			accountName: 'All included accounts',
			currency: base,
			closingBalance: total,
			closingBalanceBase: total,
			capturedAt,
			source: 'import',
			notes: `Sum of ${accounts.length} imported account row(s)`,
		});
	}
	await upsertCashflowRows(db, totals);

	const missingFx = accountRows.filter((row) => row.closingBalanceBase === null).length;
	const result: CashflowImportResult = {
		periods: periodStarts.size,
		accounts: accountRows.length,
		totalsWritten: totals.length,
		totalsSkipped,
		missingFx,
	};
	await logRun(
		db,
		missingFx ? 'WARN' : 'INFO',
		'import.cashflow',
		`Imported ${result.accounts} cash-flow account row(s) across ${result.periods} period(s); ${result.totalsWritten} TOTAL row(s) written, ` +
			`${totalsSkipped} kept (automatic capture exists)${missingFx ? `, ${missingFx} row(s) without an FX rate counted as 0` : ''}.`,
	);
	return result;
}
