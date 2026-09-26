-- Migration number: 0002 	 Multi-household tenancy.
--
-- Every household-owned table gains a `household_id` as the first primary-key column: BudgetBakers
-- built-in category/group ids are identical across accounts, so without it two households would
-- overwrite each other's rows. SQLite cannot change a primary key in place, so each table is
-- rebuilt with the copy-rename recipe (CREATE <t>_new → INSERT ... SELECT → DROP → RENAME,
-- https://www.sqlite.org/lang_altertable.html#otheralter); all existing rows become household 1.
--
-- household_id 0 is reserved for global settings (see GLOBAL_KEYS in src/db/settings.ts). There are
-- no foreign keys, matching the rest of the schema.

-- Households: one BudgetBakers account, one shared dashboard password each.
CREATE TABLE households (
	id INTEGER PRIMARY KEY, -- rowid alias
	name TEXT NOT NULL COLLATE NOCASE UNIQUE, -- stored lower-case; login name
	password_hash TEXT NOT NULL DEFAULT '', -- 'pbkdf2$100000$<saltB64>$<hashB64>'; '' = adopt DASHBOARD_PASSWORD on first login
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
	wa_approved INTEGER NOT NULL DEFAULT 0 CHECK (wa_approved IN (0, 1)), -- owner approval for WhatsApp sends
	wallet_token_enc TEXT, -- AES-GCM 'v1.<iv>.<ct>' under TOKEN_ENCRYPTION_KEY (src/lib/crypto.ts)
	anthropic_key_enc TEXT, -- same format; bring-your-own Anthropic API key
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- WhatsApp recipients → household (inbound routing). A number belongs to at most one household.
CREATE TABLE household_recipients (
	e164 TEXT PRIMARY KEY,
	household_id INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_household_recipients_household ON household_recipients (household_id);

-- The existing single-household data becomes household 1. Its password is adopted from the
-- DASHBOARD_PASSWORD secret on first login (empty hash = adoption sentinel).
INSERT INTO households (id, name, password_hash, status, wa_approved) VALUES (1, 'guillaume', '', 'active', 1);

-- categories: PK (household_id, id)
CREATE TABLE categories_new (
	household_id INTEGER NOT NULL,
	id TEXT NOT NULL,
	parent_id TEXT,
	name TEXT NOT NULL,
	group_id TEXT,
	group_name TEXT,
	full_path TEXT,
	level INTEGER NOT NULL DEFAULT 0,
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (household_id, id)
) STRICT;

INSERT INTO categories_new (household_id, id, parent_id, name, group_id, group_name, full_path, level, archived, updated_at)
SELECT 1, id, parent_id, name, group_id, group_name, full_path, level, archived, updated_at FROM categories;
DROP TABLE categories;
ALTER TABLE categories_new RENAME TO categories;

-- accounts: PK (household_id, id)
CREATE TABLE accounts_new (
	household_id INTEGER NOT NULL,
	id TEXT NOT NULL,
	name TEXT NOT NULL,
	account_type TEXT,
	currency TEXT,
	balance REAL,
	exclude_from_stats INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_stats IN (0, 1)),
	include_in_cashflow INTEGER NOT NULL DEFAULT 1 CHECK (include_in_cashflow IN (0, 1)),
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	updated_at TEXT NOT NULL,
	PRIMARY KEY (household_id, id)
) STRICT;

INSERT INTO accounts_new (household_id, id, name, account_type, currency, balance, exclude_from_stats, include_in_cashflow, archived, updated_at)
SELECT 1, id, name, account_type, currency, balance, exclude_from_stats, include_in_cashflow, archived, updated_at FROM accounts;
DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;

-- transactions: PK (household_id, id); indexes household-first
CREATE TABLE transactions_new (
	household_id INTEGER NOT NULL,
	id TEXT NOT NULL,
	record_date TEXT NOT NULL, -- ISO instant as returned by Wallet
	date TEXT NOT NULL, -- local yyyy-mm-dd in the `timezone` setting
	account_id TEXT,
	account_name TEXT,
	category_id TEXT,
	record_type TEXT, -- 'expense' | 'income'
	payment_type TEXT,
	record_state TEXT,
	amount REAL NOT NULL, -- signed, native currency
	currency TEXT NOT NULL,
	amount_base REAL, -- signed, converted to base currency; NULL when no FX rate was available
	note TEXT,
	synced_at TEXT NOT NULL,
	PRIMARY KEY (household_id, id)
) STRICT;

INSERT INTO transactions_new (
	household_id, id, record_date, date, account_id, account_name, category_id, record_type, payment_type, record_state,
	amount, currency, amount_base, note, synced_at
)
SELECT
	1, id, record_date, date, account_id, account_name, category_id, record_type, payment_type, record_state,
	amount, currency, amount_base, note, synced_at
FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;

CREATE INDEX idx_transactions_date ON transactions (household_id, date);
CREATE INDEX idx_transactions_category ON transactions (household_id, category_id);
CREATE INDEX idx_transactions_account ON transactions (household_id, account_id);

-- budget_targets: PK (household_id, entity_type, entity_id)
CREATE TABLE budget_targets_new (
	household_id INTEGER NOT NULL,
	entity_type TEXT NOT NULL CHECK (entity_type IN ('category', 'group')),
	entity_id TEXT NOT NULL,
	period TEXT NOT NULL DEFAULT 'monthly',
	forecast_type TEXT NOT NULL DEFAULT 'day_to_day' CHECK (forecast_type IN ('day_to_day', 'recurring')),
	budget REAL,
	include_in_report INTEGER NOT NULL DEFAULT 0 CHECK (include_in_report IN (0, 1)),
	include_in_expense INTEGER NOT NULL DEFAULT 1 CHECK (include_in_expense IN (0, 1)),
	PRIMARY KEY (household_id, entity_type, entity_id)
) STRICT;

INSERT INTO budget_targets_new (household_id, entity_type, entity_id, period, forecast_type, budget, include_in_report, include_in_expense)
SELECT 1, entity_type, entity_id, period, forecast_type, budget, include_in_report, include_in_expense FROM budget_targets;
DROP TABLE budget_targets;
ALTER TABLE budget_targets_new RENAME TO budget_targets;

-- cashflow_balances: PK (household_id, period_end, row_type, account_key)
CREATE TABLE cashflow_balances_new (
	household_id INTEGER NOT NULL,
	period_start TEXT NOT NULL,
	period_end TEXT NOT NULL, -- inclusive last day of the budget period
	row_type TEXT NOT NULL CHECK (row_type IN ('TOTAL', 'ACCOUNT')),
	account_key TEXT NOT NULL, -- account id, or a stable label for imported/TOTAL rows
	account_name TEXT,
	currency TEXT,
	closing_balance REAL NOT NULL,
	closing_balance_base REAL,
	captured_at TEXT NOT NULL,
	source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'import')),
	notes TEXT,
	PRIMARY KEY (household_id, period_end, row_type, account_key)
) STRICT;

