import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	type AccountRow,
	type CashflowRow,
	type CategoryRow,
	type TransactionRow,
	deleteTransactionsNotIn,
	ensureDefaultTargets,
	getFxCoverage,
	getFxRateOnOrBefore,
	getMessageLogByWaId,
	insertMessageLog,
	listAccounts,
	listCashflowRows,
	listCashflowTotals,
	listCategories,
	listMessageLog,
	listRunLog,
	listTargets,
	listTransactionsBetween,
	listTransactionsOnDate,
	logRun,
	pruneRunLog,
	updateMessageLogByWaId,
	upsertAccounts,
	upsertCashflowRows,
	upsertCategories,
	upsertFxRates,
	upsertTarget,
	upsertTransactions,
} from '../src/db/repo';
import { SETTING_DEFAULTS, getSetting, getSettings, setSetting, setSettings, waWindowKey } from '../src/db/settings';
import { resetDb } from './helpers';

const db = env.DB;
const NOW = '2026-09-26T10:00:00.000Z';

function category(id: string, name: string, groupId: string | null, groupName: string | null): CategoryRow {
	return { id, parentId: null, name, groupId, groupName, fullPath: groupName ? `${groupName} > ${name}` : name, level: 0, archived: 0, updatedAt: NOW };
}

function account(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
	return {
		id,
		name: `Account ${id}`,
		accountType: 'CurrentAccount',
		currency: 'EUR',
		balance: 100,
		excludeFromStats: 0,
		includeInCashflow: 1,
		archived: 0,
		updatedAt: NOW,
		...overrides,
	};
}

function transaction(id: string, date: string, overrides: Partial<TransactionRow> = {}): TransactionRow {
	return {
		id,
		recordDate: `${date}T12:00:00Z`,
		date,
		accountId: 'acc-1',
		accountName: 'Current',
		categoryId: 'cat-groceries',
		recordType: 'expense',
		paymentType: 'card',
		recordState: 'cleared',
		amount: -12.34,
		currency: 'EUR',
		amountBase: -12.34,
		note: null,
		syncedAt: NOW,
		...overrides,
	};
}

beforeEach(resetDb);

describe('categories & accounts', () => {
	it('upserts and lists categories (camelCase round trip, update on conflict)', async () => {
		const groceries = category('cat-groceries', 'Groceries', 'food_drinks', 'Food & Drinks');
		await upsertCategories(db, [groceries, category('cat-salary', 'Salary', 'income', 'Income')]);
		await upsertCategories(db, [{ ...groceries, name: 'Supermarket', archived: 1 }]);

		const rows = await listCategories(db);
		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.id === 'cat-groceries')).toEqual({ ...groceries, name: 'Supermarket', archived: 1 });
	});

	it('preserves the user-controlled includeInCashflow flag on account upserts', async () => {
		await upsertAccounts(db, [account('a1', { includeInCashflow: 0 }), account('a2')]);
		await upsertAccounts(db, [account('a1', { balance: 250.5, includeInCashflow: 1, name: 'Renamed' })]);

		expect(await listAccounts(db)).toEqual([account('a2'), account('a1', { balance: 250.5, includeInCashflow: 0, name: 'Renamed' })]);
	});
});

