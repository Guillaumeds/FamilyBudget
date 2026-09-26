// Owner console (#/owner): the site owner's only page. Households (WhatsApp approval, suspend /
// activate, password reset, adopting the transitional env secrets into household 1), the global
// settings shared by every household, and the logs of all households. The owner has no budget
// data of its own, so this view never calls the household data routes.
import { renderField, saveFields } from './fields.js';
import { api, badge, callout, emptyState, errorBox, formatDate, formatInstant, h, pageHeader, spinner, timeAgo, toast, withBusy } from './lib.js';
import { logsCard } from './settings.js';

const MIN_PASSWORD = 8;

export async function render(root, ctx) {
	const body = h('div', {}, spinner());
	const refresh = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => ctx.navigate('#/owner') }, 'Refresh');
	root.append(pageHeader('Owner console', 'Households, settings shared by everyone, and all logs.', refresh), body);

	let households;
	let globals;
	try {
		[{ households }, { settings: globals }] = await Promise.all([api('/api/owner/households'), api('/api/owner/settings')]);
	} catch (error) {
		body.replaceChildren(errorBox(error, () => ctx.navigate('#/owner')));
		return;
	}

	const byId = new Map(households.map((household) => [household.id, household]));
	const householdLabel = (id) => (id === null || id === undefined ? 'system' : (byId.get(id)?.name ?? `#${id}`));

	const filter = h(
		'select',
		{ class: 'select-sm', 'aria-label': 'Filter logs by household' },
		h('option', { value: '' }, 'All households'),
		households.map((household) => h('option', { value: String(household.id) }, household.name)),
	);

	body.replaceChildren(
		householdsCard(households),
		globalSettingsCard(globals),
		logsCard({
			url: (type) => `/api/owner/logs?type=${type}&limit=200${filter.value ? `&household=${encodeURIComponent(filter.value)}` : ''}`,
			filter,
			householdLabel,
		}),
	);
}

// ---------------------------------------------------------------------------------------------
// Households
// ---------------------------------------------------------------------------------------------

const n = (value) => Number(value ?? 0).toLocaleString();

function householdsCard(households) {
	const tbody = h('tbody', {});
	const rows = new Map();

	/** (Re)renders one household row; actions replace it with the fresh row from the API. */
	const renderRow = (household) => {
		const row = householdRow(household, (updated) => {
			const next = renderRow(updated);
			rows.get(updated.id)?.replaceWith(next);
			rows.set(updated.id, next);
		});
		return row;
	};
	for (const household of households) {
		const row = renderRow(household);
		rows.set(household.id, row);
		tbody.append(row);
	}

	const active = households.filter((household) => household.status === 'active').length;
	const pending = households.filter((household) => !household.waApproved && household.status === 'active').length;

	return h(
		'section',
		{ class: 'card', id: 'section-households' },
		h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Households'), h('span', { class: 'small muted' }, `${households.length} total · ${active} active${pending ? ` · ${pending} awaiting WhatsApp approval` : ''}`)),
		households.length === 0
			? emptyState(h('p', {}, 'No households yet.'), h('p', { class: 'small muted' }, 'People can create one from the sign-in page (“Create a household”) while signups are open.'))
			: h(
					'div',
					{ class: 'table-scroll' },
					h(
						'table',
						{ class: 'table table-compact owner-table' },
						h(
							'thead',
							{},
							h(
								'tr',
								{},
								['Household', 'Status', 'WhatsApp', 'Data', 'Last sync', 'Keys', 'Created', 'Actions'].map((label) => h('th', { scope: 'col' }, label)),
							),
						),
						tbody,
					),
				),
	);
}

