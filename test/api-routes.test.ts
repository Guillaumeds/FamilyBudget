import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, createSessionValue } from '../src/api/auth';
import { handleApiRequest } from '../src/api/routes';
import {
	type CategoryRow,
	type TransactionRow,
	getTarget,
	insertMessageLog,
	listRunLog,
	listTransactionsBetween,
	logRun,
	upsertCashflowRows,
	upsertCategories,
	upsertFxRates,
	upsertTarget,
	upsertTransactions,
} from '../src/db/repo';
import { getSetting, getSettings, setSettings } from '../src/db/settings';
import type { Env } from '../src/env';
import { convertToBase } from '../src/lib/fx';
import { addDays, localDate } from '../src/lib/tz';
import { WalletApiError } from '../src/wallet/client';
import { syncWallet } from '../src/wallet/sync';
import { sendDailyBrief } from '../src/whatsapp/client';
import { resetDb } from './helpers';

vi.mock('../src/wallet/sync', () => ({ syncWallet: vi.fn() }));
vi.mock('../src/whatsapp/client', () => ({ sendDailyBrief: vi.fn() }));

const db = env.DB;
const ORIGIN = 'https://budget.example.com';
const testEnv: Env = {
	...env,
	DASHBOARD_PASSWORD: 'pw',
	SESSION_SECRET: 'routes-test-secret',
	WALLET_API_TOKEN: 'wallet-token',
	WHATSAPP_ACCESS_TOKEN: 'wa-token',
	WHATSAPP_PHONE_NUMBER_ID: '12345',
	ANTHROPIC_API_KEY: undefined,
};
let cookie = '';

// Dates relative to the real clock: the API always uses `new Date()`; settings use UTC and start day 1.
const today = localDate(new Date(), 'UTC');
const yesterday = addDays(today, -1);
const stamp = new Date().toISOString();

async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Cookie', `${SESSION_COOKIE}=${cookie}`);
	let body = init.body;
	if (init.json !== undefined) {
		headers.set('Content-Type', 'application/json');
		body = JSON.stringify(init.json);
	}
	const response = await handleApiRequest(new Request(`${ORIGIN}${path}`, { ...init, headers, body }), testEnv, createExecutionContext());
	if (!response) throw new Error(`null response for ${path}`);
	return response;
}

async function getJson<T = any>(path: string): Promise<T> {
	const response = await call(path);
	expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
	return (await response.json()) as T;
}

function category(id: string, name: string, groupId: string, groupName: string, extra: Partial<CategoryRow> = {}): CategoryRow {
	return { id, parentId: null, name, groupId, groupName, fullPath: name, level: 0, archived: 0, updatedAt: stamp, ...extra };
}

function tx(id: string, date: string, categoryId: string, amount: number, extra: Partial<TransactionRow> = {}): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-1',
		accountName: 'Current',
		categoryId,
		recordType: amount < 0 ? 'expense' : 'income',
		paymentType: 'card',
		recordState: 'cleared',
		amount,
		currency: 'EUR',
		amountBase: amount,
		note: null,
		syncedAt: stamp,
		...extra,
	};
}

beforeEach(async () => {
	await resetDb();
	vi.mocked(syncWallet).mockReset();
	vi.mocked(sendDailyBrief).mockReset();
	cookie = await createSessionValue(testEnv, Date.now() + 3_600_000);
	await setSettings(db, { timezone: 'UTC', base_currency: 'EUR', budget_month_start_day: '1' });
	await upsertCategories(db, [
		category('c-groc', 'Groceries', 'food', 'Food & Drinks', { fullPath: 'Food & Drinks > Groceries', level: 1 }),
		category('c-rest', 'Restaurant', 'food', 'Food & Drinks', { fullPath: 'Food & Drinks > Restaurant', level: 1 }),
		category('c-rent', 'Rent', 'housing', 'Housing'),
		category('c-salary', 'Salary', 'income', 'Income'),
	]);
	await upsertTarget(db, { entityType: 'category', entityId: 'c-groc', period: 'monthly', forecastType: 'day_to_day', budget: 400, includeInReport: 1, includeInExpense: 1 });
	await upsertTarget(db, { entityType: 'category', entityId: 'c-rent', period: 'monthly', forecastType: 'recurring', budget: 1500, includeInReport: 0, includeInExpense: 1 });
	await upsertTransactions(db, [
		tx('t-1', today, 'c-groc', -42.5, { note: 'Tesco weekly shop', accountName: 'Joint' }),
		tx('t-2', today, 'c-rest', -30, { note: 'Pizza night' }),
		tx('t-3', today, 'c-rent', -1500),
		tx('t-4', today, 'c-salary', 3000),
		tx('t-5', yesterday, 'c-groc', -10, { note: 'Milk' }),
	]);
});

