// First-run setup wizard (#/setup/<step>): checks → basics → data → WhatsApp → done.
import { importCsv, outcome, runFxBackfill, runSync, sendBrief } from './actions.js';
import { browserTimeZone, renderField, saveFields } from './fields.js';
import { api, badge, callout, card, errorBox, h, keyValues, spinner, toast, withBusy } from './lib.js';

const STEPS = [
	{ id: 'checks', title: 'Checks', render: checksStep },
	{ id: 'basics', title: 'Basics', render: basicsStep },
	{ id: 'data', title: 'Data', render: dataStep },
	{ id: 'whatsapp', title: 'WhatsApp', render: whatsappStep },
];

export async function render(root, ctx) {
	const index = Math.min(STEPS.length, Math.max(1, Number(ctx.sub[0]) || 1)) - 1;
	const step = STEPS[index];
	const go = (i) => ctx.navigate(`#/setup/${i + 1}`);

	const stepper = h(
		'ol',
		{ class: 'stepper' },
		STEPS.map((s, i) =>
			h(
				'li',
				{ class: i < index ? 'done' : i === index ? 'current' : '' },
				h('a', { href: `#/setup/${i + 1}`, 'aria-current': i === index ? 'step' : null }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, i < index ? '✓' : String(i + 1)), h('span', { class: 'step-title' }, s.title)),
			),
		),
	);
	const content = h('div', { class: 'wizard-body' }, spinner());
	root.append(
		h(
			'div',
			{ class: 'wizard' },
			h('div', { class: 'wizard-head' }, h('h1', {}, 'Set up your budget companion'), h('p', { class: 'muted' }, 'A few minutes, once. You can change everything later in Settings.')),
			h('nav', { 'aria-label': 'Setup steps' }, stepper),
			content,
		),
	);

	let settings;
	let status;
	try {
		[{ settings }, status] = await Promise.all([api('/api/settings'), api('/api/status')]);
	} catch (error) {
		content.replaceChildren(errorBox(error, () => ctx.navigate(location.hash)));
		return;
	}

	const footer = (...buttons) => h('div', { class: 'wizard-footer' }, index > 0 ? h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => go(index - 1) }, '← Back') : h('span'), h('div', { class: 'button-row' }, buttons));
	content.replaceChildren(...step.render({ settings, status, ctx, go: () => go(index + 1), footer }));
}

// ---------------------------------------------------------------------------------------------
// 1. Checks
// ---------------------------------------------------------------------------------------------

