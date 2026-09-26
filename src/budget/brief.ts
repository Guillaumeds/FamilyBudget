/**
 * Daily brief — renders the WhatsApp daily budget brief, porting the POC's
 * buildFamilyBudgetBriefMessage / formatSummaryBudgetLineForWhatsApp (legacy/Code.gs ~1186–1277)
 * byte-for-byte, plus the named-parameter payload for the approved WhatsApp template.
 *
 * CONTRACT FILE: whatsapp/client.ts and api/routes.ts import these types and functions.
 * Implementations may be replaced, but the exported signatures must stay stable.
 */
import { listCashflowTotals } from '../db/repo';
import type { Settings } from '../db/settings';
import type { Tenant } from '../db/tenant';
import { categoryEmoji, formatMoney, roundCurrency, sanitizeTemplateParam } from '../lib/format';
import { briefDateLabel, MONTH_SHORT, parseDateText } from '../lib/tz';
import { listYesterdayExpenses, loadBudgetComputation, type BudgetLine, type YesterdayExpense } from './engine';

export interface CashflowBriefEntry {
	/** Period label, e.g. "25 Aug to 24 Sep 2026". */
	label: string;
	/** Closing funds in base currency. */
	closing: number;
	/** Change vs the previous captured period (0 when hasPrior is false). */
	change: number;
	hasPrior: boolean;
}

export interface BriefData {
	/** brief_title setting, default "Family Budget Brief". */
	title: string;
	/** e.g. "Fri, 26 Sep 2026" in the configured timezone. */
	dateLabel: string;
	/** Current budget period label. */
	periodLabel: string;
	/** base_currency setting. */
	currency: string;
	yesterday: YesterdayExpense[];
	overall: BudgetLine;
	/** Lines with includeInReport, excluding OVERALL, in engine display order. */
	reportLines: BudgetLine[];
	/** Last captured cash-flow periods, newest first (up to 3). */
	cashflow: CashflowBriefEntry[];
}

const RULE = '━━━━━━━━━━━━━━━━━━';
/** Filler for unused template slots — Meta rejects empty parameters. */
const EMPTY_PARAM = '–';
const TEMPLATE_EXPENSE_SLOTS = 10;
const CASHFLOW_ENTRIES = 3;

/** "25 Aug to 24 Sep 2026" — same format as BudgetPeriod.label (lib/period.ts). */
function periodLabel(startText: string, endText: string): string {
	const start = parseDateText(startText);
	const end = parseDateText(endText);
	const dd = (day: number) => String(day).padStart(2, '0');
	return `${dd(start.day)} ${MONTH_SHORT[start.month - 1]} to ${dd(end.day)} ${MONTH_SHORT[end.month - 1]} ${end.year}`;
}

/** One expense as used by both the text brief and the template ("{date} · {category} — {amount} from {account}"). */
function expenseSummary(expense: YesterdayExpense, currency: string): string {
	return `${expense.date} · ${expense.category} — ${formatMoney(expense.amountBase, currency)} from ${expense.account}`;
}

/** Loads everything the brief needs from D1. */
export async function buildBriefData(t: Tenant, settings: Settings, now: Date): Promise<BriefData> {
	const [computation, yesterday, totals] = await Promise.all([
		loadBudgetComputation(t, settings, now, 0),
		listYesterdayExpenses(t, settings, now),
		// One more than shown, so the oldest shown period still has a prior balance to compare with.
		listCashflowTotals(t, CASHFLOW_ENTRIES + 1),
	]);

	// POC getLastCompletedCashFlowPeriodsFromSheet: oldest first to compute changes, then newest first.
	const ascending = [...totals].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
	const closings = ascending.map((row) => row.closingBalanceBase ?? row.closingBalance);
	const cashflow = ascending
		.map(
			(row, index): CashflowBriefEntry => ({
				label: periodLabel(row.periodStart, row.periodEnd),
				closing: closings[index]!,
				change: index > 0 ? roundCurrency(closings[index]! - closings[index - 1]!) : 0,
				hasPrior: index > 0,
			}),
		)
		.reverse()
		.slice(0, CASHFLOW_ENTRIES);

	return {
		title: settings.brief_title,
		dateLabel: briefDateLabel(now, settings.timezone),
		periodLabel: computation.period.label,
		currency: settings.base_currency,
		yesterday,
		overall: computation.overall,
		reportLines: computation.lines.filter((line) => line.includeInReport && line.rowType !== 'OVERALL'),
		cashflow,
	};
}

