# Architecture

Wallet Budget Companion is **one Cloudflare Worker**, **one D1 (SQLite) database** and **one hourly cron trigger**, serving any number of households. It has no build step for the dashboard and no external state; a Cloudflare Queue is optional. Modules are written pure-function-first, so the budget maths and the brief text can be unit-tested without Cloudflare.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entry point: `fetch` (routes `/health`, `/webhook`, `/api/*`, otherwise static assets), `scheduled` and `queue`. |
| `src/scheduled.ts` | Hourly cron, the queue **producer**: decides per household, in its timezone, which tasks are due, then enqueues them (or runs them inline without a queue). Also global housekeeping. |
| `src/tasks.ts` | Queue **consumer**: runs one household's sync, brief and capture; logs dead letters. |
| `src/wallet/` | `client.ts`: BudgetBakers REST client (bearer auth, pagination, `429`/`409` handling, change-rev header). `sync.ts`: upserts categories, accounts and records, then deletes vanished records within the window. `token.ts`: a household's encrypted BudgetBakers token and Anthropic key. |
| `src/budget/` | `engine.ts`: spend, forecast, baselines and rollups per category/group/overall (pure). `brief.ts`: the WhatsApp brief text and the template parameters (pure). |
| `src/whatsapp/` | `client.ts`: Cloud API text/template sends, 24-hour-window logic, dry run. `webhook.ts`: verification handshake, signature check, fast ACK, routing by sender number, dedup, `Budget` command, Claude hand-off. |
| `src/ai/` | `assistant.ts`: Anthropic Messages API client with a small tool-use loop over read-only D1 tools. |
| `src/api/` | Dashboard JSON API (`routes.ts`), household/owner login, signup and signed-cookie auth (`auth.ts`), owner console API (`owner.ts`), settings validation, CSV parsing and imports. |
| `src/cashflow/` | `capture.ts`: closing balance per included account at the end of a budget period. |
| `src/db/` | `tenant.ts`: the `Tenant` scope. `repo.ts`: typed, household-scoped D1 access with batched writes. `settings.ts`: two-level key/value settings and their defaults. `households.ts`: households and the recipient lookup table. |
| `src/lib/` | `period.ts` (budget-month maths), `tz.ts` (timezone/local dates), `fx.ts` (Frankfurter rates cached in D1), `crypto.ts` (PBKDF2 passwords, AES-GCM secrets), `format.ts` (money formatting, emoji, masking, template-param sanitising). |
| `public/` | Dashboard: plain HTML/JS/CSS served by Workers Static Assets. |
| `migrations/` | D1 schema. The only seed row is household 1 (`guillaume`, no password; see [Tenancy](#tenancy)), and personal data never goes in migrations. |
| `scripts/setup.mjs` | One-command onboarding (`npm run setup`). |
| `legacy/` | The original Google Apps Script proof of concept, kept for reference. |

## Data flow

### HTTP requests

```
request ─▶ Workers Static Assets ── matches a file in public/ ──▶ served directly (Worker not invoked)
              │  (/api/* and /webhook* always go to the Worker: assets.run_worker_first)
              ▼
           src/index.ts
              ├─ /health           → {"ok":true}
              ├─ GET  /webhook     → hub.challenge if hub.verify_token matches
              ├─ POST /webhook     → verify X-Hub-Signature-256 over raw bytes → 200 immediately
              │                       └─ ctx.waitUntil: status events → run_log
              │                                         messages → sender → household → dedup → window bookkeeping
              │                                                  → stale check → "Budget" | Claude | help → reply
              └─ /api/*            → same-origin check → session cookie → household (Tenant) → route handler → D1
```

### Hourly cron (`0 * * * *` UTC) and the task queue

The cron tick is the **producer**. It only reads D1: the active households and, in one query, the settings it gates on. Then it decides per household, in **that household's** `timezone`:

```
scheduledTime ─▶ for each active household: local date + hour in its timezone
   sync | full-sync          every tick; full-sync instead on Sunday at 03:00 local
   brief                     if hour ≥ brief_hour_local and brief_last_sent_date ≠ today
   capture                   if today is the period's last day and hour ≥ capture_hour_local
                             and capture_last_period_end ≠ this period
   ─▶ one message per household: {v: 1, householdId, tasks: [...], scheduledFor: <tick ISO time>}
      HOUSEHOLD_TASKS bound → sendBatch to the `household-tasks` queue (≤ 100 per call)
      no binding            → run each household inline, one after another
   housekeeping              at 04:00 UTC (global): prune run_log entries older than 90 days
```

The **consumer** (`src/tasks.ts`, also called directly for the inline run) handles one household at a time. It skips suspended households, re-reads the household's settings and runs, in order:

1. The Wallet sync (incremental or full).
2. The brief, if the guard is still unset.
3. The capture of the period ending today, if its guard is still unset.
4. After a sync, a catch-up capture of the previous period if it has no TOTAL row.

Each step has its own `try/catch` and logs to the household's run log, so a failing sync never blocks the brief (the brief reads only D1). Task errors don't fail the message: it is acked, and the next tick re-plans whatever is still due, the same hourly retry cadence as before.

Queues deliver **at least once**, so a message can arrive twice. That is safe because the consumer re-checks the guards (`brief_last_sent_date`, `capture_last_period_end`) against fresh settings, and a repeated sync only upserts. The tasks run "as of" `scheduledFor`, not the delivery time. Only a failure before any task runs (loading the household or its settings) throws: the queue retries the message (`max_retries: 3`) and then moves it to `household-tasks-dlq`, whose consumer writes an ERROR to the run log and acks.

The queue is **optional**. The `queues` block in `wrangler.jsonc` ships commented out. Without it `env.HOUSEHOLD_TASKS` is undefined and the producer runs every household inline in the cron invocation, which shares that one invocation's limits and suits a handful of households. With it, each household runs in its own consumer invocation (batches of up to 5, up to 4 concurrent consumers). See the README's [Scaling and the task queue](../README.md#scaling-and-the-task-queue).

## D1 tables

Every household-owned table has `household_id` as the first column of its primary key.

| Table | Holds |
| --- | --- |
| `households` | Name (login), PBKDF2 password hash, `active`/`suspended`, WhatsApp approval, encrypted BudgetBakers token and Anthropic key. |
| `household_recipients` | WhatsApp number (E.164) → household. A number belongs to one household at most. |
| `categories` | BudgetBakers categories with parent, group, full path and depth (synced). |
| `accounts` | BudgetBakers accounts with current balance, plus the user-controlled `include_in_cashflow` flag, which sync preserves. |
| `transactions` | BudgetBakers records: signed native `amount` + `currency`, converted `amount_base`, local `date`. |
| `budget_targets` | User-owned target, forecast type, period and report/expense flags per category or group. Sync auto-inserts defaults for new categories. |
| `cashflow_balances` | Closing balance per account and period, plus a TOTAL row, either `auto` (captured) or `import` (CSV). |
| `fx_rates` | Cached daily rates keyed by `(base_currency, date, currency)`: base-currency units per 1 unit of a foreign currency. Shared by all households. |
| `message_log` | WhatsApp audit trail and inbound dedup (`wa_message_id` UNIQUE across households). Phone numbers are masked. Nullable `household_id` (NULL for unknown senders). |
| `run_log` | Operational log: syncs, sends, errors. Nullable `household_id` (NULL for system entries such as the cron producer). |
| `settings` | Key/value settings per household (`household_id` 0 = global) plus runtime state (guards, change rev, per-number window timestamps). |

## Tenancy

One deployment serves many households on the same Worker, database and WhatsApp sender.

**Households.** The `households` table holds one row per BudgetBakers account: a unique, case-insensitive login name, the password hash, the status (`active` or `suspended`) and `wa_approved`. Migration `0002` moved the existing single-household data into household 1 (`guillaume`), with an empty password hash. The first login to that household with the `DASHBOARD_PASSWORD` value stores it as the household's own hash ("adoption"). Fresh installs start with the same empty household 1.

**Tenant context.** Every function that touches household data takes a `Tenant` (`{ db, hid }`, `src/db/tenant.ts`) instead of a bare `D1Database`, and its SQL filters on `household_id`. The signature shows the scope, and a missing filter is easy to grep for. Truly global functions (the FX cache, message dedup, the households table) keep taking `db`. The API gets the tenant from the session; the webhook from the sender's number; the queue consumer from the message.

**Composite keys.** BudgetBakers' built-in category and group ids are **identical across accounts**. With the old single-column keys, two households would overwrite each other's categories, budget targets and transactions. So `categories`, `accounts`, `transactions`, `budget_targets`, `cashflow_balances` and `settings` all have `household_id` first in their primary key, their indexes are household-first, and the sync's "delete records Wallet no longer returns" is scoped to the household in both its `SELECT` and its `DELETE`.

**Two-level settings.** Reads merge defaults ← global rows (`household_id = 0`) ← the household's rows, in one query. The global keys (`GLOBAL_KEYS`: `wa_template_name`, `wa_template_lang`, `signup_enabled`) describe the shared sender and the site, so only the owner changes them (`/api/owner/settings`), and `PUT /api/settings` rejects them with `GLOBAL_KEY`. Everything else, including `ai_model`, is per household.

**Encrypted per-household secrets.** A household's BudgetBakers token and Anthropic key are stored in `households.wallet_token_enc` / `anthropic_key_enc`. They are encrypted with AES-GCM-256 under the `TOKEN_ENCRYPTION_KEY` Worker secret (base64 of 32 bytes) with a random 12-byte IV, stored as `v1.<iv>.<ciphertext>`. The additional authenticated data is `wallet-token.v1.<hid>` or `anthropic-key.v1.<hid>`, which binds the ciphertext to its row and column: a value copied to another household or column fails to decrypt. The API only writes them (`POST /api/wallet-token`, `POST /api/ai-key`) and never returns them. For the upgrade from the single-household version, household 1 falls back to the old `WALLET_API_TOKEN` / `ANTHROPIC_API_KEY` secrets when its column is empty, encrypts them into the row on first use and logs it. After that the Worker secrets can be deleted.

**Inbound WhatsApp routing.** All households share one sender number, so the webhook finds the household by the **sender's** number in `household_recipients`. That table is rewritten from `whatsapp_to_numbers` on every settings save, and a number another household already has is rejected (`RECIPIENT_TAKEN`). Unknown numbers and suspended households are logged as `IGNORED_SENDER` and never answered.

**WhatsApp approval and FX.** A household's daily brief is skipped (`not_approved`) until the owner sets `wa_approved`, because sends cost the owner money and use the owner's number. The FX cache stays shared, keyed by base currency, so changing one household's base currency clears nothing.

**Limits of a single database.** All households share one D1 database, which is capped at 10 GB on Workers Paid and 500 MB on Free ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). That is far more than a family budget needs. If it ever fills up, sharding households across databases would be the next step.

## Key design decisions

**Signed native amounts plus a converted base column.** `transactions.amount` stores the value exactly as Wallet returns it, signed (expenses negative) and in its own currency. `amount_base` holds the same value converted to `base_currency` at that day's rate. The Wallet API has no converted-amount field, so conversion is done here, using [Frankfurter](https://frankfurter.dev) rates cached in `fx_rates`. Keeping the native value means a base-currency change or a late-arriving rate can be fixed by re-converting (**Settings → FX backfill → Re-convert all**) without re-downloading anything. Rows without a rate keep `amount_base = NULL` and are counted and shown as missing, not silently treated as 0.

**Group budgets: manual first, sum as fallback.** A category group (the POC's `TYPE` row) takes its budget from its own `budget_targets` row when that budget is set, and otherwise from the sum of the budgets of its categories counted in expenses. A manual group budget is forecast like a category (recurring: the budget; day-to-day: group spend extrapolated over the period). Without one, the forecast is the sum of all child forecasts. Spent and baselines are always the factual sums of the included categories, and the overall line sums the effective group values. This lets you budget a group as a whole without splitting the amount across its categories. In the dashboard, an empty group budget shows the category sum as a placeholder.

**Always send an explicit `recordDate` filter.** Without a date filter, `GET /v1/api/records` silently applies a default window of about three months. Every records request therefore passes `recordDate=gte.<date>`:
- The incremental window is the last 125 days, which covers the current period plus the three baseline periods.
- A full sync starts from `sync_backfill_from`.
- The filter date is one day earlier than the window, because date-only filters mean 00:00 UTC while local dates can be ahead of UTC.

After a complete fetch, local rows dated inside the window that Wallet no longer returns are deleted. This is how edits and deletions made in Wallet propagate. If pagination stops early, the delete is skipped. The weekly full re-sync catches changes older than the window.

**Change-rev skip.** Wallet returns an `X-Last-Data-Change-Rev` header. Each hourly sync first makes one cheap request, and if the revision equals the stored `wallet_last_change_rev`, it stops there. On a quiet day the hourly sync costs one API request. The stored revision is the *earliest* one seen during a sync, so a change that lands mid-sync triggers another sync next hour.

**One hourly UTC cron, local-time gating in code.** Cron schedules are UTC and don't know about daylight saving. Instead of a `0 9 * * *` trigger that drifts by an hour twice a year, the Worker ticks every hour and compares the local hour in each household's `timezone` setting.
- Guards in `settings` (`brief_last_sent_date`, `capture_last_period_end`) make each daily/monthly job idempotent under cron retries, replays and queue re-deliveries.
- The dispatcher uses the tick's `scheduledTime`, and queued tasks run as of that time, so a delayed run still dispatches for the hour it was meant for.
- The brief condition is `hour ≥ brief_hour_local` rather than `==`. This covers the skipped hour on DST days and allows **retries**:
  - If building the brief throws, or *every* recipient's send fails, the guard stays unset and the next tick retries.
  - If at least one recipient got it, the guard is set, so nobody is sent a duplicate.
  - A skip (WhatsApp disabled, no recipients) also sets the guard.

**Fail-closed webhook.**
- Every POST must carry a valid `X-Hub-Signature-256`: an HMAC-SHA256 of the **raw request bytes** with `META_APP_SECRET`, checked with WebCrypto's constant-time `verify`. The body is never re-serialised first, because Meta signs the exact payload bytes.
- Without the secret, every POST is rejected.
- Only numbers that are some active household's recipient (`household_recipients`, filled from `whatsapp_to_numbers`) get answers, and an empty list allows nobody.
- The Worker ACKs `200` immediately and processes in `ctx.waitUntil()`. Meta retries slow or failed deliveries for days, so inbound message IDs are de-duplicated with an atomic `INSERT` on a UNIQUE column, and messages older than `stale_seconds` are ignored.

**24-hour window vs template.** WhatsApp allows free-form messages only within 24 hours of the user's last message. Each inbound message records `wa_window_last_inbound:<number>` in settings. At brief time, a recipient whose window is open (with a 30-minute margin: 23.5 h) gets the full text brief, and everyone else gets the approved template with named parameters. Template parameters can't contain line breaks, so each expense line is its own parameter, and unused slots are padded with `–` because empty parameters are rejected. See [whatsapp-setup.md](whatsapp-setup.md).

**Claude tool loop inside the `waitUntil` budget.** Q&A uses the plain Messages API over `fetch` (no SDK dependency) with a manual tool-use loop:
- Tools: `query_transactions`, `get_budget_summary`, `get_cashflow_history`, `list_categories`, all read-only D1.
- At most 6 model calls, and tool results are capped in size.
- Workers cancels `waitUntil()` work 30 seconds after the response is sent, so the whole loop has a **22-second wall-clock budget**. That leaves time to send a coded error reply (`ERR_AI_TIMEOUT`, …) instead of going silent.
- Replies are trimmed to about 3,500 characters for WhatsApp.

**Free-tier query budgeting.** The Workers Free plan allows 50 D1 queries per invocation, and every statement inside `db.batch()` counts. Without the queue, the cron runs every household in that one invocation, which is why inline processing suits only a few households. Bulk writes (transactions, categories, targets, settings) are therefore sent as a few `INSERT … SELECT … FROM json_each(?)` statements with a JSON array parameter, instead of one statement per row. FX conversion looks up one rate per distinct (currency, date), not per transaction.

**Settings vs secrets.** Deployment-wide credentials are Worker secrets (`wrangler secret put`), never in D1, git or GitHub: the WhatsApp token and IDs, Meta app secret, owner password, session key, token encryption key and Turnstile secret. Per-household credentials (the BudgetBakers token and the Anthropic key) are pasted in the dashboard and stored in D1 encrypted, never in plain text (see [Tenancy](#tenancy)). Everything a user may want to change without redeploying is a setting in D1, edited and validated through the dashboard: timezone, base currency, budget start day, hours, recipients, feature flags and dry run (and, for the owner, the template and the signup switch). Runtime state that must survive between invocations lives in the same table (guards, change rev, window timestamps). The only non-secret deploy-time values are `WALLET_API_BASE_URL`, `WHATSAPP_API_VERSION` and `TURNSTILE_SITE_KEY` in `wrangler.jsonc`.

**Dashboard auth.**
- A household logs in with `{household, password}`. Passwords are stored as PBKDF2-SHA256 hashes (100,000 iterations, random 16-byte salt) and compared in constant time. The login name `owner` checks `DASHBOARD_PASSWORD` instead and opens only the owner console (`/api/owner/*`); the owner gets `403` on household-data routes, and households get `403` on owner routes.
- A successful login sets a stateless cookie `__Host-session=<hid>.<expiresMs>.<mac>` (HttpOnly, Secure, SameSite=Lax, 30 days). The MAC is an HMAC-SHA256 with `SESSION_SECRET` over `session.v2.<hid>.<expiresMs>.<fingerprint>`, where the fingerprint is the SHA-256 of the household's stored password hash (for the owner, of `DASHBOARD_PASSWORD`). A password reset therefore signs that household out, and rotating `SESSION_SECRET` signs everyone out. Cookies from the single-household version don't parse, so users log in once more after the upgrade.
- Every request re-reads the household, so suspending one takes effect immediately (`403 SUSPENDED`).
- Signup (`POST /api/auth/signup`) only works while the global `signup_enabled` is on. It checks a Cloudflare Turnstile token server-side when `TURNSTILE_SECRET` is set, and creates the household with WhatsApp not approved.
- A failed login waits 400 ms before answering. To limit guessing further, add a [WAF rate limiting rule](https://developers.cloudflare.com/waf/rate-limiting-rules/) on the path `/api/auth/` (the Free plan includes one rule, counted per IP over 10 seconds). WAF rules belong to a zone, so this needs a custom domain.
- State-changing API calls must be same-origin.
- If you want more, put the dashboard behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). Exclude `/webhook`, which Meta must be able to reach.
