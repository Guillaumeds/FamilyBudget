#!/usr/bin/env node
/**
 * One-command onboarding for Wallet Budget Companion: `npm run setup`.
 *
 * Steps (each one is idempotent — re-running the script is safe):
 *   1. Preflight   — Node.js >= 20, logged in to Cloudflare (`wrangler whoami`).
 *   2. D1          — create the `wallet-budget-companion` database (or reuse it) and write its id
 *                    into wrangler.jsonc.
 *   3. Migrations  — `wrangler d1 migrations apply wallet-budget-companion --remote`.
 *   4. Secrets     — `wrangler secret put <NAME>`, value piped through stdin.
 *   5. Deploy      — `wrangler deploy`, then print the workers.dev URL.
 *   6. Next steps.
 *
 * Flags:
 *   --yes    Non-interactive where possible: keep existing secrets, generate SESSION_SECRET, skip
 *            optional secrets unless they are set as environment variables of the same name.
 *   --local  Local development only: create .dev.vars from .dev.vars.example and apply the migrations
 *            to the local D1 database. Needs no Cloudflare login.
 *   --help   Show this help.
 *
 * Any secret can also be supplied as an environment variable with the same name
 * (e.g. `WALLET_API_TOKEN=... npm run setup -- --yes`); it is then used without prompting.
 *
 * No dependencies: node:readline, node:child_process, node:fs, node:crypto only.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER_CONFIG = join(ROOT, 'wrangler.jsonc');
const DEV_VARS = join(ROOT, '.dev.vars');
const DEV_VARS_EXAMPLE = join(ROOT, '.dev.vars.example');
const DB_NAME = 'wallet-budget-companion';
const DB_ID_PLACEHOLDER = 'REPLACE_WITH_D1_DATABASE_ID';
const IS_WINDOWS = process.platform === 'win32';

const args = new Set(process.argv.slice(2));
const YES = args.has('--yes') || args.has('-y');
const LOCAL = args.has('--local');
const INTERACTIVE = Boolean(process.stdin.isTTY);

const SECRETS = [
	{
		name: 'WALLET_API_TOKEN',
		required: true,
		help: 'BudgetBakers Wallet REST API token: open the Wallet web app → Settings → REST API and create a token (Premium plan required).',
	},
	{
		name: 'DASHBOARD_PASSWORD',
		required: true,
		help: 'Password for the web dashboard login. Choose a long one — the dashboard is on the public internet.',
	},
	{
		name: 'SESSION_SECRET',
		required: true,
		generate: true,
		help: 'Random key that signs dashboard session cookies. Best generated.',
	},
	{
		name: 'WHATSAPP_ACCESS_TOKEN',
		group: 'whatsapp',
		help: 'Permanent System User access token with the whatsapp_business_messaging permission (docs/whatsapp-setup.md).',
	},
	{
		name: 'WHATSAPP_PHONE_NUMBER_ID',
		group: 'whatsapp',
		help: 'Phone number ID of the sending number (App Dashboard → WhatsApp → API Setup) — the ID, not the phone number.',
	},
	{
		name: 'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
		group: 'whatsapp',
		generate: true,
		help: 'Any random string. Paste the same value into the "Verify token" field of the Meta webhook configuration.',
	},
	{
		name: 'META_APP_SECRET',
		group: 'whatsapp',
		help: 'Meta App secret (App Dashboard → App settings → Basic). Used to verify webhook signatures; without it the webhook rejects every message.',
	},
	{
		name: 'ANTHROPIC_API_KEY',
		group: 'ai',
		help: 'Anthropic API key (console.anthropic.com) for the optional Claude Q&A over WhatsApp.',
	},
];

// ---------------------------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------------------------

const color = (code) => (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = color('1');
const dim = color('2');
const green = color('32');
const yellow = color('33');
const red = color('31');

let stepNumber = 0;
function step(title) {
	stepNumber++;
	console.log(`\n${bold(`[${stepNumber}] ${title}`)}`);
}
const info = (text) => console.log(`    ${text}`);
const ok = (text) => console.log(`    ${green('✔')} ${text}`);
const warn = (text) => console.log(`    ${yellow('!')} ${text}`);

class SetupError extends Error {}
function fail(message) {
	throw new SetupError(message);
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

async function ask(question, defaultValue = '') {
	if (!INTERACTIVE) return defaultValue;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`    ${question}${defaultValue ? dim(` [${defaultValue}]`) : ''} `)).trim();
		return answer || defaultValue;
	} finally {
		rl.close();
	}
}

async function confirm(question, defaultYes = true) {
	if (YES || !INTERACTIVE) return defaultYes;
	const answer = (await ask(`${question} ${dim(defaultYes ? '(Y/n)' : '(y/N)')}`)).toLowerCase();
	if (!answer) return defaultYes;
	return answer.startsWith('y');
}

/** Reads a line without echoing it (raw TTY mode). Falls back to a visible prompt when raw mode is unavailable. */
async function askSecret(question) {
	const stdin = process.stdin;
	if (!INTERACTIVE || typeof stdin.setRawMode !== 'function') {
		return ask(`${question} ${dim('(input will be visible)')}`);
	}
	process.stdout.write(`    ${question} ${dim('(input hidden)')} `);
	return new Promise((resolve, reject) => {
		let value = '';
		const done = (result) => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.removeListener('data', onData);
			process.stdout.write('\n');
			result instanceof Error ? reject(result) : resolve(result.trim());
		};
		const onData = (chunk) => {
			for (const char of chunk.toString('utf8')) {
				if (char === '\r' || char === '\n') return done(value);
				if (char === '\u0003') return done(new SetupError('Aborted.')); // Ctrl-C
				if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
				else if (char >= ' ') value += char;
			}
		};
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on('data', onData);
	});
}

