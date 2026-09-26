/**
 * Household scoping. Every function that reads or writes household-owned data takes a `Tenant`
 * (database + household id) instead of a bare `D1Database`, so the signature shows the scope and
 * the SQL always filters on `household_id`. Genuinely global functions (FX cache, message
 * de-duplication, households) keep taking `db`.
 */

/** household_id of global settings rows (see GLOBAL_KEYS in ./settings). Never a real household. */
export const GLOBAL_HID = 0;

export interface Tenant {
	readonly db: D1Database;
	/** households.id, or GLOBAL_HID for global settings. */
	readonly hid: number;
}

export function tenant(db: D1Database, hid: number): Tenant {
	return { db, hid };
}
