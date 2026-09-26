// Settings view: grouped setting forms, connections (Wallet token, Anthropic key), admin actions,
// logs. The log card is also used by the owner console (all households).
import { importCsv, outcome, runCapture, runFxBackfill, runSync, saveAiKey, saveWalletToken, testWallet } from './actions.js';
import { GROUPS, groupKeys, renderField, saveFields } from './fields.js';
import { api, badge, callout, card, emptyState, errorBox, formatInstant, h, pageHeader, spinner, toast, withBusy } from './lib.js';

/** Settings that change the current period or amounts shown elsewhere. */
const PERIOD_KEYS = ['timezone', 'budget_month_start_day', 'base_currency'];

export async function render(root, ctx) {
	const body = h('div', {}, spinner());
	root.append(pageHeader('Settings', 'Configuration, maintenance actions and logs.'), body);

	let loaded;
	let status;
	try {
		// /api/status only adds badges (connections, WhatsApp approval): the page works without it.
		[loaded, status] = await Promise.all([api('/api/settings'), api('/api/status').catch(() => null)]);
	} catch (error) {
		body.replaceChildren(errorBox(error, () => ctx.navigate('#/settings')));
		return;
	}
	const current = loaded.settings;

	const toc = h(
		'nav',
		{ class: 'toc', 'aria-label': 'Settings sections' },
		[...GROUPS.map((group) => [group, slug(group)]), ['Connections', 'connections'], ['Actions', 'admin'], ['FX', 'fx'], ['Logs', 'logs']].map(([label, id]) =>
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

	body.replaceChildren(
		toc,
		h('div', { class: 'settings-grid' }, GROUPS.map((group) => groupForm(group, current, ctx, status))),
		connectionsCard(status),
		adminCard(current),
		logsCard(),
	);

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

function groupForm(group, current, ctx, status) {
	const fields = groupKeys(group).map((key) => renderField(key, current[key]));
	const pendingApproval = group === 'WhatsApp' && status?.approvals?.whatsapp === false;
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
		h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, group), pendingApproval && badge('pending approval', 'warn')),
		pendingApproval && callout('warn', 'The site owner hasn’t approved WhatsApp for this household yet. You can save these settings now — the daily brief starts once it is approved.'),
		fields.map((field) => field.el),
		group === 'WhatsApp' && h('p', { class: 'small muted' }, 'The message template (used outside the 24-hour window) is managed by the site owner.'),
		h('div', { class: 'button-row' }, save),
	);
	return form;
}

// ---------------------------------------------------------------------------------------------
// Connections: the household's own BudgetBakers token and Anthropic key (write-only, encrypted)
// ---------------------------------------------------------------------------------------------

