// Settings view: grouped setting forms, admin actions, logs.
import { importCsv, outcome, runCapture, runFxBackfill, runSync } from './actions.js';
import { FIELDS, GROUPS, renderField, saveFields } from './fields.js';
import { api, badge, card, emptyState, errorBox, formatInstant, h, pageHeader, spinner, toast, withBusy } from './lib.js';

/** Settings that change the current period or amounts shown elsewhere. */
const PERIOD_KEYS = ['timezone', 'budget_month_start_day', 'base_currency'];

export async function render(root, ctx) {
	const body = h('div', {}, spinner());
	root.append(pageHeader('Settings', 'Configuration, maintenance actions and logs.'), body);

	let loaded;
	try {
		loaded = await api('/api/settings');
	} catch (error) {
		body.replaceChildren(errorBox(error, () => ctx.navigate('#/settings')));
		return;
	}
	const current = loaded.settings;

	const toc = h(
		'nav',
		{ class: 'toc', 'aria-label': 'Settings sections' },
		[...GROUPS.map((group) => [group, slug(group)]), ['Actions', 'admin'], ['FX', 'fx'], ['Logs', 'logs']].map(([label, id]) =>
			h(
				'a',
				{
					href: `#/settings/${id}`,
					class: 'chip',
					// Scroll in place (a hash change would re-render and drop unsaved edits).
					onclick: (event) => {
						event.preventDefault();
						history.replaceState(null, '', `#/settings/${id}`);
						focusSection(id);
					},
				},
				label,
			),
		),
	);

	body.replaceChildren(toc, h('div', { class: 'settings-grid' }, GROUPS.map((group) => groupForm(group, current, ctx))), adminCard(current), logsCard());

	if (ctx.sub[0]) focusSection(ctx.sub[0]);
}

function focusSection(id) {
	const target = document.getElementById(`section-${id}`);
	if (!target) return;
	target.scrollIntoView({ block: 'start', behavior: 'smooth' });
	target.querySelector('input, select, button')?.focus({ preventScroll: true });
}

function slug(text) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function groupForm(group, current, ctx) {
	const fields = Object.keys(FIELDS)
		.filter((key) => FIELDS[key].group === group)
		.map((key) => renderField(key, current[key]));
	const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
	const form = h(
		'form',
		{
			class: 'card settings-form',
			id: `section-${slug(group)}`,
			novalidate: true,
			onsubmit: async (event) => {
				event.preventDefault();
				const before = Object.fromEntries(PERIOD_KEYS.map((key) => [key, current[key]]));
				const saved = await withBusy(save, () => saveFields(fields, current)).catch(() => null);
				if (!saved) return;
				toast(`${group} settings saved.`, 'ok');
				if (PERIOD_KEYS.some((key) => current[key] !== before[key])) ctx.invalidatePeriod();
			},
		},
		h('h2', { class: 'card-title' }, group),
		fields.map((field) => field.el),
		h('div', { class: 'button-row' }, save),
	);
	return form;
}

// ---------------------------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------------------------

function actionButton(label, fn, result, { primary = false } = {}) {
	const button = h('button', { type: 'button', class: `btn${primary ? ' btn-primary' : ''}` }, label);
	button.addEventListener('click', async () => {
		result.replaceChildren();
		try {
			const res = await withBusy(button, fn);
			result.replaceChildren(outcome(res));
			toast(res.summary, res.kind === 'warn' ? 'warn' : 'ok');
		} catch (error) {
			result.replaceChildren(outcome({ kind: 'error', summary: error.message }));
		}
	});
	return button;
}

function adminCard(current) {
	const result = h('div', { class: 'action-result', 'aria-live': 'polite' });

	const fxFrom = h('input', { type: 'date', id: 'fx-from', value: current.sync_backfill_from });
	const fxAll = h('input', { type: 'checkbox', id: 'fx-all' });
	const fxResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const fxButton = actionButton('Run FX backfill', () => runFxBackfill({ from: fxFrom.value, all: fxAll.checked }), fxResult);

	const importResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const fileImport = (kind, label, hint) => {
		const id = `import-${kind}`;
		const input = h('input', { type: 'file', id, accept: '.csv,text/csv' });
		input.addEventListener('change', async () => {
			const file = input.files?.[0];
			if (!file) return;
			importResult.replaceChildren();
			try {
				importResult.replaceChildren(outcome(await importCsv(kind, file)));
			} catch (error) {
				importResult.replaceChildren(outcome({ kind: 'error', summary: error.message }));
			} finally {
				input.value = '';
			}
		});
		return h('div', { class: 'field' }, h('label', { for: id }, label), input, h('div', { class: 'help' }, hint));
	};

	return h(
		'div',
		{ class: 'admin-grid' },
		h(
			'section',
			{ class: 'card', id: 'section-admin' },
			h('h2', { class: 'card-title' }, 'Sync & capture'),
			h('p', { class: 'small muted' }, 'Sync runs every hour on its own. A full sync re-imports everything since “History starts on”.'),
			h(
				'div',
				{ class: 'button-row' },
				actionButton('Sync now', () => runSync(), result, { primary: true }),
				actionButton('Full sync', () => runSync({ full: true }), result),
				actionButton('Capture balances now', () => runCapture(current.base_currency), result),
			),
			result,
		),
		h(
			'section',
			{ class: 'card', id: 'section-fx' },
			h('h2', { class: 'card-title' }, 'Exchange rates (FX backfill)'),
			h('p', { class: 'small muted' }, 'Fetches ECB rates for foreign-currency transactions and converts them to your base currency.'),
			h('div', { class: 'inline-fields' }, h('div', { class: 'field' }, h('label', { for: 'fx-from' }, 'Rates from'), fxFrom), h('div', { class: 'field field-flag' }, h('label', { for: 'fx-all' }, fxAll, h('span', {}, 'Re-convert all transactions (after changing base currency)')))),
			h('div', { class: 'button-row' }, fxButton),
			fxResult,
		),
		card(
			'Import CSV',
			fileImport('budgets', 'Budget targets', 'entity_type,name_or_path,budget,forecast_type,include_in_report,include_in_expense — or the legacy Google Sheet Budgets export.'),
			fileImport('cashflow', 'Cash-flow history', 'period_start,period_end,account_name,currency,closing_balance (optional notes).'),
			importResult,
		),
	);
}

