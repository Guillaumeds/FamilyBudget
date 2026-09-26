import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type TransactionRow,
	listAccounts,
	listCategories,
	listRunLog,
	listTargets,
	listTransactionsBetween,
	upsertFxRates,
	upsertTransactions,
} from '../src/db/repo';
import { getHousehold, secretAad, updateHousehold } from '../src/db/households';
import { getSetting, setSetting } from '../src/db/settings';
import type { Env } from '../src/env';
import { decryptSecret } from '../src/lib/crypto';
import { WalletApiError } from '../src/wallet/client';
import { syncWallet, toCategoryRows } from '../src/wallet/sync';
import { HH1, HH2, TEST_WALLET_TOKEN, resetDb } from './helpers';

const db = env.DB;
/** No env Wallet token: household 1's token comes from its encrypted households row (test/helpers.ts). */
const walletEnv: Env = { ...env, WALLET_API_TOKEN: undefined };
/** 11:00 in Dublin (IST, UTC+1) → today 2026-09-26, window start 2026-05-24, records fetched from 2026-05-23. */
const NOW = new Date('2026-09-26T10:00:00Z');

const CATEGORIES = [
	{ id: 'cat-groceries', name: 'Groceries', group: { id: 'food_and_drinks', name: 'Food & Drinks' }, archived: false },
	{ id: 'cat-missing', name: 'Missing', group: { id: 'others', name: 'Others' }, archived: false },
	{ id: 'cat-cashwd', name: 'Cash Withdrawal', parentId: 'cat-missing', group: { id: 'others', name: 'Others' } },
	{ id: 'cat-atm', name: 'ATM fees', parentId: 'cat-cashwd', group: { id: 'others', name: 'Others' } },
	{ id: 'cat-salary', name: 'Salary', parentId: '', group: { id: 'income', name: 'Income' } },
	{ id: 'cat-transfer', name: 'Transfer', group: { id: 'system_categories', name: 'System categories' }, archived: true },
];

const ACCOUNTS = [
	{ id: 'acc-cash', name: 'Cash', accountType: 'Cash', excludeFromStats: false, balance: { currencyCode: 'EUR', currentBalance: 40 } },
	{ id: 'acc-current', name: 'Current', accountType: 'CurrentAccount', balance: { currencyCode: 'EUR', currentBalance: 1234.5 } },
	{ id: 'acc-zar', name: 'Rand', accountType: 'CurrentAccount', excludeFromStats: true, balance: { currencyCode: 'ZAR', currentBalance: 3450.51 } },
	{ id: 'acc-old', name: 'Old USD', accountType: 'SavingAccount', archived: true, initialBalance: { value: 0, currencyCode: 'USD' } },
];

function record(id: string, accountId: string, value: number, currencyCode: string, recordDate: string, extra: object = {}) {
	return { id, accountId, amount: { value, currencyCode }, recordDate, recordState: 'cleared', ...extra };
}

const RECORD_PAGES: Record<string, object> = {
	'0': {
		limit: 200,
		offset: 0,
		nextOffset: 200,
		records: [
			record('rec-eur', 'acc-current', -12.34, 'EUR', '2026-09-25T23:30:00Z', {
				accountName: 'Current',
				category: { id: 'cat-groceries', name: 'Groceries' },
				recordType: 'expense',
				paymentType: 'card',
				note: 'Tesco',
			}),
			record('rec-income', 'acc-current', 2500, 'EUR', '2026-09-01T09:00:00Z', { category: { id: 'cat-salary' }, recordType: 'income' }),
		],
	},
	'200': {
		limit: 200,
		offset: 200,
		records: [
			record('rec-zar', 'acc-zar', -200, 'ZAR', '2026-09-20T10:00:00Z', { recordType: 'expense' }),
			record('rec-usd', 'acc-old', -50, 'USD', '2026-09-10T12:00:00Z', { recordType: 'expense' }),
			{ id: 'rec-nodate', accountId: 'acc-current', amount: { value: -1, currencyCode: 'EUR' } },
		],
	},
};

interface FakeWallet {
	categories?: object[];
	accounts?: object[];
	recordPages?: Record<string, object>;
	rev?: string;
	/** Status returned for /records instead of data. */
	recordsStatus?: number;
	frankfurterStatus?: number;
}