describe('GET /api/status', () => {
	it('reports configuration, counts and the latest runs', async () => {
		await logRun(db, 'INFO', 'walletSync', 'old sync');
		await logRun(db, 'WARN', 'walletSync', 'newest sync');
		await logRun(db, 'INFO', 'capture', 'captured');
		const body = await getJson('/api/status');
		expect(body).toMatchObject({
			setupComplete: false,
			walletConfigured: true,
			whatsappConfigured: true,
			webhookConfigured: false,
			aiConfigured: false,
			dashboardSecured: true,
			baseCurrency: 'EUR',
			counts: { transactions: 5, categories: 4, accounts: 0, missingFx: 0 },
		});
		expect(body.lastRun.sync).toMatchObject({ level: 'WARN', message: 'newest sync' });
		expect(body.lastRun.capture).toMatchObject({ message: 'captured' });
		expect(body.lastRun.brief).toBeNull();
	});
});

describe('GET /api/summary', () => {
	it('returns the budget computation for the current period', async () => {
		const body = await getJson('/api/summary');
		expect(Object.keys(body).sort()).toEqual(['currency', 'lines', 'missingFxCount', 'offset', 'period', 'targets', 'todayLocal']);
		expect(body).toMatchObject({ offset: 0, todayLocal: today, missingFxCount: 0, currency: 'EUR' });
		expect(body.period.startText <= today && today <= body.period.endText).toBe(true);
		// t-5 (yesterday, 10.00) falls in the previous period when today is the 1st.
		const yesterdayInPeriod = today.endsWith('-01') ? 0 : 10;
		expect(body.lines[0]).toMatchObject({ rowType: 'OVERALL', spent: 1572.5 + yesterdayInPeriod });
		expect(body.lines.find((l: any) => l.id === 'c-groc')).toMatchObject({ rowType: 'CATEGORY', budget: 400, depth: 1, groupName: 'Food & Drinks' });
		expect(body.lines.find((l: any) => l.rowType === 'TYPE' && l.id === 'food')).toMatchObject({ spent: 72.5 + yesterdayInPeriod });
		expect(body.targets['category:c-groc']).toEqual({ budget: 400, period: 'monthly' });
	});

	it('accepts an offset and rejects bad ones', async () => {
		const previous = await getJson('/api/summary?offset=-1');
		expect(previous.offset).toBe(-1);
		expect(previous.period.endExclusiveText <= today).toBe(true);
		expect((await call('/api/summary?offset=abc')).status).toBe(400);
		expect((await call('/api/summary?offset=99')).status).toBe(400);
	});
});

describe('PUT /api/targets/:entityType/:entityId', () => {
	const put = (path: string, json: unknown) => call(`/api/targets/${path}`, { method: 'PUT', json });

	it('updates only the given fields and preserves the rest', async () => {
		let response = await put('category/c-rent', { budget: 1600.456 });
		expect(response.status).toBe(200);
		expect(await getTarget(db, 'category', 'c-rent')).toEqual({
			entityType: 'category',
			entityId: 'c-rent',
			period: 'monthly',
			forecastType: 'recurring',
			budget: 1600.46,
			includeInReport: 0,
			includeInExpense: 1,
		});

		response = await put('category/c-rent', { includeInReport: true, forecastType: 'day_to_day' });
		expect(((await response.json()) as any).target).toMatchObject({ budget: 1600.46, includeInReport: 1, forecastType: 'day_to_day' });

		await put('category/c-rent', { budget: null });
		expect(await getTarget(db, 'category', 'c-rent')).toMatchObject({ budget: null, includeInReport: 1, forecastType: 'day_to_day' });
	});

	it('creates a target with defaults when none exists (income group excluded from expenses)', async () => {
		expect(await getTarget(db, 'group', 'income')).toBeNull();
		expect((await put('group/income', { includeInReport: true })).status).toBe(200);
		expect(await getTarget(db, 'group', 'income')).toEqual({
			entityType: 'group',
			entityId: 'income',
			period: 'monthly',
			forecastType: 'day_to_day',
			budget: null,
			includeInReport: 1,
			includeInExpense: 0,
		});
	});

	it.each([
		['category/c-rent', { budget: -1 }],
		['category/c-rent', { budget: '100' }],
		['category/c-rent', { forecastType: 'weekly' }],
		['category/c-rent', { includeInReport: 'yes' }],
		['category/c-rent', { includeInExpense: 1 }],
		['category/c-rent', { colour: 'red' }],
		['category/c-rent', {}],
		['account/c-rent', { budget: 1 }],
	])('400s on %s %j', async (path, json) => {
		const response = await put(path, json);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
	});

	it('404s on an unknown entity and 400s on bad JSON', async () => {
		expect((await put('category/nope', { budget: 1 })).status).toBe(404);
		expect((await call('/api/targets/category/c-rent', { method: 'PUT', body: '{nope' })).status).toBe(400);
	});

	it('changes are visible in the summary', async () => {
		await put('category/c-rest', { budget: 100, forecastType: 'recurring' });
		const body = await getJson('/api/summary');
		expect(body.lines.find((l: any) => l.id === 'c-rest')).toMatchObject({ budget: 100, forecast: 100, remaining: 70 });
		expect(body.lines.find((l: any) => l.rowType === 'TYPE' && l.id === 'food').budget).toBe(500);
	});
});

