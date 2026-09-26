/**
 * Claude Q&A over WhatsApp: a plain-fetch Messages API client with a small manual tool-use loop whose
 * tools read D1 (transactions, budget computation, cash-flow history, categories).
 *
 * Anthropic docs relied on:
 *   - https://platform.claude.com/docs/en/api/messages — POST /v1/messages with `x-api-key`,
 *     `anthropic-version: 2023-06-01`, `content-type: application/json`; `stop_reason`.
 *   - https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls — on
 *     `stop_reason: "tool_use"` append the assistant `content` unchanged, then one user message whose
 *     content starts with a `tool_result` block ({tool_use_id, content, is_error?}) per `tool_use`.
 *
 * Replaces the POC's agent-session polling (legacy/Code.gs callClaudeFamilyBudgetAssistant ~1702);
 * reply shaping ports formatClaudeReplyForWhatsApp (~1900).
 */
import { loadBudgetComputation } from '../budget/engine';
import { listCashflowTotals, listCategories, listTransactionsBetween } from '../db/repo';
import { getHousehold } from '../db/households';
import { getSettings, type Settings } from '../db/settings';
import type { Tenant } from '../db/tenant';
import type { Env } from '../env';
import { roundCurrency } from '../lib/format';
import { normalizeStartDay, periodForOffset } from '../lib/period';
import { addDays, briefDateLabel, localDate, parseDateText } from '../lib/tz';
import { getAiKey } from '../wallet/token';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 1500;
/** Maximum Messages API calls per question. */
export const MAX_ITERATIONS = 6;
const TOOL_RESULT_MAX_CHARS = 40_000;
const REPLY_MAX_CHARS = 3500;
const REPLY_SHORTENED_SUFFIX = '\n\n…reply shortened for WhatsApp.';
/**
 * Wall-clock budget for the whole loop. The webhook runs this inside ctx.waitUntil(), which Workers
 * cancels 30s after the response was sent — stopping earlier leaves time to send a coded error reply.
 */
export const AI_TIME_BUDGET_MS = 22_000;

export type AssistantErrorCode =
	| 'ERR_AI_CONFIG'
	| 'ERR_AI_AUTH'
	| 'ERR_AI_RATE_LIMIT'
	| 'ERR_AI_ERROR'
	| 'ERR_AI_TIMEOUT'
	| 'ERR_AI_TOOL_LIMIT'
	| 'ERR_AI_EMPTY_REPLY';

export class AssistantError extends Error {
	readonly code: AssistantErrorCode;
	readonly status?: number;
	/** Anthropic `request-id` response header, for support requests. */
	readonly requestId?: string;

	constructor(code: AssistantErrorCode, message: string, details: { status?: number; requestId?: string } = {}) {
		super(message);
		this.name = 'AssistantError';
		this.code = code;
		this.status = details.status;
		this.requestId = details.requestId;
	}
}

// ---------------------------------------------------------------------------------------------
// Wire types (subset of the Messages API used here)
// ---------------------------------------------------------------------------------------------

interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: unknown;
}
type ContentBlock = { type: 'text'; text: string } | ToolUseBlock | { type: string; [key: string]: unknown };
interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
	is_error?: boolean;
}
interface MessageParam {
	role: 'user' | 'assistant';
	content: string | ContentBlock[] | ToolResultBlock[];
}
interface MessagesResponse {
	content: ContentBlock[];
	stop_reason: string | null;
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

const TOOLS = [
	{
		name: 'query_transactions',
		description:
			'List individual transactions (synced from BudgetBakers) between two local dates, newest first, with optional ' +
			'case-insensitive filters. Defaults to the current budget period. amountBase is in the base currency and signed: ' +
			'expenses are negative, income positive. The result also has `matched` (rows matching all filters) and ' +
			'`totalAmountBase` (sum over ALL matched rows, not only the returned ones) — use them for totals.',
		input_schema: {
			type: 'object',
			properties: {
				start_date: { type: 'string', description: 'First day, inclusive (yyyy-mm-dd). Default: start of the current budget period.' },
				end_date: { type: 'string', description: 'Last day, inclusive (yyyy-mm-dd). Default: end of the current budget period.' },
				category_contains: { type: 'string', description: 'Substring of the category name, full path or group name.' },
				account_contains: { type: 'string', description: 'Substring of the account name.' },
				note_contains: { type: 'string', description: 'Substring of the transaction note.' },
				record_type: { type: 'string', enum: ['expense', 'income'], description: 'Only expenses or only income.' },
				limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum rows to return (default 50, max 100).' },
			},
		},
	},
	{
		name: 'get_budget_summary',
		description:
			"The family's budget table for one budget period: per line (OVERALL, category groups as TYPE, categories) the " +
			'budget target, amount spent, remaining, and end-of-period forecast, in the base currency. The budget targets here ' +
			'are authoritative — they are maintained in this app and do not exist in BudgetBakers. includeInReport marks the ' +
			'lines the family tracks in the daily brief.',
		input_schema: {
			type: 'object',
			properties: {
				period_offset: {
					type: 'integer',
					description: 'Budget period relative to the current one: 0 = current (default), -1 = previous, -2 = two periods ago, ...',
				},
			},
		},
	},
	{
		name: 'get_cashflow_history',
		description:
			'Total closing balance (all included accounts, base currency) at the end of recent budget periods, newest first. ' +
			'Use it for savings / cash-flow trend questions.',
		input_schema: {
			type: 'object',
			properties: {
				limit: { type: 'integer', minimum: 1, maximum: 24, description: 'Number of periods (default 6).' },
			},
		},
	},
	{
		name: 'list_categories',
		description: 'All BudgetBakers categories with their id, full path and group name.',
		input_schema: { type: 'object', properties: {} },
	},
] as const;

type ToolInput = Record<string, unknown>;

function optionalString(input: ToolInput, key: string): string | undefined {
	const value = input[key];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string') throw new Error(`${key} must be a string`);
	return value.trim() || undefined;
}

function optionalDate(input: ToolInput, key: string): string | undefined {
	const value = optionalString(input, key);
	if (value !== undefined) parseDateText(value); // throws "Invalid date text (expected yyyy-mm-dd)"
	return value;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	const number = Math.trunc(Number(value ?? fallback));
	return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function currentPeriod(settings: Settings, now: Date) {
	return periodForOffset(localDate(now, settings.timezone), normalizeStartDay(Number(settings.budget_month_start_day)), 0);
}

async function queryTransactions(t: Tenant, settings: Settings, now: Date, input: ToolInput) {
	const period = currentPeriod(settings, now);
	const startDate = optionalDate(input, 'start_date') ?? period.startText;
	const endDate = optionalDate(input, 'end_date') ?? period.endText;
	if (endDate < startDate) throw new Error('end_date is before start_date');
	const categoryFilter = optionalString(input, 'category_contains')?.toLowerCase();
	const accountFilter = optionalString(input, 'account_contains')?.toLowerCase();
	const noteFilter = optionalString(input, 'note_contains')?.toLowerCase();
	const recordType = optionalString(input, 'record_type')?.toLowerCase();
	const limit = boundedInt(input.limit, 50, 1, 100);

	const [rows, categories] = await Promise.all([listTransactionsBetween(t, startDate, addDays(endDate, 1)), listCategories(t)]);
	const categoryById = new Map(categories.map((category) => [category.id, category]));

	const matched = rows
		.filter((row) => {
			const category = row.categoryId ? categoryById.get(row.categoryId) : undefined;
			const categoryText = [category?.name, category?.fullPath, category?.groupName].join(' ').toLowerCase();
			return (
				(!categoryFilter || categoryText.includes(categoryFilter)) &&
				(!accountFilter || (row.accountName ?? '').toLowerCase().includes(accountFilter)) &&
				(!noteFilter || (row.note ?? '').toLowerCase().includes(noteFilter)) &&
				(!recordType || (row.recordType ?? '').toLowerCase() === recordType)
			);
		})
		.reverse(); // newest first

	return {
		startDate,
		endDate,
		currency: settings.base_currency,
		matched: matched.length,
		totalAmountBase: roundCurrency(matched.reduce((sum, row) => sum + (row.amountBase ?? 0), 0)),
		returned: Math.min(limit, matched.length),
		transactions: matched.slice(0, limit).map((row) => ({
			date: row.date,
			category: (row.categoryId && categoryById.get(row.categoryId)?.name) || null,
			account: row.accountName,
			amountBase: row.amountBase === null ? null : roundCurrency(row.amountBase),
			note: row.note || null,
		})),
	};
}

async function getBudgetSummary(t: Tenant, settings: Settings, now: Date, input: ToolInput) {
	const offset = boundedInt(input.period_offset, 0, -36, 12);
	const computation = await loadBudgetComputation(t, settings, now, offset);
	return {
		period: computation.period.label,
		startDate: computation.period.startText,
		endDate: computation.period.endText,
		currency: settings.base_currency,
		transactionsMissingFxRate: computation.missingFxCount,
		lines: computation.lines.map((line) => ({
			name: line.name,
			path: line.path,
			rowType: line.rowType,
			budget: roundCurrency(line.budget),
			spent: roundCurrency(line.spent),
			remaining: roundCurrency(line.remaining),
			forecast: roundCurrency(line.forecast),
			includeInReport: line.includeInReport,
		})),
	};
}

async function getCashflowHistory(t: Tenant, settings: Settings, input: ToolInput) {
	const rows = await listCashflowTotals(t, boundedInt(input.limit, 6, 1, 24));
	return {
		currency: settings.base_currency,
		periods: rows.map((row) => ({
			periodStart: row.periodStart,
			periodEnd: row.periodEnd,
			closingBalanceBase: row.closingBalanceBase === null ? null : roundCurrency(row.closingBalanceBase),
		})),
	};
}

async function executeTool(t: Tenant, settings: Settings, now: Date, name: string, rawInput: unknown): Promise<unknown> {
	const input: ToolInput = rawInput && typeof rawInput === 'object' ? (rawInput as ToolInput) : {};
	switch (name) {
		case 'query_transactions':
			return queryTransactions(t, settings, now, input);
		case 'get_budget_summary':
			return getBudgetSummary(t, settings, now, input);
		case 'get_cashflow_history':
			return getCashflowHistory(t, settings, input);
		case 'list_categories':
			return (await listCategories(t)).map((category) => ({
				id: category.id,
				fullPath: category.fullPath || category.name,
				groupName: category.groupName,
			}));
		default:
			throw new Error(`Unknown tool: ${name}`);
	}
}

async function runTool(t: Tenant, settings: Settings, now: Date, block: ToolUseBlock): Promise<ToolResultBlock> {
	try {
		const json = JSON.stringify(await executeTool(t, settings, now, block.name, block.input));
		const content = json.length > TOOL_RESULT_MAX_CHARS ? `${json.slice(0, TOOL_RESULT_MAX_CHARS)}…[truncated]` : json;
		return { type: 'tool_result', tool_use_id: block.id, content };
	} catch (error) {
		return { type: 'tool_result', tool_use_id: block.id, content: `Error: ${error instanceof Error ? error.message : String(error)}`, is_error: true };
	}
}

// ---------------------------------------------------------------------------------------------
// Messages API
// ---------------------------------------------------------------------------------------------

function buildSystemPrompt(settings: Settings, now: Date): string {
	const timeZone = settings.timezone;
	const startDay = normalizeStartDay(Number(settings.budget_month_start_day));
	const period = currentPeriod(settings, now);
	return [
		`Today is ${briefDateLabel(now, timeZone)} (${localDate(now, timeZone)}), time zone ${timeZone}.`,
		`A budget month starts on day ${startDay} of a month and ends the day before day ${startDay} of the next month. ` +
			`The current budget period is ${period.label} (${period.startText} to ${period.endText}).`,
		`Amounts are in the base currency, ${settings.base_currency}.`,
		"You answer questions about the family's budget using the tools. Reply concisely and WhatsApp-friendly: short lines, " +
			'*bold* for key figures, no markdown tables or headers.',
	].join('\n');
}

async function createMessage(apiKey: string, body: Record<string, unknown>, deadline: number): Promise<MessagesResponse> {
	const remaining = deadline - Date.now();
	if (remaining < 1000) throw new AssistantError('ERR_AI_TIMEOUT', `No time left to call Claude (budget ${AI_TIME_BUDGET_MS} ms).`);

	let response: Response;
	try {
		response = await fetch(ANTHROPIC_MESSAGES_URL, {
			method: 'POST',
			headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(remaining),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
			throw new AssistantError('ERR_AI_TIMEOUT', `Claude did not answer within the ${AI_TIME_BUDGET_MS} ms budget.`);
		}
		throw new AssistantError('ERR_AI_ERROR', `Anthropic API request failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	const requestId = response.headers.get('request-id') ?? undefined;
	const text = await response.text();
	let json: (MessagesResponse & { error?: { message?: string } }) | undefined;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		// Handled below.
	}
	if (!response.ok) {
		const code = response.status === 429 ? 'ERR_AI_RATE_LIMIT' : response.status === 401 ? 'ERR_AI_AUTH' : 'ERR_AI_ERROR';
		const detail = json?.error?.message ?? text.slice(0, 300);
		throw new AssistantError(
			code,
			`Anthropic API HTTP ${response.status}${detail ? `: ${detail}` : ''}${requestId ? ` (request-id ${requestId})` : ''}`,
			{ status: response.status, requestId },
		);
	}
	if (!json || !Array.isArray(json.content)) {
		throw new AssistantError('ERR_AI_ERROR', `Anthropic API returned an unexpected body${requestId ? ` (request-id ${requestId})` : ''}.`, {
			status: response.status,
			requestId,
		});
	}
	return json;
}

/** Joins the final text blocks and fits the reply into one WhatsApp message (port of ~1900). */
function formatReply(response: MessagesResponse): string {
	const text = response.content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('')
		.trim();
	if (!text) throw new AssistantError('ERR_AI_EMPTY_REPLY', `Claude returned no text (stop_reason=${response.stop_reason}).`);
	if (text.length <= REPLY_MAX_CHARS) return text;
	let cut = text.slice(0, REPLY_MAX_CHARS - REPLY_SHORTENED_SUFFIX.length);
	if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
	return `${cut.trimEnd()}${REPLY_SHORTENED_SUFFIX}`;
}

/**
 * Answers a free-text budget question for household `t` with Claude (using the household's own
 * Anthropic API key, see wallet/token.ts) and the D1 tools. Returns WhatsApp-ready text
 * (≤ 3500 chars). Throws AssistantError with a stable `code` on any failure.
 */
export async function answerQuestion(env: Env, t: Tenant, question: string, now: Date): Promise<string> {
	const household = await getHousehold(t.db, t.hid);
	const apiKey = household ? await getAiKey(env, t.db, household) : null;
	if (!apiKey) {
		throw new AssistantError('ERR_AI_CONFIG', 'No Anthropic API key is configured for this household. Add your own Anthropic API key in Settings.');
	}
	const deadline = Date.now() + AI_TIME_BUDGET_MS;
	const settings = await getSettings(t);
	const system = buildSystemPrompt(settings, now);
	const messages: MessageParam[] = [{ role: 'user', content: question }];

	for (let iteration = 1; ; iteration++) {
		const response = await createMessage(apiKey, { model: settings.ai_model, max_tokens: MAX_TOKENS, system, tools: TOOLS, messages }, deadline);
		// Anything but tool_use (end_turn, max_tokens, refusal, ...) ends the loop; a max_tokens turn may
		// carry a truncated tool_use block, which must not be executed.
		if (response.stop_reason !== 'tool_use') return formatReply(response);
		if (iteration >= MAX_ITERATIONS) {
			throw new AssistantError('ERR_AI_TOOL_LIMIT', `Claude was still calling tools after ${MAX_ITERATIONS} requests.`);
		}
		const toolUses = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
		messages.push({ role: 'assistant', content: response.content });
		messages.push({ role: 'user', content: await Promise.all(toolUses.map((block) => runTool(t, settings, now, block))) });
	}
}
