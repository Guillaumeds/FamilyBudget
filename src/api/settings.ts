/**
 * Validation for PUT /api/settings. Only household keys of SETTING_DEFAULTS are writable from the
 * dashboard: runtime state such as brief_last_sent_date is not, and GLOBAL_KEYS belong to the site
 * owner (validated in ./owner.ts). Each validator returns the normalised value to store or throws a
 * message shown next to the field.
 */
import { GLOBAL_KEYS, SETTING_DEFAULTS, type SettingKey } from '../db/settings';
import { isDateText } from './http';

type Validator = (value: string) => string;

/** Settings owned by the site owner (stored at GLOBAL_HID). */
export type GlobalSettingKey = (typeof GLOBAL_KEYS)[number];
/** Settings a household may write. */
export type HouseholdSettingKey = Exclude<SettingKey, GlobalSettingKey>;

export function isGlobalKey(key: string): key is GlobalSettingKey {
	return (GLOBAL_KEYS as readonly string[]).includes(key);
}

const FLAG_KEYS = new Set<SettingKey>(['whatsapp_enabled', 'dry_run', 'ai_enabled', 'setup_complete']);

function integer(min: number, max: number): Validator {
	return (value) => {
		if (!/^\d+$/.test(value)) throw new Error(`Enter a whole number between ${min} and ${max}.`);
		const number = Number(value);
		if (number < min || number > max) throw new Error(`Must be between ${min} and ${max}.`);
		return String(number);
	};
}

const flag: Validator = (value) => {
	if (value !== '0' && value !== '1') throw new Error("Must be '0' or '1'.");
	return value;
};

/** E.164: '+', country code not starting with 0, at most 15 digits in total. */
const E164 = /^\+[1-9]\d{6,14}$/;

const VALIDATORS: Record<HouseholdSettingKey, Validator> = {
	timezone: (value) => {
		if (!value) throw new Error('Enter an IANA time zone, e.g. Europe/Dublin.');
		try {
			// Throws RangeError for unknown zones; resolvedOptions() gives the canonical spelling.
			return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
		} catch {
			throw new Error(`Unknown time zone "${value}". Use an IANA name such as Europe/Dublin or America/New_York.`);
		}
	},
	base_currency: (value) => {
		const code = value.toUpperCase();
		if (!/^[A-Z]{3}$/.test(code)) throw new Error('Use a 3-letter ISO currency code, e.g. EUR.');
		return code;
	},
	budget_month_start_day: integer(1, 31),
	brief_title: (value) => {
		if (!value) throw new Error('The brief title cannot be empty.');
		if (/[\r\n]/.test(value)) throw new Error('The brief title must be a single line.');
		if (value.length > 60) throw new Error('Keep the brief title under 60 characters.');
		return value;
	},
	brief_hour_local: integer(0, 23),
	capture_hour_local: integer(0, 23),
	whatsapp_enabled: flag,
	whatsapp_to_numbers: (value) => {
		const numbers = value
			.split(/[,;\n]+/)
			.map((part) => part.replace(/[\s\-().]/g, ''))
			.filter(Boolean);
		const bad = numbers.filter((number) => !E164.test(number));
		if (bad.length > 0) throw new Error(`Not in international format (+<country code><number>): ${bad.join(', ')}`);
		return [...new Set(numbers)].join(',');
	},
	dry_run: flag,
	ai_enabled: flag,
	ai_model: (value) => {
		if (!/^[A-Za-z0-9._:@/-]{1,100}$/.test(value)) throw new Error('Enter a model id such as claude-sonnet-5.');
		return value;
	},
	stale_seconds: integer(60, 86_400),
	sync_backfill_from: (value) => {
		if (!isDateText(value)) throw new Error('Use a date in the form yyyy-mm-dd.');
		if (value < '2000-01-01') throw new Error('Pick a date on or after 2000-01-01.');
		return value;
	},
	setup_complete: flag,
};

export function isSettingKey(key: string): key is SettingKey {
	return Object.hasOwn(SETTING_DEFAULTS, key);
}

export function isHouseholdSettingKey(key: string): key is HouseholdSettingKey {
	return isSettingKey(key) && !isGlobalKey(key);
}

/**
 * Validates a `{ key: value }` patch. Values may be strings, finite numbers, or booleans (flags
 * only). Returns the normalised values and a per-key error map (empty when everything is valid).
 */
export function validateSettingsPatch(patch: Record<string, unknown>): {
	values: Partial<Record<HouseholdSettingKey, string>>;
	errors: Record<string, string>;
} {
	const values: Partial<Record<HouseholdSettingKey, string>> = {};
	const errors: Record<string, string> = {};
	for (const [key, raw] of Object.entries(patch)) {
		if (isGlobalKey(key)) {
			errors[key] = 'This setting is shared by every household and can only be changed by the site owner.';
			continue;
		}
		if (!isHouseholdSettingKey(key)) {
			errors[key] = 'Unknown setting.';
			continue;
		}
		let text: string;
		if (typeof raw === 'string') text = raw.trim();
		else if (typeof raw === 'number' && Number.isFinite(raw)) text = String(raw);
		else if (typeof raw === 'boolean' && FLAG_KEYS.has(key)) text = raw ? '1' : '0';
		else {
			errors[key] = 'Invalid value type.';
			continue;
		}
		try {
			values[key] = VALIDATORS[key](text);
		} catch (error) {
			errors[key] = error instanceof Error ? error.message : String(error);
		}
	}
	return { values, errors };
}
