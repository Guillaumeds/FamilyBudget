import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type BriefData, buildBriefData, renderBriefText, renderTemplateParams } from '../src/budget/brief';
import { listMessageLog, listRunLog } from '../src/db/repo';
import { getSettings, SETTING_DEFAULTS, type Settings, setSettings, waWindowKey } from '../src/db/settings';
import type { Env } from '../src/env';
import {
	isWindowOpen,
	normalizeE164,
	parseRecipients,
	sameNumber,
	sendDailyBrief,
	sendTemplate,
	sendText,
	TEXT_BODY_MAX_CHARS,
	WhatsAppError,
} from '../src/whatsapp/client';
import { GLOBAL_HID, tenant } from '../src/db/tenant';
import { HH1, HH2, resetDb } from './helpers';

// brief.ts is implemented in parallel — never run its real bodies here.
vi.mock('../src/budget/brief', () => ({
	buildBriefData: vi.fn(),
	renderBriefText: vi.fn(),
	renderTemplateParams: vi.fn(),
	buildDailyBriefText: vi.fn(),
}));

const db = env.DB;
const waEnv: Env = { ...env, WHATSAPP_ACCESS_TOKEN: 'test-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_API_VERSION: 'v26.0' };
const NOW = new Date('2026-09-26T08:00:00.000Z');
const ALICE = '+15550001111';
const BOB = '+15550002222';
const BRIEF_TEXT = '*Family Budget Brief*\nFri, 26 Sep 2026\n...';
const PARAMS = { date: 'Fri, 26 Sep 2026', expense_1: 'Groceries €12.34', expense_2: '–', overall_spent: '€100.00' };

type GraphPayload = Record<string, any>;

/** Fake Graph API: records payloads, answers like Meta (messages[0].id) unless `handler` returns a Response. */
function mockGraph(handler?: (payload: GraphPayload) => Response | undefined) {
	let sent = 0;
	return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
		const payload = JSON.parse(String(init?.body)) as GraphPayload;
		return (
			handler?.(payload) ??
			Response.json({ messaging_product: 'whatsapp', contacts: [{ input: payload.to }], messages: [{ id: `wamid.TEST${++sent}` }] })
		);
	});
}

function payloads(spy: ReturnType<typeof mockGraph>): GraphPayload[] {
	return spy.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as GraphPayload);
}

