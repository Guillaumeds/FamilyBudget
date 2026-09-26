/**
 * Key/value settings stored in the `settings` table. Values are always strings; parse at the edge.
 *
 * Besides the keys in SETTING_DEFAULTS, runtime state lives here too and goes through the same
 * functions (no default — `getSetting` returns null until written):
 *   brief_last_sent_date, capture_last_period_end, wallet_last_change_rev,
 *   `wa_window_last_inbound:<E164>` (see `waWindowKey`).
 */

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
} as const satisfies Record<string, string>;

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** All default keys (always present) plus any runtime keys that have been stored. */
export type Settings = { [K in SettingKey]: string } & Record<string, string>;

/** Settings key holding the last inbound WhatsApp message time (ISO) for a sender, for the 24h window. */
export function waWindowKey(e164: string): string {
	return `wa_window_last_inbound:${e164}`;
}

/** Every setting, stored values overriding SETTING_DEFAULTS. */
export async function getSettings(db: D1Database): Promise<Settings> {
	const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
	const settings: Record<string, string> = { ...SETTING_DEFAULTS };
	for (const row of results) settings[row.key] = row.value;
	return settings as Settings;
}

/** One setting: the stored value, else its default; null for an unset key without a default. */
export async function getSetting(db: D1Database, key: SettingKey): Promise<string>;
export async function getSetting(db: D1Database, key: string): Promise<string | null>;
export async function getSetting(db: D1Database, key: string): Promise<string | null> {
	const value = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<string>('value');
	return value ?? (SETTING_DEFAULTS as Record<string, string>)[key] ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
	await db
		.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
		.bind(key, String(value))
		.run();
}

/** Upserts several settings in a single statement. */
export async function setSettings(db: D1Database, values: Record<string, string>): Promise<void> {
	const entries = Object.entries(values);
	if (entries.length === 0) return;
	const payload = JSON.stringify(Object.fromEntries(entries.map(([key, value]) => [key, String(value)])));
	await db
		.prepare(
			// json_each over an object yields one row per property (key, value). `WHERE true` is required
			// by SQLite to disambiguate INSERT ... SELECT ... ON CONFLICT.
			'INSERT INTO settings (key, value) SELECT key, value FROM json_each(?) WHERE true ON CONFLICT (key) DO UPDATE SET value = excluded.value',
		)
		.bind(payload)
		.run();
}
