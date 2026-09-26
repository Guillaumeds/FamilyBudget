/**
 * WhatsApp Cloud API client: free-form text, approved template messages (named parameters), the 24h
 * customer-service window, and the daily-brief delivery (text inside the window, template outside it,
 * dry-run logging instead of sending).
 *
 * Meta docs relied on:
 *   - Text messages: https://developers.facebook.com/docs/whatsapp/cloud-api/messages/text-messages
 *     (POST /{version}/{phone-number-id}/messages, text.body "Maximum 4096 characters", response
 *     `messages[0].id`).
 *   - Templates with named parameters:
 *     https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
 *     (`components: [{ type: 'body', parameters: [{ type: 'text', parameter_name, text }] }]`).
 *
 * Ported from legacy/Code.gs sendWhatsAppTextMessage (~1586).
 */
import { buildBriefData, renderBriefText, renderTemplateParams } from '../budget/brief';
import { insertMessageLog, logRun, type MessageLogInsert } from '../db/repo';
import { getSettings, type Settings, waWindowKey } from '../db/settings';
import type { Env } from '../env';
import { maskPhone } from '../lib/format';
import { isoNow } from '../lib/tz';

export type WhatsAppErrorCode = 'ERR_WHATSAPP_SEND' | 'ERR_WHATSAPP_CONFIG';

export class WhatsAppError extends Error {
	readonly code: WhatsAppErrorCode;
	/** HTTP status of a failed Graph API call. */
	readonly status?: number;
	/** First 500 characters of the failed response body. */
	readonly bodyExcerpt?: string;

	constructor(code: WhatsAppErrorCode, message: string, details: { status?: number; bodyExcerpt?: string } = {}) {
		super(message);
		this.name = 'WhatsAppError';
		this.code = code;
		this.status = details.status;
		this.bodyExcerpt = details.bodyExcerpt;
	}
}

/** Meta's limit for `text.body`. */
export const TEXT_BODY_MAX_CHARS = 4096;
/** The service window is 24h after the user's last message; keep a 30-minute safety margin. */
export const SERVICE_WINDOW_MS = 23.5 * 60 * 60 * 1000;
/** message_log.body is capped like the POC's MessageLog sheet. */
const LOG_BODY_MAX_CHARS = 4000;
const BRIEF_ACTION = 'whatsapp.brief';

// ---------------------------------------------------------------------------------------------
// Phone numbers & the 24h window
// ---------------------------------------------------------------------------------------------

function digitsOf(value: string | null | undefined): string {
	return String(value ?? '').replace(/\D/g, '');
}

/** '+' followed by the digits of `value` ('' when there are none). Webhook `from` values have no '+'. */
export function normalizeE164(value: string | null | undefined): string {
	const digits = digitsOf(value);
	return digits ? `+${digits}` : '';
}

/** True when both values contain the same (non-empty) digits, whatever the formatting. */
export function sameNumber(a: string | null | undefined, b: string | null | undefined): boolean {
	const digits = digitsOf(a);
	return digits !== '' && digits === digitsOf(b);
}

/** The comma-separated `whatsapp_to_numbers` setting as normalized, de-duplicated E.164 numbers. */
export function parseRecipients(value: string | null | undefined): string[] {
	const numbers = String(value ?? '')
		.split(',')
		.map(normalizeE164)
		.filter(Boolean);
	return [...new Set(numbers)];
}

/** Whether `to` messaged us less than 23.5h before `now` (free-form messages are allowed then). */
export function isWindowOpen(settings: Settings, to: string, now: Date): boolean {
	const lastInbound = Date.parse(settings[waWindowKey(normalizeE164(to))] ?? '');
	return Number.isFinite(lastInbound) && now.getTime() - lastInbound < SERVICE_WINDOW_MS;
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

/** Truncates to `max` UTF-16 units (ending in '…') without splitting a surrogate pair. */
function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = text.slice(0, max - 1);
	if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
	return `${cut}…`;
}

function recipientOrThrow(to: string): string {
	const recipient = normalizeE164(to);
	if (!recipient) throw new WhatsAppError('ERR_WHATSAPP_CONFIG', 'Recipient phone number is empty or invalid.');
	return recipient;
}

