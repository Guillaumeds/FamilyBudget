import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_TIME_BUDGET_MS, ANTHROPIC_MESSAGES_URL, AssistantError, answerQuestion, MAX_ITERATIONS } from '../src/ai/assistant';
import { type BudgetComputation, type BudgetLine, loadBudgetComputation } from '../src/budget/engine';
import { type CategoryRow, type TransactionRow, upsertCashflowRows, upsertCategories, upsertTransactions } from '../src/db/repo';
import { setSettings } from '../src/db/settings';
import type { Env } from '../src/env';
import { resetDb } from './helpers';

// engine.ts is implemented in parallel — never run its real bodies here.
vi.mock('../src/budget/engine', () => ({ computeBudget: vi.fn(), loadBudgetComputation: vi.fn(), listYesterdayExpenses: vi.fn() }));

const db = env.DB;
const aiEnv: Env = { ...env, ANTHROPIC_API_KEY: 'sk-ant-test' };
const NOW = new Date('2026-09-26T10:00:00.000Z');
const SYNCED = NOW.toISOString();

type Block = Record<string, unknown>;
type RequestBody = { model: string; max_tokens: number; system: string; tools: Array<{ name: string }>; messages: Array<{ role: string; content: any }> };

function message(content: Block[], stopReason: string): Block {
	return {
		id: 'msg_test',
		type: 'message',
		role: 'assistant',
		model: 'claude-sonnet-5',
		content,
		stop_reason: stopReason,
		usage: { input_tokens: 100, output_tokens: 20 },
	};
}
const toolUse = (id: string, name: string, input: Block = {}) => ({ type: 'tool_use', id, name, input });
const text = (value: string) => ({ type: 'text', text: value });

/** Fake Messages API answering with `responses` in order (a Response is returned as-is). */
function mockClaude(...responses: Array<Block | Response>) {
	const queue = [...responses];
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
		const next = queue.shift();
		if (!next) throw new Error('unexpected extra Messages API request');
		return next instanceof Response ? next : Response.json(next, { headers: { 'request-id': 'req_test' } });
	});
}

function requests(spy: ReturnType<typeof mockClaude>): RequestBody[] {
	return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as RequestBody);
}

function line(overrides: Partial<BudgetLine>): BudgetLine {
	return {
		rowType: 'CATEGORY',
		id: '',
		name: '',
		path: '',
		depth: 1,
		groupId: '',
		groupName: '',
		forecastType: 'day_to_day',
		budget: 0,
		spent: 0,
		remaining: 0,
		usedPct: 0,
		forecast: 0,
		forecastVsBudget: 0,
		baselines: [0, 0, 0],
		baselineAvg: 0,
		includeInReport: false,
		includeInExpense: true,
		...overrides,
	};
}

function category(id: string, name: string, groupName: string): CategoryRow {
	return { id, parentId: null, name, groupId: `g-${groupName}`, groupName, fullPath: `${groupName} > ${name}`, level: 1, archived: 0, updatedAt: SYNCED };
}

