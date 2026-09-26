import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureClosingBalances } from '../src/cashflow/capture';
import { type AccountRow, type TransactionRow, listCashflowRows, listRunLog, upsertAccounts, upsertCashflowRows, upsertTransactions } from '../src/db/repo';
import { getSetting, setSettings } from '../src/db/settings';
import { runScheduled } from '../src/scheduled';
import { WalletApiError } from '../src/wallet/client';
import { syncWallet } from '../src/wallet/sync';
import { sendDailyBrief } from '../src/whatsapp/client';
import { resetDb } from './helpers';

// The setup file imports cloudflare:test, which also imports the main Worker, so src/index.ts's whole
// module graph is already cached (unmocked) when this file starts. Drop it so the vi.mock() calls
// below apply to every module this file imports.

vi.mock('../src/wallet/sync', () => ({ syncWallet: vi.fn() }));
vi.mock('../src/whatsapp/client', () => ({ sendDailyBrief: vi.fn() }));
vi.mock('../src/cashflow/capture', () => ({ captureClosingBalances: vi.fn() }));

const db = env.DB;
const sync = vi.mocked(syncWallet);
const brief = vi.mocked(sendDailyBrief);
const capture = vi.mocked(captureClosingBalances);

/** One cron tick at the given UTC instant (what `controller.scheduledTime` would carry). */
async function tick(iso: string): Promise<Date> {
	const now = new Date(iso);
	await runScheduled(env, createExecutionContext(), now);
	return now;
}

// Compare bindings by identity: deep equality would walk env's RPC-stub bindings.
const syncCalls = () => sync.mock.calls.map(([e, d, opts]) => [e === env && d === db, opts]);
const briefCalls = () => brief.mock.calls.map(([e, d, now]) => [e === env && d === db, now]);
const captureCalls = () => capture.mock.calls.map(([d, settings, now, offset]) => [d === db, settings.budget_month_start_day, now, offset]);

async function logLines(): Promise<string[]> {
	return (await listRunLog(db, 100)).map((row) => `${row.level} ${row.action}: ${row.message}`);
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
	await setSettings(db, {
		timezone: 'Europe/Dublin',
		brief_hour_local: '9',
		budget_month_start_day: '25',
		capture_hour_local: '22',
		base_currency: 'EUR',
	});
});

describe('daily brief gating', () => {
	it('follows local time across DST: 08:00 UTC in Irish summer time (IST, UTC+1)', async () => {
		await tick('2026-07-15T07:00:00Z'); // 08:00 local
		expect(brief).not.toHaveBeenCalled();

		const now = await tick('2026-07-15T08:00:00Z'); // 09:00 local
		expect(briefCalls()).toEqual([[true, now]]);
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-07-15');

		await tick('2026-07-15T09:00:00Z'); // 10:00 local — guard already set
		expect(brief).toHaveBeenCalledOnce();
	});

	it('follows local time across DST: 09:00 UTC in winter (GMT, UTC+0)', async () => {
		await tick('2026-01-15T08:00:00Z');
		expect(brief).not.toHaveBeenCalled();

		await tick('2026-01-15T09:00:00Z');
		expect(brief).toHaveBeenCalledOnce();
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-01-15');
	});

	it('catches up later the same day when the brief hour was missed (>=, not ===)', async () => {
		await tick('2026-01-15T11:00:00Z'); // 11:00 local, guard unset
		expect(brief).toHaveBeenCalledOnce();
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-01-15');
	});

	it('the guard prevents a second send the same local day, not the next day', async () => {
		await setSettings(db, { brief_last_sent_date: '2026-01-15' });
		await tick('2026-01-15T10:00:00Z');
		await tick('2026-01-15T23:00:00Z');
		expect(brief).not.toHaveBeenCalled();

		await tick('2026-01-16T09:00:00Z');
		expect(brief).toHaveBeenCalledOnce();
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-01-16');
	});

	it('sets the guard when the client skipped (nothing to retry) and logs the reason', async () => {
		brief.mockResolvedValue({ results: [], skippedReason: 'whatsapp_disabled' });
		await tick('2026-01-15T09:00:00Z');
		await tick('2026-01-15T10:00:00Z');

		expect(brief).toHaveBeenCalledOnce();
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-01-15');
		expect(await logLines()).toContain('INFO scheduled: Daily brief for 2026-01-15: skipped (whatsapp_disabled).');
	});

	it('sets the guard after a partial failure so the recipient that succeeded is not messaged twice', async () => {
		brief.mockResolvedValue({
			results: [
				{ to: '+35*****12', mode: 'text', messageId: 'wamid.1' },
				{ to: '+27*****34', mode: 'template', error: 'ERR_WHATSAPP_SEND: boom' },
			],
		});
		await tick('2026-01-15T09:00:00Z');
		await tick('2026-01-15T10:00:00Z');

		expect(brief).toHaveBeenCalledOnce();
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-01-15');
		expect(await logLines()).toContain('WARN scheduled: Daily brief for 2026-01-15: +35*****12: text, +27*****34: template FAILED.');
	});

	it('leaves the guard unset when building the brief throws, so the next hour retries', async () => {
		brief.mockRejectedValueOnce(new Error('engine exploded'));
		await tick('2026-01-15T09:00:00Z');

		expect(await getSetting(db, 'brief_last_sent_date')).toBeNull();
		expect((await logLines()).some((line) => line.startsWith('ERROR scheduled: Daily brief for 2026-01-15 failed') && line.includes('engine exploded'))).toBe(true);

		await tick('2026-01-15T10:00:00Z');
		expect(brief).toHaveBeenCalledTimes(2);
		expect(await getSetting(db, 'brief_last_sent_date')).toBe('2026-01-15');
	});
});