function settingsWith(values: Record<string, string>): Settings {
	return { ...SETTING_DEFAULTS, ...values } as Settings;
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	vi.mocked(buildBriefData).mockResolvedValue({ title: 'Family Budget Brief' } as BriefData);
	vi.mocked(renderBriefText).mockReturnValue(BRIEF_TEXT);
	vi.mocked(renderTemplateParams).mockReturnValue(PARAMS);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('numbers', () => {
	it('normalizeE164 keeps only digits behind a +', () => {
		expect(normalizeE164('15550001111')).toBe(ALICE);
		expect(normalizeE164(' +1 (555) 000-1111 ')).toBe(ALICE);
		expect(normalizeE164('')).toBe('');
		expect(normalizeE164(null)).toBe('');
	});

	it('sameNumber compares digits only', () => {
		expect(sameNumber('15550001111', ALICE)).toBe(true);
		expect(sameNumber('+1 555 000 1111', '15550001111')).toBe(true);
		expect(sameNumber(ALICE, BOB)).toBe(false);
		expect(sameNumber('', '')).toBe(false);
	});

	it('parseRecipients splits, normalizes and de-duplicates the setting', () => {
		expect(parseRecipients(` ${ALICE}, 15550002222,,+1 555 000 1111 `)).toEqual([ALICE, BOB]);
		expect(parseRecipients('')).toEqual([]);
	});
});

describe('isWindowOpen', () => {
	const at = (ms: number) => settingsWith({ [waWindowKey(ALICE)]: new Date(NOW.getTime() - ms).toISOString() });
	const WINDOW = 23.5 * 3600_000;

	it('is open just inside 23.5h and closed at/after it', () => {
		expect(isWindowOpen(at(0), ALICE, NOW)).toBe(true);
		expect(isWindowOpen(at(WINDOW - 1), ALICE, NOW)).toBe(true);
		expect(isWindowOpen(at(WINDOW), ALICE, NOW)).toBe(false);
		expect(isWindowOpen(at(24 * 3600_000), ALICE, NOW)).toBe(false);
	});

	it('looks the number up in normalized form', () => {
		expect(isWindowOpen(at(60_000), '15550001111', NOW)).toBe(true);
	});

	it('is closed without a (valid) inbound timestamp', () => {
		expect(isWindowOpen(settingsWith({}), ALICE, NOW)).toBe(false);
		expect(isWindowOpen(settingsWith({ [waWindowKey(ALICE)]: 'garbage' }), ALICE, NOW)).toBe(false);
		expect(isWindowOpen(at(60_000), BOB, NOW)).toBe(false);
	});
});

describe('sendText', () => {
	it('POSTs a text message to the versioned Graph endpoint with the bearer token', async () => {
		const spy = mockGraph();
		expect(await sendText(waEnv, '15550001111', 'Hello')).toEqual({ messageId: 'wamid.TEST1' });

		const [url, init] = spy.mock.calls[0]!;
		expect(String(url)).toBe('https://graph.facebook.com/v26.0/1234567890/messages');
		expect(init?.method).toBe('POST');
		expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-token');
		expect(payloads(spy)[0]).toEqual({
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			to: ALICE,
			type: 'text',
			text: { preview_url: false, body: 'Hello' },
		});
	});

	it(`truncates the body to Meta's ${TEXT_BODY_MAX_CHARS}-character limit`, async () => {
		const spy = mockGraph();
		await sendText(waEnv, ALICE, 'x'.repeat(5000));
		const body = payloads(spy)[0]!.text.body as string;
		expect(body).toHaveLength(TEXT_BODY_MAX_CHARS);
		expect(body.endsWith('…')).toBe(true);

		await sendText(waEnv, ALICE, 'y'.repeat(TEXT_BODY_MAX_CHARS));
		expect(payloads(spy)[1]!.text.body).toBe('y'.repeat(TEXT_BODY_MAX_CHARS));
	});

	it('fails with ERR_WHATSAPP_CONFIG and makes no request when credentials are missing', async () => {
		const spy = mockGraph();
		for (const missing of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'] as const) {
			const error = await sendText({ ...waEnv, [missing]: undefined }, ALICE, 'Hi').catch((e) => e);
			expect(error).toBeInstanceOf(WhatsAppError);
			expect(error.code).toBe('ERR_WHATSAPP_CONFIG');
		}
		await expect(sendText(waEnv, 'not a number', 'Hi')).rejects.toMatchObject({ code: 'ERR_WHATSAPP_CONFIG' });
		expect(spy).not.toHaveBeenCalled();
	});

	it('maps a non-2xx response to ERR_WHATSAPP_SEND with status and body excerpt', async () => {
		const metaError = { error: { message: '(#131030) Recipient phone number not in allowed list', type: 'OAuthException', code: 131030 } };
		mockGraph(() => Response.json(metaError, { status: 400 }));
		const error = await sendText(waEnv, ALICE, 'Hi').catch((e) => e);
		expect(error).toBeInstanceOf(WhatsAppError);
		expect(error).toMatchObject({ code: 'ERR_WHATSAPP_SEND', status: 400 });
		expect(error.message).toContain('HTTP 400');
		expect(error.message).toContain('Recipient phone number not in allowed list');
		expect(error.bodyExcerpt).toContain('131030');
	});
});

describe('sendTemplate', () => {
	it('sends the configured template with NAMED body parameters', async () => {
		const spy = mockGraph();
		const settings = settingsWith({ wa_template_name: 'daily_budget_update', wa_template_lang: 'en' });
		expect(await sendTemplate(waEnv, settings, ALICE, { date: 'Fri, 26 Sep 2026', overall_spent: '€100.00' })).toEqual({
			messageId: 'wamid.TEST1',
		});
		expect(payloads(spy)[0]).toEqual({
			messaging_product: 'whatsapp',
			recipient_type: 'individual',
			to: ALICE,
			type: 'template',
			template: {
				name: 'daily_budget_update',
				language: { code: 'en' },
				components: [
					{
						type: 'body',
						parameters: [
							{ type: 'text', parameter_name: 'date', text: 'Fri, 26 Sep 2026' },
							{ type: 'text', parameter_name: 'overall_spent', text: '€100.00' },
						],
					},
				],
			},
		});
	});

	it('fails with ERR_WHATSAPP_CONFIG when no template name is set', async () => {
		const spy = mockGraph();
		await expect(sendTemplate(waEnv, settingsWith({ wa_template_name: '  ' }), ALICE, PARAMS)).rejects.toMatchObject({
			code: 'ERR_WHATSAPP_CONFIG',
		});
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('sendDailyBrief', () => {
	const enabled = { whatsapp_enabled: '1', whatsapp_to_numbers: `${ALICE},${BOB}`, wa_template_name: 'daily_budget_update', dry_run: '0' };

	it('skips when WhatsApp is disabled, without building the brief', async () => {
		const spy = mockGraph();
		await setSettings(HH1, { ...enabled, whatsapp_enabled: '0' });
		expect(await sendDailyBrief(waEnv, HH1, NOW)).toEqual({ results: [], skippedReason: 'whatsapp_disabled' });
		expect(buildBriefData).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
	});

	it('skips a household whose WhatsApp is not approved by the owner, without building the brief', async () => {
		const spy = mockGraph();
		await setSettings(HH2, enabled);
		expect(await sendDailyBrief(waEnv, HH2, NOW)).toEqual({ results: [], skippedReason: 'not_approved' });
		expect(buildBriefData).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
		expect((await listRunLog(db, 1, 2))[0]).toMatchObject({ level: 'INFO', action: 'whatsapp.brief' });
	});

	it('uses the global template name/language when the household has none', async () => {
		const spy = mockGraph();
		await setSettings(tenant(db, GLOBAL_HID), { wa_template_name: 'global_brief', wa_template_lang: 'en_GB' });
		const { wa_template_name: _unused, ...household } = enabled;
		await setSettings(HH1, household);
		await sendDailyBrief(waEnv, HH1, NOW, { recipients: [ALICE] });
		expect(payloads(spy)[0]!.template).toMatchObject({ name: 'global_brief', language: { code: 'en_GB' } });
	});

	it('skips when there are no recipients', async () => {
		const spy = mockGraph();
		await setSettings(HH1, { ...enabled, whatsapp_to_numbers: ' , ' });
		expect(await sendDailyBrief(waEnv, HH1, NOW)).toEqual({ results: [], skippedReason: 'no_recipients' });
		expect(spy).not.toHaveBeenCalled();
	});

	it('dry run: logs DRY_RUN rows instead of sending', async () => {
		const spy = mockGraph();
		await setSettings(HH1, { ...enabled, dry_run: '1', [waWindowKey(ALICE)]: new Date(NOW.getTime() - 3600_000).toISOString() });

		const outcome = await sendDailyBrief(waEnv, HH1, NOW);
		expect(outcome.results).toEqual([
			{ to: '***1111', mode: 'dry' },
			{ to: '***2222', mode: 'dry' },
		]);
		expect(spy).not.toHaveBeenCalled();
		expect(buildBriefData).toHaveBeenCalledOnce();

		const rows = await listMessageLog(db, 10, 1);
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.direction === 'out' && row.status === 'DRY_RUN')).toBe(true);
		expect(rows.map((row) => row.fromNumber).sort()).toEqual(['***1111', '***2222']);
		expect(rows.find((row) => row.fromNumber === '***1111')!.body).toBe(BRIEF_TEXT); // window open → text
		expect(rows.find((row) => row.fromNumber === '***2222')!.body).toContain('daily_budget_update'); // closed → template
		const runLog = await listRunLog(db, 10, 1);
		expect(runLog.filter((row) => row.message.startsWith('DRY RUN'))).toHaveLength(2);
	});

	it('sends free-form text inside the 24h window and the template outside it', async () => {
		const spy = mockGraph();
		await setSettings(HH1, { ...enabled, [waWindowKey(ALICE)]: new Date(NOW.getTime() - 3600_000).toISOString() });

		const outcome = await sendDailyBrief(waEnv, HH1, NOW);
		expect(outcome).toEqual({
			results: [
				{ to: '***1111', mode: 'text', messageId: 'wamid.TEST1' },
				{ to: '***2222', mode: 'template', messageId: 'wamid.TEST2' },
			],
		});
		expect(buildBriefData).toHaveBeenCalledOnce();

		const [toAlice, toBob] = payloads(spy);
		expect(toAlice).toMatchObject({ to: ALICE, type: 'text', text: { body: BRIEF_TEXT } });
		expect(toBob).toMatchObject({ to: BOB, type: 'template', template: { name: 'daily_budget_update', language: { code: 'en' } } });
		expect(toBob!.template.components[0].parameters).toContainEqual({ type: 'text', parameter_name: 'expense_2', text: '–' });

		const rows = await listMessageLog(db, 10, 1);
		expect(rows.map((row) => [row.direction, row.status, row.fromNumber, row.outboundMessageId]).sort()).toEqual([
			['out', 'SENT', '***1111', 'wamid.TEST1'],
			['out', 'SENT', '***2222', 'wamid.TEST2'],
		]);
	});

	it('one failing recipient does not stop the other', async () => {
		mockGraph((payload) => (payload.to === ALICE ? Response.json({ error: { message: 'boom' } }, { status: 500 }) : undefined));
		await setSettings(HH1, enabled);

		const { results } = await sendDailyBrief(waEnv, HH1, NOW);
		expect(results[0]).toMatchObject({ to: '***1111', mode: 'template' });
		expect(results[0]!.error).toMatch(/^ERR_WHATSAPP_SEND: .*HTTP 500/);
		expect(results[1]).toEqual({ to: '***2222', mode: 'template', messageId: 'wamid.TEST1' });

		const errors = (await listRunLog(db, 10, 1)).filter((row) => row.level === 'ERROR');
		expect(errors).toHaveLength(1);
		expect(errors[0]!.message).toContain('***1111');
		const statuses = (await listMessageLog(db, 10, 1)).map((row) => row.status).sort();
		expect(statuses).toEqual(['FAILED', 'SENT']);
	});

	it('uses options.recipients instead of the setting', async () => {
		const spy = mockGraph();
		await setSettings(HH1, enabled);
		const { results } = await sendDailyBrief(waEnv, HH1, NOW, { recipients: ['15550002222'] });
		expect(results).toEqual([{ to: '***2222', mode: 'template', messageId: 'wamid.TEST1' }]);
		expect(payloads(spy).map((payload) => payload.to)).toEqual([BOB]);
		expect((await getSettings(HH1)).whatsapp_to_numbers).toBe(`${ALICE},${BOB}`);
	});
});