describe('transactions', () => {
	it('upserts in chunks and lists by date window', async () => {
		const rows = Array.from({ length: 250 }, (_, i) =>
			transaction(`t${String(i).padStart(3, '0')}`, `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, {
				note: i === 0 ? 'Tesco — weekly shop' : null,
				currency: i % 2 ? 'ZAR' : 'EUR',
				amountBase: i % 2 ? null : -12.34,
			}),
		);
		await upsertTransactions(db, rows);

		const september = await listTransactionsBetween(db, '2026-09-01', '2026-10-01');
		expect(september).toHaveLength(250);
		expect(september.find((row) => row.id === 't000')).toEqual(rows[0]);
		expect(september.find((row) => row.id === 't001')!.amountBase).toBeNull();

		const firstWeek = await listTransactionsBetween(db, '2026-09-01', '2026-09-08');
		expect(firstWeek.every((row) => row.date >= '2026-09-01' && row.date < '2026-09-08')).toBe(true);
		expect(firstWeek.map((row) => row.date)).toEqual([...firstWeek.map((row) => row.date)].sort());

		const onDate = await listTransactionsOnDate(db, '2026-09-01');
		expect(onDate.map((row) => row.date)).toEqual(Array(onDate.length).fill('2026-09-01'));
		expect(onDate.length).toBeGreaterThan(0);
	});

	it('updates existing rows on conflict', async () => {
		await upsertTransactions(db, [transaction('t1', '2026-09-10')]);
		await upsertTransactions(db, [transaction('t1', '2026-09-11', { amount: -99, amountBase: -99, note: 'edited' })]);
		expect(await listTransactionsBetween(db, '2026-09-01', '2026-10-01')).toEqual([
			transaction('t1', '2026-09-11', { amount: -99, amountBase: -99, note: 'edited' }),
		]);
	});

	it('deleteTransactionsNotIn removes only rows in the window that Wallet no longer returns', async () => {
		await upsertTransactions(db, [
			transaction('old', '2026-05-31'),
			transaction('keep-1', '2026-06-01'),
			transaction('gone-1', '2026-06-01'),
			transaction('keep-2', '2026-07-15'),
			transaction('gone-2', '2026-09-20'),
		]);

		expect(await deleteTransactionsNotIn(db, '2026-06-01', ['keep-1', 'keep-2', 'not-local'])).toBe(2);
		const remaining = await listTransactionsBetween(db, '2000-01-01', '2100-01-01');
		expect(remaining.map((row) => row.id)).toEqual(['old', 'keep-1', 'keep-2']);
		expect(await deleteTransactionsNotIn(db, '2026-06-01', new Set(['keep-1', 'keep-2']))).toBe(0);
	});

	it('deleteTransactionsNotIn handles more ids than one statement', async () => {
		await upsertTransactions(db, Array.from({ length: 1200 }, (_, i) => transaction(`x${i}`, '2026-09-01')));
		expect(await deleteTransactionsNotIn(db, '2026-09-01', ['x7'])).toBe(1199);
		expect((await listTransactionsOnDate(db, '2026-09-01')).map((row) => row.id)).toEqual(['x7']);
	});
});

describe('budget targets', () => {
	const categories = [
		category('cat-groceries', 'Groceries', 'food_drinks', 'Food & Drinks'),
		category('cat-restaurant', 'Restaurant', 'food_drinks', 'Food & Drinks'),
		category('cat-salary', 'Salary', 'income', 'Income'),
		category('cat-transfer', 'Transfer', 'system_categories', 'System categories'),
		category('cat-move', 'Savings move', 'transfers', 'Transfers'),
		category('cat-orphan', 'Orphan', null, null),
	];

	it('ensureDefaultTargets inserts category and group rows with the income/transfer/system rule', async () => {
		expect(await ensureDefaultTargets(db, categories)).toBe(6 + 4);

		const targets = await listTargets(db);
		const flag = (type: string, id: string) => targets.find((t) => t.entityType === type && t.entityId === id)?.includeInExpense;
		expect(flag('category', 'cat-groceries')).toBe(1);
		expect(flag('category', 'cat-orphan')).toBe(1);
		expect(flag('category', 'cat-salary')).toBe(0);
		expect(flag('category', 'cat-transfer')).toBe(0);
		expect(flag('category', 'cat-move')).toBe(0);
		expect(flag('group', 'food_drinks')).toBe(1);
		expect(flag('group', 'income')).toBe(0);
		expect(flag('group', 'system_categories')).toBe(0);
		expect(flag('group', 'transfers')).toBe(0);
		expect(targets.find((t) => t.entityId === 'cat-groceries')).toEqual({
			entityType: 'category',
			entityId: 'cat-groceries',
			period: 'monthly',
			forecastType: 'day_to_day',
			budget: null,
			includeInReport: 0,
			includeInExpense: 1,
		});
	});

	it('ensureDefaultTargets is idempotent and never overwrites user edits', async () => {
		await ensureDefaultTargets(db, categories);
		await upsertTarget(db, {
			entityType: 'category',
			entityId: 'cat-groceries',
			period: 'monthly',
			forecastType: 'recurring',
			budget: 650,
			includeInReport: 1,
			includeInExpense: 1,
		});

		expect(await ensureDefaultTargets(db, categories)).toBe(0);
		expect(await ensureDefaultTargets(db, [...categories, category('cat-new', 'New', 'food_drinks', 'Food & Drinks')])).toBe(1);

		const groceries = (await listTargets(db)).find((t) => t.entityId === 'cat-groceries');
		expect(groceries).toMatchObject({ forecastType: 'recurring', budget: 650, includeInReport: 1 });
		expect(await listTargets(db)).toHaveLength(11);
	});

	it('ensureDefaultTargets with no categories is a no-op', async () => {
		expect(await ensureDefaultTargets(db, [])).toBe(0);
	});
});

describe('cash-flow balances', () => {
	const row = (periodEnd: string, rowType: CashflowRow['rowType'], accountKey: string, closingBalance: number): CashflowRow => ({
		periodStart: '2026-07-25',
		periodEnd,
		rowType,
		accountKey,
		accountName: rowType === 'TOTAL' ? 'Total' : `Account ${accountKey}`,
		currency: 'EUR',
		closingBalance,
		closingBalanceBase: closingBalance,
		capturedAt: NOW,
		source: 'auto',
		notes: null,
	});

	it('upserts idempotently and lists totals / rows newest first', async () => {
		await upsertCashflowRows(db, [
			row('2026-08-24', 'ACCOUNT', 'a1', 100),
			row('2026-08-24', 'TOTAL', 'TOTAL', 100),
			row('2026-09-24', 'ACCOUNT', 'a1', 200),
			row('2026-09-24', 'TOTAL', 'TOTAL', 200),
		]);
		await upsertCashflowRows(db, [row('2026-09-24', 'TOTAL', 'TOTAL', 250)]);

		expect((await listCashflowTotals(db, 10)).map((r) => [r.periodEnd, r.closingBalance])).toEqual([
			['2026-09-24', 250],
			['2026-08-24', 100],
		]);
		expect(await listCashflowTotals(db, 1)).toHaveLength(1);
		expect((await listCashflowRows(db)).map((r) => [r.periodEnd, r.rowType])).toEqual([
			['2026-09-24', 'TOTAL'],
			['2026-09-24', 'ACCOUNT'],
			['2026-08-24', 'TOTAL'],
			['2026-08-24', 'ACCOUNT'],
		]);
		expect(await listCashflowRows(db, '2026-08-24')).toEqual([row('2026-08-24', 'TOTAL', 'TOTAL', 100), row('2026-08-24', 'ACCOUNT', 'a1', 100)]);
	});
});

describe('fx rates', () => {
	it('upserts, reports coverage and looks up on-or-before', async () => {
		await upsertFxRates(db, [
			{ date: '2026-09-18', currency: 'usd', rateToBase: 0.9 },
			{ date: '2026-09-21', currency: 'USD', rateToBase: 0.85 },
		]);
		await upsertFxRates(db, [{ date: '2026-09-21', currency: 'USD', rateToBase: 0.8 }]);

		expect(await getFxRateOnOrBefore(db, '2026-09-20', 'USD')).toBe(0.9);
		expect(await getFxRateOnOrBefore(db, '2026-09-21', 'USD')).toBe(0.8);
		expect(await getFxRateOnOrBefore(db, '2026-09-17', 'USD')).toBeNull();
		expect(await getFxCoverage(db, ['usd', 'ZAR'])).toEqual(new Map([['USD', { minDate: '2026-09-18', maxDate: '2026-09-21' }]]));
	});
});

describe('message log', () => {
	it('de-duplicates by wa_message_id and supports status updates', async () => {
		const inbound = { waMessageId: 'wamid.1', direction: 'in' as const, fromNumber: '***4567', inboundTs: NOW, body: 'Budget', status: 'PROCESSING' };
		expect(await insertMessageLog(db, inbound)).toBe(true);
		expect(await insertMessageLog(db, inbound)).toBe(false);

		expect(await updateMessageLogByWaId(db, 'wamid.1', { status: 'COMPLETED', outboundMessageId: 'wamid.out', outboundAt: NOW })).toBe(true);
		expect(await updateMessageLogByWaId(db, 'wamid.missing', { status: 'FAILED' })).toBe(false);

		const row = await getMessageLogByWaId(db, 'wamid.1');
		expect(row).toMatchObject({ ...inbound, status: 'COMPLETED', outboundMessageId: 'wamid.out', outboundAt: NOW, errorCode: null });
		expect(row!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(await getMessageLogByWaId(db, 'wamid.missing')).toBeNull();
	});

	it('lists newest first; rows without a wa id are allowed', async () => {
		await insertMessageLog(db, { direction: 'out', status: 'SENT', body: 'brief 1' });
		await insertMessageLog(db, { direction: 'out', status: 'SENT', body: 'brief 2' });
		expect((await listMessageLog(db, 10)).map((row) => row.body)).toEqual(['brief 2', 'brief 1']);
	});
});

describe('run log', () => {
	it('logRun writes rows, listRunLog returns newest first, pruneRunLog drops old rows', async () => {
		await logRun(db, 'INFO', 'sync', 'first');
		await logRun(db, 'ERROR', 'sync', 'second');
		await db.prepare('INSERT INTO run_log (ts, level, action, message) VALUES (?, ?, ?, ?)').bind('2020-01-01T00:00:00.000Z', 'INFO', 'old', 'ancient').run();

		expect((await listRunLog(db, 2)).map((row) => row.message)).toEqual(['ancient', 'second']);
		expect(await pruneRunLog(db)).toBe(1);
		expect((await listRunLog(db, 10)).map((row) => [row.level, row.action, row.message])).toEqual([
			['ERROR', 'sync', 'second'],
			['INFO', 'sync', 'first'],
		]);
	});

	it('logRun never throws', async () => {
		const broken = { prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('D1 down')) }) }) } as unknown as D1Database;
		await expect(logRun(broken, 'WARN', 'test', 'still fine')).resolves.toBeUndefined();
	});
});

describe('settings', () => {
	it('getSettings returns defaults merged with stored values', async () => {
		expect(await getSettings(db)).toEqual(SETTING_DEFAULTS);

		await setSetting(db, 'timezone', 'Europe/Dublin');
		await setSettings(db, { budget_month_start_day: '25', whatsapp_to_numbers: '+353000000000', wallet_last_change_rev: '42' });

		const settings = await getSettings(db);
		expect(settings).toMatchObject({
			timezone: 'Europe/Dublin',
			budget_month_start_day: '25',
			whatsapp_to_numbers: '+353000000000',
			wallet_last_change_rev: '42',
			base_currency: 'EUR',
			ai_model: 'claude-sonnet-5',
		});
	});

	it('getSetting falls back to the default, or null for unset runtime keys', async () => {
		expect(await getSetting(db, 'brief_hour_local')).toBe('9');
		expect(await getSetting(db, 'brief_last_sent_date')).toBeNull();

		await setSetting(db, 'brief_hour_local', '8');
		await setSetting(db, waWindowKey('+353871234567'), NOW);
		await setSettings(db, { brief_hour_local: '7' });

		expect(await getSetting(db, 'brief_hour_local')).toBe('7');
		expect(await getSetting(db, 'wa_window_last_inbound:+353871234567')).toBe(NOW);
	});

	it('setSettings with an empty record is a no-op', async () => {
		await setSettings(db, {});
		expect(await getSettings(db)).toEqual(SETTING_DEFAULTS);
	});
});
