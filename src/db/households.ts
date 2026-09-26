/**
 * Households (tenants) and their WhatsApp recipient numbers — both global tables, so these
 * functions take `db`, not a Tenant. Secrets are stored encrypted (src/lib/crypto.ts); `secretAad`
 * is the AAD that binds each ciphertext to its household row.
 */
import { HttpError } from '../api/http';
import { isoNow } from '../lib/tz';
import type { Flag } from './repo';

export type HouseholdStatus = 'active' | 'suspended';

export interface HouseholdRow {
	id: number;
	/** Lower-case login name (unique, case-insensitive). */
	name: string;
	/** 'pbkdf2$100000$<salt>$<hash>'; '' = adopt DASHBOARD_PASSWORD on first login (household 1). */
	passwordHash: string;
	status: HouseholdStatus;
	/** Owner approval for WhatsApp sends from the shared sender. */
	waApproved: Flag;
	/** encryptSecret() of the BudgetBakers Wallet API token (AAD secretAad('wallet-token', id)). */
	walletTokenEnc: string | null;
	/** encryptSecret() of the household's own Anthropic API key (AAD secretAad('anthropic-key', id)). */
	anthropicKeyEnc: string | null;
	createdAt: string;
	updatedAt: string;
}

export type HouseholdPatch = Partial<Omit<HouseholdRow, 'id' | 'createdAt' | 'updatedAt'>>;
export type HouseholdInsert = Pick<HouseholdRow, 'name' | 'passwordHash'> & HouseholdPatch;

export type SecretKind = 'wallet-token' | 'anthropic-key';

/** AAD for a household secret, e.g. 'wallet-token.v1.2'. */
export function secretAad(kind: SecretKind, hid: number): string {
	return `${kind}.v1.${hid}`;
}

/** Writable columns: [snake_case column, camelCase property] (everything except id and the timestamps). */
const WRITABLE_FIELDS = [
	['name', 'name'],
	['password_hash', 'passwordHash'],
	['status', 'status'],
	['wa_approved', 'waApproved'],
	['wallet_token_enc', 'walletTokenEnc'],
	['anthropic_key_enc', 'anthropicKeyEnc'],
] as const satisfies ReadonlyArray<readonly [string, keyof HouseholdPatch]>;

const HOUSEHOLD_FIELDS = [['id', 'id'], ...WRITABLE_FIELDS, ['created_at', 'createdAt'], ['updated_at', 'updatedAt']] as const;

const SELECT_HOUSEHOLD = `SELECT ${HOUSEHOLD_FIELDS.map(([column, property]) => (column === property ? column : `${column} AS ${property}`)).join(', ')} FROM households`;

export async function getHousehold(db: D1Database, id: number): Promise<HouseholdRow | null> {
	return db.prepare(`${SELECT_HOUSEHOLD} WHERE id = ?`).bind(id).first<HouseholdRow>();
}

/** Case-insensitive lookup by login name. */
export async function getHouseholdByName(db: D1Database, name: string): Promise<HouseholdRow | null> {
	return db.prepare(`${SELECT_HOUSEHOLD} WHERE name = ?`).bind(name.trim().toLowerCase()).first<HouseholdRow>();
}

export async function listHouseholds(db: D1Database): Promise<HouseholdRow[]> {
	const { results } = await db.prepare(`${SELECT_HOUSEHOLD} ORDER BY id`).all<HouseholdRow>();
	return results;
}

/** Inserts a household (name stored lower-case). Throws HttpError 409 NAME_TAKEN for a duplicate name. */
export async function createHousehold(db: D1Database, row: HouseholdInsert): Promise<HouseholdRow> {
	const values: HouseholdPatch = { status: 'active', waApproved: 0, ...row, name: row.name.trim().toLowerCase() };
	const fields = WRITABLE_FIELDS.filter(([, property]) => values[property] !== undefined);
	const now = isoNow();
	try {
		const created = await db
			.prepare(
				`INSERT INTO households (${fields.map(([column]) => column).join(', ')}, created_at, updated_at)
				 VALUES (${fields.map(() => '?').join(', ')}, ?, ?) RETURNING id`,
			)
			.bind(...fields.map(([, property]) => values[property] ?? null), now, now)
			.first<number>('id');
		return (await getHousehold(db, created!))!;
	} catch (error) {
		if (error instanceof Error && /UNIQUE constraint failed: households\.name/.test(error.message)) {
			throw new HttpError(409, `The household name "${values.name}" is already taken.`, 'NAME_TAKEN');
		}
		throw error;
	}
}

/** Applies `patch` (and bumps updated_at). Returns false when the household does not exist. */
export async function updateHousehold(db: D1Database, id: number, patch: HouseholdPatch): Promise<boolean> {
	const values: HouseholdPatch = patch.name === undefined ? patch : { ...patch, name: patch.name.trim().toLowerCase() };
	const fields = WRITABLE_FIELDS.filter(([, property]) => values[property] !== undefined);
	const result = await db
		.prepare(`UPDATE households SET ${fields.map(([column]) => `${column} = ?, `).join('')}updated_at = ? WHERE id = ?`)
		.bind(...fields.map(([, property]) => values[property] ?? null), isoNow(), id)
		.run();
	return result.meta.changes > 0;
}

// ---------------------------------------------------------------------------------------------
// WhatsApp recipients
// ---------------------------------------------------------------------------------------------

/**
 * Makes `e164s` (normalized E.164) the complete recipient list of household `hid`, atomically.
 * Throws HttpError 400 RECIPIENT_TAKEN (extra `{ number }`) when a number already belongs to
 * another household — inbound messages are routed by number, so it can only have one owner.
 */
export async function replaceRecipients(db: D1Database, hid: number, e164s: readonly string[]): Promise<void> {
	const numbers = JSON.stringify([...new Set(e164s)]);
	const taken = await db
		.prepare('SELECT e164 FROM household_recipients WHERE household_id <> ? AND e164 IN (SELECT value FROM json_each(?)) LIMIT 1')
		.bind(hid, numbers)
		.first<string>('e164');
	if (taken !== null) {
		throw new HttpError(400, `${taken} already receives the brief of another household.`, 'RECIPIENT_TAKEN', { number: taken });
	}
	// db.batch() runs as one transaction: a concurrent claim of the same number fails the PK and rolls back.
	await db.batch([
		db.prepare('DELETE FROM household_recipients WHERE household_id = ?').bind(hid),
		db.prepare('INSERT INTO household_recipients (e164, household_id) SELECT value, ? FROM json_each(?)').bind(hid, numbers),
	]);
}

export async function listRecipients(db: D1Database, hid: number): Promise<string[]> {
	const { results } = await db.prepare('SELECT e164 FROM household_recipients WHERE household_id = ? ORDER BY e164').bind(hid).all<{ e164: string }>();
	return results.map((row) => row.e164);
}

/** The household a WhatsApp number belongs to, or null for an unknown sender. */
export async function lookupRecipient(db: D1Database, e164: string): Promise<number | null> {
	return db.prepare('SELECT household_id FROM household_recipients WHERE e164 = ?').bind(e164).first<number>('household_id');
}