describe('GET /api/settings, PUT /api/settings', () => {
	const put = (json: unknown) => call('/api/settings', { method: 'PUT', json });

	it('returns settings with defaults', async () => {
		const body = await getJson('/api/settings');
		expect(body.settings).toMatchObject({ timezone: 'UTC', base_currency: 'EUR', dry_run: '1' });
		expect(body.defaults.brief_hour_local).toBe('9');
	});

	it('validates and normalises values', async () => {
		const response = await put({
			timezone: 'europe/dublin',
			budget_month_start_day: 25,
			brief_hour_local: '9',
			whatsapp_to_numbers: '+353 87 123 4567, +27-82-000-1111',
			dry_run: false,
			brief_title: '  Our Budget  ',
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.warning).toBeUndefined();
		expect(body.settings).toMatchObject({
			timezone: 'Europe/Dublin',
			budget_month_start_day: '25',
			whatsapp_to_numbers: '+353871234567,+27820001111',
			dry_run: '0',
			brief_title: 'Our Budget',
		});
	});

	it.each([
		[{ timezone: 'Mars/Olympus_Mons' }, 'timezone'],
		[{ budget_month_start_day: 32 }, 'budget_month_start_day'],
		[{ budget_month_start_day: '0' }, 'budget_month_start_day'],
		[{ budget_month_start_day: '2.5' }, 'budget_month_start_day'],
		[{ brief_hour_local: 24 }, 'brief_hour_local'],
		[{ capture_hour_local: -1 }, 'capture_hour_local'],
		[{ stale_seconds: 30 }, 'stale_seconds'],
		[{ whatsapp_to_numbers: '0871234567' }, 'whatsapp_to_numbers'],
		[{ whatsapp_enabled: 'yes' }, 'whatsapp_enabled'],
		[{ base_currency: 'EURO' }, 'base_currency'],
		[{ sync_backfill_from: '2026-02-30' }, 'sync_backfill_from'],
		[{ brief_last_sent_date: '2026-01-01' }, 'brief_last_sent_date'],
		[{ brief_title: null }, 'brief_title'],
	])('rejects %j', async (json, field) => {
		const response = await put(json);
		expect(response.status).toBe(400);
		const body = (await response.json()) as any;
		expect(body.code).toBe('VALIDATION');
		expect(Object.keys(body.fields)).toEqual([field]);
	});

	it('writes nothing when any key is invalid', async () => {
		expect((await put({ brief_hour_local: 7, timezone: 'Nowhere/Land' })).status).toBe(400);
		expect(await getSetting(db, 'brief_hour_local')).toBe('9');
	});

	it('changing base_currency clears cached FX rates and returns a warning', async () => {
		await upsertFxRates(db, [{ date: today, currency: 'ZAR', rateToBase: 0.05 }]);
		const same = (await (await put({ base_currency: 'eur' })).json()) as any;
		expect(same.warning).toBeUndefined();
		expect(await db.prepare('SELECT COUNT(*) AS n FROM fx_rates').first('n')).toBe(1);

		const response = await put({ base_currency: 'usd' });
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body.settings.base_currency).toBe('USD');
		expect(body.warning).toContain('EUR to USD');
		expect(await db.prepare('SELECT COUNT(*) AS n FROM fx_rates').first('n')).toBe(0);
		expect((await listRunLog(db, 1))[0]).toMatchObject({ level: 'WARN', action: 'settings' });
	});
});

