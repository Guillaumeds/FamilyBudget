import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureClosingBalances } from '../src/cashflow/capture';
import { updateHousehold } from '../src/db/households';
import { type AccountRow, type TransactionRow, listCashflowRows, listRunLog, upsertAccounts, upsertCashflowRows, upsertTransactions } from '../src/db/repo';
import { getSetting, setSettings } from '../src/db/settings';
import type { Tenant } from '../src/db/tenant';
import { type HouseholdTask, parseTaskMessage, queueHandler, runHouseholdTasks } from '../src/tasks';
import { WalletApiError } from '../src/wallet/client';
import { syncWallet } from '../src/wallet/sync';
import { sendDailyBrief } from '../src/whatsapp/client';
import { HH1, HH2, resetDb } from './helpers';

vi.mock('../src/wallet/sync', () => ({ syncWallet: vi.fn() }));
vi.mock('../src/whatsapp/client', () => ({ sendDailyBrief: vi.fn() }));
vi.mock('../src/cashflow/capture', () => ({ captureClosingBalances: vi.fn() }));

const db = env.DB;
const sync = vi.mocked(syncWallet);
const brief = vi.mocked(sendDailyBrief);
const capture = vi.mocked(captureClosingBalances);

const ALL: HouseholdTask[] = ['sync', 'brief', 'capture'];

async function run(iso: string, tasks: HouseholdTask[] = ALL, hid = 1): Promise<Date> {
	const now = new Date(iso);
	await runHouseholdTasks(env, hid, tasks, now);
	return now;
}

// Compare bindings by identity: deep equality would walk env's RPC-stub bindings.
const isTenant = (t: Tenant, hid: number) => t.db === db && t.hid === hid;
const syncCalls = () => sync.mock.calls.map(([e, t, opts]) => [e === env && isTenant(t, 1), opts]);
const briefCalls = () => brief.mock.calls.map(([e, t, now]) => [e === env && isTenant(t, 1), now]);
const captureCalls = () => capture.mock.calls.map(([t, settings, now, offset]) => [isTenant(t, 1), settings.budget_month_start_day, now, offset]);

async function logLines(hid?: number): Promise<string[]> {
	return (await listRunLog(db, 100, hid)).map((row) => `${row.level} ${row.action}: ${row.message}`);
}

function tx(id: string, date: string, amount: number): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc',
		accountName: null,
		categoryId: 'cat',
		recordType: amount < 0 ? 'expense' : 'income',
		paymentType: null,
		recordState: null,
		amount,
		currency: 'EUR',
		amountBase: amount,
		note: null,
		syncedAt: '2026-09-01T00:00:00Z',
	};
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	sync.mockResolvedValue({ skipped: true, categories: 0, accounts: 0, recordsUpserted: 0, recordsDeleted: 0, windowStart: null, changeRev: '1' });
	brief.mockResolvedValue({ results: [{ to: '+35*****12', mode: 'text', messageId: 'wamid.1' }] });
	capture.mockResolvedValue({ periodEnd: '2026-09-24', accounts: 1, totalBase: 100 });
	await setSettings(HH1, { timezone: 'Europe/Dublin', budget_month_start_day: '25', base_currency: 'EUR' });
});

describe('runHouseholdTasks — order and isolation', () => {
	it('runs sync → brief → capture in order, each failure isolated and logged to the household', async () => {
		sync.mockRejectedValue(new Error('sync down'));
		brief.mockRejectedValue(new Error('brief down'));
		capture.mockRejectedValue(new Error('capture down'));

		await run('2026-09-24T21:00:00Z');

		expect(sync.mock.invocationCallOrder[0]!).toBeLessThan(brief.mock.invocationCallOrder[0]!);
		expect(brief.mock.invocationCallOrder[0]!).toBeLessThan(capture.mock.invocationCallOrder[0]!);
		const lines = await logLines(1);
		expect(lines.filter((line) => line.startsWith('ERROR scheduled'))).toHaveLength(3);
	});

	it('runs only the requested tasks; full-sync → {full:true}', async () => {
		const now = await run('2026-09-27T02:00:00Z', ['full-sync']);
		expect(syncCalls()).toEqual([[true, { full: true, now }]]);
		expect(brief).not.toHaveBeenCalled();
		expect(capture).not.toHaveBeenCalled();

		vi.clearAllMocks();
		await run('2026-09-26T08:00:00Z', ['brief']);
		expect(sync).not.toHaveBeenCalled();
		expect(brief).toHaveBeenCalledOnce();
	});

	it('Wallet errors: 409 in-progress and WALLET_AUTH (no token yet) are warnings; others are errors; brief still runs', async () => {
		sync.mockRejectedValueOnce(new WalletApiError('WALLET_SYNC_IN_PROGRESS', 'BudgetBakers is still running its initial data sync.'));
		await run('2026-01-15T09:00:00Z');
		sync.mockRejectedValueOnce(new WalletApiError('WALLET_AUTH', 'No Wallet token configured.'));
		await run('2026-01-16T09:00:00Z');
		sync.mockRejectedValueOnce(new TypeError('network down'));
		await run('2026-01-17T09:00:00Z');

		expect(brief).toHaveBeenCalledTimes(3);
		const lines = await logLines(1);
		expect(lines).toContain('WARN scheduled: Incremental Wallet sync failed: WALLET_SYNC_IN_PROGRESS: BudgetBakers is still running its initial data sync.');
		expect(lines).toContain('WARN scheduled: Incremental Wallet sync failed (no token yet / auth failed): WALLET_AUTH: No Wallet token configured.');
		expect(lines).toContain('ERROR scheduled: Incremental Wallet sync failed: network down');
	});

	it('falls back to UTC when the stored timezone is invalid', async () => {
		await setSettings(HH1, { timezone: 'Mars/Olympus' });
		await run('2026-01-15T23:30:00Z', ['brief']);
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBe('2026-01-15');
	});
});

