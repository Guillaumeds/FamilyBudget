// Cash-flow view: closing funds per budget period (newest first), expandable per-account rows.
import { api, badge, emptyState, errorBox, formatDate, formatInstant, h, money, pageHeader, signedMoney, spinner } from './lib.js';

export async function render(root) {
	const body = h('div', {}, spinner());
	root.append(pageHeader('Cash flow', 'Closing funds at the end of each budget period.'), body);

	async function load() {
		try {
			const data = await api('/api/cashflow');
			body.replaceChildren(...renderData(data));
		} catch (error) {
			body.replaceChildren(errorBox(error, load));
		}
	}
	await load();
}

function renderData({ currency, totals, accounts }) {
	if (totals.length === 0) {
		return [
			emptyState(
				h('p', {}, h('strong', {}, 'No cash-flow history yet.')),
				h('p', { class: 'muted' }, 'Account balances are captured automatically on the last day of every budget period. You can also capture now or import history from a CSV in ', h('a', { href: '#/settings/admin' }, 'Settings'), '.'),
			),
		];
	}
	const latest = totals[0];
	const intro = h(
		'section',
		{ class: 'card summary' },
		h(
			'div',
			{ class: 'stats' },
			h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, 'Latest closing funds'), h('div', { class: 'stat-value' }, money(latest.closing, currency)), h('div', { class: 'stat-extra' }, `Period ending ${formatDate(latest.periodEnd, { year: true })}`)),
			latest.hasPrior &&
				h('div', { class: `stat ${latest.change < 0 ? 'is-bad' : 'is-good'}` }, h('div', { class: 'stat-label' }, 'Change vs previous'), h('div', { class: 'stat-value' }, signedMoney(latest.change, currency))),
		),
	);
	const list = h(
		'div',
		{ class: 'cf-list', role: 'list' },
		totals.map((total) => {
			const rows = accounts[total.periodEnd] ?? [];
			const change = total.hasPrior ? h('span', { class: `cf-change ${total.change < 0 ? 'neg' : total.change > 0 ? 'pos' : 'muted'}` }, signedMoney(total.change, currency)) : h('span', { class: 'cf-change muted' }, '—');
			const summary = h(
				'summary',
				{},
				h('span', { class: 'cf-period' }, h('strong', {}, `${formatDate(total.periodStart, { weekday: false })} – ${formatDate(total.periodEnd, { weekday: false, year: true })}`), h('span', { class: 'small muted' }, `${rows.length} account${rows.length === 1 ? '' : 's'}`)),
				h('span', { class: 'cf-closing' }, money(total.closing, currency)),
				change,
				sourceBadge(total.source),
			);
			const table =
				rows.length > 0
					? h(
							'div',
							{ class: 'table-scroll' },
							h(
								'table',
								{ class: 'table table-compact' },
								h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Account'), h('th', { scope: 'col', class: 'num' }, 'Balance'), h('th', { scope: 'col', class: 'num' }, `In ${currency}`), h('th', { scope: 'col' }, 'Source'))),
								h(
									'tbody',
									{},
									rows.map((row) =>
										h(
											'tr',
											{},
											h('th', { scope: 'row' }, row.accountName ?? row.accountKey, row.notes && h('div', { class: 'small muted' }, row.notes)),
											h('td', { class: 'num' }, money(row.closingBalance, row.currency || currency)),
											h('td', { class: 'num' }, row.closingBalanceBase === null ? h('span', { class: 'warn-text', title: 'No exchange rate' }, '—') : money(row.closingBalanceBase, currency)),
											h('td', {}, sourceBadge(row.source)),
										),
									),
								),
							),
						)
					: h('p', { class: 'muted small' }, 'No per-account rows for this period.');
			return h(
				'details',
				{ class: 'cf-item', role: 'listitem' },
				summary,
				h('div', { class: 'cf-detail' }, table, h('p', { class: 'small muted' }, `Captured ${formatInstant(total.capturedAt)}${total.notes ? ` · ${total.notes}` : ''}`)),
			);
		}),
	);
	return [intro, list];
}

function sourceBadge(source) {
	return source === 'import' ? badge('import', 'info') : badge('auto', 'neutral');
}