describe('GET /api/transactions, /api/yesterday', () => {
	it('lists the current period newest first with category paths', async () => {
		const body = await getJson('/api/transactions');
		expect(body.total).toBe(today.endsWith('-01') ? 4 : 5);
		expect(body.transactions[0]).toMatchObject({ date: today, categoryPath: expect.any(String) });
		expect(body.transactions.find((t: any) => t.id === 't-1')).toMatchObject({ categoryPath: 'Food & Drinks > Groceries', categoryName: 'Groceries', groupName: 'Food & Drinks' });
	});

	it('filters by date range and by q over category path, account and note', async () => {
		const range = `from=${yesterday}&to=${today}`;
		const byNote = await getJson(`/api/transactions?${range}&q=pizza`);
		expect(byNote.transactions.map((t: any) => t.id)).toEqual(['t-2']);
		const byPath = await getJson(`/api/transactions?${range}&q=${encodeURIComponent('food & drinks')}`);
		expect(byPath.transactions.map((t: any) => t.id).sort()).toEqual(['t-1', 't-2', 't-5']);
		const byAccount = await getJson(`/api/transactions?${range}&q=JOINT`);
		expect(byAccount.transactions.map((t: any) => t.id)).toEqual(['t-1']);
		const onlyYesterday = await getJson(`/api/transactions?from=${yesterday}&to=${yesterday}`);
		expect(onlyYesterday.transactions.map((t: any) => t.id)).toEqual(['t-5']);
		expect(onlyYesterday.totals).toEqual({ expenses: 10, income: 0, missingFx: 0 });
		const limited = await getJson(`/api/transactions?${range}&limit=2`);
		expect(limited).toMatchObject({ total: 5, truncated: true });
		expect(limited.transactions).toHaveLength(2);
	});

	it('validates parameters', async () => {
		expect((await call('/api/transactions?from=2026-13-01')).status).toBe(400);
		expect((await call(`/api/transactions?from=${today}&to=${yesterday}`)).status).toBe(400);
		expect((await call('/api/transactions?limit=501')).status).toBe(400);
	});

	it("returns yesterday's included expenses", async () => {
		const body = await getJson('/api/yesterday');
		expect(body).toMatchObject({ date: yesterday, currency: 'EUR', total: 10 });
		expect(body.expenses).toEqual([expect.objectContaining({ recordId: 't-5', category: 'Groceries', amountBase: 10, note: 'Milk' })]);
	});
});

describe('GET /api/cashflow', () => {
	it('returns totals newest first with change vs prior, and account rows per period', async () => {
		const row = (periodEnd: string, rowType: 'TOTAL' | 'ACCOUNT', accountKey: string, closing: number) => ({
			periodStart: addDays(periodEnd, -29),
			periodEnd,
			rowType,
			accountKey,
			accountName: accountKey,
			currency: 'EUR',
			closingBalance: closing,
			closingBalanceBase: closing,
			capturedAt: stamp,
			source: 'auto' as const,
			notes: null,
		});
		await upsertCashflowRows(db, [
			row('2026-07-24', 'TOTAL', 'TOTAL', 1000),
			row('2026-08-24', 'TOTAL', 'TOTAL', 1250.5),
			row('2026-08-24', 'ACCOUNT', 'a-1', 1250.5),
		]);
		const body = await getJson('/api/cashflow');
		expect(body.totals.map((t: any) => [t.periodEnd, t.closing, t.change, t.hasPrior])).toEqual([
			['2026-08-24', 1250.5, 250.5, true],
			['2026-07-24', 1000, 0, false],
		]);
		expect(Object.keys(body.accounts)).toEqual(['2026-08-24']);
		expect(body.accounts['2026-08-24'][0]).toMatchObject({ accountKey: 'a-1', closingBalance: 1250.5 });
	});
});

