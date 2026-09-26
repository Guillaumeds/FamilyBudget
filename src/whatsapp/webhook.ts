/**
 * WhatsApp webhook: GET subscription verification, POST with X-Hub-Signature-256 validation, fast
 * 200 ACK and all processing in ctx.waitUntil().
 *
 * Meta docs relied on:
 *   - https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/
 *     GET: hub.mode=subscribe + hub.verify_token → respond 200 with hub.challenge. POST: header
 *     `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(payload, app secret); failed deliveries are
 *     retried for up to 7 days, so the receiver must de-duplicate.
 *   - https://developers.facebook.com/docs/messenger-platform/webhooks — the signature is computed over
 *     the escaped-unicode payload exactly as sent, so we hash the raw request bytes, never re-serialized JSON.
 *   - Payload shapes: .../whatsapp/webhooks/reference/messages (entry[].changes[].value.messages[] /
 *     .statuses[]; `from` is digits without '+', `timestamp` is unix seconds as a string).
 *
 * Ports legacy/Code.gs handleWhatsAppWebhookPayload (~1627), beginMessageProcessing (~650),
 * extractWhatsApp{Incoming,Status}… / getWhatsAppInboundText (~1906–1958) and
 * buildCodedWhatsAppErrorMessage (~2605).
 */
import { AssistantError, answerQuestion } from '../ai/assistant';
import { buildDailyBriefText } from '../budget/brief';
import { type HouseholdRow, getHousehold, lookupRecipient } from '../db/households';
import { insertMessageLog, logRun, type MessageLogPatch, updateMessageLogByWaId } from '../db/repo';
import { getSettings, SETTING_DEFAULTS, type Settings, setSetting, waWindowKey } from '../db/settings';
import { type Tenant, tenant } from '../db/tenant';
import type { Env } from '../env';
import { maskPhone } from '../lib/format';
import { isoNow } from '../lib/tz';
import { errorCode, errorText, logMessage, normalizeE164, sendText } from './client';

const ACTION = 'whatsapp.webhook';
const LOG_BODY_MAX_CHARS = 4000;

export const HELP_REPLY = 'Send *Budget* for the daily brief, or ask a question about your budget.';
export const AI_DISABLED_REPLY = 'I can send the daily brief — reply *Budget*. Free-text questions are disabled.';
export const PENDING_APPROVAL_REPLY = 'This household is waiting for the site owner to approve WhatsApp messaging. You can keep using the web dashboard meanwhile.';
export function codedErrorReply(code: string): string {
	return `⚠️ Something went wrong (${code}). Please try again.`;
}

// ---------------------------------------------------------------------------------------------
// Payload types (the subset we read)
// ---------------------------------------------------------------------------------------------

export interface InboundMessage {
	from?: string;
	id?: string;
	timestamp?: string;
	type?: string;
	text?: { body?: string };
	button?: { text?: string };
	interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

export interface StatusEvent {
	id?: string;
	status?: string;
	recipient_id?: string;
	errors?: Array<{ code?: number | string; title?: string; message?: string; error_data?: { details?: string } }>;
}

interface ChangeValue {
	messages?: InboundMessage[];
	statuses?: StatusEvent[];
}

function changeValues(payload: unknown): ChangeValue[] {
	const entries = (payload as { entry?: unknown } | null)?.entry;
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry) => {
		const changes = (entry as { changes?: unknown } | null)?.changes;
		return Array.isArray(changes) ? changes.map((change) => ((change as { value?: ChangeValue } | null)?.value ?? {}) as ChangeValue) : [];
	});
}

function listOf<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

// ---------------------------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}

/**
 * Validates `X-Hub-Signature-256` ("sha256=<hex>") = HMAC-SHA256 over the raw body with the app
 * secret. crypto.subtle.verify compares in constant time.
 */
