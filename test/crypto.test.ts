import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { CryptoError, decryptSecret, encryptSecret, pbkdf2Hash, pbkdf2Verify } from '../src/lib/crypto';
import { TEST_TOKEN_ENCRYPTION_KEY } from './helpers';

const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe('pbkdf2', () => {
	it('hashes in the documented format and verifies the right password only', async () => {
		const hash = await pbkdf2Hash('correct horse');
		expect(hash).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$/);
		expect(await pbkdf2Hash('correct horse')).not.toBe(hash); // fresh salt every time

		expect(await pbkdf2Verify('correct horse', hash)).toBe(true);
		expect(await pbkdf2Verify('correct horsE', hash)).toBe(false);
		expect(await pbkdf2Verify('', hash)).toBe(false);
	});

	it('rejects malformed or empty hashes without throwing', async () => {
		for (const stored of ['', 'pbkdf2$abc$x$y', 'sha256$100000$AAAA$AAAA', 'pbkdf2$100000$!!!$AAAA', 'pbkdf2$100000$AAAA$AAAA']) {
			expect(await pbkdf2Verify('anything', stored)).toBe(false);
		}
	});
});

describe('encryptSecret / decryptSecret', () => {
	it('round-trips with the same key and AAD; each encryption uses a fresh IV', async () => {
		const value = await encryptSecret('wallet-token-ü', TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1');
		expect(value).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
		expect(await encryptSecret('wallet-token-ü', TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1')).not.toBe(value);
		expect(await decryptSecret(value, TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1')).toBe('wallet-token-ü');
	});

	it('the test binding matches the helper constant', () => {
		expect(env.TOKEN_ENCRYPTION_KEY).toBe(TEST_TOKEN_ENCRYPTION_KEY);
	});

	it('fails with CryptoError for a wrong key, a wrong AAD, or a tampered value', async () => {
		const value = await encryptSecret('secret', TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1');
		const [version, iv, ciphertext] = value.split('.') as [string, string, string];
		const flipped = `${version}.${iv}.${(ciphertext[0] === 'A' ? 'B' : 'A') + ciphertext.slice(1)}`;

		await expect(decryptSecret(value, OTHER_KEY, 'wallet-token.v1.1')).rejects.toBeInstanceOf(CryptoError);
		await expect(decryptSecret(value, TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.2')).rejects.toBeInstanceOf(CryptoError);
		await expect(decryptSecret(value, TEST_TOKEN_ENCRYPTION_KEY, 'anthropic-key.v1.1')).rejects.toBeInstanceOf(CryptoError);
		await expect(decryptSecret(flipped, TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1')).rejects.toBeInstanceOf(CryptoError);
		await expect(decryptSecret('v2.x.y', TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1')).rejects.toBeInstanceOf(CryptoError);
		await expect(decryptSecret('garbage', TEST_TOKEN_ENCRYPTION_KEY, 'wallet-token.v1.1')).rejects.toBeInstanceOf(CryptoError);
	});

	it('rejects a missing or wrong-length TOKEN_ENCRYPTION_KEY', async () => {
		await expect(encryptSecret('secret', undefined, 'a')).rejects.toBeInstanceOf(CryptoError);
		await expect(encryptSecret('secret', btoa('too short'), 'a')).rejects.toBeInstanceOf(CryptoError);
		await expect(encryptSecret('secret', 'not base64 !!', 'a')).rejects.toBeInstanceOf(CryptoError);
	});
});