describe('GET /api/brief/preview', () => {
	it('renders the exact brief text and the 14 template params', async () => {
		await setSettings(db, { brief_title: 'Test Brief' });
		const body = await getJson('/api/brief/preview');
		expect(body.text).toContain('💰 *Test Brief*');
		expect(body.text).toContain('Groceries');
		expect(Object.keys(body.params)).toHaveLength(14);
		expect(body.params.expense_1).toContain('Groceries');
		expect(body.params.expense_2).toBe('–');
		expect(body.data).toMatchObject({ title: 'Test Brief', currency: 'EUR' });
		expect(body.data.reportLines.map((l: any) => l.id)).toEqual(['c-groc']);
	});
});

describe('admin: sync', () => {
	const result = { skipped: false, categories: 4, accounts: 2, recordsUpserted: 10, recordsDeleted: 1, windowStart: '2020-01-01', changeRev: '7' };

	it('runs a sync with the requested options', async () => {
		vi.mocked(syncWallet).mockResolvedValue(result);
		const response = await call('/api/admin/sync', { method: 'POST', json: { full: true } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, full: true, ...result });
		expect(vi.mocked(syncWallet).mock.calls[0]!.slice(1)).toEqual([db, { full: true, force: false }]);
	});

	it('maps the initial-sync 409 to 202 with retryAfterSeconds', async () => {
		vi.mocked(syncWallet).mockRejectedValue(
			new WalletApiError('WALLET_SYNC_IN_PROGRESS', 'BudgetBakers is still running its initial data sync; retry later (in ~5 min).', { status: 409, retryAfterSeconds: 300 }),
		);
		const response = await call('/api/admin/sync', { method: 'POST', json: {} });
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({ pending: true, code: 'WALLET_SYNC_IN_PROGRESS', retryAfterSeconds: 300 });
	});

	it('maps other Wallet errors to 502 with their code', async () => {
		vi.mocked(syncWallet).mockRejectedValue(new WalletApiError('WALLET_AUTH', 'Wallet API authentication/permission failed (HTTP 401)', { status: 401 }));
		const response = await call('/api/admin/sync', { method: 'POST', json: { force: true } });
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'Wallet API authentication/permission failed (HTTP 401)', code: 'WALLET_AUTH' });
	});

	it('turns unexpected errors into 500 and logs them', async () => {
		vi.mocked(syncWallet).mockRejectedValue(new Error('boom'));
		const response = await call('/api/admin/sync', { method: 'POST' });
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ code: 'INTERNAL' });
		const [log] = await listRunLog(db, 1);
		expect(log).toMatchObject({ level: 'ERROR', action: 'api' });
		expect(log!.message).toContain('POST /api/admin/sync failed: Error: boom');
	});
});

describe('admin: send-brief', () => {
	it('sends via sendDailyBrief and documents dry-run mode', async () => {
		vi.mocked(sendDailyBrief).mockResolvedValue({ results: [{ to: '***4567', mode: 'dry' }] });
		const response = await call('/api/admin/send-brief', { method: 'POST', json: {} });
		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		expect(body).toMatchObject({ ok: true, dryRun: true, results: [{ to: '***4567', mode: 'dry' }] });
		expect(body.note).toContain('dry_run is on');
		expect(vi.mocked(sendDailyBrief).mock.calls[0]![1]).toBe(db);
	});

	it('passes through skip reasons and per-recipient errors', async () => {
		await setSettings(db, { dry_run: '0' });
		vi.mocked(sendDailyBrief).mockResolvedValue({ results: [{ to: '***1111', mode: 'template', error: 'ERR_WHATSAPP_SEND: 131047' }] });
		const body = (await (await call('/api/admin/send-brief', { method: 'POST' })).json()) as any;
		expect(body).toMatchObject({ ok: false, dryRun: false });

		vi.mocked(sendDailyBrief).mockResolvedValue({ results: [], skippedReason: 'whatsapp_disabled' });
		expect(await (await call('/api/admin/send-brief', { method: 'POST' })).json()).toMatchObject({ ok: true, skippedReason: 'whatsapp_disabled' });
	});
});