function connectionsCard(status) {
	const configuredBadge = (on) => (on ? badge('configured', 'ok') : badge('not set', 'neutral'));

	// Wallet token
	const walletBadge = h('span', {}, status ? configuredBadge(status.walletConfigured) : null);
	const walletInput = h('input', { id: 'conn-wallet', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: status?.walletConfigured ? 'Paste a new token to replace it' : 'Paste your Wallet API token' });
	const walletResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const walletSave = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save & test');
	const walletTest = h('button', { type: 'button', class: 'btn' }, 'Test connection');
	const walletClear = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Remove');
	const setWallet = (on) => {
		walletBadge.replaceChildren(configuredBadge(on));
		walletInput.placeholder = on ? 'Paste a new token to replace it' : 'Paste your Wallet API token';
	};
	walletSave.addEventListener('click', async () => {
		const token = walletInput.value.trim();
		if (!token) return walletInput.focus();
		walletResult.replaceChildren();
		try {
			const res = await withBusy(walletSave, () => saveWalletToken(token), { quiet: true });
			walletResult.replaceChildren(res.el);
			walletInput.value = '';
			setWallet(true);
		} catch (error) {
			walletResult.replaceChildren(callout('error', error.message));
		}
	});
	walletTest.addEventListener('click', async () => {
		walletResult.replaceChildren();
		try {
			walletResult.replaceChildren((await withBusy(walletTest, testWallet, { quiet: true })).el);
		} catch (error) {
			walletResult.replaceChildren(callout('error', error.message));
		}
	});
	walletClear.addEventListener('click', async () => {
		if (!confirm('Remove the Wallet token? Syncing stops until you paste a new one. Your stored data is kept.')) return;
		walletResult.replaceChildren();
		try {
			walletResult.replaceChildren((await withBusy(walletClear, () => saveWalletToken(''), { quiet: true })).el);
			setWallet(false);
		} catch (error) {
			walletResult.replaceChildren(callout('error', error.message));
		}
	});

	// Anthropic key
	const aiBadge = h('span', {}, status ? configuredBadge(status.aiConfigured) : null);
	const aiInput = h('input', { id: 'conn-ai', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: status?.aiConfigured ? 'Paste a new key to replace it' : 'sk-ant-…' });
	const aiSave = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save key');
	const aiClear = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Remove');
	const setAi = (on) => {
		aiBadge.replaceChildren(configuredBadge(on));
		aiInput.placeholder = on ? 'Paste a new key to replace it' : 'sk-ant-…';
	};
	aiSave.addEventListener('click', async () => {
		const key = aiInput.value.trim();
		if (!key) return aiInput.focus();
		const message = await withBusy(aiSave, () => saveAiKey(key)).catch(() => null);
		if (!message) return;
		aiInput.value = '';
		setAi(true);
		toast(message, 'ok');
	});
	aiClear.addEventListener('click', async () => {
		if (!confirm('Remove the Anthropic key? WhatsApp questions will no longer be answered by Claude.')) return;
		const message = await withBusy(aiClear, () => saveAiKey('')).catch(() => null);
		if (!message) return;
		setAi(false);
		toast(message, 'ok');
	});

	return h(
		'section',
		{ class: 'card', id: 'section-connections' },
		h('h2', { class: 'card-title' }, 'Connections'),
		h('p', { class: 'small muted' }, 'Your household’s own keys. They are stored encrypted and never shown again — paste a new one to replace it.'),
		h('div', { class: 'settings-grid' },
			h(
				'div',
				{},
				h('h3', { class: 'check-label' }, 'BudgetBakers Wallet token ', walletBadge),
				h('div', { class: 'field' }, h('label', { for: 'conn-wallet' }, 'Wallet API token'), walletInput, h('div', { class: 'help' }, 'Create one in the Wallet web app: Settings → API (Premium plan).')),
				h('div', { class: 'button-row' }, walletSave, walletTest, walletClear),
				walletResult,
			),
			h(
				'div',
				{},
				h('h3', { class: 'check-label' }, 'Anthropic API key ', aiBadge),
				h('div', { class: 'field' }, h('label', { for: 'conn-ai' }, 'API key (optional)'), aiInput, h('div', { class: 'help' }, 'Lets Claude answer free-text WhatsApp questions, billed to your own Anthropic account. Also switch on “Answer WhatsApp questions with Claude” above.')),
				h('div', { class: 'button-row' }, aiSave, aiClear),
			),
		),
	);
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

/**
 * Run/message log card. Defaults to this household's logs; the owner console passes
 * `url(type)` (global logs), a `filter` control that reloads on change and `householdLabel(id)`
 * to add a Household column.
 */
export function logsCard({ url = (type) => `/api/admin/logs?type=${type}&limit=100`, filter = null, householdLabel = null } = {}) {
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
			const data = await api(url(type));
			if (mine === token) panel.replaceChildren(type === 'run' ? runTable(data.rows, householdLabel) : messageTable(data.rows, householdLabel));
		} catch (error) {
			if (mine === token) panel.replaceChildren(errorBox(error, load));
		}
	}

	filter?.addEventListener('change', load);
	load();
	return h('section', { class: 'card', id: 'section-logs' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Logs'), h('div', { class: 'button-row' }, filter, refresh)), tablist, panel);
}

function logTable(head, rows) {
	return h('div', { class: 'table-scroll logs-scroll' }, h('table', { class: 'table table-compact logs-table' }, h('thead', {}, h('tr', {}, head.map((label) => h('th', { scope: 'col' }, label)))), h('tbody', {}, rows)));
}

/** Optional Household column (owner console). */
const householdCell = (label, row) => label && h('td', { class: 'nowrap small' }, label(row.householdId));

function runTable(rows, label) {
	if (rows.length === 0) return emptyState(h('p', {}, 'No log entries yet.'));
	return logTable(
		['Time', label && 'Household', 'Level', 'Action', 'Message'].filter(Boolean),
		rows.map((row) =>
			h(
				'tr',
				{},
				h('td', { class: 'nowrap', title: row.ts }, formatInstant(row.ts)),
				householdCell(label, row),
				h('td', {}, badge(row.level, LEVEL_KIND[row.level] ?? 'neutral')),
				h('td', { class: 'mono small' }, row.action),
				h('td', { class: 'log-message' }, row.message),
			),
		),
	);
}

function messageTable(rows, label) {
	if (rows.length === 0) return emptyState(h('p', {}, 'No WhatsApp messages yet.'));
	return logTable(
		['Time', label && 'Household', 'Dir.', 'Number', 'Status', 'Message'].filter(Boolean),
		rows.map((row) =>
			h(
				'tr',
				{},
				h('td', { class: 'nowrap', title: row.createdAt }, formatInstant(row.createdAt)),
				householdCell(label, row),
				h('td', {}, row.direction === 'in' ? badge('in', 'info') : badge('out', 'neutral')),
				h('td', { class: 'mono small nowrap' }, row.fromNumber ?? ''),
				h('td', {}, badge(row.status, STATUS_KIND[row.status] ?? 'neutral')),
				h('td', { class: 'log-message' }, row.body ?? '', (row.errorCode || row.errorMessage) && h('div', { class: 'small error-text' }, [row.errorCode, row.errorMessage].filter(Boolean).join(': '))),
			),
		),
	);
}