describe('runHouseholdTasks — household state', () => {
	it('a suspended household is a no-op (WARN in its log)', async () => {
		await updateHousehold(db, 2, { status: 'suspended' });
		await run('2026-01-15T09:00:00Z', ALL, 2);
		expect(sync).not.toHaveBeenCalled();
		expect(brief).not.toHaveBeenCalled();
		expect(await logLines(2)).toEqual(['WARN scheduled: Household is suspended — tasks [sync, brief, capture] skipped.']);
	});

	it('a missing household is a no-op (WARN system row)', async () => {
		await run('2026-01-15T09:00:00Z', ALL, 99);
		expect(sync).not.toHaveBeenCalled();
		expect(await logLines()).toContain('WARN scheduled: Household 99 not found — tasks [sync, brief, capture] skipped.');
	});

	it('runs against the given household only', async () => {
		await run('2026-01-15T09:00:00Z', ['sync', 'brief'], 2);
		expect(sync.mock.calls[0]![1]).toMatchObject({ hid: 2 });
		expect(brief.mock.calls[0]![1]).toMatchObject({ hid: 2 });
		expect(await getSetting(HH2, 'brief_last_sent_date')).toBe('2026-01-15');
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBeNull();
	});
});

describe('runHouseholdTasks — brief guard', () => {
	it('sets the guard to the local date on success; a re-delivered message sends nothing more', async () => {
		const now = await run('2026-07-15T23:30:00Z', ['brief']); // 00:30 on 16 Jul in Dublin
		expect(briefCalls()).toEqual([[true, now]]);
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBe('2026-07-16');

		await run('2026-07-15T23:30:00Z', ['brief']); // at-least-once duplicate
		expect(brief).toHaveBeenCalledOnce();
	});

	it('sets the guard when the client skipped (disabled or not approved) and logs the reason', async () => {
		brief.mockResolvedValueOnce({ results: [], skippedReason: 'whatsapp_disabled' });
		await run('2026-01-15T09:00:00Z', ['brief']);
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBe('2026-01-15');
		expect(await logLines(1)).toContain('INFO scheduled: Daily brief for 2026-01-15: skipped (whatsapp_disabled).');

		brief.mockResolvedValueOnce({ results: [], skippedReason: 'not_approved' });
		await run('2026-01-15T09:00:00Z', ['brief'], 2);
		expect(await getSetting(HH2, 'brief_last_sent_date')).toBe('2026-01-15');
		expect(await logLines(2)).toContain('INFO scheduled: Daily brief for 2026-01-15: skipped (not_approved).');
	});

	it('sets the guard after a partial failure so the recipient that succeeded is not messaged twice', async () => {
		brief.mockResolvedValue({
			results: [
				{ to: '+35*****12', mode: 'text', messageId: 'wamid.1' },
				{ to: '+27*****34', mode: 'template', error: 'ERR_WHATSAPP_SEND: boom' },
			],
		});
		await run('2026-01-15T09:00:00Z', ['brief']);
		await run('2026-01-15T10:00:00Z', ['brief']);

		expect(brief).toHaveBeenCalledOnce();
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBe('2026-01-15');
		expect(await logLines(1)).toContain('WARN scheduled: Daily brief for 2026-01-15: +35*****12: text, +27*****34: template FAILED.');
	});

	it('leaves the guard unset when every recipient failed — the next tick retries', async () => {
		brief.mockResolvedValueOnce({
			results: [
				{ to: '+35*****12', mode: 'text', error: 'ERR_WHATSAPP_SEND: 500' },
				{ to: '+27*****34', mode: 'template', error: 'ERR_WHATSAPP_SEND: 500' },
			],
		});
		await run('2026-01-15T09:00:00Z', ['brief']);
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBeNull();
		expect((await logLines(1)).some((line) => line.includes('all sends failed, retrying next hour'))).toBe(true);

		await run('2026-01-15T10:00:00Z', ['brief']);
		expect(brief).toHaveBeenCalledTimes(2);
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBe('2026-01-15');
	});

	it('leaves the guard unset when building the brief throws', async () => {
		brief.mockRejectedValueOnce(new Error('engine exploded'));
		await run('2026-01-15T09:00:00Z', ['brief']);
		expect(await getSetting(HH1, 'brief_last_sent_date')).toBeNull();
		expect((await logLines(1)).some((line) => line.startsWith('ERROR scheduled: Daily brief for 2026-01-15 failed') && line.includes('engine exploded'))).toBe(true);
	});
});