// ---------------------------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------------------------

const LEVEL_KIND = { ERROR: 'bad', WARN: 'warn', INFO: 'info', DEBUG: 'neutral' };
const STATUS_KIND = { COMPLETED: 'ok', SENT: 'ok', FAILED: 'bad', PROCESSING: 'info', STALE_IGNORED: 'neutral', IGNORED_SENDER: 'neutral', DRY_RUN: 'warn' };

function logsCard() {
	let type = 'run';
	const tabs = ['run', 'message'].map((value) =>
		h(
			'button',
			{ type: 'button', role: 'tab', id: `tab-${value}`, class: 'tab', 'aria-controls': 'logs-panel', 'aria-selected': String(value === type), tabindex: value === type ? '0' : '-1', onclick: () => select(value) },
			value === 'run' ? 'Run log' : 'Messages',
		),
	);
	const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Log type' }, tabs);
	tablist.addEventListener('keydown', (event) => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		const nextType = type === 'run' ? 'message' : 'run';
		select(nextType);
		document.getElementById(`tab-${nextType}`).focus();
	});
	const panel = h('div', { id: 'logs-panel', role: 'tabpanel', 'aria-labelledby': 'tab-run' });
	const refresh = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => withBusy(refresh, load).catch(() => {}) }, 'Refresh');

	function select(value) {
		type = value;
		for (const tab of tabs) {
			const on = tab.id === `tab-${value}`;
			tab.setAttribute('aria-selected', String(on));
			tab.tabIndex = on ? 0 : -1;
		}
		panel.setAttribute('aria-labelledby', `tab-${value}`);
		load();
	}

	let token = 0;
	async function load() {
		const mine = ++token;
		panel.replaceChildren(spinner());
		try {
			const data = await api(`/api/admin/logs?type=${type}&limit=100`);
			if (mine === token) panel.replaceChildren(type === 'run' ? runTable(data.rows) : messageTable(data.rows));
		} catch (error) {
			if (mine === token) panel.replaceChildren(errorBox(error, load));
		}
	}

	load();
	return h('section', { class: 'card', id: 'section-logs' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Logs'), refresh), tablist, panel);
}

function logTable(head, rows) {
	return h('div', { class: 'table-scroll logs-scroll' }, h('table', { class: 'table table-compact logs-table' }, h('thead', {}, h('tr', {}, head.map((label) => h('th', { scope: 'col' }, label)))), h('tbody', {}, rows)));
}

function runTable(rows) {
	if (rows.length === 0) return emptyState(h('p', {}, 'No log entries yet.'));
	return logTable(
		['Time', 'Level', 'Action', 'Message'],
		rows.map((row) => h('tr', {}, h('td', { class: 'nowrap', title: row.ts }, formatInstant(row.ts)), h('td', {}, badge(row.level, LEVEL_KIND[row.level] ?? 'neutral')), h('td', { class: 'mono small' }, row.action), h('td', { class: 'log-message' }, row.message))),
	);
}

function messageTable(rows) {
	if (rows.length === 0) return emptyState(h('p', {}, 'No WhatsApp messages yet.'));
	return logTable(
		['Time', 'Dir.', 'Number', 'Status', 'Message'],
		rows.map((row) =>
			h(
				'tr',
				{},
				h('td', { class: 'nowrap', title: row.createdAt }, formatInstant(row.createdAt)),
				h('td', {}, row.direction === 'in' ? badge('in', 'info') : badge('out', 'neutral')),
				h('td', { class: 'mono small nowrap' }, row.fromNumber ?? ''),
				h('td', {}, badge(row.status, STATUS_KIND[row.status] ?? 'neutral')),
				h('td', { class: 'log-message' }, row.body ?? '', (row.errorCode || row.errorMessage) && h('div', { class: 'small error-text' }, [row.errorCode, row.errorMessage].filter(Boolean).join(': '))),
			),
		),
	);
}
