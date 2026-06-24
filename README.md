# Wallet Family Budget Tracker

Google Apps Script project for a shared BudgetBakers Wallet budget dashboard.

## Your configuration

- Email recipients: `guillaume.de.s@gmail.com`, `dorette.marais1@gmail.com`
- Spreadsheet name: `Family Budget Tracker`
- Timezone: `Europe/Dublin`
- Currency: `EUR`
- Wallet accounts: all included
- Foreign currency handling: uses Wallet reference/converted EUR amount where available
- Baseline months: May and June 2026
- Daily summary: 9am
- ntfy topic: `Family-Budget`

> Note: ntfy topics cannot contain spaces, so `Family Budget` was normalized to `Family-Budget`.

## Secure setup steps

1. Enable Apps Script API access:
   - Open https://script.google.com/home/usersettings
   - Turn on Apps Script API access.

2. Install/login to clasp for code push only:
   - Install Node.js if needed.
   - Install clasp globally: `npm install -g @google/clasp`
   - Run `clasp login` and complete the browser sign-in.
   - Do not use `clasp login --use-project-scopes --include-clasp-scopes` unless the Apps Script API executable, standard Cloud project, OAuth consent screen, and OAuth client are configured for the script scopes. Google can block broad or unverified OAuth requests.

3. Create the Apps Script project from this folder:
   - From this folder, run: `clasp create-script --title "Family Budget Tracker" --rootDir .`
   - Run: `clasp push`
   - Run: `clasp open-script`

4. Add script properties securely:
   - In Apps Script, open Project Settings.
    - Under Script Properties, click Edit script properties.
    - Add these properties from your local `.env` values. Do not commit or print the values:
       - `WALLET_API_TOKEN` <= `BBToken`
       - `WHATSAPP_ACCESS_TOKEN` <= `WAToken`
       - `WHATSAPP_PHONE_NUMBER_ID` <= `WAPhoneNumberID`
       - `CLAUDE_API_KEY` <= `ClaudeAPIKey`
       - `CLAUDE_AGENT_ID` <= `ClaudeAgentID`
       - `CLAUDE_ENV_ID` <= `ClaudeEnvID`
       - `CLAUDE_VAULT_IDS` <= `ClaudeVaultID`
       - `CLAUDE_VAULT_CREDENTIAL_ID` <= `ClaudeVaultCredentialID` if present
    - Save script properties.
    - Optional local validation without printing secrets: run `tools/set-script-properties.ps1`. It validates required `.env` keys and prints only the property names to enter.

5. Run setup:
   - In Apps Script editor, select `setup` and Run.
   - Accept Google authorization prompts.
   - The script creates a Google Sheet named `Family Budget Tracker` automatically and stores its ID in Script Properties as `SPREADSHEET_ID`.

## Official Google auth notes

- Apps Script detects required OAuth scopes from code, but explicit manifest scopes should be least-privilege.
- This project uses script properties for secrets. Google documents the official manual path as Apps Script editor > Project Settings > Script Properties.
- `clasp push` only uploads code. `clasp run` uses the Apps Script API `scripts.run` path, which officially requires an API executable deployment, a standard Cloud project shared by the script and caller, Apps Script API enabled, and an OAuth token covering all script scopes.
- If an OAuth app requests sensitive or restricted scopes and is not verified or not configured for testing/internal use, Google can show unverified warnings or block access. For this project, prefer the Apps Script editor for first authorization and script-property setup.

6. Inspect the real Wallet schema:
   - Select `runSchemaReview` and Run.
   - Open the generated Google Sheet and review the `SchemaReview` tab.
   - Confirm the `records.amount-diagnostics` rows select the Wallet reference/converted EUR amount field.

7. Run first refresh:
   - Select `runFullRefresh` and Run.
   - Review `Budgets`, `Summary`, and `Dashboard` tabs.

8. Phone notifications:
   - Install ntfy on both phones.
   - Subscribe both phones to topic `Family-Budget`.

## How reporting works

- `Categories` and `Budgets` include every Wallet category/subcategory.
- Reports use only rows where `Report` is `TRUE`.
- Initial budget values use average spend across May 2026 and June 2026.
- Initial `Report=TRUE` is assigned to the top baseline-spend categories; edit the `Report` column any time.

## Main functions

- `setup()` initializes sheets and triggers.
- `runSchemaReview()` samples Wallet categories, accounts, and records into `SchemaReview` so the real API shape can be verified.
- `runFullRefresh()` fetches Wallet data, computes budgets, updates summary, and builds dashboard.
- `runHourlySync()` keeps data fresh and sends threshold alerts.
- `runDailySummary()` sends the 9am email and ntfy summary.
