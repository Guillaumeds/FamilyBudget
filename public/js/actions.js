// Admin actions shared by the Settings page and the setup wizard: sync, FX backfill, capture,
// CSV imports, test brief. Each returns the API result and a short human summary.
import { api, badge, callout, h, keyValues, money, readFileText } from './lib.js';

const n = (value) => Number(value ?? 0).toLocaleString();

/** POST /api/admin/sync. A 202 means BudgetBakers is still running its first import. */
export async function runSync({ full = false } = {}) {
	const result = await api('/api/admin/sync', { method: 'POST', body: { full, force: full } });
	return { result, ...describeSync(result) };
}

export function describeSync(result) {
	if (result.pending) {
		const minutes = Math.max(1, Math.round((result.retryAfterSeconds ?? 300) / 60));
		return {
			kind: 'warn',
			summary: `BudgetBakers is still preparing your data (initial sync). Try again in about ${minutes} min.`,
			details: null,
		};
	}
	if (result.skipped) return { kind: 'ok', summary: 'Nothing new — Wallet data hasn’t changed since the last sync.', details: null };
	return {
		kind: 'ok',
		summary: `${result.full ? 'Full sync' : 'Sync'} done: ${n(result.recordsUpserted)} record(s) updated, ${n(result.recordsDeleted)} removed.`,
		details: keyValues([
			['Categories', n(result.categories)],
			['Accounts', n(result.accounts)],
			['Records updated', n(result.recordsUpserted)],
			['Records removed', n(result.recordsDeleted)],
			result.windowStart && ['Mirrors Wallet since', result.windowStart],
		]),
	};
}

/** POST /api/admin/fx-backfill {from, all}. */
export async function runFxBackfill({ from, all = false } = {}) {
	const result = await api('/api/admin/fx-backfill', { method: 'POST', body: { ...(from ? { from } : {}), all } });
	const currencies = result.currencies.length ? result.currencies.join(', ') : 'none (everything is already in the base currency)';
	return {
		result,
		kind: result.stillMissing ? 'warn' : 'ok',
		summary: `Exchange rates: ${n(result.ratesFetched)} fetched, ${n(result.reconverted)} transaction(s) converted${result.stillMissing ? `, ${n(result.stillMissing)} still without a rate` : ''}.`,
		details: keyValues([
			['From', result.from],
			['Foreign currencies', currencies],
			['Rates fetched', n(result.ratesFetched)],
			['Transactions converted', n(result.reconverted)],
			['Still missing a rate', n(result.stillMissing)],
		]),
	};
}

/** POST /api/admin/capture. */
export async function runCapture(currency) {
	const result = await api('/api/admin/capture', { method: 'POST' });
	return {
		result,
		kind: 'ok',
		summary: `Captured ${n(result.accounts)} account balance(s) for the period ending ${result.periodEnd}: ${money(result.totalBase, currency)} in total.`,
		details: null,
	};
}

/** Uploads a CSV file to one of the import endpoints and renders the outcome. */
export async function importCsv(kind, file) {
	const csv = await readFileText(file);
	const result = await api(`/api/admin/import/${kind}`, { method: 'POST', csv });
	if (kind === 'budgets') {
		return {
			result,
			kind: result.unmatched.length ? 'warn' : 'ok',
			summary: `Imported ${n(result.imported)} budget target(s) (${result.format} format), ${n(result.skipped)} row(s) skipped.`,
			details: h(
				'div',
				{},
				keyValues([
					['Imported', n(result.imported)],
					['Skipped', n(result.skipped)],
					['Unmatched / invalid', n(result.unmatched.length)],
				]),
				result.unmatched.length > 0 &&
					h('details', { class: 'unmatched' }, h('summary', {}, `Show ${result.unmatched.length} unmatched row(s)`), h('ul', {}, result.unmatched.map((line) => h('li', {}, line)))),
			),
		};
	}
	return {
		result,
		kind: result.missingFx ? 'warn' : 'ok',
		summary: `Imported ${n(result.accounts)} account balance(s) across ${n(result.periods)} period(s).`,
		details: keyValues([
			['Periods', n(result.periods)],
			['Account rows', n(result.accounts)],
			['Period totals written', n(result.totalsWritten)],
			['Totals kept (automatic capture exists)', n(result.totalsSkipped)],
			['Rows without an exchange rate', n(result.missingFx)],
		]),
	};
}

const SKIP_REASONS = {
	whatsapp_disabled: 'WhatsApp sending is switched off (Send the daily brief on WhatsApp).',
	no_recipients: 'No recipients are configured.',
};

const MODE_LABELS = { text: 'free-form text', template: 'template', dry: 'dry run (logged only)' };

/** POST /api/admin/send-brief → per-recipient result list. */
export async function sendBrief() {
	const result = await api('/api/admin/send-brief', { method: 'POST' });
	let kind = result.ok ? 'ok' : 'error';
	let summary = result.dryRun ? 'Dry run: the brief was built and logged, nothing was sent.' : 'Brief sent.';
	if (result.skippedReason) {
		kind = 'warn';
		summary = `Nothing sent. ${SKIP_REASONS[result.skippedReason] ?? result.skippedReason}`;
	} else if (!result.ok) {
		summary = 'Sending failed for at least one recipient.';
	}
	const details =
		result.results.length > 0
			? h(
					'ul',
					{ class: 'recipients' },
					result.results.map((r) =>
						h(
							'li',
							{},
							h('span', { class: 'mono' }, r.to),
							r.error ? badge('failed', 'bad') : badge(MODE_LABELS[r.mode] ?? r.mode, r.mode === 'dry' ? 'warn' : 'ok'),
							r.error && h('div', { class: 'small error-text' }, r.error),
						),
					),
				)
			: null;
	return { result, kind, summary, details, note: result.dryRun && !result.skippedReason ? result.note : null };
}

/** Renders an action outcome in place (a callout with optional details). */
export function outcome({ kind, summary, details, note }) {
	return callout(kind === 'error' ? 'error' : kind, h('div', {}, summary), note && h('div', { class: 'small' }, note), details);
}
