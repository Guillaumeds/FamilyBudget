/**
 * Cash-flow closing-balance capture — ports captureBudgetPeriodClosingBalances and
 * getNonCashAccountClosingDetailsForPeriods (legacy/Code.gs ~1137 and ~1452), adapted to the signed
 * native amounts stored in D1.
 *
 * For the current budget period, each account with include_in_cashflow (and not archived) gets a
 * closing balance = current Wallet balance − the net of its transactions dated after the period end.
 * Writes one ACCOUNT row per account plus a TOTAL row (source 'auto'). Re-runs replace the previous
 * 'auto' capture of that period; 'import' rows are never touched.
 */
import { deleteCashflowRows, listAccounts, listCashflowRows, listTransactionsBetween, logRun, upsertCashflowRows, type CashflowRow } from '../db/repo';
import type { Settings } from '../db/settings';
import { formatMoney, roundCurrency } from '../lib/format';
import { convertToBase } from '../lib/fx';
import { normalizeStartDay, periodForOffset } from '../lib/period';
import { isoNow, localDate } from '../lib/tz';

export interface CaptureResult {
	periodEnd: string;
	accounts: number;
	totalBase: number;
}

const rowKey = (row: Pick<CashflowRow, 'rowType' | 'accountKey'>) => `${row.rowType}:${row.accountKey}`;

export async function captureClosingBalances(db: D1Database, settings: Settings, now: Date): Promise<CaptureResult> {
	const base = settings.base_currency.toUpperCase();
	const period = periodForOffset(localDate(now, settings.timezone), normalizeStartDay(Number(settings.budget_month_start_day)), 0);
	const [accounts, laterTransactions] = await Promise.all([
		listAccounts(db),
		listTransactionsBetween(db, period.endExclusiveText, '9999-12-31'),
	]);

	// Net signed movement per account after the period end (POC movementAfterPeriodEnd).
	const movementAfterEnd = new Map<string, number>();
	for (const row of laterTransactions) {
		if (row.accountId) movementAfterEnd.set(row.accountId, (movementAfterEnd.get(row.accountId) ?? 0) + row.amount);
	}

	const capturedAt = isoNow();
	const accountRows: CashflowRow[] = [];
	for (const account of accounts) {
		if (account.includeInCashflow !== 1 || account.archived === 1) continue;
		const currency = (account.currency || base).toUpperCase();
		const closing = roundCurrency((account.balance ?? 0) - (movementAfterEnd.get(account.id) ?? 0));
		const closingBase = await convertToBase(db, closing, currency, period.endText, base);
		accountRows.push({
			periodStart: period.startText,
			periodEnd: period.endText,
			rowType: 'ACCOUNT',
			accountKey: account.id,
			accountName: account.name,
			currency,
			closingBalance: closing,
			closingBalanceBase: closingBase === null ? null : roundCurrency(closingBase),
			capturedAt,
			source: 'auto',
			notes: null,
		});
	}
	const totalBase = roundCurrency(accountRows.reduce((total, row) => total + (row.closingBalanceBase ?? 0), 0));
	const rows: CashflowRow[] = [
		{
			periodStart: period.startText,
			periodEnd: period.endText,
			rowType: 'TOTAL',
			accountKey: 'TOTAL',
			accountName: 'All included accounts',
			currency: base,
			closingBalance: totalBase,
			closingBalanceBase: totalBase,
			capturedAt,
			source: 'auto',
			notes: null,
		},
		...accountRows,
	];

	await deleteCashflowRows(db, period.endText, 'auto');
	// An imported row with the same key wins: the upsert would otherwise overwrite it.
	const imported = new Set((await listCashflowRows(db, period.endText)).map(rowKey));
	await upsertCashflowRows(
		db,
		rows.filter((row) => !imported.has(rowKey(row))),
	);

	const missingFx = accountRows.filter((row) => row.closingBalanceBase === null).length;
	await logRun(
		db,
		'INFO',
		'capture',
		`Captured ${accountRows.length} account(s) for ${period.label}: total ${formatMoney(totalBase, base)}` +
			(missingFx ? ` (${missingFx} without an FX rate, counted as 0)` : '') +
			(imported.size ? ` (${imported.size} imported row(s) kept)` : '') +
			'.',
	);
	return { periodEnd: period.endText, accounts: accountRows.length, totalBase };
}
