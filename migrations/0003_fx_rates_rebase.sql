-- Migration number: 0003 	 fx_rates keyed by base currency.
--
-- The FX cache is shared by all households; households with different base currencies need
-- different rates for the same (date, currency), so the base becomes part of the primary key
-- (copy-rename, see 0002). Existing rates were fetched for household 1's `base_currency` setting.

CREATE TABLE fx_rates_new (
	base_currency TEXT NOT NULL,
	date TEXT NOT NULL,
	currency TEXT NOT NULL,
	rate_to_base REAL NOT NULL, -- base_currency units per 1 unit of `currency`
	fetched_at TEXT NOT NULL,
	PRIMARY KEY (base_currency, date, currency)
) STRICT;

INSERT INTO fx_rates_new (base_currency, date, currency, rate_to_base, fetched_at)
SELECT
	coalesce((SELECT upper(value) FROM settings WHERE household_id = 1 AND key = 'base_currency'), 'EUR'),
	date, currency, rate_to_base, fetched_at
FROM fx_rates;
DROP TABLE fx_rates;
ALTER TABLE fx_rates_new RENAME TO fx_rates;