INSERT INTO cashflow_balances_new (
	household_id, period_start, period_end, row_type, account_key, account_name, currency,
	closing_balance, closing_balance_base, captured_at, source, notes
)
SELECT
	1, period_start, period_end, row_type, account_key, account_name, currency,
	closing_balance, closing_balance_base, captured_at, source, notes
FROM cashflow_balances;
DROP TABLE cashflow_balances;
ALTER TABLE cashflow_balances_new RENAME TO cashflow_balances;

-- settings: PK (household_id, key); household_id 0 = global. All keys (incl. runtime guards such as
-- wallet_last_change_rev and brief_last_sent_date) move to household 1 ...
CREATE TABLE settings_new (
	household_id INTEGER NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (household_id, key)
) STRICT;

INSERT INTO settings_new (household_id, key, value) SELECT 1, key, value FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- ... except the WhatsApp template, which belongs to the shared sender and becomes global.
UPDATE settings SET household_id = 0 WHERE household_id = 1 AND key IN ('wa_template_name', 'wa_template_lang');

-- Household 1's recipients: split the comma-separated whatsapp_to_numbers setting (stored
-- normalized by the settings validator) into household_recipients.
INSERT OR IGNORE INTO household_recipients (e164, household_id)
WITH RECURSIVE split (item, rest) AS (
	SELECT '', (SELECT value FROM settings WHERE household_id = 1 AND key = 'whatsapp_to_numbers') || ','
	UNION ALL
	SELECT trim(substr(rest, 1, instr(rest, ',') - 1)), substr(rest, instr(rest, ',') + 1) FROM split WHERE rest <> ''
)
SELECT item, 1 FROM split WHERE item <> '';

-- Logs: nullable household_id (NULL = system / unknown sender). wa_message_id stays globally
-- UNIQUE (inbound de-duplication). Every existing row is household 1's.
ALTER TABLE message_log ADD COLUMN household_id INTEGER;
ALTER TABLE run_log ADD COLUMN household_id INTEGER;
UPDATE message_log SET household_id = 1;
UPDATE run_log SET household_id = 1;

CREATE INDEX idx_message_log_household ON message_log (household_id, id);
CREATE INDEX idx_run_log_household ON run_log (household_id, id);