describe('wallet sync', () => {
	it('runs a full sync on Sunday 03:00 local and an incremental one otherwise', async () => {
		const sundaySummer = await tick('2026-09-27T02:00:00Z'); // Sun 03:00 IST
		const sundayWinter = await tick('2026-01-18T03:00:00Z'); // Sun 03:00 GMT
		const sundayLater = await tick('2026-09-27T03:00:00Z'); // Sun 04:00 IST
		const saturday = await tick('2026-09-26T02:00:00Z'); // Sat 03:00 IST

		expect(syncCalls()).toEqual([
			[true, { full: true, now: sundaySummer }],
			[true, { full: true, now: sundayWinter }],
			[true, { now: sundayLater }],
			[true, { now: saturday }],
		]);
	});

	it('a failing sync does not stop the brief; an initial-sync 409 is only a warning', async () => {
		sync.mockRejectedValueOnce(new WalletApiError('WALLET_SYNC_IN_PROGRESS', 'BudgetBakers is still running its initial data sync.'));
		await tick('2026-01-15T09:00:00Z');
		sync.mockRejectedValueOnce(new WalletApiError('WALLET_AUTH', 'token expired'));
		await tick('2026-01-16T09:00:00Z');
		sync.mockRejectedValueOnce(new TypeError('network down'));
		await tick('2026-01-17T09:00:00Z');

		expect(brief).toHaveBeenCalledTimes(3);
		const lines = await logLines();
		expect(lines).toContain('WARN scheduled: Incremental Wallet sync failed: WALLET_SYNC_IN_PROGRESS: BudgetBakers is still running its initial data sync.');
		expect(lines).toContain('ERROR scheduled: Incremental Wallet sync failed: WALLET_AUTH: token expired');
		expect(lines).toContain('ERROR scheduled: Incremental Wallet sync failed: network down');
	});
});

