// App shell: boot (auth status → secrets screen / login / setup wizard / dashboard), hash router,
// top navigation and the current-period label. Each view is an ES module exporting
// `render(root, ctx)`; it is loaded on first visit.
import { ApiError, api, callout, errorBox, h, onAuthProblem, periodLabel, spinner } from './lib.js';

const VIEWS = {
	budget: { title: 'Budget', load: () => import('./budget.js') },
	transactions: { title: 'Transactions', load: () => import('./transactions.js') },
	cashflow: { title: 'Cash flow', load: () => import('./cashflow.js') },
	brief: { title: 'Brief', load: () => import('./brief.js') },
	settings: { title: 'Settings', load: () => import('./settings.js') },
	setup: { title: 'Setup', load: () => import('./setup.js') },
};
const APP_NAME = 'Wallet Budget Companion';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const periodPill = document.getElementById('period-label');
const setupBanner = document.getElementById('setup-banner');

const state = {
	/** 'booting' | 'secrets' | 'login' | 'app' */
	screen: 'booting',
	setupComplete: false,
	/** Memoised { period, todayLocal, currency } of the current budget period. */
	periodPromise: null,
	renderToken: 0,
	firstRender: true,
};

// ---------------------------------------------------------------------------------------------
// Context handed to every view
// ---------------------------------------------------------------------------------------------

const ctx = {
	/** Current budget period (offset 0): { period, todayLocal, currency }. Cached until invalidated. */
	currentPeriod() {
		if (!state.periodPromise) {
			state.periodPromise = api('/api/summary?offset=0')
				.then((summary) => {
					const current = { period: summary.period, todayLocal: summary.todayLocal, currency: summary.currency };
					showPeriod(current.period);
					return current;
				})
				.catch((error) => {
					state.periodPromise = null;
					throw error;
				});
		}
		return state.periodPromise;
	},
	/** Views that already fetched /api/summary?offset=0 share it (saves a round trip). */
	setCurrentPeriod(summary) {
		const current = { period: summary.period, todayLocal: summary.todayLocal, currency: summary.currency };
		state.periodPromise = Promise.resolve(current);
		showPeriod(current.period);
	},
	/** Call after settings that move the period (time zone, start day, currency) change. */
	invalidatePeriod() {
		state.periodPromise = null;
		ctx.currentPeriod().catch(() => {});
	},
	get setupComplete() {
		return state.setupComplete;
	},
	markSetupComplete() {
		state.setupComplete = true;
		setupBanner.hidden = true;
	},
	navigate(hash) {
		if (location.hash === hash) render();
		else location.hash = hash;
	},
};

function showPeriod(period) {
	periodPill.textContent = periodLabel(period.startText, period.endText);
	periodPill.hidden = false;
}

// ---------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------

