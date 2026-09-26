// App shell: boot (auth status → secrets screen / login / signup / suspended / setup wizard /
// dashboard / owner console), hash router, top navigation, the signed-in household and the
// current-period label. Each view is an ES module exporting `render(root, ctx)`; it is loaded on
// first visit.
import { ApiError, api, callout, errorBox, h, lowercaseInput, onAuthProblem, periodLabel, spinner } from './lib.js';

const VIEWS = {
	budget: { title: 'Budget', load: () => import('./budget.js') },
	transactions: { title: 'Transactions', load: () => import('./transactions.js') },
	cashflow: { title: 'Cash flow', load: () => import('./cashflow.js') },
	brief: { title: 'Brief', load: () => import('./brief.js') },
	settings: { title: 'Settings', load: () => import('./settings.js') },
	setup: { title: 'Setup', load: () => import('./setup.js') },
	owner: { title: 'Owner console', load: () => import('./owner.js') },
};
const APP_NAME = 'Wallet Budget Companion';

const main = document.getElementById('main');
const topbar = document.getElementById('topbar');
const periodPill = document.getElementById('period-label');
const householdPill = document.getElementById('household-name');
const setupBanner = document.getElementById('setup-banner');
const brand = topbar.querySelector('.brand');

const state = {
	/** 'booting' | 'secrets' | 'login' | 'signup' | 'suspended' | 'app' */
	screen: 'booting',
	setupComplete: false,
	/** The site owner (login name "owner") only sees the owner console — it has no budget data. */
	isOwner: false,
	householdName: '',
	/** Last GET /api/auth/status (signup switch + Turnstile site key for the login/signup screens). */
	authStatus: null,
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
		if (state.isOwner) return Promise.reject(new Error('The owner account has no budget data.'));
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
	get isOwner() {
		return state.isOwner;
	},
	get householdName() {
		return state.householdName;
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
	// The owner only has the owner console; households never see it.
	let view = VIEWS[name] ? name : 'budget';
	if (state.isOwner) view = 'owner';
	else if (view === 'owner') view = 'budget';
	return { name: view, sub: view === name ? sub : [], params: new URLSearchParams(query) };
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
	setupBanner.hidden = state.isOwner || state.setupComplete || route.name === 'setup';
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
		if (error instanceof ApiError && (error.status === 401 || error.code === 'NEEDS_SECRETS' || error.code === 'SUSPENDED')) return; // handled globally
		root.replaceChildren(errorBox(error, render));
	}
}

/** Header for the signed-in identity: household name (or "Owner") and the nav it may use. */
function applyIdentity() {
	householdPill.textContent = state.isOwner ? 'Owner' : state.householdName;
	householdPill.hidden = !householdPill.textContent;
	for (const link of topbar.querySelectorAll('.nav a')) link.hidden = state.isOwner !== (link.dataset.view === 'owner');
	brand.setAttribute('href', state.isOwner ? '#/owner' : '#/budget');
	if (state.isOwner) periodPill.hidden = true;
}

// ---------------------------------------------------------------------------------------------
// Screens outside the dashboard: missing secrets, login, signup, suspended
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
			h('p', {}, 'The site is locked until it has an owner password and a session secret. Set both as Worker secrets:'),
			code('npx wrangler secret put DASHBOARD_PASSWORD\nnpx wrangler secret put SESSION_SECRET'),
			h('p', { class: 'muted' }, 'For the session secret, paste a long random string, e.g. the output of ', h('code', {}, 'openssl rand -base64 32'), '.'),
			h('p', { class: 'muted' }, 'The owner signs in with the household name ', h('code', {}, 'owner'), ' and DASHBOARD_PASSWORD.'),
			callout('info', 'Running locally with ', h('code', {}, 'wrangler dev'), '? Put both values in ', h('code', {}, '.dev.vars'), ' instead (see ', h('code', {}, '.dev.vars.example'), ') and restart it.'),
			h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: () => location.reload() }, 'I’ve set them — reload'),
		),
	);
}

function isSignupHash() {
	return /^#\/?signup\b/.test(location.hash);
}

