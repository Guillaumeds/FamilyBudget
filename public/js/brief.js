// Brief view: the exact WhatsApp text, the template parameters, dry-run toggle and "send now".
import { outcome, sendBrief } from './actions.js';
import { api, callout, card, errorBox, h, pageHeader, spinner, toast, withBusy } from './lib.js';

/** WhatsApp-style formatting: *bold*, _italic_, ~strike~ (single line spans), everything else as text. */
export function whatsappText(text) {
	const out = [];
	// Like WhatsApp, markers only count at word boundaries (so "snake_case" stays as-is).
	const pattern = /(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|(?<![\w~])~([^~\n]+)~(?![\w~])/g;
	let last = 0;
	for (const match of text.matchAll(pattern)) {
		if (match.index > last) out.push(text.slice(last, match.index));
		if (match[1] !== undefined) out.push(h('strong', {}, match[1]));
		else if (match[2] !== undefined) out.push(h('em', {}, match[2]));
		else out.push(h('s', {}, match[3]));
		last = match.index + match[0].length;
	}
	out.push(text.slice(last));
	return out;
}

export async function render(root, ctx) {
	const body = h('div', {}, spinner());
	const refresh = h('button', { type: 'button', class: 'btn', onclick: () => withBusy(refresh, load).catch(() => {}) }, 'Refresh');
	root.append(pageHeader('Daily brief', 'Exactly what goes out on WhatsApp — rebuilt from live data.', refresh), body);

	async function load() {
		try {
			const [preview, { settings }] = await Promise.all([api('/api/brief/preview'), api('/api/settings')]);
			body.replaceChildren(...renderPage(preview, settings, ctx));
		} catch (error) {
			body.replaceChildren(errorBox(error, load));
		}
	}
	await load();
}

function renderPage(preview, settings) {
	const now = new Date();
	const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

	const bubble = h(
		'div',
		{ class: 'wa-chat' },
		h('div', { class: 'wa-bubble' }, h('div', { class: 'wa-text' }, whatsappText(preview.text)), h('div', { class: 'wa-time' }, time)),
	);

	const params = h(
		'table',
		{ class: 'table table-compact params-table' },
		h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Parameter'), h('th', { scope: 'col' }, 'Value'))),
		h('tbody', {}, Object.entries(preview.params).map(([key, value]) => h('tr', {}, h('th', { scope: 'row', class: 'mono' }, `{{${key}}}`), h('td', {}, value)))),
	);

	// Dry-run switch writes the setting immediately.
	const dryRun = h('input', { type: 'checkbox', id: 'brief-dry-run', class: 'switch', checked: settings.dry_run === '1' });
	const dryNote = callout('warn', h('strong', {}, 'Dry run is on. '), '“Send brief now” builds and logs the brief but delivers nothing.');
	dryNote.hidden = !dryRun.checked;
	dryRun.addEventListener('change', async () => {
		const value = dryRun.checked ? '1' : '0';
		dryRun.disabled = true;
		try {
			await api('/api/settings', { method: 'PUT', body: { dry_run: value } });
			dryNote.hidden = value !== '1';
			toast(value === '1' ? 'Dry run on — messages are only logged.' : 'Dry run off — messages will really be sent.', value === '1' ? 'info' : 'warn');
		} catch (error) {
			dryRun.checked = !dryRun.checked;
			toast(error.message, 'error');
		} finally {
			dryRun.disabled = false;
		}
	});

	const result = h('div', { class: 'action-result', 'aria-live': 'polite' });
	const send = h('button', { type: 'button', class: 'btn btn-primary' }, 'Send brief now');
	send.addEventListener('click', async () => {
		if (!dryRun.checked && !confirm('Send the brief to every configured recipient now?')) return;
		result.replaceChildren();
		try {
			const res = await withBusy(send, sendBrief);
			result.replaceChildren(outcome(res));
		} catch {
			// withBusy already toasted the error.
		}
	});

	const recipients = settings.whatsapp_to_numbers.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
	const warnings = [];
	if (settings.whatsapp_enabled !== '1') warnings.push(callout('info', 'WhatsApp sending is switched off, so nothing is sent on schedule. ', h('a', { href: '#/settings' }, 'Turn it on in Settings →')));
	else if (recipients.length === 0) warnings.push(callout('warn', 'No recipients configured yet. ', h('a', { href: '#/settings' }, 'Add numbers in Settings →')));

	return [
		...warnings,
		h(
			'div',
			{ class: 'brief-grid' },
			card(
				null,
				h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Message'), h('span', { class: 'small muted' }, `${preview.data.dateLabel} · sent daily at ${String(settings.brief_hour_local).padStart(2, '0')}:00`)),
				bubble,
				h('p', { class: 'small muted' }, 'Inside the 24-hour window (someone messaged the bot recently) this text is sent as-is. Otherwise the approved template is used with the parameters on the right.'),
			),
			h(
				'div',
				{ class: 'stack' },
				card(
					'Send',
					h('div', { class: 'field field-flag' }, h('label', { for: 'brief-dry-run' }, dryRun, h('span', {}, 'Dry run (log instead of sending)'))),
					dryNote,
					h('div', { class: 'button-row' }, send, h('span', { class: 'small muted' }, recipients.length ? `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}` : 'no recipients')),
					result,
				),
				card(
					'Template parameters',
					h('p', { class: 'small muted' }, `Template: `, h('span', { class: 'mono' }, settings.wa_template_name || '(not configured)'), ` · ${settings.wa_template_lang}`),
					h('div', { class: 'table-scroll' }, params),
				),
			),
		),
	];
}
