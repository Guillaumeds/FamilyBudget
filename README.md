# Wallet Budget Companion

**Budgets, a web dashboard and a daily WhatsApp brief for [BudgetBakers Wallet](https://budgetbakers.com), running free on Cloudflare Workers.**

BudgetBakers Wallet is good at bank sync and automatic categorisation, but it has no real budget tracking: you can't set a monthly target per category, see a forecast for the month or get a daily summary. Wallet Budget Companion is a small plugin that does that part. It reads your Wallet data through the official [Wallet REST API](https://rest.budgetbakers.com/wallet/reference), keeps a copy in a Cloudflare D1 database, and adds:

- a budget table with a target, spend, remaining amount and forecast for every category and group,
- a **daily WhatsApp brief** with yesterday's expenses and where the month stands,
- optional **Claude Q&A**: ask "how much did we spend on restaurants this month?" on WhatsApp.

BudgetBakers is still where you manage categories and fix transactions. New or renamed categories show up in the companion after the next hourly sync.

One deployment serves several **households**. Each household signs up with a name and a password, connects its own BudgetBakers account and keeps its own data, settings and WhatsApp recipients. The person who deploys it is the **owner**: they pay for the Cloudflare account and the WhatsApp sender, and approve which households may use WhatsApp.

<!-- Screenshot placeholder: dashboard budget table + a WhatsApp daily brief, e.g. docs/img/dashboard.png and docs/img/brief.png -->

> Not affiliated with BudgetBakers. You need a **BudgetBakers Wallet Premium** plan, because the REST API requires it.

## Features

- **Hourly sync** of categories, accounts and records from Wallet, plus a full re-sync every Sunday at 03:00 local time that catches old edits and deletions.
- **Budget table** with inline-editable targets on categories, sub-categories and groups (a group without its own target sums its categories), forecast types (day-to-day or recurring) and include flags. It shows 3-period baselines and group/overall rollups, and supports a **custom budget month** (for example the 25th to the 24th, to match your payday).
- **Daily WhatsApp brief** at the hour you choose. If the recipient messaged the bot in the last 24 hours, they get the full brief as free-form text. Otherwise the bot sends your **approved message template**, as WhatsApp's rules require (see [docs/whatsapp-setup.md](docs/whatsapp-setup.md)).
- **"Budget" command**: reply `Budget` on WhatsApp at any time to get the full brief. Replying also reopens the 24-hour window.
- **Claude Q&A** (optional): free-text questions are answered by Claude, which uses read-only tools over your synced data. Each household brings its own Anthropic API key.
- **Web dashboard** with a first-run setup wizard, budget, transactions, cash-flow and brief-preview views, settings and logs.
- **Households**: open signup (with an optional [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) CAPTCHA), one login per household, and an **owner console** to approve WhatsApp, suspend households, reset passwords and close signups. BudgetBakers tokens and Anthropic keys are stored encrypted in D1.
- **CSV imports** for budget targets (a simple format, or the old Apps Script sheet export) and for cash-flow closing-balance history.
- **Cash-flow tracking**: closing balances per account are captured automatically at the end of every budget period.
- **Multi-currency**: amounts are stored in their original currency and converted to your base currency with daily reference rates from [Frankfurter](https://frankfurter.dev) (ECB and other central banks, no API key).
- **Safe by default**: `dry_run` is on until you turn it off, new households can't send WhatsApp messages until the owner approves them, the webhook rejects unsigned requests and unknown senders, and no personal data is ever committed to the repo.

## Quickstart

**Prerequisites**

- BudgetBakers Wallet **Premium**, and an API token from the Wallet web app → **Settings → REST API** (one per household; you paste it in the dashboard, not during setup)
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) 20 or newer, and git
- Optional: a Meta developer account for WhatsApp, a Cloudflare Turnstile widget for the signup page, and an [Anthropic API key](https://console.anthropic.com) per household for Claude Q&A

**Install and deploy**

```sh
git clone https://github.com/<you>/wallet-budget-companion.git
cd wallet-budget-companion
npm install
npx wrangler login     # once; opens the browser
npm run setup
```

`npm run setup` ([scripts/setup.mjs](scripts/setup.mjs)) runs these steps and is safe to re-run:

1. Checks Node and your Cloudflare login.
2. Creates the D1 database `wallet-budget-companion` and writes its id into `wrangler.jsonc`.
3. Applies the database migrations.
4. Asks for the secrets and stores them with `wrangler secret put`. The owner password (`DASHBOARD_PASSWORD`), a session key and an encryption key (both of which it can generate) are required. The WhatsApp and Turnstile secrets are optional, and you can add them later. It doesn't ask for a Wallet token or an Anthropic key: each household pastes its own in the dashboard.
5. Deploys the Worker and prints its `https://wallet-budget-companion.<your-subdomain>.workers.dev` URL.

Then open that URL and log in:

- **Household `guillaume`** with your `DASHBOARD_PASSWORD`. The first migration creates this one household (the project started as a single-family app), with no password yet. Its first login stores whatever password matches `DASHBOARD_PASSWORD` as its own, so do this once, right away. After that, either keep using it and give it its own password (owner console → **Reset password**), or create your real household with **Sign up** and suspend `guillaume` in the owner console.
- **`owner`** with your `DASHBOARD_PASSWORD` opens the **owner console** (see [Households and the owner console](#households-and-the-owner-console)). The owner has no budget data of its own.
- **Sign up** creates a new household and signs it in.

In a household, the **setup wizard** asks for its BudgetBakers token and tests it, asks for the timezone, base currency and budget-month start day, runs the historical backfill, and optionally sets up WhatsApp and the household's own Anthropic key.

> Right after you create a Wallet token, BudgetBakers runs an initial data sync and the API answers `409` for a few minutes. The wizard tells you when this happens. Wait and retry.

Flags: `npm run setup -- --yes` (non-interactive where possible; secrets can come from environment variables of the same name), `npm run setup -- --local` (local development only, see below), `npm run setup -- --help`.

## How it works

Everything runs in one Cloudflare Worker with one D1 (SQLite) database and a single hourly cron trigger (`0 * * * *`, UTC). Every household's rows live in the same tables, keyed by household:

```
BudgetBakers Wallet API ──hourly sync──▶ Worker ──▶ D1 (households, transactions, targets, settings, logs)
     (one token per household)             │
   Browser ◀── dashboard (static + /api) ──┤
   WhatsApp ◀─ daily brief / replies ──────┤◀── Meta webhook (/webhook), routed by sender number
   Anthropic Messages API ◀─ Q&A tools ────┘    (each household's own key)
```

Each hour, for every active household and in that household's timezone, the Worker syncs Wallet, sends the daily brief if it's that hour and today's brief hasn't gone out yet, and captures closing balances on the last day of a budget period. The cron only decides what is due. The work runs inline, one household after another, or as one queue message per household when the task queue is turned on (see [Scaling and the task queue](#scaling-and-the-task-queue)). Because all local-time decisions are made in code, it stays correct across daylight-saving changes. See **[docs/architecture.md](docs/architecture.md)** for the module map, data flow, tenancy model and design decisions.

## Configuration

### Secrets

Secrets are stored as Cloudflare Worker secrets (`npx wrangler secret put <NAME>`, or `npm run setup`). For local development they go in `.dev.vars` (see [`.dev.vars.example`](.dev.vars.example)). They never go into git or GitHub.

| Secret | Required | What it is |
| --- | --- | --- |
| `DASHBOARD_PASSWORD` | yes | Owner password: log in with the name `owner` for the owner console. On a fresh install it also opens household `guillaume` once (see [Quickstart](#quickstart)). |
| `SESSION_SECRET` | yes | Random key (32+ bytes) that signs the session cookie. Changing it signs everyone out. |
| `TOKEN_ENCRYPTION_KEY` | yes | Base64 of 32 random bytes (`openssl rand -base64 32`). AES-GCM key that encrypts each household's BudgetBakers token and Anthropic key in D1. Changing it makes the stored tokens unreadable, and every household must paste them again. |
| `TURNSTILE_SECRET` | recommended | Cloudflare Turnstile secret key for the signup page. Put the widget's site key in `wrangler.jsonc` → `vars` → `TURNSTILE_SITE_KEY`. Without it, signups still work, without a CAPTCHA. |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp | Permanent System User token with `whatsapp_business_messaging`. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | ID of the sending business phone number (not the number itself). Every household's brief is sent from this number. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp replies | Any random string. The same value goes into Meta's webhook "Verify token" field. |
| `META_APP_SECRET` | WhatsApp replies | Meta app secret, used to verify the `X-Hub-Signature-256` of every webhook call. |

The BudgetBakers token and the Anthropic key are **not** Worker secrets. Each household pastes its own in the dashboard (setup wizard, or **Settings → Connections**). They are stored encrypted and never shown again.

> **Upgrading a single-household deployment?** The old `WALLET_API_TOKEN` and `ANTHROPIC_API_KEY` secrets are still read, for household 1 only. On first use (or with **Adopt env secrets** in the owner console) they are encrypted into that household. Then delete them with `npx wrangler secret delete WALLET_API_TOKEN` and `npx wrangler secret delete ANTHROPIC_API_KEY`. See [docs/migrating-from-apps-script.md](docs/migrating-from-apps-script.md).

Three non-secret values live in `wrangler.jsonc` → `vars`: `WALLET_API_BASE_URL`, `WHATSAPP_API_VERSION` (Graph API version, currently `v26.0`) and `TURNSTILE_SITE_KEY` (public; empty means no CAPTCHA widget).

### Settings

Everything else is a **setting**, stored in D1 and edited in the dashboard (Settings page and setup wizard). You don't need to redeploy after changing one. Settings belong to a household, except the three marked *global*: those are shared by every household and only the owner can change them, in the owner console. The main ones are listed below (defaults from [`src/db/settings.ts`](src/db/settings.ts)):

| Setting | Default | Meaning |
| --- | --- | --- |
| `timezone` | `UTC` | IANA time zone, e.g. `America/New_York`. Decides "yesterday", brief/capture hours and local dates. |
| `base_currency` | `EUR` | Currency that every amount is converted to. After changing it, run an FX backfill with "re-convert all". |
| `budget_month_start_day` | `1` | Day the budget month starts (1–31). With `25`, a period runs from the 25th to the 24th. |
| `brief_hour_local` | `9` | Local hour (0–23) for the daily brief. |
| `brief_title` | `Family Budget Brief` | Heading of the text brief. |
| `capture_hour_local` | `22` | Local hour for the closing-balance capture on the last day of each period. |
| `whatsapp_enabled` | `0` | Master switch for the daily brief. |
| `whatsapp_to_numbers` | *(empty)* | Comma-separated E.164 numbers (`+<country><number>`). These receive the brief, and they are also the **only** numbers allowed to talk to the bot. A number can belong to one household only; replies are routed by it. |
| `wa_template_name` / `wa_template_lang` | *(empty)* / `en` | *Global.* The approved template of the shared sender, used outside the 24-hour window. |
| `signup_enabled` | `1` | *Global.* Whether the signup page accepts new households. |
| `dry_run` | `1` | When on, briefs and replies are logged instead of sent. Turn it off when you're happy with the preview. |
| `ai_enabled` / `ai_model` | `0` / `claude-sonnet-5` | Claude Q&A switch and model id. |
| `stale_seconds` | `300` | Inbound WhatsApp messages older than this are ignored instead of answered. |
| `sync_backfill_from` | `2020-01-01` | Start date for full syncs and FX backfills. |

## Households and the owner console

- **Signup.** Anyone who can open the site can create a household while `signup_enabled` is on. Set up Turnstile (`TURNSTILE_SECRET` plus the `TURNSTILE_SITE_KEY` var) so bots can't; signups without it are logged as a warning. To stop new signups altogether, turn off **Allow new households to sign up** in the owner console. Household names are 2–32 lower-case letters, digits, `-` or `_`; passwords need at least 8 characters.
- **Login.** A household logs in with its name and password, shared by everyone in it. When the owner resets the password, the household is signed out everywhere.
- **Owner console.** Log in with the name `owner` and `DASHBOARD_PASSWORD`. It lists every household with its data counts and last sync, and lets you approve or revoke WhatsApp, suspend or re-activate a household, reset its password, edit the global settings and read every household's logs. Keep `DASHBOARD_PASSWORD` different from any household's password (the Worker logs a warning when it matches household 1's).
- **WhatsApp approval.** All briefs go out from the owner's Meta number, which the owner pays for. A new household can set everything up, but its daily brief stays off until the owner approves it.
- **Bring your own keys.** Each household pastes its own BudgetBakers token and, for Claude Q&A, its own Anthropic key. Both are encrypted with AES-GCM under `TOKEN_ENCRYPTION_KEY` before they are stored in D1, and Anthropic usage is billed to the household's own key.
- **Suspended** households can't log in, aren't synced and get no briefs; their data is kept.

The households table leaves room for billing later; there is none today.

## WhatsApp setup

WhatsApp is optional. The dashboard and sync work with just a Wallet token. The owner sets up the sender once for the whole deployment:

1. Create a Meta developer app with the WhatsApp product and get a permanent System User token, the phone number ID and the app secret.
2. Point the app's webhook at `https://<your-worker>/webhook` (verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`) and subscribe to `messages`.
3. Submit the recommended daily template for approval, then enter its name and language in the owner console's global settings.

Then each household adds its recipients in Settings, previews the brief with `dry_run` on and turns `dry_run` off once the owner has approved it.

The full walkthrough, including the recommended template body, is in **[docs/whatsapp-setup.md](docs/whatsapp-setup.md)**.

## Scaling and the task queue

By default the hourly cron runs every household's tasks **inline**, one household after another, in a single invocation. That shares one invocation's limits (on the Workers Free plan, 50 subrequests including D1 queries, and 10 ms of CPU time), so it suits a handful of households.

With the task queue turned on, the cron only decides what is due and sends one [Cloudflare Queues](https://developers.cloudflare.com/queues/) message per household. Each household then runs in its own consumer invocation with its own limits, failures are retried, and messages that keep failing land in a dead-letter queue that is written to the run log. To turn it on:

```sh
npx wrangler queues create household-tasks
npx wrangler queues create household-tasks-dlq
# uncomment the "queues" block at the end of wrangler.jsonc, then:
npm run deploy
```

The comment in `wrangler.jsonc` treats Queues as a Workers Paid feature. Queues are included in the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/); Cloudflare's [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) now also lists a Free-plan allowance of 10,000 operations per day. A message usually costs 3 operations (write, read, delete), so each household uses about 72 a day. Commenting the block out again falls back to inline processing, with no other change.

## Custom domain

The Worker works on its `workers.dev` URL. To serve it from your own domain (which must be a zone on your Cloudflare account), no code change is needed:

1. In the Cloudflare dashboard, open **Workers & Pages** → your Worker → **Settings → Domains & Routes → Add → Custom Domain**, enter the host name (e.g. `budget.example.com`) and add it. Cloudflare creates the DNS record for you ([Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).
2. In the Meta App Dashboard, open **WhatsApp → Configuration**, change the **Callback URL** to `https://budget.example.com/webhook`, and verify and save again with the same verify token.
3. If you use Turnstile, add the new host name to the widget's hostnames.

Login cookies use the `__Host-` prefix, which ties them to the exact host they were set on. They keep working on the new domain, but everyone has to log in once there. Sessions on the `workers.dev` URL are separate.

## Local development

```sh
npm install
npm run setup -- --local   # creates .dev.vars (with generated SESSION_SECRET and TOKEN_ENCRYPTION_KEY) and applies migrations locally
# edit .dev.vars: at least DASHBOARD_PASSWORD
npm run dev                # wrangler dev → http://localhost:8787
```

Log in as household `guillaume` with `DASHBOARD_PASSWORD`, sign up a new household, or use `owner` for the owner console. Locally there is no queue binding, so the cron runs every household inline.

Useful commands (all defined in `package.json`):

| Command | Does |
| --- | --- |
| `npm run dev` | Local Worker + dashboard with a local D1 database (`wrangler dev`). |
| `npm test` | Unit and Workers-runtime integration tests (Vitest). |
| `npm run typecheck` | TypeScript check of the Worker and the tests. |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after changing bindings in `wrangler.jsonc`. |
| `npm run deploy` | `wrangler deploy` to Cloudflare. |

While `npm run dev` runs, you can fire the hourly cron with `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=0+*+*+*+*"`. Local migrations: `npx wrangler d1 migrations apply wallet-budget-companion --local`.

## Deploying from GitHub

Two GitHub Actions workflows are included:

- **CI** ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs on every push and pull request: `npm ci`, typecheck, tests and `wrangler deploy --dry-run`.
- **Deploy** ([.github/workflows/deploy.yml](.github/workflows/deploy.yml)) runs on every push to `main`: typecheck, tests, `d1 migrations apply --remote`, then `wrangler deploy`.

To turn on the deploy workflow, go to your repository's **Settings → Secrets and variables → Actions** and add:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | Your [Cloudflare account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/). |
| Secret | `CLOUDFLARE_API_TOKEN` | An API token created from the **Edit Cloudflare Workers** template, with the account permission **D1: Edit** added (needed for migrations). |

Also commit the `database_id` that `npm run setup` wrote into `wrangler.jsonc`. Forks and clones without the `CLOUDFLARE_ACCOUNT_ID` variable skip the deploy job, so CI stays green. App secrets (WhatsApp, passwords, keys) are **never** stored in GitHub. They stay in Cloudflare Worker secrets, and the households' BudgetBakers tokens and Anthropic keys stay encrypted in D1.

## Migrating from the Apps Script version

This project replaces an earlier Google Apps Script + Google Sheet proof of concept, kept for reference in [`legacy/`](legacy/). To move budgets and cash-flow history across and switch the WhatsApp webhook over safely, follow **[docs/migrating-from-apps-script.md](docs/migrating-from-apps-script.md)**.

## Rate limits and costs

- **Cloudflare**: the Workers Free plan covers a few households: 100,000 requests/day, 5 cron triggers per account (this uses 1), and D1 with 5 GB of storage, 5 million rows read and 100,000 rows written per day. Database writes are batched to stay within the Free plan's 50 queries per invocation. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/). For more households, turn on the [task queue](#scaling-and-the-task-queue).
- **BudgetBakers**: the Wallet API allows 300 requests/hour per token, and each household uses its own token. An hourly sync takes a handful of requests and is skipped after one request when nothing changed. A full backfill of several years takes a few dozen. The client honours `429 Retry-After`.
- **WhatsApp**: Meta charges per template message, with rates that depend on the template category and the recipient's country. Non-template (free-form) messages are free, and so are utility templates sent inside an open 24-hour window. Marketing templates are always charged. See [WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing). The brief is sent as free text whenever the window is open, so if the family replies `Budget` now and then, most briefs cost nothing. Only the days that fall back to the template are charged, and they are charged to the owner's WhatsApp Business Account whichever household the brief is for.
- **Anthropic** (optional): billed per token for each Claude question, to the asking household's own API key. Answers use at most 6 model calls. See [Anthropic pricing](https://www.anthropic.com/pricing).

## License

[MIT](LICENSE) © 2026 Guillaume de Swardt