export async function verifySignature(
	rawBody: string | ArrayBuffer | ArrayBufferView,
	signatureHeader: string | null,
	appSecret: string,
): Promise<boolean> {
	const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader?.trim() ?? '');
	if (!match || !appSecret) return false;
	const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
	const data = typeof rawBody === 'string' ? encoder.encode(rawBody) : rawBody;
	return crypto.subtle.verify('HMAC', key, hexToBytes(match[1]!), data);
}

/** GET /webhook — Meta's subscription handshake. */
export function handleWebhookGet(request: Request, env: Env): Response {
	const params = new URL(request.url).searchParams;
	const expected = env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
	const challenge = params.get('hub.challenge');
	if (params.get('hub.mode') === 'subscribe' && expected && params.get('hub.verify_token') === expected && challenge !== null) {
		return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
	}
	return new Response('Forbidden', { status: 403 });
}

/**
 * POST /webhook — rejects unsigned/forged calls, then ACKs immediately (Meta expects a fast 200 and
 * retries otherwise) and processes the payload in ctx.waitUntil().
 */
export async function handleWebhookPost(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const rawBody = await request.arrayBuffer();
	if (!env.META_APP_SECRET) {
		await logRun(env.DB, 'ERROR', ACTION, 'META_APP_SECRET is not set — rejecting webhook POST (signature cannot be verified).');
		return new Response('Webhook not configured', { status: 500 });
	}
	if (!(await verifySignature(rawBody, request.headers.get('X-Hub-Signature-256'), env.META_APP_SECRET))) {
		console.warn(`[WARN] ${ACTION}: rejected POST with a missing or invalid X-Hub-Signature-256.`);
		return new Response('Invalid signature', { status: 401 });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(rawBody));
	} catch (error) {
		ctx.waitUntil(logRun(env.DB, 'ERROR', ACTION, `Signed webhook body is not valid JSON: ${errorText(error)}`));
		return new Response('EVENT_RECEIVED', { status: 200 });
	}
	ctx.waitUntil(processWebhookPayload(env, env.DB, payload, new Date()));
	return new Response('EVENT_RECEIVED', { status: 200 });
}

// ---------------------------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------------------------

/** Status updates for our outbound messages (sent/delivered/read/failed) → run_log. */
async function logStatusEvents(db: D1Database, statuses: StatusEvent[]): Promise<void> {
	for (const status of statuses) {
		const state = status.status || 'unknown';
		const errors = listOf<NonNullable<StatusEvent['errors']>[number]>(status.errors)
			.map((error) => [error.code, error.title, error.message, error.error_data?.details].filter(Boolean).join(' '))
			.join(' | ');
		const detail = `messageId=${status.id ?? ''} recipient=${status.recipient_id ? maskPhone(status.recipient_id) : 'unknown'} status=${state}${errors ? ` errors=${errors}` : ''}`;
		await logRun(db, state === 'failed' ? 'ERROR' : 'INFO', 'whatsapp.status', detail);
	}
}

/** Text of a text / button / interactive reply message; '' for anything else (images, audio, ...). */
function inboundText(message: InboundMessage): string {
	if (message.type === 'text') return String(message.text?.body ?? '');
	if (message.type === 'button') return String(message.button?.text ?? '');
	if (message.type === 'interactive') return String(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? '');
	return '';
}