describe('cash-flow capture', () => {
	// Budget period 25 Aug – 24 Sep 2026; 21:00 UTC on 24 Sep = 22:00 in Dublin.
	it('fires only on the period end day at/after the capture hour, then sets its guard', async () => {
		await tick('2026-09-23T21:00:00Z'); // day before the end
		await tick('2026-09-24T20:00:00Z'); // end day, 21:00 local
		expect(capture).not.toHaveBeenCalled();

		const now = await tick('2026-09-24T21:00:00Z');
		expect(captureCalls()).toEqual([[true, '25', now, undefined]]);
		expect(await getSetting(db, 'capture_last_period_end')).toBe('2026-09-24');

		await tick('2026-09-24T22:00:00Z'); // 23:00 local — guard set
		expect(capture).toHaveBeenCalledOnce();
	});

	it('leaves its guard unset when the capture throws', async () => {
		capture.mockRejectedValueOnce(new Error('D1 hiccup'));
		await tick('2026-09-24T21:00:00Z');
		expect(await getSetting(db, 'capture_last_period_end')).toBeNull();

		await tick('2026-09-24T22:00:00Z');
		expect(capture).toHaveBeenCalledTimes(2);
		expect(await getSetting(db, 'capture_last_period_end')).toBe('2026-09-24');
	});

	it('retroactively captures the previous period when it has transactions but no TOTAL row', async () => {
		await upsertTransactions(db, [tx('t1', '2026-08-10', -20)]); // in 25 Jul – 24 Aug
		const now = await tick('2026-09-10T12:00:00Z');
		expect(captureCalls()).toEqual([[true, '25', now, -1]]);
	});

	it('skips the catch-up when the previous period has an (imported) TOTAL row or no transactions', async () => {
		await tick('2026-09-10T12:00:00Z'); // no transactions at all
		expect(capture).not.toHaveBeenCalled();

		await upsertTransactions(db, [tx('t1', '2026-08-10', -20)]);
		await upsertCashflowRows(db, [
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
		await tick('2026-09-10T13:00:00Z');
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
		await upsertAccounts(db, [account]);
		// In the previous period (25 Jul – 24 Aug) and after its end: 1000 − (−100 + 50) = 1050.
		await upsertTransactions(db, [tx('t1', '2026-08-10', -20), tx('t2', '2026-08-25', -100), tx('t3', '2026-09-05', 50)]);

		await tick('2026-09-10T12:00:00Z');
		await tick('2026-09-10T13:00:00Z');

		expect(capture).toHaveBeenCalledOnce();
		const rows = await listCashflowRows(db);
		expect(rows.map((r) => [r.periodStart, r.periodEnd, r.rowType, r.accountKey, r.closingBalance, r.source])).toEqual([
			['2026-07-25', '2026-08-24', 'TOTAL', 'TOTAL', 1050, 'auto'],
			['2026-07-25', '2026-08-24', 'ACCOUNT', 'acc', 1050, 'auto'],
		]);
		expect(await getSetting(db, 'capture_last_period_end')).toBeNull(); // the current-period guard is untouched
	});
});

describe('housekeeping', () => {
	const OLD_TS = '2000-01-01T00:00:00.000Z';
	const oldRowCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM run_log WHERE ts = ?').bind(OLD_TS).first<number>('n')) ?? 0;

	it('prunes run_log only at 04:00 local', async () => {
		await db.prepare("INSERT INTO run_log (ts, level, action, message) VALUES (?, 'INFO', 'old', 'ancient')").bind(OLD_TS).run();

		await tick('2026-07-15T02:00:00Z'); // 03:00 IST
		await tick('2026-07-15T04:00:00Z'); // 05:00 IST
		expect(await oldRowCount()).toBe(1);

		await tick('2026-07-15T03:00:00Z'); // 04:00 IST
		expect(await oldRowCount()).toBe(0);
		expect(await logLines()).toContain('INFO scheduled: Pruned 1 run_log row(s) older than 90 days.');
	});
});

describe('isolation between steps', () => {
	it('runs sync → brief → capture → prune in order, each failure isolated from the next', async () => {
		await setSettings(db, { brief_hour_local: '0', capture_hour_local: '0' });
		await db.prepare("INSERT INTO run_log (ts, level, action, message) VALUES ('2000-01-01T00:00:00.000Z', 'INFO', 'old', 'ancient')").run();
		sync.mockRejectedValue(new Error('sync down'));
		brief.mockRejectedValue(new Error('brief down'));
		capture.mockRejectedValue(new Error('capture down'));

		await tick('2026-09-24T03:00:00Z'); // period end day, 04:00 IST

		expect(sync.mock.invocationCallOrder[0]!).toBeLessThan(brief.mock.invocationCallOrder[0]!);
		expect(brief.mock.invocationCallOrder[0]!).toBeLessThan(capture.mock.invocationCallOrder[0]!);
		const lines = await logLines();
		expect(lines.filter((line) => line.startsWith('ERROR scheduled'))).toHaveLength(3);
		expect(lines).toContain('INFO scheduled: Pruned 1 run_log row(s) older than 90 days.');
	});

	it('uses the defaults when an hour setting is invalid', async () => {
		await setSettings(db, { brief_hour_local: 'nine' }); // → default 9
		await tick('2026-01-15T08:00:00Z');
		expect(brief).not.toHaveBeenCalled();
		await tick('2026-01-15T09:00:00Z');
		expect(brief).toHaveBeenCalledOnce();
	});
});