/** Fake Wallet API + a Frankfurter that knows no currency (422), so only pre-seeded rates exist. */
function fakeApis(wallet: FakeWallet = {}) {
	const { categories = CATEGORIES, accounts = ACCOUNTS, recordPages = RECORD_PAGES, rev = 'r100' } = wallet;
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
		const url = new URL(String(input));
		if (url.hostname === 'api.frankfurter.dev') {
			if (wallet.frankfurterStatus) return new Response('down', { status: wallet.frankfurterStatus });
			return Response.json({ message: `invalid currency: ${url.searchParams.get('quotes')!.split(',')[0]}` }, { status: 422 });
		}
		const headers = { 'X-Last-Data-Change-Rev': rev };
		const offset = url.searchParams.get('offset') ?? '0';
		switch (url.pathname) {
			case '/wallet/v1/api/categories':
				return Response.json({ limit: 200, offset: 0, categories }, { headers });
			case '/wallet/v1/api/accounts':
				return Response.json({ limit: 200, offset: 0, accounts: accounts.slice(0, Number(url.searchParams.get('limit'))) }, { headers });
			case '/wallet/v1/api/records':
				if (wallet.recordsStatus) return Response.json({ error: 'Invalid or expired token' }, { status: wallet.recordsStatus });
				return Response.json(recordPages[offset] ?? { records: [] }, { headers });
		}
		return new Response('not found', { status: 404 });
	});
}

function requests(spy: ReturnType<typeof fakeApis>, path: string): URL[] {
	return spy.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname.endsWith(path));
}

function localRow(id: string, date: string): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-current',
		accountName: 'Current',
		categoryId: 'cat-groceries',
		recordType: 'expense',
		paymentType: null,
		recordState: 'cleared',
		amount: -5,
		currency: 'EUR',
		amountBase: -5,
		note: null,
		syncedAt: NOW.toISOString(),
	};
}

async function transactionIds(): Promise<string[]> {
	return (await listTransactionsBetween(HH1, '2000-01-01', '2100-01-01')).map((row) => row.id).sort();
}