function householdRow(household, replace) {
	const post = (action, body) => api(`/api/owner/households/${household.id}/${action}`, { method: 'POST', body });
	const suspended = household.status === 'suspended';

	// WhatsApp approval switch.
	const approve = h('input', { type: 'checkbox', class: 'switch', checked: !!household.waApproved, 'aria-label': `WhatsApp approved for ${household.name}` });
	approve.addEventListener('change', async () => {
		const wanted = approve.checked;
		approve.disabled = true;
		try {
			const result = await post('approve', { whatsapp: wanted });
			toast(`WhatsApp ${wanted ? 'approved' : 'revoked'} for ${household.name}.`, 'ok');
			replace(result.household ?? { ...household, waApproved: wanted });
		} catch (error) {
			approve.checked = !wanted;
			approve.disabled = false;
			toast(error.message, 'error');
		}
	});

	const statusButton = h('button', { type: 'button', class: `btn btn-sm${suspended ? '' : ' btn-ghost'}` }, suspended ? 'Activate' : 'Suspend');
	statusButton.addEventListener('click', async () => {
		const question = suspended
			? `Activate “${household.name}”? Its members can sign in again and syncs and briefs resume.`
			: `Suspend “${household.name}”? Its members are locked out and syncs and briefs stop. Data is kept.`;
		if (!confirm(question)) return;
		const result = await withBusy(statusButton, () => post(suspended ? 'activate' : 'suspend')).catch(() => null);
		if (!result) return;
		toast(`${household.name} ${suspended ? 'activated' : 'suspended'}.`, 'ok');
		replace(result.household ?? { ...household, status: suspended ? 'active' : 'suspended' });
	});

	const resetButton = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => resetPasswordDialog(household) }, 'Reset password');

	let adoptButton = null;
	if (household.id === 1) {
		adoptButton = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', title: 'Encrypt WALLET_API_TOKEN / ANTHROPIC_API_KEY into this household' }, 'Adopt env secrets');
		adoptButton.addEventListener('click', async () => {
			if (!confirm(`Store the WALLET_API_TOKEN / ANTHROPIC_API_KEY Worker secrets (encrypted) in “${household.name}”? Afterwards you can delete them with wrangler secret delete.`)) return;
			const result = await withBusy(adoptButton, () => post('adopt-env-token')).catch(() => null);
			if (!result) return;
			const adopted = [result.adopted?.walletToken && 'Wallet token', result.adopted?.anthropicKey && 'Anthropic key'].filter(Boolean);
			toast(adopted.length ? `Adopted: ${adopted.join(', ')}.` : 'Nothing adopted.', 'ok');
			replace(result.household ?? household);
		});
	}

	const sync = household.lastSync;
	const syncKind = sync ? (sync.level === 'ERROR' ? 'bad' : sync.level === 'WARN' ? 'warn' : null) : null;
	const counts = household.counts ?? {};
	const created = household.createdAt ?? '';

	return h(
		'tr',
		{ class: suspended ? 'is-suspended' : null },
		h('th', { scope: 'row' }, h('div', { class: 'owner-name' }, household.name), h('div', { class: 'small muted' }, `#${household.id}`)),
		h('td', {}, suspended ? badge('suspended', 'bad') : badge('active', 'ok')),
		h('td', {}, h('label', { class: 'inline-flag' }, approve, h('span', { class: 'small' }, household.waApproved ? 'approved' : 'pending'))),
		h('td', { class: 'nowrap small' }, `${n(counts.transactions)} tx`, h('div', { class: 'muted' }, `${n(counts.categories)} categories · ${n(counts.accounts)} accounts`)),
		h(
			'td',
			{ class: 'small', title: sync ? `${sync.ts} — ${sync.message}` : '' },
			sync ? [h('span', { class: 'nowrap' }, timeAgo(sync.ts)), syncKind && [' ', badge(sync.level.toLowerCase(), syncKind)], syncKind && h('div', { class: 'muted owner-sync-msg' }, sync.message)] : h('span', { class: 'muted' }, 'never'),
		),
		h('td', { class: 'nowrap' }, keyDot(household.walletConfigured, 'Wallet'), ' ', keyDot(household.aiConfigured, 'AI')),
		h('td', { class: 'nowrap small', title: created }, /^\d{4}-\d{2}-\d{2}/.test(created) ? formatDate(created.slice(0, 10), { year: true, weekday: false }) : formatInstant(created)),
		h('td', {}, h('div', { class: 'button-row owner-actions' }, statusButton, resetButton, adoptButton)),
	);
}