/** The full multi-line WhatsApp text (free-form message inside the 24h service window). */
export function renderBriefText(data: BriefData): string {
	const money = (value: number) => formatMoney(value, data.currency);
	const { overall } = data;

	const yesterdayBlocks = data.yesterday.map(
		(expense) => `• ${expenseSummary(expense, data.currency)}${expense.note ? ` — ${expense.note}` : ''}`,
	);
	// POC formatSummaryBudgetLineForWhatsApp, indenting subcategories two spaces per level.
	const budgetBlocks = data.reportLines.map((line) => {
		const indent = '  '.repeat(Math.max(0, line.depth - 1));
		return [
			`${indent}${categoryEmoji(line.name, line.groupName)} *${line.name}*`,
			`${indent}Spent: ${money(line.spent)} / ${money(line.budget)}`,
			`${indent}Forecast: ${money(line.forecast)}`,
		].join('\n');
	});
	const cashflowBlocks = data.cashflow.map((entry) => {
		const change = entry.hasPrior
			? `${roundCurrency(entry.change) < 0 ? '-' : '+'}${money(Math.abs(entry.change))} change`
			: 'baseline captured';
		return `*${entry.label}:* ${change} · closing funds ${money(entry.closing)}`;
	});

	return [
		`💰 *${data.title}*`,
		`${data.dateLabel} · *${data.periodLabel}*`,
		'',
		RULE,
		'*Yesterday’s Expenses*',
		'',
		yesterdayBlocks.length ? yesterdayBlocks.join('\n') : 'No included expenses found for yesterday.',
		'',
		RULE,
		'📊 *Overall*',
		`Spent: *${money(overall.spent)}* / ${money(overall.budget)}`,
		`Remaining: ${money(overall.remaining)} · Forecast: ${money(overall.forecast)}`,
		RULE,
		'',
		budgetBlocks.length ? budgetBlocks.join('\n\n') : 'No budget lines are selected for the report yet.',
		'',
		RULE,
		'*Cash Flow*',
		'',
		cashflowBlocks.length ? cashflowBlocks.join('\n') : 'No captured cash-flow periods yet.',
	].join('\n');
}

/**
 * Named template parameters for the approved daily template. Keys: date, expense_1..expense_10,
 * overall_spent, overall_remaining, overall_forecast. Every value is non-empty (unused expense
 * slots are '–'), single-line, and sanitized for Meta's template-parameter rules.
 */
export function renderTemplateParams(data: BriefData): Record<string, string> {
	const money = (value: number) => formatMoney(value, data.currency);
	const param = (value: string) => sanitizeTemplateParam(value) || EMPTY_PARAM;
	const params: Record<string, string> = { date: param(data.dateLabel) };
	for (let slot = 0; slot < TEMPLATE_EXPENSE_SLOTS; slot++) {
		const expense = data.yesterday[slot];
		params[`expense_${slot + 1}`] = expense ? param(expenseSummary(expense, data.currency)) : EMPTY_PARAM;
	}
	params.overall_spent = param(`${money(data.overall.spent)} of ${money(data.overall.budget)}`);
	params.overall_remaining = param(money(data.overall.remaining));
	params.overall_forecast = param(money(data.overall.forecast));
	return params;
}

/** Convenience: buildBriefData + renderBriefText. */
export async function buildDailyBriefText(t: Tenant, settings: Settings, now: Date): Promise<string> {
	return renderBriefText(await buildBriefData(t, settings, now));
}