beforeEach(async () => {
	await resetDb();
	await setSetting(HH1, 'timezone', 'Europe/Dublin');
	// ZAR covered from before the oldest record through today → ensureRates only asks Frankfurter for USD.
	await upsertFxRates(db, 'EUR', [
		{ date: '2026-08-25', currency: 'ZAR', rateToBase: 0.05 },
		{ date: '2026-09-18', currency: 'ZAR', rateToBase: 0.05 },
		{ date: '2026-09-26', currency: 'ZAR', rateToBase: 0.05 },
	]);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('syncWallet', () => {
	it('syncs categories, accounts and records end to end', async () => {
		const spy = fakeApis();
		const result = await syncWallet(walletEnv, HH1, { now: NOW });

		expect(result).toEqual({
			skipped: false,
			categories: 6,
			accounts: 4,
			recordsUpserted: 4,
			recordsDeleted: 0,
			windowStart: '2026-05-24',
			changeRev: 'r100',
		});

		// Categories: parent chain → fullPath/level, blank parentId → null, archived flag.
		const categories = new Map((await listCategories(HH1)).map((c) => [c.id, c]));
		expect(categories.get('cat-atm')).toMatchObject({
			parentId: 'cat-cashwd',
			fullPath: 'Missing > Cash Withdrawal > ATM fees',
			level: 2,
			groupId: 'others',
			groupName: 'Others',
		});
		expect(categories.get('cat-cashwd')).toMatchObject({ parentId: 'cat-missing', fullPath: 'Missing > Cash Withdrawal', level: 1 });
		expect(categories.get('cat-missing')).toMatchObject({ parentId: null, fullPath: 'Missing', level: 0, archived: 0 });
		expect(categories.get('cat-salary')).toMatchObject({ parentId: null, fullPath: 'Salary', level: 0 });
		expect(categories.get('cat-transfer')).toMatchObject({ archived: 1, groupName: 'System categories' });

		// Default budget targets for every category and group.
		const targets = await listTargets(HH1);
		expect(targets).toHaveLength(6 + 4);
		expect(targets).toContainEqual(expect.objectContaining({ entityType: 'group', entityId: 'income', includeInExpense: 0 }));
		expect(targets).toContainEqual(expect.objectContaining({ entityType: 'group', entityId: 'others', includeInExpense: 1 }));
		expect(targets).toContainEqual(expect.objectContaining({ entityType: 'category', entityId: 'cat-transfer', includeInExpense: 0 }));

		// Accounts: currency/balance fallbacks, cash accounts start excluded from cash flow.
		const accounts = new Map((await listAccounts(HH1)).map((a) => [a.id, a]));
		expect(accounts.get('acc-cash')).toMatchObject({ accountType: 'Cash', currency: 'EUR', balance: 40, includeInCashflow: 0 });
		expect(accounts.get('acc-current')).toMatchObject({ currency: 'EUR', balance: 1234.5, includeInCashflow: 1, excludeFromStats: 0 });
		expect(accounts.get('acc-zar')).toMatchObject({ currency: 'ZAR', balance: 3450.51, excludeFromStats: 1 });
		expect(accounts.get('acc-old')).toMatchObject({ currency: 'USD', balance: null, archived: 1 });

		// Transactions: local date, signed native amount, base conversion, null when no rate.
		const rows = new Map((await listTransactionsBetween(HH1, '2026-01-01', '2027-01-01')).map((t) => [t.id, t]));
		expect([...rows.keys()].sort()).toEqual(['rec-eur', 'rec-income', 'rec-usd', 'rec-zar']);
		expect(rows.get('rec-eur')).toMatchObject({
			recordDate: '2026-09-25T23:30:00Z',
			date: '2026-09-26',
			accountId: 'acc-current',
			accountName: 'Current',
			categoryId: 'cat-groceries',
			recordType: 'expense',
			paymentType: 'card',
			recordState: 'cleared',
			amount: -12.34,
			currency: 'EUR',
			amountBase: -12.34,
			note: 'Tesco',
		});
		expect(rows.get('rec-income')).toMatchObject({ amount: 2500, amountBase: 2500, recordType: 'income', note: null, paymentType: null });
		expect(rows.get('rec-zar')!.amount).toBe(-200);
		expect(rows.get('rec-zar')!.amountBase).toBeCloseTo(-10);
		expect(rows.get('rec-usd')).toMatchObject({ amount: -50, currency: 'USD', amountBase: null, accountName: 'Old USD' });

		// Every records request carries the explicit date filter (never the 3-month default window).
		const recordRequests = requests(spy, '/v1/api/records');
		expect(recordRequests.map((u) => u.searchParams.get('offset'))).toEqual(['0', '200']);
		for (const url of recordRequests) {
			expect(url.searchParams.get('recordDate')).toBe('gte.2026-05-23');
			expect(url.searchParams.get('limit')).toBe('200');
		}

		// FX: only the uncovered currency was requested from Frankfurter.
		expect(requests(spy, '/v2/rates').map((u) => u.searchParams.get('quotes'))).toEqual(['USD']);

		expect(await getSetting(HH1, 'wallet_last_change_rev')).toBe('r100');
		const [log] = await listRunLog(db, 1, 1);
		expect(log).toMatchObject({ level: 'INFO', action: 'walletSync' });
		expect(log!.message).toContain('4 records upserted');
		expect(log!.message).toContain('1 without FX rate');
	});

	it('keeps a user-modified include_in_cashflow across re-syncs', async () => {
		fakeApis();
		await syncWallet(walletEnv, HH1, { now: NOW });
		await db.batch([
			db.prepare("UPDATE accounts SET include_in_cashflow = 1 WHERE id = 'acc-cash'"),
			db.prepare("UPDATE accounts SET include_in_cashflow = 0 WHERE id = 'acc-current'"),
		]);

		await syncWallet(walletEnv, HH1, { now: NOW, force: true });
		const accounts = new Map((await listAccounts(HH1)).map((a) => [a.id, a]));
		expect(accounts.get('acc-cash')!.includeInCashflow).toBe(1);
		expect(accounts.get('acc-current')!.includeInCashflow).toBe(0);
	});

	it('deletes local rows missing from Wallet only inside the window', async () => {
		await upsertTransactions(HH1, [
			localRow('stale-in-window', '2026-09-01'),
			localRow('stale-at-window-start', '2026-05-24'),
			localRow('edge-before-window', '2026-05-23'),
			localRow('old', '2026-01-15'),
			localRow('rec-nodate', '2026-09-02'), // still in Wallet, just not normalizable → must not be deleted
		]);
		fakeApis();
		const result = await syncWallet(walletEnv, HH1, { now: NOW });

		expect(result.recordsDeleted).toBe(2);
		expect(await transactionIds()).toEqual(['edge-before-window', 'old', 'rec-eur', 'rec-income', 'rec-nodate', 'rec-usd', 'rec-zar']);
	});

	it('never deletes after an empty record fetch', async () => {
		await upsertTransactions(HH1, [localRow('stale-in-window', '2026-09-01')]);
		fakeApis({ recordPages: { '0': { limit: 200, offset: 0, records: [] } } });
		const result = await syncWallet(walletEnv, HH1, { now: NOW });

		expect(result).toMatchObject({ recordsUpserted: 0, recordsDeleted: 0 });
		expect(await transactionIds()).toEqual(['stale-in-window']);
	});

	it('never deletes (and keeps the old rev) when pagination stops early', async () => {
		await upsertTransactions(HH1, [localRow('stale-in-window', '2026-09-01')]);
		fakeApis({
			recordPages: {
				'0': { nextOffset: 200, records: [record('rec-a', 'acc-current', -1, 'EUR', '2026-09-03T10:00:00Z')] },
				'200': { nextOffset: 200, records: [record('rec-b', 'acc-current', -2, 'EUR', '2026-09-04T10:00:00Z')] },
			},
		});
		const result = await syncWallet(walletEnv, HH1, { now: NOW });

		expect(result).toMatchObject({ recordsUpserted: 2, recordsDeleted: 0 });
		expect(await transactionIds()).toEqual(['rec-a', 'rec-b', 'stale-in-window']);
		expect(await getSetting(HH1, 'wallet_last_change_rev')).toBeNull();
		expect((await listRunLog(db, 5, 1)).some((log) => log.level === 'WARN' && log.message.includes('pagination stopped early'))).toBe(true);
	});

	it('skips when X-Last-Data-Change-Rev is unchanged; force and full bypass the check', async () => {
		await setSetting(HH1, 'wallet_last_change_rev', 'r100');
		let spy = fakeApis({ rev: 'r100' });

		const skipped = await syncWallet(walletEnv, HH1, { now: NOW });
		expect(skipped).toEqual({
			skipped: true,
			categories: 0,
			accounts: 0,
			recordsUpserted: 0,
			recordsDeleted: 0,
			windowStart: null,
			changeRev: 'r100',
		});
		expect(spy).toHaveBeenCalledOnce();
		expect(requests(spy, '/v1/api/accounts')[0]!.searchParams.get('limit')).toBe('1');
		expect((await listRunLog(db, 1, 1))[0]).toMatchObject({ level: 'INFO', action: 'walletSync' });
		expect(await transactionIds()).toEqual([]);

		const forced = await syncWallet(walletEnv, HH1, { now: NOW, force: true });
		expect(forced).toMatchObject({ skipped: false, recordsUpserted: 4 });
		expect(requests(spy, '/v1/api/accounts').map((u) => u.searchParams.get('limit'))).toEqual(['1', '200']);

		vi.restoreAllMocks();
		spy = fakeApis({ rev: 'r100' });
		const full = await syncWallet(walletEnv, HH1, { now: NOW, full: true });
		expect(full).toMatchObject({ skipped: false, windowStart: '2020-01-01' });
		expect(requests(spy, '/v1/api/records').map((u) => u.searchParams.get('recordDate'))).toEqual(['gte.2019-12-31', 'gte.2019-12-31']);
		expect(requests(spy, '/v1/api/accounts').map((u) => u.searchParams.get('limit'))).toEqual(['200']);
	});

	it('syncs and stores the new rev when it changed', async () => {
		await setSetting(HH1, 'wallet_last_change_rev', 'r100');
		fakeApis({ rev: 'r101' });
		expect(await syncWallet(walletEnv, HH1, { now: NOW })).toMatchObject({ skipped: false, changeRev: 'r101' });
		expect(await getSetting(HH1, 'wallet_last_change_rev')).toBe('r101');
	});

	it('stores the rev guard in the synced household only', async () => {
		await setSetting(HH2, 'wallet_last_change_rev', 'hh2-rev');
		fakeApis({ rev: 'r101' });
		await syncWallet(walletEnv, HH1, { now: NOW });
		expect(await getSetting(HH1, 'wallet_last_change_rev')).toBe('r101');
		expect(await getSetting(HH2, 'wallet_last_change_rev')).toBe('hh2-rev');
	});

	it("authenticates with the household's decrypted Wallet token, not the env secret", async () => {
		const spy = fakeApis();
		await syncWallet({ ...env, WALLET_API_TOKEN: 'env-token-ignored' }, HH1, { now: NOW });

		const walletCalls = spy.mock.calls.filter(([input]) => new URL(String(input)).pathname.startsWith('/wallet/'));
		expect(walletCalls.length).toBeGreaterThan(0);
		for (const [, init] of walletCalls) expect(new Headers(init!.headers).get('Authorization')).toBe(`Bearer ${TEST_WALLET_TOKEN}`);
	});

	it('household 1 adopts the env WALLET_API_TOKEN into its encrypted row when it has none', async () => {
		await updateHousehold(db, 1, { walletTokenEnc: null });
		const spy = fakeApis();
		await syncWallet({ ...env, WALLET_API_TOKEN: ' env-wallet-token ' }, HH1, { now: NOW });

		expect(new Headers(spy.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Bearer env-wallet-token');
		const stored = (await getHousehold(db, 1))!.walletTokenEnc;
		expect(stored).toMatch(/^v1\./);
		expect(await decryptSecret(stored!, env.TOKEN_ENCRYPTION_KEY, secretAad('wallet-token', 1))).toBe('env-wallet-token');
		expect((await listRunLog(db, 10, 1)).some((log) => log.level === 'INFO' && log.action === 'secrets' && log.message.includes('WALLET_API_TOKEN'))).toBe(true);

		// Afterwards the env secret is no longer needed.
		vi.restoreAllMocks();
		const next = fakeApis();
		await syncWallet(walletEnv, HH1, { now: NOW, force: true });
		expect(new Headers(next.mock.calls[0]![1]!.headers).get('Authorization')).toBe('Bearer env-wallet-token');
	});

	it('fails with WALLET_AUTH without calling Wallet when the household has no token (no env adoption beyond household 1)', async () => {
		const spy = fakeApis();
		const error = await syncWallet({ ...env, WALLET_API_TOKEN: 'env-wallet-token' }, HH2, { now: NOW }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(WalletApiError);
		expect(error).toMatchObject({ code: 'WALLET_AUTH', message: expect.stringContaining('No Wallet token configured') });
		expect(spy).not.toHaveBeenCalled();
		expect((await getHousehold(db, 2))!.walletTokenEnc).toBeNull();
		expect((await listRunLog(db, 1, 2))[0]).toMatchObject({ level: 'ERROR', action: 'walletSync' });
	});

	it('treats an undecryptable stored token as missing and logs the crypto error', async () => {
		await updateHousehold(db, 1, { walletTokenEnc: 'v1.AAAA.BBBB' });
		const spy = fakeApis();
		await expect(syncWallet(walletEnv, HH1, { now: NOW })).rejects.toMatchObject({ code: 'WALLET_AUTH' });
		expect(spy).not.toHaveBeenCalled();
		expect((await listRunLog(db, 5, 1)).some((log) => log.level === 'ERROR' && log.action === 'secrets')).toBe(true);
	});

	it('logs a WalletApiError with its code, rethrows it and writes nothing', async () => {
		fakeApis({ recordsStatus: 401 });
		const error = await syncWallet(walletEnv, HH1, { now: NOW }).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(WalletApiError);
		expect(error).toMatchObject({ code: 'WALLET_AUTH', status: 401 });
		const [log] = await listRunLog(db, 1, 1);
		expect(log).toMatchObject({ level: 'ERROR', action: 'walletSync' });
		expect(log!.message).toMatch(/^WALLET_AUTH: /);
		expect(await listCategories(HH1)).toEqual([]);
	});

	it('keeps syncing when Frankfurter is down (amount_base stays null without a cached rate)', async () => {
		fakeApis({ frankfurterStatus: 503 });
		const result = await syncWallet(walletEnv, HH1, { now: NOW });

		expect(result.recordsUpserted).toBe(4);
		const rows = new Map((await listTransactionsBetween(HH1, '2026-01-01', '2027-01-01')).map((t) => [t.id, t]));
		expect(rows.get('rec-usd')!.amountBase).toBeNull();
		expect(rows.get('rec-zar')!.amountBase).toBeCloseTo(-10);
		expect((await listRunLog(db, 5, 1)).some((log) => log.level === 'WARN' && log.message.includes('FX refresh failed'))).toBe(true);
	});
});

describe('toCategoryRows', () => {
	it('guards against parent cycles and keeps unknown parents as references', () => {
		const rows = toCategoryRows(
			[
				{ id: 'a', name: 'A', parentId: 'b' },
				{ id: 'b', name: 'B', parentId: 'a' },
				{ id: 'c', name: 'C', parentId: 'gone' },
				{ id: 'd' },
				{ name: 'no id' },
			],
			NOW.toISOString(),
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		expect(rows).toHaveLength(4);
		expect(byId.get('a')).toMatchObject({ fullPath: 'A > B > A', level: 2 });
		expect(byId.get('b')).toMatchObject({ fullPath: 'A > B', level: 1 });
		expect(byId.get('c')).toMatchObject({ parentId: 'gone', fullPath: 'C', level: 0 });
		expect(byId.get('d')).toMatchObject({ name: 'Uncategorized', groupId: null, groupName: null });
	});
});