function checksStep({ status, go, footer }) {
	const row = (ok, label, required, detail) =>
		h(
			'li',
			{ class: 'check' },
			h('span', { class: `check-icon ${ok ? 'ok' : required ? 'bad' : 'off'}`, 'aria-hidden': 'true' }, ok ? '✓' : required ? '!' : '–'),
			h('div', {}, h('div', { class: 'check-label' }, label, ' ', ok ? badge('configured', 'ok') : required ? badge('required', 'bad') : badge('optional', 'neutral')), detail && h('div', { class: 'small muted' }, detail)),
		);
	const secret = (...names) => h('span', {}, 'Set ', names.map((name, i) => [i > 0 && ' and ', h('code', {}, name)]), ' with ', h('code', {}, 'wrangler secret put'), '.');

	const walletResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const test = h('button', { type: 'button', class: 'btn btn-primary', disabled: !status.walletConfigured }, 'Test Wallet connection');
	test.addEventListener('click', async () => {
		walletResult.replaceChildren();
		try {
			const result = await withBusy(test, () => api('/api/admin/test-wallet', { method: 'POST' }));
			walletResult.replaceChildren(walletOutcome(result));
		} catch (error) {
			walletResult.replaceChildren(callout('error', error.message));
		}
	});

	return [
		card(
			'Configuration',
			h('p', { class: 'muted' }, 'Secrets are stored in Cloudflare, never in the dashboard. Only the Wallet token is needed to get started.'),
			h(
				'ul',
				{ class: 'checks' },
				row(status.walletConfigured, 'BudgetBakers Wallet API token', true, status.walletConfigured ? 'Used for the hourly sync.' : secret('WALLET_API_TOKEN')),
				row(status.dashboardSecured, 'Dashboard password', true, 'You’re signed in, so this works.'),
				row(status.whatsappConfigured, 'WhatsApp sending', false, status.whatsappConfigured ? 'The daily brief can be delivered.' : secret('WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID')),
				row(status.webhookConfigured, 'WhatsApp replies (webhook)', false, status.webhookConfigured ? 'Replies like “Budget” are answered.' : secret('META_APP_SECRET', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN')),
				row(status.aiConfigured, 'Claude assistant', false, status.aiConfigured ? 'Free-text questions on WhatsApp can be answered.' : secret('ANTHROPIC_API_KEY')),
			),
		),
		card(
			'Wallet connection',
			h('p', { class: 'muted' }, 'Checks the token against the BudgetBakers API (doesn’t count towards your usage).'),
			h('div', { class: 'button-row' }, test),
			walletResult,
			status.counts.transactions > 0 && keyValues([['Transactions stored', status.counts.transactions.toLocaleString()], ['Categories', String(status.counts.categories)], ['Accounts', String(status.counts.accounts)]]),
		),
		footer(h('button', { type: 'button', class: 'btn btn-primary', onclick: go }, 'Continue →')),
	];
}

function walletOutcome(result) {
	if (result.ok) return callout('ok', h('strong', {}, 'Connected. '), 'Your Wallet token works.');
	if (result.code === 'WALLET_SYNC_IN_PROGRESS') {
		return callout('warn', h('strong', {}, 'Almost there. '), 'BudgetBakers is still preparing your data after the token was created. This usually takes a few minutes — try again shortly.');
	}
	if (result.code === 'WALLET_AUTH') {
		return callout('error', h('strong', {}, 'The token was rejected. '), 'Create a new one in the Wallet web app (Settings → API, Premium plan) and set it again with ', h('code', {}, 'wrangler secret put WALLET_API_TOKEN'), '.', h('div', { class: 'small muted' }, result.message));
	}
	if (result.code === 'WALLET_RATE_LIMIT') return callout('warn', h('strong', {}, 'Rate limited. '), 'The Wallet API allows 300 requests per hour. Wait a bit and try again.');
	return callout('error', h('strong', {}, 'Connection failed. '), result.message ?? 'Unknown error.');
}

// ---------------------------------------------------------------------------------------------
// 2. Basics
// ---------------------------------------------------------------------------------------------

function basicsStep({ settings, ctx, go, footer }) {
	// Suggest the browser's time zone until one was chosen.
	const suggested = settings.timezone === 'UTC' && !ctx.setupComplete ? browserTimeZone() : settings.timezone;
	const fields = ['timezone', 'base_currency', 'budget_month_start_day', 'brief_title'].map((key) => renderField(key, key === 'timezone' ? suggested : settings[key]));
	const next = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save & continue →');
	const form = h(
		'form',
		{
			novalidate: true,
			onsubmit: async (event) => {
				event.preventDefault();
				const saved = await withBusy(next, () => saveFields(fields, settings)).catch(() => null);
				if (!saved) return;
				ctx.invalidatePeriod();
				go();
			},
		},
		card(
			'Basics',
			h('p', { class: 'muted' }, 'These decide what “today” and “this month” mean for your budget.'),
			h('div', { class: 'form-grid' }, fields.map((field) => field.el)),
		),
		footer(next),
	);
	return [form];
}

// ---------------------------------------------------------------------------------------------
// 3. Data
// ---------------------------------------------------------------------------------------------

function dataStep({ settings, status, go, footer }) {
	const historyField = renderField('sync_backfill_from', settings.sync_backfill_from);

	const syncResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const syncButton = h('button', { type: 'button', class: 'btn btn-primary' }, 'Run full sync');
	syncButton.addEventListener('click', async () => {
		syncResult.replaceChildren();
		try {
			const res = await withBusy(syncButton, async () => {
				if (!(await saveFields([historyField], settings))) throw new Error('Fix the start date first.');
				return runSync({ full: true });
			});
			syncResult.replaceChildren(outcome(res));
			if (!res.result.pending) fxFrom.value = settings.sync_backfill_from;
		} catch (error) {
			syncResult.replaceChildren(outcome({ kind: 'error', summary: error.message }));
		}
	});

	const fxFrom = h('input', { type: 'date', id: 'setup-fx-from', value: settings.sync_backfill_from });
	const fxResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const fxButton = h('button', { type: 'button', class: 'btn' }, 'Run FX backfill');
	fxButton.addEventListener('click', async () => {
		fxResult.replaceChildren();
		try {
			fxResult.replaceChildren(outcome(await withBusy(fxButton, () => runFxBackfill({ from: fxFrom.value }))));
		} catch (error) {
			fxResult.replaceChildren(outcome({ kind: 'error', summary: error.message }));
		}
	});

	const importResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const fileInput = (kind, label, hint) => {
		const id = `setup-import-${kind}`;
		const input = h('input', { type: 'file', id, accept: '.csv,text/csv' });
		input.addEventListener('change', async () => {
			const file = input.files?.[0];
			if (!file) return;
			importResult.replaceChildren(spinner(`Importing ${file.name}…`));
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

	return [
		card(
			'1 · Import from BudgetBakers',
			h('p', { class: 'muted' }, 'Pulls categories, accounts and every record since the start date. Large histories can take a minute.'),
			!status.walletConfigured && callout('warn', 'The Wallet token isn’t configured yet — go back to Checks.'),
			historyField.el,
			h('div', { class: 'button-row' }, syncButton),
			syncResult,
		),
		card(
			'2 · Exchange rates',
			h('p', { class: 'muted' }, 'Sync converts foreign-currency records automatically. Run this if some transactions still lack a rate (e.g. the rate service was briefly unavailable).'),
			status.counts.missingFx > 0 && callout('warn', `${status.counts.missingFx} transaction(s) currently have no exchange rate.`),
			h('div', { class: 'field' }, h('label', { for: 'setup-fx-from' }, 'Fetch rates from'), fxFrom),
			h('div', { class: 'button-row' }, fxButton),
			fxResult,
		),
		card(
			'3 · Bring your history (optional)',
			h('p', { class: 'muted' }, 'Coming from a spreadsheet? Import budget targets and past closing balances. You can also set targets directly in the Budget table.'),
			fileInput('budgets', 'Budget targets CSV', 'Columns: entity_type,name_or_path,budget,forecast_type,include_in_report,include_in_expense — or the legacy Google Sheet Budgets export.'),
			fileInput('cashflow', 'Cash-flow history CSV', 'Columns: period_start,period_end,account_name,currency,closing_balance (optional notes).'),
			importResult,
		),
		footer(h('button', { type: 'button', class: 'btn btn-primary', onclick: go }, 'Continue →')),
	];
}

// ---------------------------------------------------------------------------------------------
// 4. WhatsApp (optional) + finish
// ---------------------------------------------------------------------------------------------

function whatsappStep({ settings, status, ctx, footer }) {
	const keys = ['whatsapp_enabled', 'whatsapp_to_numbers', 'wa_template_name', 'wa_template_lang', 'brief_hour_local', 'dry_run'];
	const fields = keys.map((key) => renderField(key, settings[key]));
	const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));

	const testResult = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const testButton = h('button', { type: 'button', class: 'btn' }, 'Send test brief');
	testButton.addEventListener('click', async () => {
		testResult.replaceChildren();
		try {
			const res = await withBusy(testButton, async () => {
				if (!(await saveFields(fields, settings))) throw new Error('Fix the highlighted fields first.');
				return sendBrief();
			});
			testResult.replaceChildren(outcome(res));
		} catch (error) {
			testResult.replaceChildren(outcome({ kind: 'error', summary: error.message }));
		}
	});

	const finish = async (button, save) => {
		await withBusy(button, async () => {
			if (save && !(await saveFields(fields, settings))) throw new Error('Fix the highlighted fields first.');
			await api('/api/settings', { method: 'PUT', body: { setup_complete: '1' } });
		}).then(
			() => {
				ctx.markSetupComplete();
				toast('Setup complete — welcome to your budget!', 'ok');
				ctx.navigate('#/budget');
			},
			() => {},
		);
	};
	const skip = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => finish(skip, false) }, 'Skip WhatsApp & finish');
	const done = h('button', { type: 'button', class: 'btn btn-primary', onclick: () => finish(done, true) }, 'Save & finish');

	return [
		card(
			'Daily WhatsApp brief',
			h('p', { class: 'muted' }, 'Optional. Every morning each recipient gets yesterday’s spending and where the budget stands.'),
			!status.whatsappConfigured &&
				callout('info', 'WhatsApp secrets aren’t set, so sending will fail until you add ', h('code', {}, 'WHATSAPP_ACCESS_TOKEN'), ' and ', h('code', {}, 'WHATSAPP_PHONE_NUMBER_ID'), '. See docs/whatsapp-setup.md. You can skip this step and come back later.'),
			byKey.whatsapp_enabled.el,
			h('div', { class: 'form-grid' }, byKey.whatsapp_to_numbers.el, byKey.brief_hour_local.el, byKey.wa_template_name.el, byKey.wa_template_lang.el),
			byKey.dry_run.el,
			h('p', { class: 'small muted' }, 'Keep dry run on for the first days: briefs are only logged (see Settings → Logs) until you turn it off.'),
			h('div', { class: 'button-row' }, testButton),
			testResult,
		),
		footer(skip, done),
	];
}
