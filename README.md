# Wallet Budget Companion

**Budgets, a web dashboard and a daily WhatsApp brief for [BudgetBakers Wallet](https://budgetbakers.com), running free on Cloudflare Workers.**

BudgetBakers Wallet is good at bank sync and automatic categorisation, but it has no real budget tracking: you can't set a monthly target per category, see a forecast for the month or get a daily summary. Wallet Budget Companion is a small plugin that does that part. It reads your Wallet data through the official [Wallet REST API](https://rest.budgetbakers.com/wallet/reference), keeps a copy in a Cloudflare D1 database, and adds:

- a budget table with a target, spend, remaining amount and forecast for every category and group,
- a **daily WhatsApp brief** with yesterday's expenses and where the month stands,
- optional **Claude Q&A**: ask "how much did we spend on restaurants this month?" on WhatsApp.

BudgetBakers is still where you manage categories and fix transactions. New or renamed categories show up in the companion after the next hourly sync.

<!-- Screenshot placeholder: dashboard budget table + a WhatsApp daily brief, e.g. docs/img/dashboard.png and docs/img/brief.png -->

> Not affiliated with BudgetBakers. You need a **BudgetBakers Wallet Premium** plan, because the REST API requires it.

## Features

- **Hourly sync** of categories, accounts and records from Wallet, plus a full re-sync every Sunday at 03:00 local time that catches old edits and deletions.
- **Budget table** with inline-editable targets on categories, sub-categories and groups (a group without its own target sums its categories), forecast types (day-to-day or recurring) and include flags. It shows 3-period baselines and group/overall rollups, and supports a **custom budget month** (for example the 25th to the 24th, to match your payday).
- **Daily WhatsApp brief** at the hour you choose. If the recipient messaged the bot in the last 24 hours, they get the full brief as free-form text. Otherwise the bot sends your **approved message template**, as WhatsApp's rules require (see [docs/whatsapp-setup.md](docs/whatsapp-setup.md)).
- **"Budget" command**: reply `Budget` on WhatsApp at any time to get the full brief. Replying also reopens the 24-hour window.
- **Claude Q&A** (optional): free-text questions are answered by Claude, which uses read-only tools over your synced data.
- **Web dashboard** with a first-run setup wizard, budget, transactions, cash-flow and brief-preview views, settings and logs.
- **CSV imports** for budget targets (a simple format, or the old Apps Script sheet export) and for cash-flow closing-balance history.
- **Cash-flow tracking**: closing balances per account are captured automatically at the end of every budget period.
- **Multi-currency**: amounts are stored in their original currency and converted to your base currency with daily reference rates from [Frankfurter](https://frankfurter.dev) (ECB and other central banks, no API key).
- **Safe by default**: `dry_run` is on until you turn it off, the webhook rejects unsigned requests and unknown senders, and no personal data is ever committed to the repo.

## Quickstart

**Prerequisites**

- BudgetBakers Wallet **Premium**, and an API token from the Wallet web app → **Settings → REST API**
- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org) 20 or newer, and git
- Optional: a Meta developer account for WhatsApp, and an [Anthropic API key](https://console.anthropic.com) for Claude Q&A

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
4. Asks for the secrets and stores them with `wrangler secret put`. The Wallet token, a dashboard password and a session key (which it can generate) are required. The WhatsApp and Anthropic secrets are optional, and you can add them later.
5. Deploys the Worker and prints its `https://wallet-budget-companion.<your-subdomain>.workers.dev` URL.

Then open that URL and log in. The **setup wizard** tests the Wallet connection, asks for your timezone, base currency and budget-month start day, runs the historical backfill, and optionally sets up WhatsApp.

> Right after you create a Wallet token, BudgetBakers runs an initial data sync and the API answers `409` for a few minutes. The wizard tells you when this happens. Wait and retry.

Flags: `npm run setup -- --yes` (non-interactive where possible; secrets can come from environment variables of the same name), `npm run setup -- --local` (local development only, see below), `npm run setup -- --help`.

## How it works

Everything runs in one Cloudflare Worker with one D1 (SQLite) database and a single hourly cron trigger (`0 * * * *`, UTC):

```
BudgetBakers Wallet API ──hourly sync──▶ Worker ──▶ D1 (transactions, targets, settings, logs)
                                           │
   Browser ◀── dashboard (static + /api) ──┤
   WhatsApp ◀─ daily brief / replies ──────┤◀── Meta webhook (/webhook)
   Anthropic Messages API ◀─ Q&A tools ────┘
```

Each hour the Worker syncs Wallet, sends the daily brief if it's that hour in your timezone and today's brief hasn't gone out yet, and captures closing balances on the last day of a budget period. Because all local-time decisions are made in code, it stays correct across daylight-saving changes. See **[docs/architecture.md](docs/architecture.md)** for the module map, data flow and design decisions.

## Configuration

### Secrets

Secrets are stored as Cloudflare Worker secrets (`npx wrangler secret put <NAME>`, or `npm run setup`). For local development they go in `.dev.vars` (see [`.dev.vars.example`](.dev.vars.example)). They never go into git or GitHub.

| Secret | Required | What it is |
| --- | --- | --- |
| `WALLET_API_TOKEN` | yes | BudgetBakers Wallet REST API token (Wallet web app → Settings → REST API, Premium). |
| `DASHBOARD_PASSWORD` | yes | Password for the dashboard login form. |
| `SESSION_SECRET` | yes | Random key (32+ bytes) that signs the session cookie. Changing it signs everyone out. |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp | Permanent System User token with `whatsapp_business_messaging`. |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp | ID of the sending business phone number (not the number itself). |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | WhatsApp replies | Any random string. The same value goes into Meta's webhook "Verify token" field. |
| `META_APP_SECRET` | WhatsApp replies | Meta app secret, used to verify the `X-Hub-Signature-256` of every webhook call. |
| `ANTHROPIC_API_KEY` | Q&A | Anthropic API key for the optional Claude answers. |

Two non-secret values live in `wrangler.jsonc` → `vars`: `WALLET_API_BASE_URL` and `WHATSAPP_API_VERSION` (Graph API version, currently `v26.0`).

### Settings

Everything else is a **setting**, stored in D1 and edited in the dashboard (Settings page and setup wizard). You don't need to redeploy after changing one. The main ones are listed below (defaults from [`src/db/settings.ts`](src/db/settings.ts)):

| Setting | Default | Meaning |
| --- | --- | --- |
| `timezone` | `UTC` | IANA time zone, e.g. `America/New_York`. Decides "yesterday", brief/capture hours and local dates. |
| `base_currency` | `EUR` | Currency that every amount is converted to. Changing it clears the FX cache; then run an FX backfill with "re-convert all". |
| `budget_month_start_day` | `1` | Day the budget month starts (1–31). With `25`, a period runs from the 25th to the 24th. |
| `brief_hour_local` | `9` | Local hour (0–23) for the daily brief. |
| `brief_title` | `Family Budget Brief` | Heading of the text brief. |
| `capture_hour_local` | `22` | Local hour for the closing-balance capture on the last day of each period. |
| `whatsapp_enabled` | `0` | Master switch for the daily brief. |
| `whatsapp_to_numbers` | *(empty)* | Comma-separated E.164 numbers (`+<country><number>`). These receive the brief, and they are also the **only** numbers allowed to talk to the bot. |
| `wa_template_name` / `wa_template_lang` | *(empty)* / `en` | Your approved template, used outside the 24-hour window. |
| `dry_run` | `1` | When on, briefs and replies are logged instead of sent. Turn it off when you're happy with the preview. |
| `ai_enabled` / `ai_model` | `0` / `claude-sonnet-5` | Claude Q&A switch and model id. |
| `stale_seconds` | `300` | Inbound WhatsApp messages older than this are ignored instead of answered. |
| `sync_backfill_from` | `2020-01-01` | Start date for full syncs and FX backfills. |

## WhatsApp setup

WhatsApp is optional. The dashboard and sync work with just a Wallet token. To get the daily brief:

1. Create a Meta developer app with the WhatsApp product and get a permanent System User token, the phone number ID and the app secret.
2. Point the app's webhook at `https://<your-worker>/webhook` (verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`) and subscribe to `messages`.
3. Submit the recommended daily template for approval, then enter its name and language in Settings.
4. Add the recipients in Settings, preview the brief with `dry_run` on, then turn `dry_run` off.

The full walkthrough, including the recommended template body, is in **[docs/whatsapp-setup.md](docs/whatsapp-setup.md)**.

## Local development

```sh
npm install
npm run setup -- --local   # creates .dev.vars (with a generated SESSION_SECRET) and applies migrations locally
# edit .dev.vars: at least WALLET_API_TOKEN and DASHBOARD_PASSWORD
npm run dev                # wrangler dev → http://localhost:8787
```

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

Also commit the `database_id` that `npm run setup` wrote into `wrangler.jsonc`. Forks and clones without the `CLOUDFLARE_ACCOUNT_ID` variable skip the deploy job, so CI stays green. App secrets (Wallet, WhatsApp, Anthropic) are **never** stored in GitHub. They stay in Cloudflare Worker secrets.

## Migrating from the Apps Script version

This project replaces an earlier Google Apps Script + Google Sheet proof of concept, kept for reference in [`legacy/`](legacy/). To move budgets and cash-flow history across and switch the WhatsApp webhook over safely, follow **[docs/migrating-from-apps-script.md](docs/migrating-from-apps-script.md)**.

## Rate limits and costs

- **Cloudflare**: the Workers Free plan covers a household: 100,000 requests/day, 5 cron triggers per account (this uses 1), and D1 with 5 GB of storage, 5 million rows read and 100,000 rows written per day. Database writes are batched to stay within the Free plan's 50 queries per invocation. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).
- **BudgetBakers**: the Wallet API allows 300 requests/hour. An hourly sync takes a handful of requests and is skipped after one request when nothing changed. A full backfill of several years takes a few dozen. The client honours `429 Retry-After`.
- **WhatsApp**: Meta charges per template message, with rates that depend on the template category and the recipient's country. Non-template (free-form) messages are free, and so are utility templates sent inside an open 24-hour window. Marketing templates are always charged. See [WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing). The brief is sent as free text whenever the window is open, so if the family replies `Budget` now and then, most briefs cost nothing. Only the days that fall back to the template are charged.
- **Anthropic** (optional): billed per token for each Claude question. Answers use at most 6 model calls. See [Anthropic pricing](https://www.anthropic.com/pricing).

## License

[MIT](LICENSE) © 2026 Guillaume de Swardt
