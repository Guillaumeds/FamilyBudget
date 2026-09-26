/**
 * Password hashing and secret encryption with WebCrypto (no dependencies).
 *
 * - Passwords: PBKDF2-SHA256, 100 000 iterations (the Workers maximum), 16-byte random salt, stored
 *   as 'pbkdf2$100000$<saltB64>$<hashB64>'. Verification compares with the Workers-specific
 *   `crypto.subtle.timingSafeEqual` (https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
 * - Secrets (per-household Wallet token / Anthropic key): AES-GCM-256 under the TOKEN_ENCRYPTION_KEY
 *   secret (base64 of 32 random bytes), 12-byte random IV, stored as 'v1.<ivB64url>.<ctB64url>'.
 *   The additional authenticated data (AAD) binds a ciphertext to its row, so a value copied to
 *   another household or column fails to decrypt.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
const IV_BYTES = 12;
const SECRET_VERSION = 'v1';

/** Wrong key, wrong AAD, tampered or malformed ciphertext, or an unusable TOKEN_ENCRYPTION_KEY. */
export class CryptoError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CryptoError';
	}
}

function toBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function toBase64Url(bytes: Uint8Array): string {
	return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
	return fromBase64(value.replace(/-/g, '+').replace(/_/g, '/'));
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BITS));
}

/** 'pbkdf2$100000$<saltB64>$<hashB64>' for `password` with a fresh random salt. */
export async function pbkdf2Hash(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Whether `password` matches a pbkdf2Hash() value. False (never throws) for malformed hashes. */
export async function pbkdf2Verify(password: string, stored: string): Promise<boolean> {
	const [scheme, iterations, salt, hash] = stored.split('$');
	if (scheme !== 'pbkdf2' || !/^\d+$/.test(iterations ?? '') || !salt || !hash) return false;
	try {
		const expected = fromBase64(hash);
		const actual = await pbkdf2(password, fromBase64(salt), Number(iterations));
		return actual.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

async function aesKey(keyB64: string | undefined, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
	let raw: Uint8Array;
	try {
		raw = fromBase64(keyB64?.trim() ?? '');
	} catch {
		raw = new Uint8Array();
	}
	if (raw.byteLength !== 32) throw new CryptoError('TOKEN_ENCRYPTION_KEY must be the base64 encoding of 32 random bytes.');
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);
}

/** Encrypts `plaintext` to 'v1.<ivB64url>.<ctB64url>'; `aad` must be passed again to decrypt. */
export async function encryptSecret(plaintext: string, keyB64: string | undefined, aad: string): Promise<string> {
	const key = await aesKey(keyB64, 'encrypt');
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(plaintext));
	return `${SECRET_VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypts an encryptSecret() value. Throws CryptoError on any failure. */
export async function decryptSecret(value: string, keyB64: string | undefined, aad: string): Promise<string> {
	const key = await aesKey(keyB64, 'decrypt');
	const [version, iv, ciphertext, extra] = value.split('.');
	if (version !== SECRET_VERSION || !iv || !ciphertext || extra !== undefined) throw new CryptoError('Malformed encrypted secret.');
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: encoder.encode(aad) },
			key,
			fromBase64Url(ciphertext),
		);
		return decoder.decode(plaintext);
	} catch {
		throw new CryptoError('Could not decrypt secret (wrong key, wrong row or tampered value).');
	}
}
