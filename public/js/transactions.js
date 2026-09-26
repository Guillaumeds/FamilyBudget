// Transactions view: date range, search, quick filters, table with totals.
import { addDays, api, debounce, emptyState, errorBox, formatDate, h, money, pageHeader, setChildren, spinner } from './lib.js';

const LIMIT = 500;

export async function render(root, ctx) {
	const header = pageHeader('Transactions', 'Everything synced from BudgetBakers, newest first.');
	const body = h('div', {}, spinner());
	root.append(header, body);

	let current;
	try {
		current = await ctx.currentPeriod();
	} catch (error) {
		body.replaceChildren(errorBox(error, () => ctx.navigate('#/transactions')));
		return;
	}
	const yesterday = addDays(current.todayLocal, -1);
	const periodRange = [current.period.startText, current.period.endText];

	const from = h('input', { type: 'date', id: 'tx-from', value: ctx.params.get('from') || periodRange[0] });
	const to = h('input', { type: 'date', id: 'tx-to', value: ctx.params.get('to') || periodRange[1] });
	const search = h('input', { type: 'search', id: 'tx-q', placeholder: 'Category, account or note', autocomplete: 'off', value: ctx.params.get('q') || '' });

	const chip = (label, range) => {
		const button = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: () => setRange(range) }, label);
		button.range = range;
		return button;
	};
	const chips = [chip('This period', periodRange), chip('Yesterday', [yesterday, yesterday]), chip('Today', [current.todayLocal, current.todayLocal])];

	const filters = h(
		'form',
		{ class: 'filters card', role: 'search', onsubmit: (event) => (event.preventDefault(), load()) },
		h('div', { class: 'field' }, h('label', { for: 'tx-from' }, 'From'), from),
		h('div', { class: 'field' }, h('label', { for: 'tx-to' }, 'To'), to),
		h('div', { class: 'field field-grow' }, h('label', { for: 'tx-q' }, 'Search'), search),
		h('div', { class: 'chips', role: 'group', 'aria-label': 'Quick ranges' }, chips),
	);
	const status = h('div', { class: 'result-bar', 'aria-live': 'polite' });
	const results = h('div', {});
	body.replaceChildren(filters, status, results);

	function setRange([start, end]) {
		from.value = start;
		to.value = end;
		load();
	}

	let token = 0;
	async function load() {
		const mine = ++token;
		for (const button of chips) button.setAttribute('aria-pressed', String(button.range[0] === from.value && button.range[1] === to.value));
		if (!from.value || !to.value) return;
		const query = new URLSearchParams({ from: from.value, to: to.value, limit: String(LIMIT) });
		if (search.value.trim()) query.set('q', search.value.trim());
		const hashQuery = new URLSearchParams({ from: from.value, to: to.value, ...(search.value.trim() ? { q: search.value.trim() } : {}) });
		history.replaceState(null, '', `#/transactions?${hashQuery}`);
		results.classList.add('is-loading');
		try {
			const data = await api(`/api/transactions?${query}`);
			if (mine !== token) return;
			renderResults(data);
		} catch (error) {
			if (mine !== token) return;
			status.replaceChildren();
			results.replaceChildren(errorBox(error, load));
		} finally {
			if (mine === token) results.classList.remove('is-loading');
		}
	}

	function renderResults(data) {
		const cur = data.currency;
		const shown = data.transactions;
		const sumOf = (type, sign) => shown.reduce((sum, t) => (t.recordType?.toLowerCase() === type ? sum + sign * (t.amountBase ?? 0) : sum), 0);
		const shownExpenses = sumOf('expense', -1);
		const shownIncome = sumOf('income', 1);
		setChildren(
			status,
			h('span', {}, h('strong', {}, shown.length.toLocaleString()), data.truncated ? ` of ${data.total.toLocaleString()} transactions (showing the newest ${LIMIT})` : ` transaction${shown.length === 1 ? '' : 's'}`),
			h('span', {}, 'Expenses ', h('strong', { class: 'neg' }, money(shownExpenses, cur))),
			shownIncome > 0 && h('span', {}, 'Income ', h('strong', { class: 'pos' }, money(shownIncome, cur))),
			data.totals.missingFx > 0 && h('span', { class: 'warn-text', title: 'Run an FX backfill in Settings' }, `${data.totals.missingFx} without exchange rate`),
		);
		if (shown.length === 0) {
			results.replaceChildren(emptyState(h('p', {}, data.q ? `No transactions match “${data.q}” in this range.` : 'No transactions in this range.')));
			return;
		}
		const rows = shown.map((t) => {
			const income = t.recordType?.toLowerCase() === 'income';
			const foreign = t.currency && t.currency.toUpperCase() !== cur.toUpperCase();
			const amount =
				t.amountBase === null
					? h('span', { class: 'warn-text', title: 'No exchange rate yet' }, money(t.amount, t.currency))
					: h('span', { class: income ? 'pos' : '', title: foreign ? `${money(t.amount, t.currency)} (original amount)` : null }, money(t.amountBase, cur), foreign && h('span', { class: 'fx-mark', 'aria-hidden': 'true' }, ' *'));
			return h(
				'tr',
				{},
				h('td', { class: 'nowrap' }, h('time', { datetime: t.date }, formatDate(t.date))),
				h('td', { class: 'tx-category' }, t.categoryPath ?? h('span', { class: 'muted' }, 'Uncategorised')),
				h('td', { class: 'muted' }, t.accountName ?? ''),
				h('td', { class: 'num' }, amount),
				h('td', { class: 'tx-note' }, t.note ?? ''),
			);
		});
		setChildren(
			results,
			h(
				'div',
				{ class: 'table-scroll' },
				h(
					'table',
					{ class: 'table tx-table' },
					h('caption', { class: 'visually-hidden' }, `Transactions from ${data.from} to ${data.to}`),
					h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Category'), h('th', { scope: 'col' }, 'Account'), h('th', { scope: 'col', class: 'num' }, `Amount (${cur})`), h('th', { scope: 'col' }, 'Note'))),
					h('tbody', {}, rows),
				),
			),
			shown.some((t) => t.currency && t.currency.toUpperCase() !== cur.toUpperCase()) && h('p', { class: 'small muted' }, '* converted from another currency — hover for the original amount.'),
		);
	}

	from.addEventListener('change', load);
	to.addEventListener('change', load);
	search.addEventListener('input', debounce(load, 300));
	await load();
}
