// Signup screen (#/signup, shown outside the dashboard): household name + password (+ Cloudflare
// Turnstile when the site has a site key). New households start with WhatsApp locked until the
// site owner approves; everything else works right away, so success goes straight to the wizard.
import { api, callout, h, lowercaseInput } from './lib.js';

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__wbcTurnstileReady';
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
const RESERVED = ['owner', 'admin', 'global'];
const MIN_PASSWORD = 8;

let turnstilePromise = null;

/** Loads the Turnstile API once (explicit rendering, https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/). */
function loadTurnstile() {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	if (!turnstilePromise) {
		turnstilePromise = new Promise((resolve, reject) => {
			window.__wbcTurnstileReady = () => resolve(window.turnstile);
			const script = h('script', { src: TURNSTILE_SRC });
			script.addEventListener('error', () => {
				turnstilePromise = null;
				script.remove();
				reject(new Error('The anti-bot check couldn’t load. Check your connection (or content blocker) and reload the page.'));
			});
			document.head.append(script);
		});
	}
	return turnstilePromise;
}

/** Client-side hint for the name; the server has the final say (INVALID_NAME). */
function nameProblem(name) {
	if (!name) return 'Choose a household name.';
	if (RESERVED.includes(name)) return `“${name}” is reserved — pick another name.`;
	if (!NAME_PATTERN.test(name)) return 'Use 2–32 lower-case letters, digits, “-” or “_”, starting with a letter or digit.';
	return '';
}

/**
 * Builds the signup card. `status` is GET /api/auth/status ({ signupEnabled, turnstileSiteKey }).
 * `onSignedUp()` runs once the household exists and the session cookie is set.
 */