async function postMessage(env: Env, payload: Record<string, unknown>): Promise<{ messageId: string }> {
	const token = env.WHATSAPP_ACCESS_TOKEN?.trim();
	const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
	const version = env.WHATSAPP_API_VERSION?.trim();
	if (!token || !phoneNumberId || !version) {
		throw new WhatsAppError(
			'ERR_WHATSAPP_CONFIG',
			'WhatsApp is not configured: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_API_VERSION are required.',
		);
	}

	const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(phoneNumberId)}/messages`;
	let response: Response;
	try {
		response = await fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
		});
	} catch (error) {
		throw new WhatsAppError('ERR_WHATSAPP_SEND', `WhatsApp Cloud API request failed: ${errorText(error)}`);
	}

	const body = await response.text();
	let json: { messages?: Array<{ id?: string }>; error?: { message?: string } } = {};
	try {
		json = body ? JSON.parse(body) : {};
	} catch {
		// Non-JSON body — only the excerpt below is useful.
	}
	if (!response.ok) {
		const detail = json.error?.message ? ` — ${json.error.message}` : '';
		throw new WhatsAppError('ERR_WHATSAPP_SEND', `WhatsApp Cloud API failed: HTTP ${response.status}${detail}`, {
			status: response.status,
			bodyExcerpt: body.slice(0, 500),
		});
	}
	return { messageId: json.messages?.[0]?.id ?? '' };
}

/** Sends a free-form text message (only delivered inside the 24h service window). */
export async function sendText(env: Env, to: string, body: string): Promise<{ messageId: string }> {
	return postMessage(env, {
		to: recipientOrThrow(to),
		type: 'text',
		text: { preview_url: false, body: truncate(body, TEXT_BODY_MAX_CHARS) },
	});
}

/** Sends the configured approved template (`wa_template_name` / `wa_template_lang`) with named body parameters. */
export async function sendTemplate(
	env: Env,
	settings: Settings,
	to: string,
	params: Record<string, string>,
): Promise<{ messageId: string }> {
	const name = settings.wa_template_name?.trim();
	if (!name) throw new WhatsAppError('ERR_WHATSAPP_CONFIG', 'No WhatsApp template configured (wa_template_name setting).');
	const parameters = Object.entries(params).map(([parameter_name, text]) => ({ type: 'text', parameter_name, text }));
	return postMessage(env, {
		to: recipientOrThrow(to),
		type: 'template',
		template: {
			name,
			language: { code: settings.wa_template_lang?.trim() || 'en' },
			...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
		},
	});
}

// ---------------------------------------------------------------------------------------------
// Daily brief delivery
// ---------------------------------------------------------------------------------------------

export interface BriefSendResult {
	/** Masked recipient (see maskPhone). */
	to: string;
	mode: 'text' | 'template' | 'dry';
	messageId?: string;
	/** "<CODE>: <message>" when this recipient failed. */
	error?: string;
}

export interface DailyBriefOutcome {
	results: BriefSendResult[];
	/** Set when nothing was attempted ('whatsapp_disabled' | 'no_recipients'). */
	skippedReason?: string;
}

/**
 * Builds the daily brief once and delivers it to every configured recipient: free-form text inside
 * the 24h window, the approved template otherwise, or only logged when `dry_run` is '1'. A failing
 * recipient is recorded in its result (and run_log/message_log) without stopping the others.
 *
 * `options.recipients` overrides the `whatsapp_to_numbers` setting (e.g. an admin test send).
 * Errors while building the brief itself propagate to the caller.
 */
export async function sendDailyBrief(
	env: Env,
	db: D1Database,
	now: Date,
	options: { recipients?: string[] } = {},
): Promise<DailyBriefOutcome> {
	const settings = await getSettings(db);
	if (settings.whatsapp_enabled !== '1') {
		await logRun(db, 'INFO', BRIEF_ACTION, 'Daily brief skipped: WhatsApp is disabled (whatsapp_enabled).');
		return { results: [], skippedReason: 'whatsapp_disabled' };
	}
	const recipients = options.recipients ? parseRecipients(options.recipients.join(',')) : parseRecipients(settings.whatsapp_to_numbers);
	if (recipients.length === 0) {
		await logRun(db, 'INFO', BRIEF_ACTION, 'Daily brief skipped: no recipients configured (whatsapp_to_numbers).');
		return { results: [], skippedReason: 'no_recipients' };
	}

	const data = await buildBriefData(db, settings, now);
	const text = renderBriefText(data);
	const params = renderTemplateParams(data);
	const templateBody = `template ${settings.wa_template_name || '(not configured)'} ${JSON.stringify(params)}`;
	const dryRun = settings.dry_run === '1';

	const results: BriefSendResult[] = [];
	for (const to of recipients) {
		const masked = maskPhone(to);
		const mode = isWindowOpen(settings, to, now) ? 'text' : 'template';
		const logBody = (mode === 'text' ? text : templateBody).slice(0, LOG_BODY_MAX_CHARS);

		if (dryRun) {
			await logRun(
				db,
				'INFO',
				BRIEF_ACTION,
				`DRY RUN: would send the daily brief to ${masked} as ${mode === 'text' ? `text (${text.length} chars)` : `template ${settings.wa_template_name || '(not configured)'} (${Object.keys(params).length} params)`}.`,
			);
			await logMessage(db, { direction: 'out', status: 'DRY_RUN', fromNumber: masked, body: logBody });
			results.push({ to: masked, mode: 'dry' });
			continue;
		}

		try {
			const { messageId } = mode === 'text' ? await sendText(env, to, text) : await sendTemplate(env, settings, to, params);
			await logMessage(db, {
				direction: 'out',
				status: 'SENT',
				fromNumber: masked,
				body: logBody,
				outboundMessageId: messageId || null,
				outboundAt: isoNow(),
			});
			await logRun(db, 'INFO', BRIEF_ACTION, `Sent the daily brief to ${masked} as ${mode} (messageId=${messageId || 'n/a'}).`);
			results.push({ to: masked, mode, messageId });
		} catch (error) {
			const code = errorCode(error, 'ERR_WHATSAPP_SEND');
			const message = errorText(error);
			const excerpt = error instanceof WhatsAppError && error.bodyExcerpt ? ` body=${error.bodyExcerpt}` : '';
			await logRun(db, 'ERROR', BRIEF_ACTION, `Daily brief to ${masked} (${mode}) failed: ${code}: ${message}${excerpt}`);
			await logMessage(db, { direction: 'out', status: 'FAILED', fromNumber: masked, body: logBody, errorCode: code, errorMessage: message });
			results.push({ to: masked, mode, error: `${code}: ${message}` });
		}
	}
	return { results };
}

// ---------------------------------------------------------------------------------------------
// Shared helpers (also used by the webhook)
// ---------------------------------------------------------------------------------------------

/** The `code` of a coded error (WhatsAppError, AssistantError, ...), else `fallback`. */
export function errorCode(error: unknown, fallback: string): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === 'string' && code ? code : fallback;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** insertMessageLog for audit rows that must never break a send flow. */
export async function logMessage(db: D1Database, row: MessageLogInsert): Promise<void> {
	try {
		await insertMessageLog(db, row);
	} catch (error) {
		console.error(`message_log insert failed: ${errorText(error)}`);
	}
}
