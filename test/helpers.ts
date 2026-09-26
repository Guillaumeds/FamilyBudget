import { env } from 'cloudflare:workers';
import { type HouseholdPatch, secretAad } from '../src/db/households';
import { type Tenant, tenant } from '../src/db/tenant';
import { encryptSecret, pbkdf2Hash } from '../src/lib/crypto';

const TABLES = [
	'categories',
	'accounts',
	'transactions',
	'budget_targets',
	'cashflow_balances',
	'fx_rates',
	'message_log',
	'run_log',
	'settings',
	'households',
	'household_recipients',
] as const;

/** Same value as the TOKEN_ENCRYPTION_KEY test binding in vitest.config.ts (base64 of bytes 0..31). */
export const TEST_TOKEN_ENCRYPTION_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
/** Dashboard password of every seeded household. */
export const TEST_PASSWORD = 'test-password';
/** Decrypted secrets of household 1. */
export const TEST_WALLET_TOKEN = 'test-wallet-token';
export const TEST_AI_KEY = 'test-ai-key';

/** Real PBKDF2 hash of TEST_PASSWORD, computed once per test file (100k iterations is slow-ish). */
export const TEST_PASSWORD_HASH = await pbkdf2Hash(TEST_PASSWORD);

/** Household 1 ('guillaume': WhatsApp approved, Wallet token + Anthropic key stored). */
export const HH1: Tenant = tenant(env.DB, 1);
/** Household 2 ('testers': WhatsApp not approved, no secrets stored). */
export const HH2: Tenant = tenant(env.DB, 2);

/**
 * Inserts household `id` (password TEST_PASSWORD, active, WhatsApp not approved, no secrets unless
 * `secrets` gives plaintexts to encrypt under TEST_TOKEN_ENCRYPTION_KEY) and returns its Tenant.
 */
export async function seedHousehold(
	id: number,
	name: string,
	patch: Omit<HouseholdPatch, 'name' | 'walletTokenEnc' | 'anthropicKeyEnc'> = {},
	secrets: { walletToken?: string; aiKey?: string } = {},
): Promise<Tenant> {
	const walletTokenEnc = secrets.walletToken
		? await encryptSecret(secrets.walletToken, TEST_TOKEN_ENCRYPTION_KEY, secretAad('wallet-token', id))
		: null;
	const anthropicKeyEnc = secrets.aiKey ? await encryptSecret(secrets.aiKey, TEST_TOKEN_ENCRYPTION_KEY, secretAad('anthropic-key', id)) : null;
	await env.DB.prepare(
		`INSERT INTO households (id, name, password_hash, status, wa_approved, wallet_token_enc, anthropic_key_enc)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, name, patch.passwordHash ?? TEST_PASSWORD_HASH, patch.status ?? 'active', patch.waApproved ?? 0, walletTokenEnc, anthropicKeyEnc)
		.run();
	return tenant(env.DB, id);
}

/**
 * Storage is isolated per test file, not per test — call in beforeEach for a clean database.
 * Empties every table, then seeds HH1 and HH2.
 */
export async function resetDb(): Promise<void> {
	await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
	await seedHousehold(1, 'guillaume', { waApproved: 1 }, { walletToken: TEST_WALLET_TOKEN, aiKey: TEST_AI_KEY });
	await seedHousehold(2, 'testers');
}