// ---------------------------------------------------------------------------------------------
// Running wrangler
// ---------------------------------------------------------------------------------------------

/**
 * Runs `npx wrangler <args>`. `capture` returns stdout/stderr instead of streaming them; `input`
 * is piped to stdin (how `wrangler secret put` receives a value non-interactively).
 */
function wrangler(wranglerArgs, { capture = false, input, env } = {}) {
	const result = spawnSync('npx', ['wrangler', ...wranglerArgs], {
		cwd: ROOT,
		env: { ...process.env, ...env },
		encoding: 'utf8',
		input,
		stdio: input !== undefined ? ['pipe', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'] : capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		shell: IS_WINDOWS, // npx is npx.cmd on Windows
	});
	if (result.error) fail(`Could not run npx wrangler: ${result.error.message}`);
	return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** First JSON value (object or array) found in wrangler's output. */
function parseJsonOutput(text) {
	const start = text.search(/[[{]/);
	if (start < 0) return null;
	const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function checkNode() {
	const major = Number(process.versions.node.split('.')[0]);
	if (major < 20) fail(`Node.js 20 or newer is required (found ${process.versions.node}). Install the current LTS from https://nodejs.org.`);
	ok(`Node.js ${process.versions.node}`);
	if (!existsSync(join(ROOT, 'node_modules', 'wrangler'))) fail('Dependencies are missing. Run `npm install` first, then `npm run setup` again.');
	ok('Dependencies installed');
}

async function checkLogin() {
	const { status, stdout } = wrangler(['whoami', '--json'], { capture: true });
	const who = status === 0 ? parseJsonOutput(stdout) : null;
	if (!who?.loggedIn) {
		console.log(`\n    You are not logged in to Cloudflare. Run:\n\n        ${bold('npx wrangler login')}\n\n    (or set CLOUDFLARE_API_TOKEN), then run ${bold('npm run setup')} again.`);
		console.log(`    No Cloudflare account yet? Sign up for free at https://dash.cloudflare.com/sign-up`);
		process.exit(1);
	}
	ok(`Logged in to Cloudflare${who.email ? ` as ${who.email}` : ''}`);

	// Several accounts: wrangler needs to know which one outside an interactive prompt.
	const accounts = Array.isArray(who.accounts) ? who.accounts : [];
	if (accounts.length > 1 && !process.env.CLOUDFLARE_ACCOUNT_ID) {
		if (YES || !INTERACTIVE) fail('Your login has access to several Cloudflare accounts. Set CLOUDFLARE_ACCOUNT_ID to the one to use and re-run.');
		info('Your login has access to several Cloudflare accounts:');
		accounts.forEach((account, index) => info(`  ${index + 1}. ${account.name} ${dim(account.id)}`));
		const choice = Number(await ask('Which one should host the Worker? Enter a number:', '1'));
		const account = accounts[choice - 1];
		if (!account) fail('Invalid choice.');
		process.env.CLOUDFLARE_ACCOUNT_ID = account.id; // inherited by every wrangler call below
		ok(`Using account ${account.name}`);
	}
}

function findDatabaseId() {
	const { status, stdout } = wrangler(['d1', 'list', '--json'], { capture: true });
	if (status !== 0) return null;
	const list = parseJsonOutput(stdout);
	const match = Array.isArray(list) ? list.find((db) => db?.name === DB_NAME) : null;
	return match?.uuid ?? null;
}

function ensureDatabase() {
	const config = readFileSync(WRANGLER_CONFIG, 'utf8');
	if (!config.includes(DB_ID_PLACEHOLDER)) {
		ok('wrangler.jsonc already has a database_id — skipping.');
		return;
	}

	let id = findDatabaseId();
	if (id) {
		ok(`Found an existing D1 database "${DB_NAME}" (${id}) — reusing it.`);
	} else {
		info(`Creating D1 database "${DB_NAME}"...`);
		// --no-update-config: we patch the placeholder ourselves instead of letting wrangler append a binding.
		const created = wrangler(['d1', 'create', DB_NAME, '--no-update-config'], { capture: true });
		if (created.status !== 0) fail(`wrangler d1 create failed:\n${created.stderr || created.stdout}`);
		id = /"?database_id"?\s*[:=]\s*"([0-9a-f-]{36})"/i.exec(created.stdout)?.[1] ?? findDatabaseId();
		if (!id) fail(`Could not read the new database id from wrangler's output:\n${created.stdout}`);
		ok(`Created D1 database ${id}`);
	}

	// Plain string replacement keeps comments and formatting intact.
	writeFileSync(WRANGLER_CONFIG, config.replace(`"${DB_ID_PLACEHOLDER}"`, `"${id}"`));
	ok('Wrote database_id into wrangler.jsonc (commit this change if you deploy from GitHub).');
}

function applyMigrations(where) {
	const { status } = wrangler(['d1', 'migrations', 'apply', DB_NAME, where]);
	if (status !== 0) fail(`Applying migrations (${where}) failed — see the output above.`);
	ok(`Migrations applied (${where.slice(2)})`);
}

function existingSecrets() {
	const { status, stdout } = wrangler(['secret', 'list', '--format', 'json'], { capture: true });
	if (status !== 0) return new Set(); // Worker not deployed yet: no secrets.
	const list = parseJsonOutput(stdout);
	return new Set(Array.isArray(list) ? list.map((secret) => secret?.name).filter(Boolean) : []);
}

async function setSecrets() {
	const existing = existingSecrets();
	const groups = {};
	const skipped = [];

	for (const secret of SECRETS) {
		const { name } = secret;
		console.log(`\n    ${bold(name)}${secret.required ? '' : dim(' (optional)')}\n    ${dim(secret.help)}`);

		const fromEnv = process.env[name]?.trim();
		if (existing.has(name) && !(await confirm(`${name} is already set. Overwrite it?`, false))) {
			ok('Kept the existing value.');
			continue;
		}

		// Optional features are offered once per group.
		if (secret.group && !fromEnv) {
			if (groups[secret.group] === undefined) {
				const label = secret.group === 'whatsapp' ? 'the WhatsApp daily brief (needs a Meta app — see docs/whatsapp-setup.md)' : 'Claude Q&A over WhatsApp';
				groups[secret.group] = YES ? false : await confirm(`Set up ${label} now? You can also do it later.`, false);
			}
			if (!groups[secret.group]) {
				info(dim('Skipped. Set it later with: npx wrangler secret put ' + name));
				skipped.push(name);
				continue;
			}
		}

		let value = fromEnv;
		if (value) info(`Using ${name} from the environment.`);
		else if (secret.generate && (await confirm('Generate a random value?', true))) {
			value = randomBytes(32).toString('hex');
			if (name === 'WHATSAPP_WEBHOOK_VERIFY_TOKEN') info(`Generated. Paste this into Meta's "Verify token" field: ${bold(value)}`);
			else ok('Generated a random value.');
		} else if (INTERACTIVE) value = await askSecret(`Enter ${name}:`);

		if (!value) {
			if (secret.required) warn(`${name} was not set. The dashboard will not work until you run: npx wrangler secret put ${name}`);
			else info(dim('Skipped.'));
			skipped.push(name);
			continue;
		}
		const { status, stderr } = wrangler(['secret', 'put', name], { input: value, capture: true });
		if (status !== 0) fail(`wrangler secret put ${name} failed:\n${stderr}`);
		ok(`${name} saved.`);
	}
	return skipped;
}

function deploy() {
	const outputFile = join(tmpdir(), `wbc-setup-${process.pid}.ndjson`);
	// WRANGLER_OUTPUT_FILE_PATH: wrangler writes ND-JSON records, including the deployed URLs, to this
	// file (https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).
	const { status } = wrangler(['deploy'], { env: { WRANGLER_OUTPUT_FILE_PATH: outputFile } });
	let targets = [];
	try {
		for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
			if (!line.trim()) continue;
			const entry = JSON.parse(line);
			if (entry.type === 'deploy' && Array.isArray(entry.targets)) targets = entry.targets;
		}
	} catch {
		// No output file (deploy failed early) — handled below.
	} finally {
		rmSync(outputFile, { force: true });
	}
	if (status !== 0) fail('wrangler deploy failed — see the output above.');
	const url = targets.find((target) => /workers\.dev/.test(target)) ?? targets[0] ?? null;
	ok(url ? `Deployed to ${bold(url)}` : 'Deployed. (Could not read the URL — see the wrangler output above.)');
	return url;
}

function printNextSteps(url, skipped = []) {
	const base = url ?? 'https://<your-worker>.<your-subdomain>.workers.dev';
	if (skipped.length) {
		console.log(`
${bold('⚠ Secrets NOT set during this run')} — the matching features stay off until you add them:
${skipped.map((name) => `     npx wrangler secret put ${name}`).join('\n')}
   (Each command prompts for the value and activates it immediately — no redeploy needed.
    WHATSAPP_* and META_APP_SECRET are needed for the daily brief and inbound messages;
    ANTHROPIC_API_KEY only for Claude Q&A.)`);
	}
	console.log(`
${bold('Done! Next steps')}

  1. Open ${bold(base)} and log in with your DASHBOARD_PASSWORD.
  2. The first-run setup wizard walks you through: testing the Wallet connection, timezone /
     base currency / budget-month start day, the historical backfill, and (optionally) WhatsApp.
     Right after a Wallet token is created BudgetBakers runs an initial sync; if the wizard says
     so, wait a few minutes and retry.
  3. WhatsApp daily brief: follow docs/whatsapp-setup.md. Your webhook URL is
     ${bold(`${base}/webhook`)}
  4. Optional — deploy automatically from GitHub on every push to main. In your repository's
     Settings → Secrets and variables → Actions, add:
       • variable CLOUDFLARE_ACCOUNT_ID  (your Cloudflare account id)
       • secret   CLOUDFLARE_API_TOKEN   (token from the "Edit Cloudflare Workers" template, plus D1: Edit)
     and commit the database_id that setup wrote into wrangler.jsonc.
`);
}

function setupLocal() {
	step('Local development (.dev.vars)');
	if (existsSync(DEV_VARS)) {
		ok('.dev.vars already exists — leaving it untouched.');
	} else {
		const sessionSecret = randomBytes(32).toString('hex');
		const text = readFileSync(DEV_VARS_EXAMPLE, 'utf8').replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${sessionSecret}`);
		writeFileSync(DEV_VARS, text);
		ok('Created .dev.vars from .dev.vars.example (with a generated SESSION_SECRET).');
		info(`Fill in at least ${bold('WALLET_API_TOKEN')} and ${bold('DASHBOARD_PASSWORD')}.`);
	}

	step('Local D1 database');
	applyMigrations('--local');

	console.log(`
${bold('Done!')} Start the dev server with ${bold('npm run dev')} and open the URL it prints.
While it runs, trigger the hourly cron with
${bold('curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"')}.
`);
}

function printHelp() {
	console.log(`Usage: npm run setup [-- --yes] [-- --local]

  (no flags)  Interactive setup on Cloudflare: D1, migrations, secrets, deploy.
  --yes, -y   Accept defaults; keep existing secrets; skip optional features unless their
              secrets are provided as environment variables of the same name.
  --local     Only prepare local development (.dev.vars + local D1). No Cloudflare login needed.
  --help, -h  Show this help.

Secrets: ${SECRETS.map((secret) => secret.name).join(', ')}`);
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
	if (args.has('--help') || args.has('-h')) return printHelp();
	console.log(bold('Wallet Budget Companion — setup'));

	step('Preflight');
	checkNode();
	if (LOCAL) return setupLocal();
	await checkLogin();

	step('D1 database');
	ensureDatabase();

	step('Database migrations');
	applyMigrations('--remote');

	step('Secrets');
	if (!INTERACTIVE && !YES) warn('No terminal detected: only secrets provided as environment variables will be set.');
	const skipped = await setSecrets();

	step('Deploy');
	const url = deploy();

	printNextSteps(url, skipped);
}

main().catch((error) => {
	console.error(`\n${red('✖')} ${error instanceof SetupError ? error.message : (error?.stack ?? error)}`);
	console.error(dim('Setup is safe to re-run: completed steps are detected and skipped.'));
	process.exit(1);
});