describe('runHouseholdTasks — cash-flow capture', () => {
	// Budget period 25 Aug – 24 Sep 2026.
	it('captures and sets its guard; a re-delivery is a no-op', async () => {
		const now = await run('2026-09-24T21:00:00Z', ['capture']);
		expect(captureCalls()).toEqual([[true, '25', now, undefined]]);
		expect(await getSetting(HH1, 'capture_last_period_end')).toBe('2026-09-24');

		await run('2026-09-24T21:00:00Z', ['capture']);
		expect(capture).toHaveBeenCalledOnce();
	});

	it('leaves its guard unset when the capture throws', async () => {
		capture.mockRejectedValueOnce(new Error('D1 hiccup'));
		await run('2026-09-24T21:00:00Z', ['capture']);
		expect(await getSetting(HH1, 'capture_last_period_end')).toBeNull();
		expect((await logLines(1)).some((line) => line.startsWith('ERROR scheduled: Cash-flow capture') && line.includes('D1 hiccup'))).toBe(true);
	});

	it('after a sync, retroactively captures the previous period when it has transactions but no TOTAL row', async () => {
		await upsertTransactions(HH1, [tx('t1', '2026-08-10', -20)]); // in 25 Jul – 24 Aug
		const now = await run('2026-09-10T12:00:00Z', ['sync']);
		expect(captureCalls()).toEqual([[true, '25', now, -1]]);
	});

	it('no catch-up without a sync task', async () => {
		await upsertTransactions(HH1, [tx('t1', '2026-08-10', -20)]);
		await run('2026-09-10T12:00:00Z', ['brief']);
		expect(capture).not.toHaveBeenCalled();
	});

	it('skips the catch-up when the previous period has an (imported) TOTAL row or no transactions', async () => {
		await run('2026-09-10T12:00:00Z', ['sync']); // no transactions at all
		expect(capture).not.toHaveBeenCalled();

		await upsertTransactions(HH1, [tx('t1', '2026-08-10', -20)]);
		await upsertCashflowRows(HH1, [
			{
				periodStart: '2026-07-25',
				periodEnd: '2026-08-24',
				rowType: 'TOTAL',
				accountKey: 'TOTAL',
				accountName: 'Imported',
				currency: 'EUR',
				closingBalance: 1,
				closingBalanceBase: 1,
				capturedAt: '2026-08-24T21:00:00Z',
				source: 'import',
				notes: null,
			},
		]);
		await run('2026-09-10T13:00:00Z', ['sync']);
		expect(capture).not.toHaveBeenCalled();
	});

	it('the real retroactive capture writes the previous period once (offset −1 end to end)', async () => {
		const actual = await vi.importActual<typeof import('../src/cashflow/capture')>('../src/cashflow/capture');
		capture.mockImplementation(actual.captureClosingBalances);
		const account: AccountRow = {
			id: 'acc',
			name: 'Current',
			accountType: 'CurrentAccount',
			currency: 'EUR',
			balance: 1000,
			excludeFromStats: 0,
			includeInCashflow: 1,
			archived: 0,
			updatedAt: '2026-09-10T00:00:00Z',
		};
		await upsertAccounts(HH1, [account]);
		// In the previous period (25 Jul – 24 Aug) and after its end: 1000 − (−100 + 50) = 1050.
		await upsertTransactions(HH1, [tx('t1', '2026-08-10', -20), tx('t2', '2026-08-25', -100), tx('t3', '2026-09-05', 50)]);

		await run('2026-09-10T12:00:00Z', ['sync']);
		await run('2026-09-10T13:00:00Z', ['sync']);

		expect(capture).toHaveBeenCalledOnce();
		const rows = await listCashflowRows(HH1);
		expect(rows.map((r) => [r.periodStart, r.periodEnd, r.rowType, r.accountKey, r.closingBalance, r.source])).toEqual([
			['2026-07-25', '2026-08-24', 'TOTAL', 'TOTAL', 1050, 'auto'],
			['2026-07-25', '2026-08-24', 'ACCOUNT', 'acc', 1050, 'auto'],
		]);
		expect(await getSetting(HH1, 'capture_last_period_end')).toBeNull(); // the current-period guard is untouched
	});
});

