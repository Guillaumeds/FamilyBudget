import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { HttpError } from '../src/api/http';
import {
	createHousehold,
	getHousehold,
	getHouseholdByName,
	listHouseholds,
	listRecipients,
	lookupRecipient,
	replaceRecipients,
	secretAad,
	updateHousehold,
} from '../src/db/households';
import { decryptSecret, pbkdf2Verify } from '../src/lib/crypto';
import { TEST_AI_KEY, TEST_PASSWORD, TEST_TOKEN_ENCRYPTION_KEY, TEST_WALLET_TOKEN, resetDb } from './helpers';

const db = env.DB;

beforeEach(resetDb);

describe('seeded fixtures', () => {
	it('household 1 has a real password hash and decryptable secrets; household 2 has none', async () => {
		const [hh1, hh2] = await listHouseholds(db);
		expect(hh1).toMatchObject({ id: 1, name: 'guillaume', status: 'active', waApproved: 1 });
		expect(await pbkdf2Verify(TEST_PASSWORD, hh1!.passwordHash)).toBe(true);
		expect(await decryptSecret(hh1!.walletTokenEnc!, TEST_TOKEN_ENCRYPTION_KEY, secretAad('wallet-token', 1))).toBe(TEST_WALLET_TOKEN);
		expect(await decryptSecret(hh1!.anthropicKeyEnc!, TEST_TOKEN_ENCRYPTION_KEY, secretAad('anthropic-key', 1))).toBe(TEST_AI_KEY);
		expect(hh2).toMatchObject({ id: 2, name: 'testers', waApproved: 0, walletTokenEnc: null, anthropicKeyEnc: null });
	});
});

describe('households CRUD', () => {
	it('creates with defaults, stores the name lower-case and looks it up case-insensitively', async () => {
		const created = await createHousehold(db, { name: '  Smiths ', passwordHash: 'pbkdf2$1$a$b' });
		expect(created).toMatchObject({
			name: 'smiths',
			passwordHash: 'pbkdf2$1$a$b',
			status: 'active',
			waApproved: 0,
			walletTokenEnc: null,
			anthropicKeyEnc: null,
		});
		expect(created.id).toBeGreaterThan(2);
		expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(await getHousehold(db, created.id)).toEqual(created);
		expect(await getHouseholdByName(db, 'SMITHS')).toEqual(created);
		expect(await getHouseholdByName(db, 'nobody')).toBeNull();
		expect(await getHousehold(db, 999)).toBeNull();
		expect((await listHouseholds(db)).map((h) => h.name)).toEqual(['guillaume', 'testers', 'smiths']);
	});

	it('rejects a duplicate name regardless of case (409 NAME_TAKEN)', async () => {
		const error = await createHousehold(db, { name: 'Guillaume', passwordHash: 'x' }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HttpError);
		expect(error).toMatchObject({ status: 409, code: 'NAME_TAKEN' });
		// Raw insert with different case is blocked by COLLATE NOCASE UNIQUE too.
		await expect(db.prepare("INSERT INTO households (name) VALUES ('TESTERS')").run()).rejects.toThrow(/UNIQUE/);
	});

	it('updates only the patched columns and bumps updated_at', async () => {
		const before = (await getHousehold(db, 2))!;
		expect(await updateHousehold(db, 2, { waApproved: 1, status: 'suspended', walletTokenEnc: 'v1.a.b' })).toBe(true);
		const after = (await getHousehold(db, 2))!;
		expect(after).toMatchObject({ ...before, waApproved: 1, status: 'suspended', walletTokenEnc: 'v1.a.b', updatedAt: after.updatedAt });
		expect(after.updatedAt >= before.updatedAt).toBe(true);

		expect(await updateHousehold(db, 2, { walletTokenEnc: null, name: 'Testers2' })).toBe(true);
		expect(await getHousehold(db, 2)).toMatchObject({ walletTokenEnc: null, name: 'testers2' });
		expect(await updateHousehold(db, 999, { status: 'active' })).toBe(false);
	});
});

describe('recipients', () => {
	it('replaces the list atomically and looks numbers up', async () => {
		await replaceRecipients(db, 1, ['+15550100001', '+15550100002', '+15550100001']);
		expect(await listRecipients(db, 1)).toEqual(['+15550100001', '+15550100002']);
		expect(await lookupRecipient(db, '+15550100002')).toBe(1);
		expect(await lookupRecipient(db, '+15550199999')).toBeNull();

		await replaceRecipients(db, 1, ['+15550100002', '+15550100003']); // re-assigning own numbers is fine
		expect(await listRecipients(db, 1)).toEqual(['+15550100002', '+15550100003']);
		expect(await lookupRecipient(db, '+15550100001')).toBeNull();

		await replaceRecipients(db, 1, []);
		expect(await listRecipients(db, 1)).toEqual([]);
	});

	it('throws RECIPIENT_TAKEN for a number of another household and changes nothing', async () => {
		await replaceRecipients(db, 1, ['+15550100001']);
		await replaceRecipients(db, 2, ['+15550100009']);

		const error = await replaceRecipients(db, 2, ['+15550100008', '+15550100001']).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(HttpError);
		expect(error).toMatchObject({ status: 400, code: 'RECIPIENT_TAKEN', extra: { number: '+15550100001' } });
		expect((error as Error).message).toContain('+15550100001');

		expect(await listRecipients(db, 2)).toEqual(['+15550100009']);
		expect(await lookupRecipient(db, '+15550100001')).toBe(1);
	});
});
