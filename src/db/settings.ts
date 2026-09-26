/**
 * Key/value settings stored in the `settings` table. Values are always strings; parse at the edge.
 *
 * Two levels: rows with household_id = GLOBAL_HID (0) apply to every household (the shared WhatsApp
 * sender's template, signup switch — see GLOBAL_KEYS), rows with a household's id apply to that
 * household only. Reads merge SETTING_DEFAULTS ← global rows ← household rows in one query; writes go
 * to the tenant's own level (use `tenant(db, GLOBAL_HID)` to write global rows).
 *
 * Besides the keys in SETTING_DEFAULTS, runtime state lives here too and goes through the same
 * functions (no default — `getSetting` returns null until written):
 *   brief_last_sent_date, capture_last_period_end, wallet_last_change_rev,
 *   `wa_window_last_inbound:<E164>` (see `waWindowKey`).
 */
import { GLOBAL_HID, type Tenant } from './tenant';

export const SETTING_DEFAULTS = {
	timezone: 'UTC',
	base_currency: 'EUR',
	budget_month_start_day: '1',
	brief_title: 'Family Budget Brief',
	brief_hour_local: '9',
	capture_hour_local: '22',
	whatsapp_enabled: '0',
	whatsapp_to_numbers: '',
	wa_template_name: '',
	wa_template_lang: 'en',
	dry_run: '1',
	ai_enabled: '0',
	ai_model: 'claude-sonnet-5',
	stale_seconds: '300',
	sync_backfill_from: '2020-01-01',
	setup_complete: '0',
	signup_enabled: '1',
} as const satisfies Record<string, string>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** Keys owned by the deployment owner and stored at GLOBAL_HID; households cannot write them. */
export const GLOBAL_KEYS = ['wa_template_name', 'wa_template_lang', 'signup_enabled'] as const satisfies readonly SettingKey[];

/** All default keys (always present) plus any runtime keys that have been stored. */
export type Settings = { [K in SettingKey]: string } & Record<string, string>;

/** Settings key holding the last inbound WhatsApp message time (ISO) for a sender, for the 24h window. */
export function waWindowKey(e164: string): string {
	return `wa_window_last_inbound:${e164}`;
}

/** Every setting: SETTING_DEFAULTS ← global rows ← the tenant's rows. */
export async function getSettings(t: Tenant): Promise<Settings> {
	const { results } = await t.db
		// GLOBAL_HID (0) sorts before every household id, so household rows are applied last and win.
		.prepare('SELECT key, value FROM settings WHERE household_id IN (?, ?) ORDER BY household_id')
		.bind(GLOBAL_HID, t.hid)
		.all<{ key: string; value: string }>();
	const settings: Record<string, string> = { ...SETTING_DEFAULTS };
	for (const row of results) settings[row.key] = row.value;
	return settings as Settings;
}

/** One setting: the household value, else the global value, else its default; null for an unset key without a default. */
export async function getSetting(t: Tenant, key: SettingKey): Promise<string>;
export async function getSetting(t: Tenant, key: string): Promise<string | null>;
export async function getSetting(t: Tenant, key: string): Promise<string | null> {
	const value = await t.db
		.prepare('SELECT value FROM settings WHERE household_id IN (?, ?) AND key = ? ORDER BY household_id DESC LIMIT 1')
		.bind(GLOBAL_HID, t.hid, key)
		.first<string>('value');
	return value ?? (SETTING_DEFAULTS as Record<string, string>)[key] ?? null;
}

export async function setSetting(t: Tenant, key: string, value: string): Promise<void> {
	await t.db
		.prepare(
			'INSERT INTO settings (household_id, key, value) VALUES (?, ?, ?) ON CONFLICT (household_id, key) DO UPDATE SET value = excluded.value',
		)
		.bind(t.hid, key, String(value))
		.run();
}

/** Upserts several settings in a single statement. */
export async function setSettings(t: Tenant, values: Record<string, string>): Promise<void> {
	const entries = Object.entries(values);
	if (entries.length === 0) return;
	const payload = JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [key, String(value)])));
	await t.db
		.prepare(
			// json_each over an object yields one row per property (key, value). `WHERE true` is required
			// by SQLite to disambiguate INSERT ... SELECT ... ON CONFLICT.
			`INSERT INTO settings (household_id, key, value) SELECT ?, key, value FROM json_each(?) WHERE true
			 ON CONFLICT (household_id, key) DO UPDATE SET value = excluded.value`,
		)
		.bind(t.hid, payload)
		.run();
}