function keyDot(on, label) {
	return h('span', { class: `key-dot${on ? ' is-on' : ''}`, title: `${label} ${on ? 'configured' : 'not configured'}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { class: 'small' }, label), h('span', { class: 'visually-hidden' }, on ? ' configured' : ' not configured'));
}

/** Modal for POST …/reset-password {password} (min 8 characters; signs the household out everywhere). */
function resetPasswordDialog(household) {
	const password = h('input', { id: 'reset-password', type: 'password', autocomplete: 'new-password', minlength: String(MIN_PASSWORD), required: true, 'aria-describedby': 'reset-error' });
	const repeat = h('input', { id: 'reset-confirm', type: 'password', autocomplete: 'new-password', required: true, 'aria-describedby': 'reset-error' });
	const error = h('div', { class: 'field-error', id: 'reset-error', role: 'alert' });
	const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Reset password');
	const cancel = h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => dialog.close() }, 'Cancel');
	const dialog = h(
		'dialog',
		{ class: 'dialog', 'aria-labelledby': 'reset-title' },
		h(
			'form',
			{
				novalidate: true,
				onsubmit: async (event) => {
					event.preventDefault();
					error.textContent = '';
					if (password.value.length < MIN_PASSWORD) {
						error.textContent = `The password needs at least ${MIN_PASSWORD} characters.`;
						return password.focus();
					}
					if (password.value !== repeat.value) {
						error.textContent = 'The passwords don’t match.';
						return repeat.focus();
					}
					const ok = await withBusy(submit, () => api(`/api/owner/households/${household.id}/reset-password`, { method: 'POST', body: { password: password.value } }), { quiet: true }).then(
						() => true,
						(err) => {
							error.textContent = err.message;
							return false;
						},
					);
					if (!ok) return;
					dialog.close();
					toast(`Password reset for ${household.name}. Its members are signed out and need the new password.`, 'ok');
				},
			},
			h('h2', { class: 'card-title', id: 'reset-title' }, `Reset password — ${household.name}`),
			h('p', { class: 'small muted' }, 'Every device signed in to this household is signed out. Share the new password with them securely.'),
			h('div', { class: 'field' }, h('label', { for: 'reset-password' }, 'New password'), password, h('div', { class: 'help' }, `At least ${MIN_PASSWORD} characters.`)),
			h('div', { class: 'field' }, h('label', { for: 'reset-confirm' }, 'Confirm password'), repeat),
			error,
			h('div', { class: 'button-row dialog-actions' }, cancel, submit),
		),
	);
	dialog.addEventListener('close', () => dialog.remove());
	document.body.append(dialog);
	dialog.showModal();
	password.focus();
}

// ---------------------------------------------------------------------------------------------
// Global settings (GET/PUT /api/owner/settings)
// ---------------------------------------------------------------------------------------------

function globalSettingsCard(current) {
	const fields = ['wa_template_name', 'wa_template_lang', 'signup_enabled'].map((key) => renderField(key, current[key] ?? ''));
	const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
	const save = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save');
	return h(
		'form',
		{
			class: 'card settings-form',
			id: 'section-global',
			novalidate: true,
			onsubmit: async (event) => {
				event.preventDefault();
				const saved = await withBusy(save, () => saveFields(fields, current, { endpoint: '/api/owner/settings' })).catch(() => null);
				if (saved) toast('Global settings saved.', 'ok');
			},
		},
		h('h2', { class: 'card-title' }, 'Global settings'),
		h('p', { class: 'small muted' }, 'Shared by every household: the WhatsApp sender’s message template and whether new households may sign up.'),
		h('div', { class: 'form-grid' }, byKey.wa_template_name.el, byKey.wa_template_lang.el),
		byKey.signup_enabled.el,
		callout('info', 'Each new household needs your WhatsApp approval (the switch in the table above) before its daily brief is sent from your WhatsApp number.'),
		h('div', { class: 'button-row' }, save),
	);
}