describe('admin: fx-backfill', () => {
	it('converts transactions missing amount_base with the same semantics as convertToBase', async () => {
		const from = addDays(today, -3);
		// Full coverage from..today → ensureRates makes no network request.
		await upsertFxRates(db, [
			{ date: from, currency: 'ZAR', rateToBase: 0.05 },
			{ date: addDays(from, 1), currency: 'ZAR', rateToBase: 0.051 },
			{ date: today, currency: 'ZAR', rateToBase: 0.052 },
		]);
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		await upsertTransactions(db, [
			tx('z-1', addDays(from, 2), 'c-groc', -1000, { currency: 'ZAR', amountBase: null }), // falls back to the day before
			tx('z-2', today, 'c-groc', -200, { currency: 'ZAR', amountBase: null }),
			tx('z-3', addDays(from, -30), 'c-groc', -50, { currency: 'ZAR', amountBase: null }), // no rate within 14 days
			tx('z-4', today, 'c-groc', -100, { currency: 'ZAR', amountBase: -1 }), // already converted: untouched
		]);

		const response = await call('/api/admin/fx-backfill', { method: 'POST', json: { from } });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, from, currencies: ['ZAR'], ratesFetched: 0, reconverted: 2, stillMissing: 1 });
		expect(fetchSpy).not.toHaveBeenCalled();

		const rows = new Map((await listTransactionsBetween(db, '2000-01-01', '9999-12-31')).map((row) => [row.id, row.amountBase]));
		expect(rows.get('z-1')).toBe(await convertToBase(db, -1000, 'ZAR', addDays(from, 2), 'EUR'));
		expect(rows.get('z-1')).toBeCloseTo(-51);
		expect(rows.get('z-2')).toBeCloseTo(-10.4);
		expect(rows.get('z-3')).toBeNull();
		expect(rows.get('z-4')).toBe(-1);
		expect(rows.get('t-1')).toBe(-42.5);

		const all = (await (await call('/api/admin/fx-backfill', { method: 'POST', json: { from, all: true } })).json()) as any;
		expect(all).toMatchObject({ reconverted: 8, stillMissing: 1 });
		expect((await listTransactionsBetween(db, today, addDays(today, 1))).find((row) => row.id === 'z-4')!.amountBase).toBeCloseTo(-5.2);
		fetchSpy.mockRestore();
	});

	it('validates "from"', async () => {
		expect((await call('/api/admin/fx-backfill', { method: 'POST', json: { from: 'yesterday' } })).status).toBe(400);
		expect((await call('/api/admin/fx-backfill', { method: 'POST', json: { from: addDays(today, 2) } })).status).toBe(400);
	});
});

describe('admin: capture, test-wallet, logs', () => {
	it('captures closing balances for the current period', async () => {
		const body = (await (await call('/api/admin/capture', { method: 'POST' })).json()) as any;
		expect(body).toMatchObject({ ok: true, accounts: 0, totalBase: 0 });
		expect(body.periodEnd >= today).toBe(true);
	});

	it('tests the Wallet token and logs the outcome', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'init_sync_in_progress', retry_after_minutes: 5 }, { status: 409 }));
		const body = (await (await call('/api/admin/test-wallet', { method: 'POST' })).json()) as any;
		expect(body).toMatchObject({ ok: false, code: 'WALLET_SYNC_IN_PROGRESS' });
		expect(body.message).toContain('~5 min');
		expect((await listRunLog(db, 1))[0]).toMatchObject({ level: 'WARN', action: 'testWallet' });
		fetchSpy.mockRestore();
	});

	it('returns run and message logs newest first', async () => {
		await logRun(db, 'INFO', 'a', 'first');
		await logRun(db, 'INFO', 'b', 'second');
		await insertMessageLog(db, { direction: 'out', status: 'SENT', fromNumber: '***4567', body: 'hi' });
		const run = await getJson('/api/admin/logs?type=run&limit=1');
		expect(run).toMatchObject({ type: 'run', rows: [{ action: 'b', message: 'second' }] });
		const message = await getJson('/api/admin/logs?type=message');
		expect(message.rows).toEqual([expect.objectContaining({ direction: 'out', status: 'SENT', fromNumber: '***4567' })]);
		expect((await call('/api/admin/logs?type=nope')).status).toBe(400);
		expect((await call('/api/admin/logs?limit=201')).status).toBe(400);
	});

	it('404s unknown paths and 405s wrong methods', async () => {
		expect((await call('/api/nope')).status).toBe(404);
		expect((await call('/api/admin/sync')).status).toBe(405);
	});
});

describe('settings read back through getSettings', () => {
	it('setup_complete accepts booleans', async () => {
		expect((await call('/api/settings', { method: 'PUT', json: { setup_complete: true } })).status).toBe(200);
		expect((await getSettings(db)).setup_complete).toBe('1');
	});
});