function showLogin() {
	if (state.screen === 'login') return;
	if (isSignupHash()) history.replaceState(null, '', location.pathname + location.search);
	document.title = `Sign in · ${APP_NAME}`;
	state.periodPromise = null;
	const household = lowercaseInput(
		h('input', { id: 'household', type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, 'aria-describedby': 'household-help login-error' }),
	);
	const input = h('input', { id: 'password', type: 'password', name: 'password', autocomplete: 'current-password', required: true, 'aria-describedby': 'login-error' });
	const error = h('div', { class: 'field-error', id: 'login-error', role: 'alert' });
	const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in');
	const signupEnabled = state.authStatus?.signupEnabled !== false;
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
					await api('/api/auth/login', { method: 'POST', body: { household: household.value.trim().toLowerCase(), password: input.value } });
					await boot();
				} catch (err) {
					if (err.code === 'NEEDS_SECRETS') return showSecrets();
					if (err.code === 'SUSPENDED') return showSuspended();
					error.textContent = err.status === 401 || err.code === 'BAD_PASSWORD' ? 'That household name or password isn’t right. Try again.' : err.message;
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
		h('p', { class: 'muted' }, 'Sign in to your household’s budget dashboard.'),
		h('div', { class: 'field' }, h('label', { for: 'household' }, 'Household'), household, h('div', { class: 'help', id: 'household-help' }, 'The lower-case name your household signed up with.')),
		h('div', { class: 'field' }, h('label', { for: 'password' }, 'Password'), input, error),
		submit,
		signupEnabled && h('p', { class: 'screen-foot small muted' }, 'New here? ', h('a', { href: '#/signup' }, 'Create a household')),
	);
	showScreen('login', form);
	household.focus();
}

async function showSignup() {
	if (state.screen === 'signup') return;
	document.title = `Create a household · ${APP_NAME}`;
	state.periodPromise = null;
	state.screen = 'signup';
	let module;
	try {
		module = await import('./signup.js');
	} catch (error) {
		showScreen('signup', h('div', { class: 'screen-card' }, errorBox(error, () => location.reload())));
		return;
	}
	if (state.screen !== 'signup') return; // navigated back to sign-in meanwhile
	showScreen(
		'signup',
		module.renderSignup({
			status: state.authStatus ?? {},
			onSignedUp: async () => {
				history.replaceState(null, '', '#/setup');
				await boot();
			},
			onNeedsSecrets: showSecrets,
		}),
	);
}

function showSuspended() {
	if (state.screen === 'suspended') return;
	document.title = `Household suspended · ${APP_NAME}`;
	state.periodPromise = null;
	const signOut = h('button', { type: 'button', class: 'btn btn-primary btn-block', onclick: logout }, 'Sign out');
	showScreen(
		'suspended',
		h(
			'div',
			{ class: 'screen-card' },
			h('div', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' }, 'B'),
			h('h1', {}, 'Household suspended'),
			callout('warn', 'This household has been suspended by the owner of this site. Syncing and the daily brief are paused and the dashboard is locked.'),
			h('p', { class: 'muted' }, 'If you think this is a mistake, contact the person who runs this site. Your data is kept.'),
			signOut,
		),
	);
	signOut.focus();
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
	state.authStatus = status;
	if (status.needsSecrets) return showSecrets();
	if (status.suspended) return showSuspended();
	if (!status.authenticated) return isSignupHash() ? showSignup() : showLogin();

	state.screen = 'app';
	state.isOwner = !!status.isOwner;
	state.householdName = status.householdName ?? '';
	state.setupComplete = state.isOwner || !!status.setupComplete;
	state.periodPromise = null;
	state.firstRender = true;
	document.body.classList.remove('bare');
	topbar.hidden = false;
	applyIdentity();
	const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
	if (state.isOwner) {
		if (name !== 'owner') history.replaceState(null, '', '#/owner');
	} else if (!state.setupComplete && name !== 'setup') {
		history.replaceState(null, '', '#/setup');
	} else if (!location.hash || name === 'signup' || name === 'owner') {
		history.replaceState(null, '', '#/budget');
	}
	render();
	// Period label for the header (the budget view provides it for free when it is the first page).
	if (!state.isOwner && parseHash().name !== 'budget') ctx.currentPeriod().catch(() => {});
}

async function logout() {
	await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
	state.isOwner = false;
	state.householdName = '';
	periodPill.hidden = true;
	householdPill.hidden = true;
	history.replaceState(null, '', location.pathname + location.search);
	// Refresh the signup switch for the sign-in screen.
	state.authStatus = await api('/api/auth/status').catch(() => state.authStatus);
	if (state.screen === 'login') state.screen = 'booting';
	showLogin();
}

onAuthProblem(showLogin, showSecrets, showSuspended);
window.addEventListener('hashchange', () => {
	// Sign-in ⇄ create-a-household links outside the dashboard.
	if (state.screen === 'login' && isSignupHash()) return showSignup();
	if (state.screen === 'signup' && !isSignupHash()) return showLogin();
	render();
});
document.getElementById('logout').addEventListener('click', logout);

boot();
