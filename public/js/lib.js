// Shared helpers: API client, DOM builder, formatting, toasts. No dependencies, no build step.

// ---------------------------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------------------------

export class ApiError extends Error {
	constructor(status, body) {
		super(body?.error || `Request failed (HTTP ${status})`);
		this.status = status;
		this.code = body?.code;
		this.body = body ?? {};
	}
}

const handlers = { unauthorized: () => {}, needsSecrets: () => {} };

/** Registers what happens when the session is gone (401) or the secrets are missing (503). */
export function onAuthProblem(unauthorized, needsSecrets) {
	handlers.unauthorized = unauthorized;
	handlers.needsSecrets = needsSecrets;
}

/**
 * fetch() wrapper: JSON in/out (or CSV in via `csv`), same-origin cookies. Resolves with the parsed
 * body for any 2xx (a 202 from /api/admin/sync carries `pending: true`), rejects with ApiError.
 */
export async function api(path, { method = 'GET', body, csv } = {}) {
	const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
	if (csv !== undefined) {
		init.headers['Content-Type'] = 'text/csv';
		init.body = csv;
	} else if (body !== undefined) {
		init.headers['Content-Type'] = 'application/json';
		init.body = JSON.stringify(body);
	}
	let response;
	try {
		response = await fetch(path, init);
	} catch {
		throw new ApiError(0, { error: 'Network error — check your connection and try again.', code: 'NETWORK' });
	}
	const data = await response.json().catch(() => ({}));
	if (!path.startsWith('/api/auth/')) {
		if (response.status === 401) handlers.unauthorized();
		if (response.status === 503 && data.code === 'NEEDS_SECRETS') handlers.needsSecrets();
	}
	if (!response.ok) throw new ApiError(response.status, data);
	return data;
}

// ---------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------

/**
 * Element builder: h('button', { class: 'btn', onclick }, 'Save'). Text children are inserted as
 * text nodes (never parsed as HTML). Boolean/number/object props (checked, disabled, value...) are set
 * as properties, strings as attributes; `style` takes an object of CSS properties.
 */
export function h(tag, props, ...children) {
	const el = document.createElement(tag);
	for (const [key, value] of Object.entries(props ?? {})) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') el.className = value;
		else if (key === 'dataset') Object.assign(el.dataset, value);
		else if (key === 'style') for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v);
		else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
		else if (key === 'value' || (typeof value !== 'string' && key in el)) el[key] = value;
		else el.setAttribute(key, value === true ? '' : value);
	}
	append(el, children);
	return el;
}

export function append(el, children) {
	for (const child of [children].flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : String(child));
	}
	return el;
}

/** Temporarily marks an element (saved / error flash). */
export function flash(el, kind) {
	el.classList.remove('flash-saved', 'flash-error');
	void el.offsetWidth; // restart the animation
	el.classList.add(`flash-${kind}`);
	setTimeout(() => el.classList.remove(`flash-${kind}`), 1600);
}

export function toast(message, kind = 'info') {
	let region = document.getElementById('toasts');
	if (!region) {
		region = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
		document.body.append(region);
	}
	const item = h('div', { class: `toast toast-${kind}` }, message);
	region.append(item);
	setTimeout(() => item.classList.add('toast-out'), kind === 'error' ? 6000 : 3200);
	setTimeout(() => item.remove(), kind === 'error' ? 6400 : 3600);
}

/** Runs `fn` while a button shows a busy state; reports errors as a toast unless `quiet`. */
export async function withBusy(button, fn, { quiet = false } = {}) {
	const label = button.textContent;
	button.disabled = true;
	button.classList.add('busy');
	try {
		return await fn();
	} catch (error) {
		if (!quiet) toast(error.message, 'error');
		throw error;
	} finally {
		button.disabled = false;
		button.classList.remove('busy');
		button.textContent = label;
	}
}

export function debounce(fn, ms) {
	let timer;
	return (...args) => {
		clearTimeout(timer);
		timer = setTimeout(() => fn(...args), ms);
	};
}

/** A small callout box. kind: info | warn | error | ok */
export function callout(kind, ...children) {
	return h('div', { class: `callout callout-${kind}` }, ...children);
}

export function spinner(label = 'Loading…') {
	return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), label);
}

/** Result list for admin actions: [{ label, value }] */
export function keyValues(pairs) {
	return h(
		'dl',
		{ class: 'kv' },
		pairs.filter(Boolean).map(([label, value]) => [h('dt', {}, label), h('dd', {}, value)]),
	);
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

const moneyFormats = new Map();

export function money(value, currency) {
	const code = (currency || 'EUR').toUpperCase();
	let format = moneyFormats.get(code);
	if (!format) {
		try {
			format = new Intl.NumberFormat(undefined, { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 });
		} catch {
			format = { format: (v) => `${code} ${Number(v).toFixed(2)}` };
		}
		moneyFormats.set(code, format);
	}
	const rounded = Math.round((Number(value) || 0) * 100) / 100;
	return format.format(rounded === 0 ? 0 : rounded);
}

export function signedMoney(value, currency) {
	const rounded = Math.round((Number(value) || 0) * 100) / 100;
	if (rounded === 0) return money(0, currency);
	return `${rounded > 0 ? '+' : '−'}${money(Math.abs(rounded), currency)}`;
}

export function percent(fraction) {
	return `${Math.round((Number(fraction) || 0) * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 'yyyy-mm-dd' → "Fri 26 Sep" (or with year). Pure string math, no time-zone surprises. */
export function formatDate(dateText, { year = false, weekday = true } = {}) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText ?? '')) return dateText ?? '';
	const [y, m, d] = dateText.split('-').map(Number);
	const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return `${weekday ? `${WEEKDAYS[day]} ` : ''}${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ''}`;
}

export function periodLabel(startText, endText) {
	return `${formatDate(startText, { weekday: false })} – ${formatDate(endText, { weekday: false, year: true })}`;
}

export function addDays(dateText, n) {
	const [y, m, d] = dateText.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function diffDays(from, to) {
	const ms = (text) => Date.UTC(...text.split('-').map((v, i) => Number(v) - (i === 1 ? 1 : 0)));
	return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** ISO instant → short local date-time ("26 Sep, 14:05"). */
export function formatInstant(iso) {
	if (!iso) return '';
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso) {
	const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
	if (!Number.isFinite(seconds)) return '';
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
	return `${Math.round(seconds / 86_400)} d ago`;
}

export function readFileText(file) {
	return file.text();
}