function transaction(id: string, date: string, categoryId: string, amountBase: number, note: string | null = null): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-1',
		accountName: 'Joint Current',
		categoryId,
		recordType: amountBase < 0 ? 'expense' : 'income',
		paymentType: 'card',
		recordState: 'cleared',
		amount: amountBase,
		currency: 'EUR',
		amountBase,
		note,
		syncedAt: SYNCED,
	};
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	await setSettings(db, { timezone: 'Europe/Dublin', budget_month_start_day: '25', base_currency: 'EUR' });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('answerQuestion', () => {
	it('runs a tool_use round trip (get_budget_summary) and returns the final text', async () => {
		const overall = line({ rowType: 'OVERALL', name: 'OVERALL', path: 'OVERALL', depth: 0, budget: 2000, spent: 500.456, remaining: 1499.544, forecast: 1800 });
		const groceries = line({ id: 'cat-groc', name: 'Groceries', path: 'Food & Drinks > Groceries', budget: 600, spent: 250, remaining: 350, forecast: 640, includeInReport: true });
		vi.mocked(loadBudgetComputation).mockResolvedValue({
			period: { startText: '2026-08-25', endText: '2026-09-24', endExclusiveText: '2026-09-25', label: '25 Aug to 24 Sep 2026', periodDays: 31 },
			todayLocal: '2026-09-26',
			lines: [overall, groceries],
			overall,
			missingFxCount: 0,
		} satisfies BudgetComputation);
		const first = message(
			[{ type: 'thinking', thinking: '', signature: 'sig' }, text('Let me check.'), toolUse('toolu_1', 'get_budget_summary', { period_offset: -1 })],
			'tool_use',
		);
		const spy = mockClaude(first, message([text('Last period groceries: *€250.00* of €600.00.')], 'end_turn'));

		expect(await answerQuestion(aiEnv, db, 'How did groceries go last month?', NOW)).toBe('Last period groceries: *€250.00* of €600.00.');
		expect(spy).toHaveBeenCalledTimes(2);

		// Request shape (plain fetch, Messages API headers).
		const [url, init] = spy.mock.calls[0]!;
		expect(String(url)).toBe(ANTHROPIC_MESSAGES_URL);
		const headers = new Headers(init?.headers);
		expect([headers.get('x-api-key'), headers.get('anthropic-version'), headers.get('content-type')]).toEqual([
			'sk-ant-test',
			'2023-06-01',
			'application/json',
		]);
		const [firstRequest, secondRequest] = requests(spy);
		expect(firstRequest).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 1500 });
		expect(firstRequest!.tools.map((tool) => tool.name)).toEqual(['query_transactions', 'get_budget_summary', 'get_cashflow_history', 'list_categories']);
		expect(firstRequest!.messages).toEqual([{ role: 'user', content: 'How did groceries go last month?' }]);
		expect(firstRequest!.system).toContain('Sat, 26 Sep 2026 (2026-09-26), time zone Europe/Dublin');
		expect(firstRequest!.system).toContain('starts on day 25');
		expect(firstRequest!.system).toContain('25 Sep to 24 Oct 2026');
		expect(firstRequest!.system).toContain('EUR');

		// Second request: assistant content echoed unchanged, then the tool_result.
		expect(secondRequest!.messages).toHaveLength(3);
		expect(secondRequest!.messages[1]).toEqual({ role: 'assistant', content: first.content });
		const [result] = secondRequest!.messages[2]!.content;
		expect(secondRequest!.messages[2]!.role).toBe('user');
		expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
		expect(result.is_error).toBeUndefined();
		const summary = JSON.parse(result.content);
		expect(summary).toMatchObject({ period: '25 Aug to 24 Sep 2026', currency: 'EUR' });
		expect(summary.lines[0]).toEqual({
			name: 'OVERALL',
			path: 'OVERALL',
			rowType: 'OVERALL',
			budget: 2000,
			spent: 500.46,
			remaining: 1499.54,
			forecast: 1800,
			includeInReport: false,
		});
		expect(summary.lines[1]).toMatchObject({ name: 'Groceries', budget: 600, spent: 250, includeInReport: true });
		expect(vi.mocked(loadBudgetComputation).mock.calls[0]![3]).toBe(-1);
	});

	it('executes parallel tool calls against D1 and returns all results in one user message', async () => {
		await upsertCategories(db, [category('cat-groc', 'Groceries', 'Food & Drinks'), category('cat-fuel', 'Fuel', 'Vehicle')]);
		await upsertTransactions(db, [
			transaction('t1', '2026-09-01', 'cat-groc', -10, 'Lidl'),
			transaction('t2', '2026-09-20', 'cat-groc', -20.5, 'Tesco'),
			transaction('t3', '2026-09-21', 'cat-fuel', -60),
			transaction('t4', '2026-10-02', 'cat-groc', -99),
		]);
		await upsertCashflowRows(db, [
			{
				periodStart: '2026-07-25',
				periodEnd: '2026-08-24',
				rowType: 'TOTAL',
				accountKey: 'TOTAL',
				accountName: 'Total',
				currency: 'EUR',
				closingBalance: 1234.5,
				closingBalanceBase: 1234.5,
				capturedAt: SYNCED,
				source: 'import',
				notes: null,
			},
		]);
		const spy = mockClaude(
			message(
				[
					toolUse('toolu_a', 'query_transactions', { category_contains: 'GROC', start_date: '2026-09-01', end_date: '2026-09-30', limit: 1 }),
					toolUse('toolu_b', 'get_cashflow_history', {}),
					toolUse('toolu_c', 'query_transactions', { start_date: '26/09/2026' }),
					toolUse('toolu_d', 'drop_tables', {}),
				],
				'tool_use',
			),
			message([text('Done.')], 'end_turn'),
		);

		expect(await answerQuestion(aiEnv, db, 'Groceries this month?', NOW)).toBe('Done.');
		const results = requests(spy)[1]!.messages[2]!.content as Array<{ tool_use_id: string; content: string; is_error?: boolean }>;
		expect(results.map((result) => result.tool_use_id)).toEqual(['toolu_a', 'toolu_b', 'toolu_c', 'toolu_d']);

		expect(JSON.parse(results[0]!.content)).toEqual({
			startDate: '2026-09-01',
			endDate: '2026-09-30',
			currency: 'EUR',
			matched: 2,
			totalAmountBase: -30.5,
			returned: 1,
			transactions: [{ date: '2026-09-20', category: 'Groceries', account: 'Joint Current', amountBase: -20.5, note: 'Tesco' }],
		});
		expect(JSON.parse(results[1]!.content)).toEqual({
			currency: 'EUR',
			periods: [{ periodStart: '2026-07-25', periodEnd: '2026-08-24', closingBalanceBase: 1234.5 }],
		});
		expect(results[2]).toMatchObject({ is_error: true });
		expect(results[2]!.content).toContain('yyyy-mm-dd');
		expect(results[3]).toMatchObject({ is_error: true, content: 'Error: Unknown tool: drop_tables' });
	});

	it('defaults query_transactions to the current budget period', async () => {
		await upsertCategories(db, [category('cat-groc', 'Groceries', 'Food & Drinks')]);
		await upsertTransactions(db, [transaction('old', '2026-09-24', 'cat-groc', -5), transaction('new', '2026-09-25', 'cat-groc', -7)]);
		const spy = mockClaude(message([toolUse('toolu_1', 'query_transactions')], 'tool_use'), message([text('ok')], 'end_turn'));
		await answerQuestion(aiEnv, db, 'Spending so far?', NOW);
		const result = JSON.parse(requests(spy)[1]!.messages[2]!.content[0].content);
		expect(result).toMatchObject({ startDate: '2026-09-25', endDate: '2026-10-24', matched: 1, totalAmountBase: -7 });
	});

	it('shortens long replies to 3500 characters for WhatsApp', async () => {
		mockClaude(message([text('a'.repeat(5000))], 'end_turn'));
		const reply = await answerQuestion(aiEnv, db, 'Tell me everything', NOW);
		expect(reply.length).toBeLessThanOrEqual(3500);
		expect(reply.endsWith('\n\n…reply shortened for WhatsApp.')).toBe(true);
		expect(reply.startsWith('a'.repeat(3000))).toBe(true);
	});

	it('throws ERR_AI_EMPTY_REPLY when the final turn has no text', async () => {
		mockClaude(message([{ type: 'thinking', thinking: '', signature: 'sig' }, text('   ')], 'end_turn'));
		const error = await answerQuestion(aiEnv, db, 'Hi', NOW).catch((e) => e);
		expect(error).toBeInstanceOf(AssistantError);
		expect(error.code).toBe('ERR_AI_EMPTY_REPLY');
	});

	it(`stops after ${MAX_ITERATIONS} requests when Claude keeps calling tools`, async () => {
		vi.mocked(loadBudgetComputation).mockRejectedValue(new Error('not needed'));
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async () => Response.json(message([toolUse(`toolu_${Math.random()}`, 'list_categories')], 'tool_use')));
		await expect(answerQuestion(aiEnv, db, 'Loop forever', NOW)).rejects.toMatchObject({ code: 'ERR_AI_TOOL_LIMIT' });
		expect(spy).toHaveBeenCalledTimes(MAX_ITERATIONS);
	});

	it('maps HTTP errors to coded errors with the request id', async () => {
		const apiError = (status: number, type: string) =>
			Response.json({ type: 'error', error: { type, message: `${type} happened` } }, { status, headers: { 'request-id': `req_${status}` } });

		mockClaude(apiError(429, 'rate_limit_error'), apiError(401, 'authentication_error'), apiError(529, 'overloaded_error'));
		const rateLimited = await answerQuestion(aiEnv, db, 'Q', NOW).catch((e) => e);
		expect(rateLimited).toMatchObject({ code: 'ERR_AI_RATE_LIMIT', status: 429, requestId: 'req_429' });
		expect(rateLimited.message).toContain('rate_limit_error happened');
		expect(rateLimited.message).toContain('req_429');
		await expect(answerQuestion(aiEnv, db, 'Q', NOW)).rejects.toMatchObject({ code: 'ERR_AI_AUTH', status: 401 });
		await expect(answerQuestion(aiEnv, db, 'Q', NOW)).rejects.toMatchObject({ code: 'ERR_AI_ERROR', status: 529 });
	});

	it('fails fast with ERR_AI_CONFIG without an API key', async () => {
		const spy = mockClaude();
		await expect(answerQuestion({ ...aiEnv, ANTHROPIC_API_KEY: undefined }, db, 'Q', NOW)).rejects.toMatchObject({ code: 'ERR_AI_CONFIG' });
		expect(spy).not.toHaveBeenCalled();
	});

	it('gives up with ERR_AI_TIMEOUT once the time budget is spent', async () => {
		let clock = 1_000_000;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
		const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			clock += AI_TIME_BUDGET_MS; // this call used the whole budget
			return Response.json(message([toolUse('toolu_1', 'list_categories')], 'tool_use'));
		});
		await expect(answerQuestion(aiEnv, db, 'Q', NOW)).rejects.toMatchObject({ code: 'ERR_AI_TIMEOUT' });
		expect(spy).toHaveBeenCalledOnce();
	});
});