export function renderSignup({ status, onSignedUp, onNeedsSecrets }) {
	const header = [
		h('div', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' }, 'B'),
		h('h1', {}, 'Create a household'),
	];
	const backToLogin = h('p', { class: 'screen-foot small muted' }, 'Already have one? ', h('a', { href: '#/' }, 'Sign in'));

	if (status.signupEnabled === false) {
		return h(
			'div',
			{ class: 'screen-card' },
			header,
			callout('info', h('strong', {}, 'Signups are closed. '), 'New households can’t be created on this site right now. Ask the person who runs it.'),
			backToLogin,
		);
	}

	const field = (id, label, input, help) => {
		const error = h('div', { class: 'field-error', id: `${id}-error` });
		input.setAttribute('aria-describedby', `${help ? `${id}-help ` : ''}${id}-error`);
		const el = h('div', { class: 'field' }, h('label', { for: id }, label), input, help && h('div', { class: 'help', id: `${id}-help` }, help), error);
		return {
			el,
			input,
			error(message) {
				error.textContent = message || '';
				el.classList.toggle('has-error', !!message);
			},
		};
	};

	const name = field(
		'signup-household',
		'Household name',
		lowercaseInput(h('input', { id: 'signup-household', type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: '32', required: true })),
		'You’ll sign in with this. Lower-case letters, digits, “-” or “_” (2–32 characters), e.g. the-smiths.',
	);
	const password = field(
		'signup-password',
		'Password',
		h('input', { id: 'signup-password', type: 'password', name: 'new-password', autocomplete: 'new-password', minlength: String(MIN_PASSWORD), required: true }),
		`At least ${MIN_PASSWORD} characters. Everyone in the household shares it.`,
	);
	const confirm = field('signup-confirm', 'Confirm password', h('input', { id: 'signup-confirm', type: 'password', name: 'confirm-password', autocomplete: 'new-password', required: true }));

	const formError = h('div', { class: 'field-error', role: 'alert' });
	const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create household');

	// Turnstile (only when the site has a site key).
	const siteKey = status.turnstileSiteKey || '';
	const captchaBox = h('div', { class: 'turnstile-box' });
	const captchaError = h('div', { class: 'field-error', role: 'alert' });
	let widgetId = null;
	let captchaToken = '';
	if (siteKey) {
		captchaBox.append(h('span', { class: 'small muted' }, 'Loading the anti-bot check…'));
		loadTurnstile().then(
			(turnstile) => {
				captchaBox.replaceChildren();
				if (!captchaBox.isConnected) return; // screen left meanwhile
				widgetId = turnstile.render(captchaBox, {
					sitekey: siteKey,
					action: 'signup',
					theme: 'auto',
					callback: (token) => {
						captchaToken = token;
						captchaError.textContent = '';
					},
					'expired-callback': () => {
						captchaToken = '';
					},
					'error-callback': () => {
						captchaToken = '';
						captchaError.textContent = 'The anti-bot check failed to run. It retries automatically — or reload the page.';
					},
				});
			},
			(error) => {
				captchaBox.replaceChildren();
				captchaError.textContent = error.message;
			},
		);
	}
	const resetCaptcha = () => {
		captchaToken = '';
		if (widgetId !== null) window.turnstile?.reset(widgetId);
	};

	// Live validation once a field was left (not while typing the first characters).
	name.input.addEventListener('blur', () => name.input.value && name.error(nameProblem(name.input.value.trim())));
	name.input.addEventListener('input', () => name.el.classList.contains('has-error') && name.error(nameProblem(name.input.value.trim())));
	confirm.input.addEventListener('input', () => confirm.el.classList.contains('has-error') && confirm.error(confirm.input.value === password.input.value ? '' : 'The passwords don’t match.'));

	const form = h(
		'form',
		{
			class: 'screen-card',
			novalidate: true,
			onsubmit: async (event) => {
				event.preventDefault();
				formError.textContent = '';
				const household = name.input.value.trim().toLowerCase();
				const problems = [
					[name, nameProblem(household)],
					[password, password.input.value.length < MIN_PASSWORD ? `The password needs at least ${MIN_PASSWORD} characters.` : ''],
					[confirm, confirm.input.value !== password.input.value ? 'The passwords don’t match.' : ''],
				];
				for (const [f, message] of problems) f.error(message);
				const first = problems.find(([, message]) => message);
				if (first) return first[0].input.focus();
				if (siteKey && !captchaToken) {
					captchaError.textContent = widgetId === null ? 'Wait for the anti-bot check to load.' : 'Complete the anti-bot check first.';
					return;
				}

				submit.disabled = true;
				submit.classList.add('busy');
				try {
					await api('/api/auth/signup', { method: 'POST', body: { household, password: password.input.value, ...(siteKey ? { turnstileToken: captchaToken } : {}) } });
					await onSignedUp();
				} catch (error) {
					// A Turnstile token is single-use: always get a fresh one after a failed attempt.
					resetCaptcha();
					switch (error.code) {
						case 'INVALID_NAME':
							name.error(error.message || nameProblem(household) || 'That household name isn’t allowed.');
							name.input.focus();
							break;
						case 'NAME_TAKEN':
							name.error(`“${household}” is already taken — pick another name.`);
							name.input.select();
							break;
						case 'WEAK_PASSWORD':
							password.error(error.message || `The password needs at least ${MIN_PASSWORD} characters.`);
							password.input.focus();
							break;
						case 'CAPTCHA_FAILED':
							captchaError.textContent = 'The anti-bot check didn’t pass. Please complete it again.';
							break;
						case 'SIGNUP_DISABLED':
							formError.textContent = 'Signups were just closed on this site. Ask the person who runs it.';
							break;
						case 'NEEDS_SECRETS':
							onNeedsSecrets();
							break;
						default:
							formError.textContent = error.message;
					}
				} finally {
					submit.disabled = false;
					submit.classList.remove('busy');
				}
			},
		},
		header,
		h('p', { class: 'muted' }, 'Your own private budget space, synced from your BudgetBakers Wallet. The daily WhatsApp brief is switched on once the site owner approves your household.'),
		name.el,
		password.el,
		confirm.el,
		siteKey && h('div', { class: 'field' }, captchaBox, captchaError),
		formError,
		submit,
		backToLogin,
	);
	queueMicrotask(() => name.input.focus());
	return form;
}
