// Settings form schema + field rendering, shared by the Settings view and the setup wizard.
import { api, h, toast } from './lib.js';

const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'ZAR', 'AUD', 'CAD', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'JPY', 'INR', 'BRL', 'MXN'];

/** Every SETTING_DEFAULTS key the dashboard edits, grouped for the Settings page. */
export const FIELDS = {
	timezone: {
		group: 'General',
		label: 'Time zone',
		type: 'timezone',
		help: 'IANA name, e.g. Europe/Dublin. Decides "today", "yesterday" and when the brief goes out.',
	},
	base_currency: {
		group: 'General',
		label: 'Base currency',
		type: 'currency',
		help: 'All amounts are converted to this currency. Changing it later needs an FX backfill.',
	},
	budget_month_start_day: {
		group: 'General',
		label: 'Budget month starts on day',
		type: 'number',
		min: 1,
		max: 31,
		help: 'e.g. 25 → each budget month runs from the 25th to the 24th (payday budgeting). 1 = calendar months.',
	},
	brief_title: { group: 'General', label: 'Brief title', type: 'text', maxlength: 60, help: 'First line of the daily WhatsApp brief.' },

	whatsapp_enabled: { group: 'WhatsApp', label: 'Send the daily brief on WhatsApp', type: 'flag' },
	whatsapp_to_numbers: {
		group: 'WhatsApp',
		label: 'Recipients',
		type: 'text',
		placeholder: '+353871234567, +27821234567',
		help: 'International format, comma-separated. Only these numbers receive the brief and may message the bot.',
	},
	brief_hour_local: { group: 'WhatsApp', label: 'Brief hour (local time)', type: 'hour', help: 'The brief is sent once a day at this hour.' },
	wa_template_name: {
		group: 'WhatsApp',
		label: 'Template name',
		type: 'text',
		placeholder: 'daily_budget_update',
		help: 'Approved WhatsApp template used outside the 24-hour service window.',
	},
	wa_template_lang: { group: 'WhatsApp', label: 'Template language', type: 'text', placeholder: 'en', help: 'e.g. en or en_US — must match the approved template.' },
	dry_run: { group: 'WhatsApp', label: 'Dry run (log messages instead of sending)', type: 'flag' },
	stale_seconds: {
		group: 'WhatsApp',
		label: 'Ignore incoming messages older than (seconds)',
		type: 'number',
		min: 60,
		max: 86400,
		help: 'Protects against old webhook retries being answered late.',
	},

	ai_enabled: { group: 'AI assistant', label: 'Answer WhatsApp questions with Claude', type: 'flag' },
	ai_model: { group: 'AI assistant', label: 'Claude model', type: 'text', help: 'Anthropic model id.' },

	sync_backfill_from: {
		group: 'Sync & capture',
		label: 'History starts on',
		type: 'date',
		help: 'A full sync imports BudgetBakers records from this date.',
	},
	capture_hour_local: {
		group: 'Sync & capture',
		label: 'Closing-balance capture hour',
		type: 'hour',
		help: 'On the last day of each budget period, account balances are captured at this hour.',
	},
};

export const GROUPS = ['General', 'WhatsApp', 'AI assistant', 'Sync & capture'];

let timezoneList;
function timezones() {
	if (!timezoneList) {
		try {
			timezoneList = Intl.supportedValuesOf('timeZone');
		} catch {
			timezoneList = ['UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Africa/Johannesburg', 'Asia/Singapore', 'Australia/Sydney'];
		}
	}
	return timezoneList;
}

export function browserTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

function datalist(id, values) {
	if (document.getElementById(id)) return null;
	return h('datalist', { id }, values.map((value) => h('option', { value })));
}

/**
 * Renders one labelled field. Returns { el, input, get(), set(v), error(msg) }.
 * `get()` returns the string value the API expects.
 */
export function renderField(key, value) {
	const spec = FIELDS[key];
	const id = `f-${key}`;
	let input;
	let extra = null;
	switch (spec.type) {
		case 'flag':
			input = h('input', { id, type: 'checkbox', class: 'switch', checked: value === '1' });
			break;
		case 'number':
			input = h('input', { id, type: 'number', inputmode: 'numeric', min: String(spec.min), max: String(spec.max), step: '1', value });
			break;
		case 'hour':
			input = h(
				'select',
				{ id },
				Array.from({ length: 24 }, (_, hour) => h('option', { value: String(hour), selected: String(hour) === value }, `${String(hour).padStart(2, '0')}:00`)),
			);
			break;
		case 'date':
			input = h('input', { id, type: 'date', value });
			break;
		case 'timezone':
			input = h('input', { id, type: 'text', list: 'dl-timezones', autocomplete: 'off', spellcheck: 'false', value });
			extra = datalist('dl-timezones', timezones());
			break;
		case 'currency': {
			let currencies = COMMON_CURRENCIES;
			try {
				currencies = [...new Set([...COMMON_CURRENCIES, ...Intl.supportedValuesOf('currency')])];
			} catch {
				// Older browsers: the common list is enough.
			}
			input = h('input', { id, type: 'text', list: 'dl-currencies', maxlength: '3', autocomplete: 'off', spellcheck: 'false', class: 'upper', value });
			extra = datalist('dl-currencies', currencies);
			break;
		}
		default:
			input = h('input', { id, type: 'text', value, placeholder: spec.placeholder, maxlength: spec.maxlength ? String(spec.maxlength) : undefined });
	}
	const errorEl = h('div', { class: 'field-error', id: `${id}-error` });
	input.setAttribute('aria-describedby', `${id}-error`);
	const el =
		spec.type === 'flag'
			? h('div', { class: 'field field-flag' }, h('label', { for: id }, input, h('span', {}, spec.label)), spec.help && h('div', { class: 'help' }, spec.help), errorEl, extra)
			: h('div', { class: 'field' }, h('label', { for: id }, spec.label), input, spec.help && h('div', { class: 'help' }, spec.help), errorEl, extra);
	return {
		key,
		el,
		input,
		get: () => (spec.type === 'flag' ? (input.checked ? '1' : '0') : input.value.trim()),
		set: (v) => (spec.type === 'flag' ? (input.checked = v === '1') : (input.value = v)),
		error: (message) => {
			errorEl.textContent = message || '';
			el.classList.toggle('has-error', !!message);
		},
	};
}

/**
 * Saves the fields whose value differs from `current`. Shows per-field errors from the API.
 * Returns the updated settings, or null when saving failed.
 */
export async function saveFields(fields, current) {
	const patch = {};
	for (const field of fields) {
		field.error('');
		if (field.get() !== current[field.key]) patch[field.key] = field.get();
	}
	if (Object.keys(patch).length === 0) return current;
	try {
		const result = await api('/api/settings', { method: 'PUT', body: patch });
		if (result.warning) toast(result.warning, 'warn');
		Object.assign(current, result.settings);
		for (const field of fields) field.set(current[field.key]);
		return current;
	} catch (error) {
		const fieldErrors = error.body?.fields ?? {};
		for (const field of fields) if (fieldErrors[field.key]) field.error(fieldErrors[field.key]);
		toast(Object.keys(fieldErrors).length ? 'Please fix the highlighted fields.' : error.message, 'error');
		return null;
	}
}