/** message.id, or a deterministic hash so Meta's retries of an id-less message still de-duplicate. */
async function messageIdOf(message: InboundMessage): Promise<string> {
	if (message.id) return String(message.id);
	const raw = [message.from ?? '', message.timestamp ?? '', message.type ?? '', JSON.stringify(message).slice(0, 500)].join('|');
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(raw)));
	return `generated_${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
}

async function updateLog(db: D1Database, waMessageId: string, patch: MessageLogPatch): Promise<void> {
	try {
		await updateMessageLogByWaId(db, waMessageId, patch);
	} catch (error) {
		console.error(`message_log update failed for ${waMessageId}: ${errorText(error)}`);
	}
}

/** Everything an inbound message of one household needs; cached per payload by household id. */
interface HouseholdContext {
	t: Tenant;
	household: HouseholdRow;
	settings: Settings;
}

/** Household context of `hid`; null when the household does not exist. */
async function loadHouseholdContext(
	db: D1Database,
	cache: Map<number, HouseholdContext | null>,
	hid: number,
): Promise<HouseholdContext | null> {
	if (!cache.has(hid)) {
		const household = await getHousehold(db, hid);
		const t = tenant(db, hid);
		cache.set(hid, household ? { t, household, settings: await getSettings(t) } : null);
	}
	return cache.get(hid)!;
}

/** Sends `text` to `to`, or only logs it when the household's dry_run is on. */
async function deliverReply(
	env: Env,
	{ t, settings }: HouseholdContext,
	to: string,
	text: string,
	waMessageId: string,
): Promise<{ messageId?: string; sentAt?: string }> {
	if (settings.dry_run === '1') {
		const masked = maskPhone(to);
		await logRun(t, 'INFO', ACTION, `DRY RUN: would reply to ${masked} (${waMessageId}): ${text.slice(0, 200)}`);
		await logMessage(t.db, {
			direction: 'out',
			status: 'DRY_RUN',
			fromNumber: masked,
			body: text.slice(0, LOG_BODY_MAX_CHARS),
			householdId: t.hid,
		});
		return {};
	}
	const { messageId } = await sendText(env, to, text);
	return { messageId, sentAt: isoNow() };
}

async function handleInboundMessage(
	env: Env,
	db: D1Database,
	cache: Map<number, HouseholdContext | null>,
	message: InboundMessage,
	now: Date,
): Promise<void> {
	if (!message?.from) return;
	const from = normalizeE164(message.from);
	const masked = maskPhone(from);
	const text = inboundText(message);
	const waMessageId = await messageIdOf(message);
	const unixSeconds = Number(message.timestamp);
	const inboundMs = unixSeconds > 0 ? unixSeconds * 1000 : now.getTime();
	const inboundTs = new Date(inboundMs).toISOString();

	// Route by sender: only numbers registered as a household's recipients may use the bot, and the
	// household must be active (fail closed for unknown numbers and suspended households).
	const hid = from ? await lookupRecipient(db, from) : null;
	const context = hid === null ? null : await loadHouseholdContext(db, cache, hid);
	if (!context || context.household.status !== 'active') {
		const suspended = context !== null;
		if (
			await insertMessageLog(db, {
				waMessageId,
				direction: 'in',
				status: 'IGNORED_SENDER',
				fromNumber: masked,
				inboundTs,
				householdId: suspended ? hid : null,
			})
		) {
			const reason = suspended ? `household ${hid} is suspended` : 'not a recipient of any household';
			await logRun(db, 'WARN', ACTION, `Ignored message ${waMessageId} from ${masked}: ${reason}.`);
		}
		return;
	}
	const { t, settings } = context;

	// De-duplication: Meta retries deliveries, and the UNIQUE wa_message_id makes this insert atomic.
	const inserted = await insertMessageLog(db, {
		waMessageId,
		direction: 'in',
		status: 'PROCESSING',
		fromNumber: masked,
		inboundTs,
		body: text.slice(0, LOG_BODY_MAX_CHARS),
		householdId: t.hid,
	});
	if (!inserted) {
		console.log(`${ACTION}: duplicate delivery of ${waMessageId} ignored.`);
		return;
	}

	// The user's message opens the 24h service window for free-form replies (and the daily brief).
	const windowKey = waWindowKey(from);
	const previous = Date.parse(settings[windowKey] ?? '');
	if (!(previous >= inboundMs)) {
		await setSetting(t, windowKey, inboundTs);
		settings[windowKey] = inboundTs;
	}

	const staleSeconds = Number(settings.stale_seconds);
	const staleMs = (staleSeconds > 0 ? staleSeconds : Number(SETTING_DEFAULTS.stale_seconds)) * 1000;
	const startedAt = Date.now();
	const isStale = () => now.getTime() + (Date.now() - startedAt) - inboundMs > staleMs;
	const markStale = async (when: string) => {
		await updateLog(db, waMessageId, { status: 'STALE_IGNORED', errorCode: 'ERR_STALE_MESSAGE', errorMessage: `Message was stale ${when}.` });
		await logRun(t, 'WARN', ACTION, `Ignored stale message ${waMessageId} from ${masked} (${when}).`);
	};
	if (isStale()) return markStale('before processing started');

	try {
		let reply: string;
		let resultCode: string | null = null;
		if (context.household.waApproved !== 1) {
			// Replies go out from the deployment owner's WhatsApp number, so they are gated by the same
			// owner approval as the daily brief. One polite pointer instead of silence.
			reply = PENDING_APPROVAL_REPLY;
			resultCode = 'ERR_NOT_APPROVED';
		} else if (!text.trim()) {
			reply = HELP_REPLY;
			resultCode = 'ERR_UNSUPPORTED_MESSAGE';
		} else if (text.trim().toLowerCase() === 'budget') {
			reply = await buildDailyBriefText(t, settings, now);
		} else if (settings.ai_enabled === '1') {
			try {
				reply = await answerQuestion(env, t, text, now);
			} catch (error) {
				// No Anthropic key for this household: tell the user how to fix it instead of a coded error.
				if (!(error instanceof AssistantError) || error.code !== 'ERR_AI_CONFIG') throw error;
				await logRun(t, 'WARN', ACTION, `ai_enabled is on but the household has no usable Anthropic API key: ${error.message}`);
				reply = error.message;
				resultCode = error.code;
			}
			if (isStale()) return markStale('before the Claude reply was sent');
		} else {
			reply = AI_DISABLED_REPLY;
		}

		const outbound = await deliverReply(env, context, from, reply, waMessageId);
		await updateLog(db, waMessageId, {
			status: 'COMPLETED',
			errorCode: resultCode,
			outboundMessageId: outbound.messageId || null,
			outboundAt: outbound.sentAt ?? null,
		});
		await logRun(t, 'INFO', ACTION, `Replied to ${waMessageId} from ${masked}${settings.dry_run === '1' ? ' (dry run)' : ''}.`);
	} catch (error) {
		const code = errorCode(error, 'ERR_WHATSAPP_HANDLER');
		const message = errorText(error);
		await logRun(t, 'ERROR', ACTION, `Failed to handle ${waMessageId} from ${masked}: ${code}: ${message}`);
		await updateLog(db, waMessageId, { status: 'FAILED', errorCode: code, errorMessage: message.slice(0, 2000) });
		if (isStale()) return;
		try {
			const outbound = await deliverReply(env, context, from, codedErrorReply(code), waMessageId);
			if (outbound.messageId) await updateLog(db, waMessageId, { outboundMessageId: outbound.messageId, outboundAt: outbound.sentAt ?? null });
		} catch (sendError) {
			await logRun(t, 'ERROR', ACTION, `Could not send the error reply for ${waMessageId}: ${errorCode(sendError, 'ERR_WHATSAPP_SEND')}: ${errorText(sendError)}`);
		}
	}
}

/**
 * Handles one webhook payload: logs delivery-status events (global) and answers each inbound
 * message (route sender → household, dedup, window bookkeeping, stale check, Budget / Claude / help
 * reply — all within that household). Never throws.
 */
export async function processWebhookPayload(env: Env, db: D1Database, payload: unknown, now: Date): Promise<void> {
	try {
		const values = changeValues(payload);
		await logStatusEvents(db, values.flatMap((value) => listOf<StatusEvent>(value.statuses)));
		const messages = values.flatMap((value) => listOf<InboundMessage>(value.messages));
		const cache = new Map<number, HouseholdContext | null>();
		for (const message of messages) await handleInboundMessage(env, db, cache, message, now);
	} catch (error) {
		await logRun(db, 'ERROR', ACTION, `Webhook processing failed: ${errorText(error)}`);
	}
}
