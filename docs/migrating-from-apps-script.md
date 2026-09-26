# Migrating from the Apps Script version

Before this Worker existed, the project was a Google Apps Script bound to a Google Sheet (kept in [`legacy/`](../legacy/)). The script synced Wallet into the Sheet, calculated budgets with sheet formulas, sent the 9 am WhatsApp brief and answered WhatsApp through an Apps Script web app webhook.

This guide moves an existing installation over without losing budget targets or cash-flow history. For a while both systems run side by side, and the Worker stays in dry-run mode until you trust its numbers.

Nothing personal needs to be committed anywhere. Targets and history travel as CSV files that you upload to your own deployment.

## Overview

1. Deploy the Worker and complete the setup wizard.
2. Backfill FX rates and run a full sync.
3. Check transaction counts against the Sheet.
4. Import budget targets from the Sheet's **Budget** tab.
5. Import cash-flow history.
6. Compare a dry-run brief with the Sheet's brief.
7. Point the Meta webhook at the Worker.
8. Disable the Apps Script triggers and archive its web app deployment.
9. Run both side by side across one budget-period boundary, then archive the Sheet.

## 1. Deploy and run the wizard

Follow the [Quickstart](../README.md#quickstart): `npm install`, `npm run setup`, then open the Worker URL and log in as household **`guillaume`** with your `DASHBOARD_PASSWORD`. That first login makes it the household's password. Your family's data will live in this household.

- You can reuse the secrets the old script used (its Script Properties). The WhatsApp token and phone number ID go into `npm run setup`. The Wallet token is pasted in the wizard's first step instead.
- The old script also used a webhook verify token. You can reuse it as `WHATSAPP_WEBHOOK_VERIFY_TOKEN` or create a new one. You'll re-enter it in Meta in step 7 anyway.
- The old Claude agent/vault properties (`CLAUDE_AGENT_ID`, `CLAUDE_ENV_ID`, …) are **not** needed. The Worker calls the Messages API directly with an Anthropic API key that you paste in the wizard (or later in **Settings → Connections**).
- Household `guillaume` is approved for WhatsApp from the start. Households that sign up later need the owner's approval.

In the wizard, match the old configuration:

| Old Sheet / script | New setting |
| --- | --- |
| Script timezone | `timezone` (e.g. `America/New_York`) |
| Currency used for the …EUR columns | `base_currency` |
| Budget month start (the day periods begin) | `budget_month_start_day` |
| Daily summary hour | `brief_hour_local` |
| Cash-flow capture hour | `capture_hour_local` |
| First year of transactions in the Sheet | `sync_backfill_from` (**History starts on**) |

**Keep `dry_run` on and `whatsapp_enabled` off for now.** The old script is still the one sending messages.

When the household works, give the owner its own password: set `DASHBOARD_PASSWORD` to a new value that is **different** from the household's password (`npx wrangler secret put DASHBOARD_PASSWORD`). The household keeps the password it adopted, and the new value only opens the owner console (login name `owner`). The Worker logs a warning while the two are the same.

### Upgrading a single-household Worker

If you already ran an earlier, single-household version of this Worker, deploying the current version (`npm run setup`, or the GitHub deploy workflow) applies migrations `0002` and `0003`, which move all your data into household 1, `guillaume`. Take a backup first: `npx wrangler d1 export wallet-budget-companion --remote --output backup.sql`. Then:

1. Add the new secrets before deploying: `npx wrangler secret put TOKEN_ENCRYPTION_KEY` (base64 of 32 random bytes, e.g. `openssl rand -base64 32`; `npm run setup` can generate it) and optionally `TURNSTILE_SECRET` (see the README's [secrets table](../README.md#secrets)).
2. Log in again (the old session cookies are no longer valid) as household `guillaume` with your existing `DASHBOARD_PASSWORD`. That password becomes the household's password.
3. Your `WALLET_API_TOKEN` and `ANTHROPIC_API_KEY` Worker secrets are encrypted into household 1 the first time they are used (the Wallet token at the next hourly sync, the Anthropic key at the next Claude question), or right away with **Adopt env secrets** in the owner console. Check that the owner console's household list shows the Wallet and AI keys as stored for `guillaume` (the household's **Settings → Connections** already says "configured" while the key is only in the Worker secret, so it doesn't prove the adoption), or look for the "Adopted the … Worker secret" entry in the household's logs. Then delete them:

   ```sh
   npx wrangler secret delete WALLET_API_TOKEN
   npx wrangler secret delete ANTHROPIC_API_KEY
   ```

4. Rotate `DASHBOARD_PASSWORD` to a distinct, owner-only value, as described above.

## 2. FX backfill and full sync

In **Settings**:

1. **Run full sync**. This imports every Wallet record since `sync_backfill_from`. If the Wallet token is brand new, BudgetBakers may answer "initial sync in progress" for a few minutes; wait and retry.
2. **Run FX backfill**. This fetches exchange rates for every foreign currency in your records and converts any rows that are still missing a base amount.

The dashboard shows a warning for any transactions still missing an FX rate.

## 3. Verify against the Sheet

Compare the Worker with the Sheet's **Transactions** tab:

- **Record counts** for a few months. The dashboard's **Transactions** page shows the count and the expense/income totals for any date range. Filter the Sheet's `Month` column the same way.
- **Totals** per period. Small differences in the …EUR columns are expected wherever the old script used a different exchange-rate source.

If counts differ, check `sync_backfill_from` first. Then run another full sync: Wallet edits made after the Sheet's last refresh are only in the Worker.

## 4. Import budget targets

Export the Sheet's **Budget** tab (the one with the formula-driven budget table) as CSV. In Google Sheets, open the tab, then **File → Download → Comma-separated values (.csv)**, which exports the current sheet only.

Then open **Settings → Import CSV** in the dashboard and upload it as *budget targets*. The Worker also accepts it directly:

```sh
# log in once (stores the session cookie), then upload
curl -c cookies.txt -H "Content-Type: application/json" \
  -d '{"household":"guillaume","password":"<your household password>"}' https://<your-worker>/api/auth/login
curl -b cookies.txt -H "Content-Type: text/csv" --data-binary @budget.csv \
  https://<your-worker>/api/admin/import/budgets
```

The importer recognises two formats from the header row.

### Legacy format (the old Budget tab)

It is detected by the `RowType` and `Category` headers. These columns are used; header matching ignores case and a trailing `?`:

| Column | Used for |
| --- | --- |
| `RowType` | `CATEGORY` rows become category targets and `TYPE` rows become category-group targets. `OVERALL` and blank rows are skipped, because the overall line is always a rollup. |
| `CategoryId`, `Path`, `Category` | The category match, tried in that order: BudgetBakers id, then full path (`Parent > Child`), then name. `TYPE` rows match a group name. |
| `BudgetEUR` (any `Budget` + up to 3 letters, e.g. `BudgetUSD`) | The target. A blank cell means "no target". On a `TYPE` row a value becomes the group's own budget, which replaces the sum of its categories. Leave it blank to keep the automatic sum. |
| `Forecast Type` | `Day-to-day` or `Recurring`. |
| `Include in Report?` | `TRUE`/`FALSE`: show this line in the WhatsApp brief. |
| `Include in Expense Calculations` | `TRUE`/`FALSE`: count this line in the group and overall totals. |
| `Period` | Optional, e.g. `monthly`. |

All the computed columns (spent, remaining, forecast, baselines, …) are ignored, because the Worker computes them itself.

### Simple format (for everyone else)

```csv
entity_type,name_or_path,budget,forecast_type,include_in_report,include_in_expense
category,Food & Drinks > Groceries,600,day_to_day,true,true
category,Housing > Rent,1500,recurring,false,true
group,Transportation,250,day_to_day,true,true
```

- `entity_type` is `category` or `group`.
- `name_or_path` is a category's full path, its name, or its BudgetBakers id. For groups, it's the group name.
- `forecast_type` accepts `day_to_day` or `recurring`.
- Flags accept `true`/`false`, `1`/`0` or `yes`/`no`.
- A `period` column is optional.

### Import behaviour (both formats)

- A blank cell keeps the stored value, except `budget`, where blank means "no target".
- Categories must already exist (from the sync). Unmatched or invalid rows are listed in the result and the rest are imported.
- Amounts like `1,234.50`, `€ 80` or `80,5` are accepted.
- Semicolon-separated files (European Excel) are detected automatically.
- Re-importing is safe, because rows are upserted.

Afterwards, check the **Budget** page and fine-tune there.

## 5. Import cash-flow history

The old Sheet stored closing balances per budget period in the **CashFlowPeriodBalances** tab. Some installs also hard-coded earlier balances in the script itself. The Worker's cash-flow import expects this format:

```csv
period_start,period_end,account_name,currency,closing_balance,closing_balance_base,notes
2026-01-25,2026-02-24,Current account,EUR,2150.00,,
2026-01-25,2026-02-24,Savings (USD),USD,1000.00,925.40,converted by hand
2026-02-25,2026-03-24,Current account,EUR,1980.35,,
```

Rules:

- Required columns are `period_start`, `period_end`, `account_name`, `currency` and `closing_balance`. `closing_balance_base` and `notes` are optional.
- Dates must be `yyyy-mm-dd`, and `period_end` is the last day of the period, inclusive.
- `currency` is a 3-letter code.
- If `closing_balance_base` is blank, it is converted from `closing_balance` at the rate on `period_end`. If the currency already is the base currency, the balance is copied as is.
- Import **account rows only**. The Worker computes each period's TOTAL row itself, as the sum of the imported accounts. It leaves the total alone if an automatic capture already exists for that period.
- If any row is invalid, nothing is imported, and the response lists the bad lines.

To convert the old tab:

1. Download **CashFlowPeriodBalances** as CSV.
2. Delete the rows whose `RowType` is `TOTAL`.
3. Rename the headers:
   - `PeriodStart` → `period_start`
   - `PeriodEnd` → `period_end`
   - `Account` → `account_name`
   - `Currency` → `currency`
   - `ClosingBalance` → `closing_balance`
   - `ClosingBalanceEUR` (your base-currency column) → `closing_balance_base`
   - `Notes` → `notes`
4. Delete the other columns, or leave them; unknown columns are ignored.
5. Make sure the dates are `yyyy-mm-dd`. Sheets may export them in your locale's format; if so, set the column's format to *Format → Number → Custom date and time* (`yyyy-mm-dd`) before downloading.

Upload the file through **Settings → Import CSV** as *cash-flow history*, or with `curl` as above against `/api/admin/import/cashflow`. Then check the **Cash flow** page.

Future periods are captured automatically on the last day of each period at `capture_hour_local`. If a capture is missed, the next hourly tick catches it up.

## 6. Dry-run brief comparison

With `dry_run` still on:

1. Open the dashboard's **Brief** page. It renders exactly the text and template parameters that would be sent today.
2. Compare it with the brief the old script sent this morning: yesterday's expenses, overall spent/remaining/forecast, and the per-category lines you marked *Include in Report*.
3. Differences usually come from targets or flags that differ, from FX, or from records edited in Wallet after the Sheet's last refresh.
4. Optionally set up WhatsApp now (recipients in Settings; the template name and language in the owner console; see [whatsapp-setup.md](whatsapp-setup.md)), turn on `whatsapp_enabled` and press **Send brief now**. With dry run on, this only writes to **Settings → Logs**.

## 7. Point the Meta webhook at the Worker

A Meta app has **one** webhook callback URL. Switching it moves inbound messages (`Budget`, questions) from Apps Script to the Worker.

1. Make sure `WHATSAPP_WEBHOOK_VERIFY_TOKEN` and `META_APP_SECRET` are set on the Worker. Unlike the old web app, the Worker **rejects unsigned webhook calls**, so the app secret is required.
2. In the App Dashboard, open **WhatsApp → Configuration**. Set the **Callback URL** to `https://<your-worker>/webhook`, enter the verify token and verify.
3. Keep the **`messages`** field subscribed.
4. Send `Budget` from a recipient's phone. With dry run on, the reply appears in **Settings → Logs**.

## 8. Retire the Apps Script

Once the webhook points at the Worker:

1. **Turn off the Worker's dry run** (`dry_run` = off) and make sure `whatsapp_enabled` is on. From now on the Worker sends the daily brief.
2. **Delete the Apps Script triggers** so the old script stops sending its own brief and syncing: go to [script.google.com](https://script.google.com) → **My Triggers**, or open the project → **Triggers**. For each trigger (hourly sync, daily summary, monthly capture), click **⋮ → Delete trigger**.
3. **Archive the web app deployment** so the old webhook URL stops responding: open the project → **Deploy → Manage deployments** → select the web app → **Archive deployment** ([Google docs](https://developers.google.com/apps-script/concepts/deployments)).
4. Remove the secrets from the old script's **Project Settings → Script Properties**. If you no longer need the old Anthropic agent setup, revoke its keys in the Anthropic console.

Steps 1 and 2 should happen together, so the family doesn't get two briefs, or none.

## 9. Side-by-side run, then archive the Sheet

Keep the Sheet (read-only) until the Worker has crossed **one budget-period boundary**:

- On the last day of the period, after `capture_hour_local`, a new automatic row should appear on the **Cash flow** page. Compare it with the balances in BudgetBakers.
- On the first day of the new period, the brief should switch to the new period. The **Budget** page's previous-period view (and the baseline columns) should match the Sheet's final numbers for the closed period.

When they match, archive the Sheet: make it read-only or move it to an archive folder. You can then delete the Apps Script project, or keep it for reference; its code is also preserved in [`legacy/`](../legacy/).