function parseHash() {
	const raw = location.hash.replace(/^#\/?/, '');
	const [path, query = ''] = raw.split('?');
	const [name, ...sub] = path.split('/').filter(Boolean);
	return { name: VIEWS[name] ? name : 'budget', sub, params: new URLSearchParams(query) };
}

async function render() {
	if (state.screen !== 'app') return;
	const token = ++state.renderToken;
	const route = parseHash();
	const view = VIEWS[route.name];

	for (const link of topbar.querySelectorAll('.nav a')) {
		if (link.dataset.view === route.name) link.setAttribute('aria-current', 'page');
		else link.removeAttribute('aria-current');
	}
	topbar.querySelector('.nav a[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	setupBanner.hidden = state.setupComplete || route.name === 'setup';
	document.title = `${view.title} · ${APP_NAME}`;

	const root = h('div', { class: `view view-${route.name}` }, spinner());
	main.replaceChildren(root);
	if (!state.firstRender) main.focus({ preventScroll: true });
	state.firstRender = false;
	window.scrollTo(0, 0);

	try {
		const module = await view.load();
		if (token !== state.renderToken) return; // navigated away meanwhile
		root.replaceChildren();
		await module.render(root, { ...ctx, sub: route.sub, params: route.params, get setupComplete() { return state.setupComplete; } });
	} catch (error) {
		if (token !== state.renderToken) return;
		if (error instanceof ApiError && (error.status === 401 || error.code === 'NEEDS_SECRETS')) return; // handled globally
		root.replaceChildren(errorBox(error, render));
	}
}

// ---------------------------------------------------------------------------------------------
// Screens outside the dashboard: missing secrets, login
// ---------------------------------------------------------------------------------------------

function showScreen(screen, ...children) {
	state.screen = screen;
	topbar.hidden = true;
	document.body.classList.add('bare');
	main.replaceChildren(h('div', { class: 'screen' }, ...children));
}

function showSecrets() {
	if (state.screen === 'secrets') return;
	document.title = `Finish installing · ${APP_NAME}`;
	const code = (text) => h('pre', { class: 'code' }, h('code', {}, text));
	showScreen(
		'secrets',
		h(
			'div',
			{ class: 'screen-card screen-card-wide' },
			h('div', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' }, 'B'),
			h('h1', {}, 'One more step'),
			h('p', {}, 'The dashboard is locked until it has a password and a session secret. Set both as Worker secrets:'),
			code('npx wrangler secret put DASHBOARD_PASSWORD\nnpx wrangler secret put SESSION_SECRET'),
			h('p', { class: 'muted' }, 'For the session secret, paste a long random string, e.g. the output of ', h('code', {}, 'openssl rand -base64 32'), '.'),
			callout('info', 'Running locally with ', h('code', {}, 'wrangler dev'), '? Put both values in ', h('code', {}, '.dev.vars'), ' instead (see ', h('code', {}, '.dev.vars.example'), ') and restart it.'),
			h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => location.reload() }, 'I’ve set them — reload'),
		),
	);
}

function showLogin() {
	if (state.screen === 'login') return;
	document.title = `Sign in · ${APP_NAME}`;
	state.periodPromise = null;
	const input = h('input', { id: 'password', type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-describedby': 'login-error' });
	const error = h('div', { class: 'field-error', id: 'login-error', role: 'alert' });
	const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');
	const form = h(
		'form',
		{
			class: 'screen-card',
			onsubmit: async (event) => {
				event.preventDefault();
				error.textContent = '';
				form.classList.remove('has-error');
				submit.disabled = true;
				submit.classList.add('busy');
				try {
					await api('/api/auth/login', { method: 'POST', body: { password: input.value } });
					await boot();
				} catch (err) {
					if (err.code === 'NEEDS_SECRETS') return showSecrets();
					error.textContent = err.code === 'BAD_PASSWORD' ? 'That password isn’t right. Try again.' : err.message;
					form.classList.add('has-error');
					input.select();
				} finally {
					submit.disabled = false;
					submit.classList.remove('busy');
				}
			},
		},
		h('div', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' }, 'B'),
		h('h1', {}, 'Budget Companion'),
		h('p', { class: 'muted' }, 'Sign in to your budget dashboard.'),
		h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), input, error),
		submit,
	);
	showScreen('login', form);
	input.focus();
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

async function boot() {
	let status;
	try {
		status = await api('/api/auth/status');
	} catch (error) {
		state.screen = 'booting';
		main.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'screen-card' }, errorBox(error, boot))));
		return;
	}
	if (status.needsSecrets) return showSecrets();
	if (!status.authenticated) return showLogin();

	state.screen = 'app';
	state.setupComplete = status.setupComplete;
	state.firstRender = true;
	document.body.classList.remove('bare');
	topbar.hidden = false;
	if (!status.setupComplete && parseHash().name !== 'setup') {
		history.replaceState(null, '', '#/setup');
	} else if (!location.hash) {
		history.replaceState(null, '', '#/budget');
	}
	render();
	// Period label for the header (the budget view provides it for free when it is the first page).
	if (parseHash().name !== 'budget') ctx.currentPeriod().catch(() => {});
}

onAuthProblem(showLogin, showSecrets);
window.addEventListener('hashchange', render);
document.getElementById('logout').addEventListener('click', async () => {
	await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
	periodPill.hidden = true;
	showLogin();
});

boot();
