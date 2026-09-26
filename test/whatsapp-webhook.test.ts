import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion } from '../src/ai/assistant';
import { buildDailyBriefText } from '../src/budget/brief';
import { getMessageLogByWaId, listMessageLog, listRunLog } from '../src/db/repo';
import { getSetting, setSettings, waWindowKey } from '../src/db/settings';
import type { Env } from '../src/env';
import {
	AI_DISABLED_REPLY,
	HELP_REPLY,
	type InboundMessage,
	handleWebhookGet,
	handleWebhookPost,
	processWebhookPayload,
	verifySignature,
} from '../src/whatsapp/webhook';
import { resetDb } from './helpers';

// Implemented in parallel / tested separately — never run the real bodies here.
vi.mock('../src/budget/brief', () => ({
	buildBriefData: vi.fn(),
	renderBriefText: vi.fn(),
	renderTemplateParams: vi.fn(),
	buildDailyBriefText: vi.fn(),
}));
vi.mock('../src/ai/assistant', () => ({ answerQuestion: vi.fn() }));

const db = env.DB;
const APP_SECRET = 'test-app-secret';
const waEnv: Env = {
	...env,
	WHATSAPP_ACCESS_TOKEN: 'test-token',
	WHATSAPP_PHONE_NUMBER_ID: '1234567890',
	WHATSAPP_API_VERSION: 'v26.0',
	WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'verify-me',
	META_APP_SECRET: APP_SECRET,
};
const NOW = new Date('2026-09-26T10:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const ALICE = '+15550001111';
const BOB = '+15550002222';

const encoder = new TextEncoder();
const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sign(body: string, secret = APP_SECRET): Promise<string> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return `sha256=${toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))}`;
}

function payloadWith(value: Record<string, unknown>) {
	return {
		object: 'whatsapp_business_account',
		entry: [
			{
				id: '102290129340398',
				changes: [
					{
						field: 'messages',
						value: {
							messaging_product: 'whatsapp',
							metadata: { display_phone_number: '15550009999', phone_number_id: '1234567890' },
							...value,
						},
					},
				],
			},
		],
	};
}

/** Inbound text message from Alice, 10 s before NOW (shape from Meta's messages webhook reference). */
function inbound(message: Partial<InboundMessage> = {}) {
	return payloadWith({
		contacts: [{ profile: { name: 'Alice' }, wa_id: '15550001111' }],
		messages: [{ from: '15550001111', id: 'wamid.IN1', timestamp: String(NOW_S - 10), type: 'text', text: { body: 'Budget' }, ...message }],
	});
}

function mockGraph(handler?: (payload: Record<string, any>) => Response | undefined) {
	let sent = 0;
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
		const payload = JSON.parse(String(init?.body));
		return handler?.(payload) ?? Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT${++sent}` }] });
	});
}

function sentBodies(spy: ReturnType<typeof mockGraph>): string[] {
	return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).text.body as string);
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	await setSettings(db, { whatsapp_to_numbers: ALICE, dry_run: '0', stale_seconds: '300' });
	vi.mocked(buildDailyBriefText).mockResolvedValue('*Family Budget Brief*\nBRIEF');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('verifySignature', () => {
	it('accepts a known HMAC-SHA256 vector', async () => {
		const header = 'sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
		expect(await verifySignature('The quick brown fox jumps over the lazy dog', header, 'key')).toBe(true);
	});

	it('accepts a signature over the exact raw body (string or bytes), rejects tampering', async () => {
		const body = JSON.stringify(inbound({ text: { body: 'Caf\\u00e9 budget?' } }));
		const header = await sign(body);
		expect(await verifySignature(body, header, APP_SECRET)).toBe(true);
		expect(await verifySignature(encoder.encode(body).buffer as ArrayBuffer, header, APP_SECRET)).toBe(true);
		expect(await verifySignature(body.replace('wamid.IN1', 'wamid.IN2'), header, APP_SECRET)).toBe(false);
		expect(await verifySignature(`${body} `, header, APP_SECRET)).toBe(false);
		expect(await verifySignature(body, header, 'other-secret')).toBe(false);
	});

	it('rejects missing or malformed headers', async () => {
		const body = '{}';
		const hex = (await sign(body)).slice('sha256='.length);
		expect(await verifySignature(body, null, APP_SECRET)).toBe(false);
		expect(await verifySignature(body, '', APP_SECRET)).toBe(false);
		expect(await verifySignature(body, hex, APP_SECRET)).toBe(false);
		expect(await verifySignature(body, `sha1=${hex}`, APP_SECRET)).toBe(false);
		expect(await verifySignature(body, `sha256=${hex.slice(2)}`, APP_SECRET)).toBe(false);
		expect(await verifySignature(body, `sha256=${hex}`, '')).toBe(false);
	});
});

describe('handleWebhookGet', () => {
	const verify = (query: string, e: Env = waEnv) => handleWebhookGet(new Request(`https://example.com/webhook?${query}`), e);

	it('echoes hub.challenge for a matching verify token', async () => {
		const response = verify('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444');
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('1158201444');
	});

	it('403s a wrong token, wrong mode or unconfigured token', () => {
		expect(verify('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1').status).toBe(403);
		expect(verify('hub.mode=unsubscribe&hub.verify_token=verify-me&hub.challenge=1').status).toBe(403);
		expect(verify('hub.mode=subscribe&hub.verify_token=&hub.challenge=1', { ...waEnv, WHATSAPP_WEBHOOK_VERIFY_TOKEN: undefined }).status).toBe(403);
	});
});