describe('parseTaskMessage', () => {
	it('accepts a v1 message (deduplicating tasks) and rejects anything else', () => {
		const ok = { v: 1, householdId: 3, tasks: ['sync', 'brief', 'sync'], scheduledFor: '2026-09-26T08:00:00.000Z' };
		expect(parseTaskMessage(ok)).toEqual({ ...ok, tasks: ['sync', 'brief'] });
		for (const bad of [
			null,
			'x',
			{ ...ok, v: 2 },
			{ ...ok, householdId: 0 },
			{ ...ok, householdId: '1' },
			{ ...ok, tasks: [] },
			{ ...ok, tasks: ['sync', 'dance'] },
			{ ...ok, scheduledFor: 'yesterday' },
		]) {
			expect(parseTaskMessage(bad)).toBeNull();
		}
	});
});

describe('queueHandler', () => {
	function message(body: unknown, id = 'm1') {
		return { id, body, attempts: 1, timestamp: new Date(), ack: vi.fn(), retry: vi.fn() };
	}
	function batch(queue: string, messages: ReturnType<typeof message>[]) {
		return { queue, messages, ackAll: vi.fn(), retryAll: vi.fn() };
	}
	const handle = (b: ReturnType<typeof batch>) => queueHandler(b as unknown as MessageBatch<unknown>, env, createExecutionContext());

	it('runs each valid message and acks it; a double delivery sends a single brief', async () => {
		const body = { v: 1, householdId: 1, tasks: ['sync', 'brief'], scheduledFor: '2026-01-15T09:00:00.000Z' };
		const first = message(body, 'a');
		const second = message(body, 'b');
		await handle(batch('household-tasks', [first, second]));

		expect(sync).toHaveBeenCalledTimes(2);
		expect(brief).toHaveBeenCalledOnce();
		expect(briefCalls()).toEqual([[true, new Date('2026-01-15T09:00:00.000Z')]]);
		expect(first.ack).toHaveBeenCalledOnce();
		expect(second.ack).toHaveBeenCalledOnce();
		expect(first.retry).not.toHaveBeenCalled();
	});

	it('acks task-level failures (logged; the next tick re-enqueues)', async () => {
		sync.mockRejectedValue(new Error('boom'));
		const m = message({ v: 1, householdId: 1, tasks: ['sync'], scheduledFor: '2026-01-15T09:00:00.000Z' });
		await handle(batch('household-tasks', [m]));
		expect(m.ack).toHaveBeenCalledOnce();
		expect(await logLines(1)).toContain('ERROR scheduled: Incremental Wallet sync failed: boom');
	});

	it('logs and acks a malformed message', async () => {
		const m = message({ v: 2, householdId: 1 }, 'bad-1');
		await handle(batch('household-tasks', [m]));
		expect(m.ack).toHaveBeenCalledOnce();
		expect(sync).not.toHaveBeenCalled();
		expect((await logLines()).some((line) => line.startsWith('ERROR scheduled: Malformed household task message bad-1'))).toBe(true);
	});

	it('logs a dead-letter batch as one ERROR summary and acks all', async () => {
		const b = batch('household-tasks-dlq', [
			message({ v: 1, householdId: 2, tasks: ['sync', 'brief'], scheduledFor: '2026-01-15T09:00:00.000Z' }, 'd1'),
			message('garbage', 'd2'),
		]);
		await handle(b);
		expect(b.ackAll).toHaveBeenCalledOnce();
		expect(sync).not.toHaveBeenCalled();
		expect(await logLines()).toContain(
			'ERROR scheduled: 2 household task message(s) dead-lettered after retries: hh2[sync,brief]@2026-01-15T09:00:00.000Z, malformed(d2)',
		);
	});
});
