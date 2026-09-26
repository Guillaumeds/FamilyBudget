# Architecture

Wallet Budget Companion is **one Cloudflare Worker**, **one D1 (SQLite) database** and **one hourly cron trigger**. It has no build step for the dashboard, no queue and no external state. Modules are written pure-function-first, so the budget maths and the brief text can be unit-tested without Cloudflare.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Worker entry point: `fetch` (routes `/health`, `/webhook`, `/api/*`, otherwise static assets) and `scheduled`. |
| `src/scheduled.ts` | Hourly cron dispatcher: sync, daily brief, cash-flow capture and housekeeping, all gated on local time. |
| `src/wallet/` | `client.ts`: BudgetBakers REST client (bearer auth, pagination, `429`/`409` handling, change-rev header). `sync.ts`: upserts categories, accounts and records, then deletes vanished records within the window. |
| `src/budget/` | `engine.ts`: spend, forecast, baselines and rollups per category/group/overall (pure). `brief.ts`: the WhatsApp brief text and the template parameters (pure). |
| `src/whatsapp/` | `client.ts`: Cloud API text/template sends, 24-hour-window logic, dry run. `webhook.ts`: verification handshake, signature check, fast ACK, dedup, allowlist, `Budget` command, Claude hand-off. |
| `src/ai/` | `assistant.ts`: Anthropic Messages API client with a small tool-use loop over read-only D1 tools. |
| `src/api/` | Dashboard JSON API (`routes.ts`), password + signed-cookie auth (`auth.ts`), settings validation, CSV parsing and imports. |
| `src/cashflow/` | `capture.ts`: closing balance per included account at the end of a budget period. |
| `src/db/` | `repo.ts`: typed D1 access with batched writes. `settings.ts`: key/value settings and their defaults. |
| `src/lib/` | `period.ts` (budget-month maths), `tz.ts` (timezone/local dates), `fx.ts` (Frankfurter rates cached in D1), `format.ts` (money formatting, emoji, masking, template-param sanitising). |
| `public/` | Dashboard: plain HTML/JS/CSS served by Workers Static Assets. |
| `migrations/` | D1 schema. It contains no seed data, and personal data never goes in migrations. |
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
              │                                         messages → allowlist → dedup → window bookkeeping
              │                                                  → stale check → "Budget" | Claude | help → reply
              └─ /api/*            → same-origin check → session cookie → route handler → D1
```

### Hourly cron (`0 * * * *` UTC)

```
scheduledTime ─▶ read settings, compute local date + hour in `timezone`
   1. Wallet sync            incremental every hour (skipped if the change rev is unchanged)
                             full re-sync on Sunday at 03:00 local
   2. Daily brief            if hour ≥ brief_hour_local and brief_last_sent_date ≠ today
   3. Cash-flow capture      if today is the period's last day and hour ≥ capture_hour_local
                             and capture_last_period_end ≠ this period;
                             plus a catch-up capture of the previous period if it has no TOTAL row
   4. Housekeeping           at 04:00 local, prune run_log entries older than 90 days
```

Each step has its own `try/catch`, so a failing sync never blocks the brief (the brief reads only D1).

## D1 tables

| Table | Holds |
| --- | --- |
| `categories` | BudgetBakers categories with parent, group, full path and depth (synced). |
| `accounts` | BudgetBakers accounts with current balance, plus the user-controlled `include_in_cashflow` flag, which sync preserves. |
| `transactions` | BudgetBakers records: signed native `amount` + `currency`, converted `amount_base`, local `date`. |
| `budget_targets` | User-owned target, forecast type, period and report/expense flags per category or group. Sync auto-inserts defaults for new categories. |
| `cashflow_balances` | Closing balance per account and period, plus a TOTAL row, either `auto` (captured) or `import` (CSV). |
| `fx_rates` | Cached daily rates: base-currency units per 1 unit of a foreign currency. |
| `message_log` | WhatsApp audit trail and inbound dedup (`wa_message_id` UNIQUE). Phone numbers are masked. |
| `run_log` | Operational log: syncs, sends, errors. |
| `settings` | Key/value settings plus runtime state (guards, change rev, per-number window timestamps). |

## Key design decisions

**Signed native amounts plus a converted base column.** `transactions.amount` stores the value exactly as Wallet returns it, signed (expenses negative) and in its own currency. `amount_base` holds the same value converted to `base_currency` at that day's rate. The Wallet API has no converted-amount field, so conversion is done here, using [Frankfurter](https://frankfurter.dev) rates cached in `fx_rates`. Keeping the native value means a base-currency change or a late-arriving rate can be fixed by re-converting (**Settings → FX backfill → Re-convert all**) without re-downloading anything. Rows without a rate keep `amount_base = NULL` and are counted and shown as missing, not silently treated as 0.

**Always send an explicit `recordDate` filter.** Without a date filter, `GET /v1/api/records` silently applies a default window of about three months. Every records request therefore passes `recordDate=gte.<date>`:
- The incremental window is the last 125 days, which covers the current period plus the three baseline periods.
- A full sync starts from `sync_backfill_from`.
- The filter date is one day earlier than the window, because date-only filters mean 00:00 UTC while local dates can be ahead of UTC.

After a complete fetch, local rows dated inside the window that Wallet no longer returns are deleted. This is how edits and deletions made in Wallet propagate. If pagination stops early, the delete is skipped. The weekly full re-sync catches changes older than the window.

**Change-rev skip.** Wallet returns an `X-Last-Data-Change-Rev` header. Each hourly sync first makes one cheap request, and if the revision equals the stored `wallet_last_change_rev`, it stops there. On a quiet day the hourly sync costs one API request. The stored revision is the *earliest* one seen during a sync, so a change that lands mid-sync triggers another sync next hour.

**One hourly UTC cron, local-time gating in code.** Cron schedules are UTC and don't know about daylight saving. Instead of a `0 9 * * *` trigger that drifts by an hour twice a year, the Worker ticks every hour and compares the local hour in the `timezone` setting.
- Guards in `settings` (`brief_last_sent_date`, `capture_last_period_end`) make each daily/monthly job idempotent under cron retries and replays.
- The dispatcher uses the tick's `scheduledTime`, so a delayed run still dispatches for the hour it was meant for.
- The brief condition is `hour ≥ brief_hour_local` rather than `==`. This covers the skipped hour on DST days and allows **retries**:
  - If building the brief throws, or *every* recipient's send fails, the guard stays unset and the next tick retries.
  - If at least one recipient got it, the guard is set, so nobody is sent a duplicate.
  - A skip (WhatsApp disabled, no recipients) also sets the guard.

**Fail-closed webhook.**
- Every POST must carry a valid `X-Hub-Signature-256`: an HMAC-SHA256 of the **raw request bytes** with `META_APP_SECRET`, checked with WebCrypto's constant-time `verify`. The body is never re-serialised first, because Meta signs the exact payload bytes.
- Without the secret, every POST is rejected.
- Only numbers in `whatsapp_to_numbers` get answers, and an empty list allows nobody.
- The Worker ACKs `200` immediately and processes in `ctx.waitUntil()`. Meta retries slow or failed deliveries for days, so inbound message IDs are de-duplicated with an atomic `INSERT` on a UNIQUE column, and messages older than `stale_seconds` are ignored.

**24-hour window vs template.** WhatsApp allows free-form messages only within 24 hours of the user's last message. Each inbound message records `wa_window_last_inbound:<number>` in settings. At brief time, a recipient whose window is open (with a 30-minute margin: 23.5 h) gets the full text brief, and everyone else gets the approved template with named parameters. Template parameters can't contain line breaks, so each expense line is its own parameter, and unused slots are padded with `–` because empty parameters are rejected. See [whatsapp-setup.md](whatsapp-setup.md).

**Claude tool loop inside the `waitUntil` budget.** Q&A uses the plain Messages API over `fetch` (no SDK dependency) with a manual tool-use loop:
- Tools: `query_transactions`, `get_budget_summary`, `get_cashflow_history`, `list_categories`, all read-only D1.
- At most 6 model calls, and tool results are capped in size.
- Workers cancels `waitUntil()` work 30 seconds after the response is sent, so the whole loop has a **22-second wall-clock budget**. That leaves time to send a coded error reply (`ERR_AI_TIMEOUT`, …) instead of going silent.
- Replies are trimmed to about 3,500 characters for WhatsApp.

**Free-tier query budgeting.** The Workers Free plan allows 50 D1 queries per invocation, and every statement inside `db.batch()` counts. Bulk writes (transactions, categories, targets, settings) are therefore sent as a few `INSERT … SELECT … FROM json_each(?)` statements with a JSON array parameter, instead of one statement per row. FX conversion looks up one rate per distinct (currency, date), not per transaction.

**Settings vs secrets.** Credentials are Worker secrets (`wrangler secret put`), never in D1, git or GitHub: the Wallet token, WhatsApp token and IDs, Meta app secret, Anthropic key, dashboard password and session key. Everything a user may want to change without redeploying is a setting in D1, edited and validated through the dashboard: timezone, base currency, budget start day, hours, recipients, template name, feature flags and dry run. Runtime state that must survive between invocations lives in the same table (guards, change rev, window timestamps). The only non-secret deploy-time values are `WALLET_API_BASE_URL` and `WHATSAPP_API_VERSION` in `wrangler.jsonc`.

**Dashboard auth.**
- One shared password (`DASHBOARD_PASSWORD`) is exchanged for a stateless `__Host-` cookie, HMAC-signed with `SESSION_SECRET` (HttpOnly, Secure, SameSite=Lax, 30 days).
- The signature also covers a fingerprint of the password, so changing the password signs everyone out.
- State-changing API calls must be same-origin.
- If you want more, put the dashboard behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/). Exclude `/webhook`, which Meta must be able to reach.