describe('handleWebhookPost', () => {
	async function post(body: string, headers: Record<string, string>, e: Env = waEnv) {
		const ctx = createExecutionContext();
		const response = await handleWebhookPost(new Request('https://example.com/webhook', { method: 'POST', body, headers }), e, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}
	const statusPayload = JSON.stringify(payloadWith({ statuses: [{ id: 'wamid.S1', status: 'delivered', timestamp: String(NOW_S), recipient_id: '15550001111' }] }));

	it('fails closed with 500 when META_APP_SECRET is missing', async () => {
		const response = await post(statusPayload, { 'X-Hub-Signature-256': await sign(statusPayload) }, { ...waEnv, META_APP_SECRET: undefined });
		expect(response.status).toBe(500);
		const [row] = await listRunLog(db, 1);
		expect(row).toMatchObject({ level: 'ERROR', action: 'whatsapp.webhook' });
	});

	it('401s a bad or missing signature and processes nothing', async () => {
		expect((await post(statusPayload, { 'X-Hub-Signature-256': await sign(statusPayload, 'wrong') })).status).toBe(401);
		expect((await post(statusPayload, {})).status).toBe(401);
		expect(await listRunLog(db, 10)).toEqual([]);
	});

	it('ACKs a valid call with 200 EVENT_RECEIVED and processes it in waitUntil', async () => {
		const response = await post(statusPayload, { 'X-Hub-Signature-256': await sign(statusPayload), 'content-type': 'application/json' });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('EVENT_RECEIVED');
		const [row] = await listRunLog(db, 1);
		expect(row).toMatchObject({ level: 'INFO', action: 'whatsapp.status' });
		expect(row!.message).toContain('messageId=wamid.S1');
	});

	it('still ACKs a signed body that is not JSON, and logs it', async () => {
		const response = await post('not json', { 'X-Hub-Signature-256': await sign('not json') });
		expect(response.status).toBe(200);
		const [row] = await listRunLog(db, 1);
		expect(row).toMatchObject({ level: 'ERROR', action: 'whatsapp.webhook' });
		expect(row!.message).toContain('not valid JSON');
	});
});

describe('processWebhookPayload', () => {
	it('"Budget" (button reply, any case) replies with the daily brief and completes the log row', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound({ type: 'button', text: undefined, button: { text: ' BUDGET ' } }), NOW);

		// Compare bindings by identity: vitest cannot pretty-print D1 objects in matcher messages.
		const [briefDb, briefSettings, briefNow] = vi.mocked(buildDailyBriefText).mock.calls[0]!;
		expect(briefDb === db).toBe(true);
		expect(briefSettings.whatsapp_to_numbers).toBe(ALICE);
		expect(briefNow).toBe(NOW);
		expect(sentBodies(spy)).toEqual(['*Family Budget Brief*\nBRIEF']);
		expect(JSON.parse(String(spy.mock.calls[0]![1]?.body)).to).toBe(ALICE);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({
			direction: 'in',
			status: 'COMPLETED',
			fromNumber: '***1111',
			inboundTs: new Date((NOW_S - 10) * 1000).toISOString(),
			body: ' BUDGET ',
			errorCode: null,
			outboundMessageId: 'wamid.OUT1',
		});
	});

	it('records the inbound time as the 24h window for the sender', async () => {
		mockGraph();
		await processWebhookPayload(waEnv, db, inbound(), NOW);
		expect(await getSetting(db, waWindowKey(ALICE))).toBe(new Date((NOW_S - 10) * 1000).toISOString());

		// An older (out-of-order) delivery never moves the window back.
		await processWebhookPayload(waEnv, db, inbound({ id: 'wamid.OLD', timestamp: String(NOW_S - 60) }), NOW);
		expect(await getSetting(db, waWindowKey(ALICE))).toBe(new Date((NOW_S - 10) * 1000).toISOString());
	});

	it('de-duplicates a redelivered message id', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound(), NOW);
		await processWebhookPayload(waEnv, db, inbound(), NOW);
		expect(spy).toHaveBeenCalledOnce();
		expect((await listMessageLog(db, 10)).filter((row) => row.direction === 'in')).toHaveLength(1);
	});

	it('de-duplicates id-less messages via a deterministic fallback id', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound({ id: undefined }), NOW);
		await processWebhookPayload(waEnv, db, inbound({ id: undefined }), NOW);
		expect(spy).toHaveBeenCalledOnce();
		const rows = await listMessageLog(db, 10);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.waMessageId).toMatch(/^generated_[0-9a-f]{40}$/);
	});

	it('ignores stale messages without replying', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound({ timestamp: String(NOW_S - 301) }), NOW);
		expect(spy).not.toHaveBeenCalled();
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'STALE_IGNORED', errorCode: 'ERR_STALE_MESSAGE' });
	});

	it('ignores senders that are not in whatsapp_to_numbers (and everyone when it is empty)', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound({ from: BOB.slice(1) }), NOW);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'IGNORED_SENDER', fromNumber: '***2222', body: null });
		const [warning] = await listRunLog(db, 1);
		expect(warning).toMatchObject({ level: 'WARN', action: 'whatsapp.webhook' });

		await setSettings(db, { whatsapp_to_numbers: '' });
		await processWebhookPayload(waEnv, db, inbound({ id: 'wamid.IN2' }), NOW);
		expect(await getMessageLogByWaId(db, 'wamid.IN2')).toMatchObject({ status: 'IGNORED_SENDER' });

		expect(spy).not.toHaveBeenCalled();
		expect(buildDailyBriefText).not.toHaveBeenCalled();
		expect(await getSetting(db, waWindowKey(BOB))).toBeNull();
	});

	it('answers other text with the static reply when AI is disabled', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound({ text: { body: 'How much on groceries?' } }), NOW);
		expect(answerQuestion).not.toHaveBeenCalled();
		expect(sentBodies(spy)).toEqual([AI_DISABLED_REPLY]);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'COMPLETED' });
	});

	it('relays other text to Claude when AI is enabled', async () => {
		const spy = mockGraph();
		vi.mocked(answerQuestion).mockResolvedValue('*€123.45* on groceries so far.');
		await setSettings(db, { ai_enabled: '1' });
		const aiEnv = { ...waEnv, ANTHROPIC_API_KEY: 'sk-test' };

		await processWebhookPayload(aiEnv, db, inbound({ text: { body: 'How much on groceries?' } }), NOW);
		const [aiEnvArg, aiDb, question, aiNow] = vi.mocked(answerQuestion).mock.calls[0]!;
		expect(aiEnvArg === aiEnv && aiDb === db).toBe(true);
		expect([question, aiNow]).toEqual(['How much on groceries?', NOW]);
		expect(sentBodies(spy)).toEqual(['*€123.45* on groceries so far.']);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'COMPLETED', outboundMessageId: 'wamid.OUT1' });
	});

	it('drops the Claude reply when the message went stale while Claude was answering', async () => {
		const spy = mockGraph();
		let clock = 1_000_000;
		vi.spyOn(Date, 'now').mockImplementation(() => clock);
		vi.mocked(answerQuestion).mockImplementation(async () => {
			clock += 295_000; // 10 s old + 295 s thinking > 300 s
			return 'late answer';
		});
		await setSettings(db, { ai_enabled: '1' });

		await processWebhookPayload({ ...waEnv, ANTHROPIC_API_KEY: 'sk-test' }, db, inbound({ text: { body: 'Question?' } }), NOW);
		expect(spy).not.toHaveBeenCalled();
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'STALE_IGNORED', errorCode: 'ERR_STALE_MESSAGE' });
	});

	it('replies with help text to messages without text (e.g. images)', async () => {
		const spy = mockGraph();
		await processWebhookPayload(waEnv, db, inbound({ type: 'image', text: undefined }), NOW);
		expect(sentBodies(spy)).toEqual([HELP_REPLY]);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'COMPLETED', errorCode: 'ERR_UNSUPPORTED_MESSAGE' });
	});

	it('marks failures FAILED and sends a short coded error reply', async () => {
		const spy = mockGraph();
		vi.mocked(buildDailyBriefText).mockRejectedValue(new Error('engine exploded'));
		await processWebhookPayload(waEnv, db, inbound(), NOW);

		expect(sentBodies(spy)).toEqual(['⚠️ Something went wrong (ERR_WHATSAPP_HANDLER). Please try again.']);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({
			status: 'FAILED',
			errorCode: 'ERR_WHATSAPP_HANDLER',
			errorMessage: 'engine exploded',
			outboundMessageId: 'wamid.OUT1',
		});
		const errors = (await listRunLog(db, 10)).filter((row) => row.level === 'ERROR');
		expect(errors[0]!.message).toContain('engine exploded');
	});

	it('uses the code of coded errors, and only logs when the error reply cannot be sent either', async () => {
		mockGraph(() => Response.json({ error: { message: 'down' } }, { status: 503 }));
		vi.mocked(answerQuestion).mockRejectedValue(Object.assign(new Error('rate limited'), { code: 'ERR_AI_RATE_LIMIT' }));
		await setSettings(db, { ai_enabled: '1' });

		await processWebhookPayload({ ...waEnv, ANTHROPIC_API_KEY: 'sk-test' }, db, inbound({ text: { body: 'Question?' } }), NOW);
		expect(await getMessageLogByWaId(db, 'wamid.IN1')).toMatchObject({ status: 'FAILED', errorCode: 'ERR_AI_RATE_LIMIT', outboundMessageId: null });
		const errors = (await listRunLog(db, 10)).filter((row) => row.level === 'ERROR').map((row) => row.message);
		expect(errors.some((message) => message.includes('Could not send the error reply') && message.includes('ERR_WHATSAPP_SEND'))).toBe(true);
	});

	it('dry run: logs the reply instead of sending it', async () => {
		const spy = mockGraph();
		await setSettings(db, { dry_run: '1' });
		await processWebhookPayload(waEnv, db, inbound(), NOW);

		expect(spy).not.toHaveBeenCalled();
		const rows = await listMessageLog(db, 10);
		expect(rows.find((row) => row.direction === 'in')).toMatchObject({ status: 'COMPLETED', outboundMessageId: null });
		expect(rows.find((row) => row.direction === 'out')).toMatchObject({ status: 'DRY_RUN', fromNumber: '***1111', body: '*Family Budget Brief*\nBRIEF' });
	});

	it('logs delivery status events (failed → ERROR with details)', async () => {
		await processWebhookPayload(
			waEnv,
			db,
			payloadWith({
				statuses: [
					{ id: 'wamid.A', status: 'delivered', timestamp: String(NOW_S), recipient_id: '15550001111' },
					{
						id: 'wamid.B',
						status: 'failed',
						timestamp: String(NOW_S),
						recipient_id: '15550002222',
						errors: [{ code: 131047, title: 'Re-engagement message', message: 'Re-engagement message', error_data: { details: 'More than 24 hours' } }],
					},
				],
			}),
			NOW,
		);
		const rows = (await listRunLog(db, 10)).reverse();
		expect(rows.map((row) => [row.level, row.action])).toEqual([
			['INFO', 'whatsapp.status'],
			['ERROR', 'whatsapp.status'],
		]);
		expect(rows[0]!.message).toBe('messageId=wamid.A recipient=***1111 status=delivered');
		expect(rows[1]!.message).toContain('errors=131047 Re-engagement message Re-engagement message More than 24 hours');
		expect(rows[1]!.message).not.toContain('15550002222');
	});
});
