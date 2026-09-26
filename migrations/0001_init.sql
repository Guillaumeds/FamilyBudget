-- Migration number: 0001 	 Initial schema — schema only, NO personal seed data.
--
-- Conventions
--   * Dates are TEXT: local calendar days as 'yyyy-mm-dd', instants as ISO-8601 UTC strings.
--   * Booleans are INTEGER 0/1.
--   * Money: `amount` is the signed native value (expenses negative) in `currency`;
--     `*_base` columns hold the same value converted to the `base_currency` setting (NULL when no FX rate).
--   * STRICT tables make SQLite reject values of the wrong type instead of silently storing them.

-- BudgetBakers categories (synced; BudgetBakers stays the place where categories are managed).
CREATE TABLE categories (
	id TEXT PRIMARY KEY,
	parent_id TEXT,
	name TEXT NOT NULL,
	group_id TEXT,
	group_name TEXT,
	full_path TEXT,
	level INTEGER NOT NULL DEFAULT 0,
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	updated_at TEXT NOT NULL
) STRICT;

-- BudgetBakers accounts (synced). include_in_cashflow is user-controlled and preserved by sync upserts.
CREATE TABLE accounts (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	account_type TEXT,
	currency TEXT,
	balance REAL,
	exclude_from_stats INTEGER NOT NULL DEFAULT 0 CHECK (exclude_from_stats IN (0, 1)),
	include_in_cashflow INTEGER NOT NULL DEFAULT 1 CHECK (include_in_cashflow IN (0, 1)),
	archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
	updated_at TEXT NOT NULL
) STRICT;

-- BudgetBakers records (synced).
CREATE TABLE transactions (
	id TEXT PRIMARY KEY,
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
	synced_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_transactions_date ON transactions (date);
CREATE INDEX idx_transactions_category ON transactions (category_id);
CREATE INDEX idx_transactions_account ON transactions (account_id);

-- User-owned budget configuration per category or category group (edited in the dashboard).
-- Sync auto-inserts default rows for new categories/groups so they show up immediately.
CREATE TABLE budget_targets (
	entity_type TEXT NOT NULL CHECK (entity_type IN ('category', 'group')),
	entity_id TEXT NOT NULL,
	period TEXT NOT NULL DEFAULT 'monthly',
	forecast_type TEXT NOT NULL DEFAULT 'day_to_day' CHECK (forecast_type IN ('day_to_day', 'recurring')),
	budget REAL,
	include_in_report INTEGER NOT NULL DEFAULT 0 CHECK (include_in_report IN (0, 1)),
	include_in_expense INTEGER NOT NULL DEFAULT 1 CHECK (include_in_expense IN (0, 1)),
	PRIMARY KEY (entity_type, entity_id)
) STRICT;

-- Closing balances per budget period (captured automatically at period end, or imported).
CREATE TABLE cashflow_balances (
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
	PRIMARY KEY (period_end, row_type, account_key)
) STRICT;

-- FX cache (frankfurter.dev). rate_to_base = base-currency units per 1 unit of `currency`.
CREATE TABLE fx_rates (
	date TEXT NOT NULL,
	currency TEXT NOT NULL,
	rate_to_base REAL NOT NULL,
	fetched_at TEXT NOT NULL,
	PRIMARY KEY (date, currency)
) STRICT;

-- WhatsApp message audit trail and inbound de-duplication.
CREATE TABLE message_log (
	id INTEGER PRIMARY KEY, -- rowid alias
	wa_message_id TEXT UNIQUE,
	direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
	from_number TEXT, -- masked, never the full number
	inbound_ts TEXT,
	body TEXT,
	status TEXT NOT NULL,
	error_code TEXT,
	error_message TEXT,
	outbound_message_id TEXT,
	outbound_at TEXT,
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Operational log (sync runs, sends, errors).
CREATE TABLE run_log (
	id INTEGER PRIMARY KEY, -- rowid alias
	ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	level TEXT NOT NULL,
	action TEXT NOT NULL,
	message TEXT NOT NULL
) STRICT;

-- Key/value settings (see src/db/settings.ts for keys and defaults).
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) STRICT;
