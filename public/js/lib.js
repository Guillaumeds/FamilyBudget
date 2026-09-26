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

const SECRET_WRITE_PATHS = ['/api/wallet-token', '/api/ai-key'];

const handlers = { unauthorized: () => {}, needsSecrets: () => {}, suspended: () => {} };

/**
 * Registers what happens when the session is gone (401), the secrets are missing (503) or the
 * household was suspended by the site owner (403 SUSPENDED).
 */
export function onAuthProblem(unauthorized, needsSecrets, suspended = () => {}) {
	handlers.unauthorized = unauthorized;
	handlers.needsSecrets = needsSecrets;
	handlers.suspended = suspended;
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
		// Storing a household secret answers 503 NEEDS_SECRETS when the site lacks TOKEN_ENCRYPTION_KEY:
		// that is shown inline, not as the "finish installing" screen.
		if (response.status === 503 && data.code === 'NEEDS_SECRETS' && !SECRET_WRITE_PATHS.includes(path)) handlers.needsSecrets();
		if (response.status === 403 && data.code === 'SUSPENDED') handlers.suspended();
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

/** replaceChildren() that skips null/false like h() (the native one would print "false"). */
export function setChildren(el, ...children) {
	el.replaceChildren();
	return append(el, children);
}

export function append(el, children) {
	for (const child of [children].flat(Infinity)) {
		if (child === null || child === undefined || child === false) continue;
		el.append(child instanceof Node ? child : String(child));
	}
	return el;
}

/** Lower-cases a household-name input as the user types (the server does the same), keeping the caret. */
export function lowercaseInput(input) {
	input.addEventListener('input', () => {
		const lower = input.value.toLowerCase();
		if (lower === input.value) return;
		const { selectionStart, selectionEnd } = input;
		input.value = lower;
		input.setSelectionRange(selectionStart, selectionEnd);
	});
	return input;
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

/** Page title row: h1, optional subtitle and right-aligned actions. */
export function pageHeader(title, subtitle, ...actions) {
	return h(
		'div',
		{ class: 'page-header' },
		h('div', {}, h('h1', {}, title), subtitle && h('p', { class: 'muted' }, subtitle)),
		actions.length > 0 && h('div', { class: 'page-actions' }, actions),
	);
}

/** A titled section card. */
export function card(title, ...children) {
	return h('section', { class: 'card' }, title && h('h2', { class: 'card-title' }, title), ...children);
}

/** kind: ok | bad | warn | info | neutral */
export function badge(text, kind = 'neutral') {
	return h('span', { class: `badge badge-${kind}` }, text);
}

export function emptyState(...children) {
	return h('div', { class: 'empty' }, ...children);
}

/**
 * Thin progress meter. `fraction` 0..n (over 1 turns red); `marker` (0..1) draws a pace tick,
 * e.g. how far through the period we are.
 */
export function meter(fraction, { marker, label } = {}) {
	const value = Math.max(0, Number(fraction) || 0);
	const el = h(
		'div',
		{ class: `meter${value > 1 ? ' meter-over' : value > 0.9 ? ' meter-near' : ''}`, role: 'img', 'aria-label': label ?? `${percent(value)} used` },
		h('span', { class: 'meter-fill', style: { width: `${Math.min(value, 1) * 100}%` } }),
	);
	if (marker !== undefined && marker !== null) el.append(h('span', { class: 'meter-marker', style: { left: `${Math.min(Math.max(marker, 0), 1) * 100}%` } }));
	return el;
}

/** Plain-language error text for a failed request, used in inline callouts. */
export function errorBox(error, retry) {
	return callout(
		'error',
		h('strong', {}, 'Couldn’t load this page. '),
		error?.message ?? String(error),
		retry && h('div', { class: 'callout-actions' }, h('button', { type: 'button', class: 'btn btn-sm', onclick: retry }, 'Try again')),
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

/** localStorage for small UI preferences; silently no-ops where storage is blocked. */
export const prefs = {
	get(key, fallback) {
		try {
			const value = localStorage.getItem(`wbc:${key}`);
			return value === null ? fallback : JSON.parse(value);
		} catch {
			return fallback;
		}
	},
	set(key, value) {
		try {
			localStorage.setItem(`wbc:${key}`, JSON.stringify(value));
		} catch {
			// Private mode / blocked storage: preferences just don't persist.
		}
	},
};
