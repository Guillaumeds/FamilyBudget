/**
 * Per-household secrets (BudgetBakers Wallet API token, the household's own Anthropic API key),
 * stored encrypted in `households` under the TOKEN_ENCRYPTION_KEY secret (src/lib/crypto.ts).
 *
 * Transition: before multi-household, both lived in Worker secrets (WALLET_API_TOKEN,
 * ANTHROPIC_API_KEY). For household 1 only, an empty column falls back to that env secret, which is
 * then encrypted into the row on first use (logged) — afterwards the env secret can be deleted.
 */
import { type HouseholdRow, type SecretKind, secretAad, updateHousehold } from '../db/households';
import { logRun } from '../db/repo';
import { tenant } from '../db/tenant';
import type { Env } from '../env';
import { CryptoError, decryptSecret, encryptSecret } from '../lib/crypto';

/** The only household that adopts the pre-multi-household env secrets. */
export const ENV_ADOPTION_HID = 1;

const ACTION = 'secrets';
const COLUMN = { 'wallet-token': 'walletTokenEnc', 'anthropic-key': 'anthropicKeyEnc' } as const satisfies Record<SecretKind, keyof HouseholdRow>;
const ENV_FALLBACK = { 'wallet-token': 'WALLET_API_TOKEN', 'anthropic-key': 'ANTHROPIC_API_KEY' } as const satisfies Record<SecretKind, keyof Env>;

function encrypt(env: Env, hid: number, kind: SecretKind, value: string): Promise<string> {
	return encryptSecret(value, env.TOKEN_ENCRYPTION_KEY, secretAad(kind, hid));
}

/**
 * The decrypted `kind` secret of `household`, or null when none is configured or it cannot be
 * decrypted (wrong/missing TOKEN_ENCRYPTION_KEY or tampered value — logged as ERROR). Household 1
 * adopts the matching env secret when its column is empty (encrypts and stores it, logs INFO).
 */
export async function getHouseholdSecret(env: Env, db: D1Database, household: HouseholdRow, kind: SecretKind): Promise<string | null> {
	const t = tenant(db, household.id);
	try {
		const stored = household[COLUMN[kind]];
		if (stored) return await decryptSecret(stored, env.TOKEN_ENCRYPTION_KEY, secretAad(kind, household.id));

		const envName = ENV_FALLBACK[kind];
		const fromEnv = household.id === ENV_ADOPTION_HID ? env[envName]?.trim() : undefined;
		if (!fromEnv) return null;
		await updateHousehold(db, household.id, { [COLUMN[kind]]: await encrypt(env, household.id, kind, fromEnv) });
		await logRun(t, 'INFO', ACTION, `Adopted the ${envName} Worker secret as this household's ${kind} (stored encrypted); it can now be deleted with wrangler secret delete ${envName}.`);
		return fromEnv;
	} catch (error) {
		if (!(error instanceof CryptoError)) throw error;
		await logRun(t, 'ERROR', ACTION, `Could not use the stored ${kind}: ${error.message}`);
		return null;
	}
}

/** Encrypts and stores `value` as household `hid`'s `kind` secret; an empty value clears it. */
export async function setHouseholdSecret(env: Env, db: D1Database, hid: number, kind: SecretKind, value: string): Promise<void> {
	const trimmed = value.trim();
	await updateHousehold(db, hid, { [COLUMN[kind]]: trimmed ? await encrypt(env, hid, kind, trimmed) : null });
}

export function getWalletToken(env: Env, db: D1Database, household: HouseholdRow): Promise<string | null> {
	return getHouseholdSecret(env, db, household, 'wallet-token');
}

export function setWalletToken(env: Env, db: D1Database, hid: number, token: string): Promise<void> {
	return setHouseholdSecret(env, db, hid, 'wallet-token', token);
}

export function getAiKey(env: Env, db: D1Database, household: HouseholdRow): Promise<string | null> {
	return getHouseholdSecret(env, db, household, 'anthropic-key');
}

export function setAiKey(env: Env, db: D1Database, hid: number, key: string): Promise<void> {
	return setHouseholdSecret(env, db, hid, 'anthropic-key', key);
}
