import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApiRequest } from '../src/api/routes';
import { listRunLog } from '../src/db/repo';
import type { Env } from '../src/env';
import worker from '../src/index';
import { runScheduled } from '../src/scheduled';
import { handleWebhookGet, handleWebhookPost } from '../src/whatsapp/webhook';
import { resetDb } from './helpers';

// The setup file imports cloudflare:test, which also imports the main Worker, so src/index.ts's whole
// module graph is already cached (unmocked) when this file starts. Drop it so the vi.mock() calls
// below apply to every module this file imports.

// The entry point is only wiring: every handler module is mocked at its boundary.
vi.mock('../src/api/routes', () => ({ handleApiRequest: vi.fn() }));
vi.mock('../src/whatsapp/webhook', () => ({ handleWebhookGet: vi.fn(), handleWebhookPost: vi.fn() }));
vi.mock('../src/scheduled', () => ({ runScheduled: vi.fn() }));

// Correctly-typed Request for calling worker.fetch() directly (pattern from the official template).
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const assets = vi.fn(async (_request: Request) => new Response('asset'));
const testEnv: Env = { ...env, ASSETS: { fetch: assets } as unknown as Fetcher };

async function call(path: string, init?: RequestInit<IncomingRequestCfProperties>): Promise<{ response: Response; request: Request; ctx: ExecutionContext }> {
	const request = new IncomingRequest(`https://example.com${path}`, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);
	return { response, request, ctx };
}

beforeEach(async () => {
	await resetDb();
	vi.clearAllMocks();
	vi.mocked(handleWebhookGet).mockReturnValue(new Response('challenge-123'));
	vi.mocked(handleWebhookPost).mockResolvedValue(new Response('EVENT_RECEIVED'));
	vi.mocked(handleApiRequest).mockResolvedValue(Response.json({ api: true }));
	vi.mocked(runScheduled).mockResolvedValue();
});

describe('fetch', () => {
	it('GET /health → {ok:true} (through the real Worker entrypoint)', async () => {
		const response = await exports.default.fetch('https://example.com/health');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it('GET /webhook → handleWebhookGet', async () => {
		const { response, request } = await call('/webhook?hub.mode=subscribe');
		expect(await response.text()).toBe('challenge-123');
		expect(vi.mocked(handleWebhookGet).mock.calls[0]![0]).toBe(request);
		expect(handleWebhookPost).not.toHaveBeenCalled();
	});

	it('POST /webhook → handleWebhookPost with the execution context', async () => {
		const { response, request, ctx } = await call('/webhook', { method: 'POST', body: '{}' });
		expect(await response.text()).toBe('EVENT_RECEIVED');
		const [req, , passedCtx] = vi.mocked(handleWebhookPost).mock.calls[0]!;
		expect(req).toBe(request);
		expect(passedCtx).toBe(ctx);
		expect(handleWebhookGet).not.toHaveBeenCalled();
	});

	it('other methods on /webhook → 405', async () => {
		const { response } = await call('/webhook', { method: 'PUT', body: '{}' });
		expect(response.status).toBe(405);
		expect(response.headers.get('Allow')).toBe('GET, POST');
		expect(handleWebhookGet).not.toHaveBeenCalled();
		expect(handleWebhookPost).not.toHaveBeenCalled();
	});

	it.each(['/api', '/api/summary', '/api/admin/sync?full=1'])('%s → handleApiRequest', async (path) => {
		const { response, request, ctx } = await call(path);
		expect(await response.json()).toEqual({ api: true });
		const [req, , passedCtx] = vi.mocked(handleApiRequest).mock.calls[0]!;
		expect(req).toBe(request);
		expect(passedCtx).toBe(ctx);
	});

	it('an /api path the API does not handle (null) → 404 JSON', async () => {
		vi.mocked(handleApiRequest).mockResolvedValue(null);
		const { response } = await call('/api/nope');
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: 'Not found' });
	});

	it('delegates everything else to the ASSETS binding', async () => {
		const { response, request } = await call('/some/page');
		expect(await response.text()).toBe('asset');
		expect(assets).toHaveBeenCalledWith(request);
		expect(handleApiRequest).not.toHaveBeenCalled();
	});

	it('an unexpected error → 500 without details, logged to run_log', async () => {
		vi.mocked(handleApiRequest).mockRejectedValue(new Error('secret detail: D1_ERROR near "SELEC"'));
		const { response } = await call('/api/summary');

		expect(response.status).toBe(500);
		const body = await response.text();
		expect(JSON.parse(body)).toEqual({ error: 'Internal server error' });
		expect(body).not.toContain('secret');

		const [row] = await listRunLog(env.DB, 1);
		expect(row).toMatchObject({ level: 'ERROR', action: 'fetch' });
		expect(row!.message).toContain('GET /api/summary');
		expect(row!.message).toContain('secret detail');
	});
});

describe('scheduled', () => {
	it('runs the dispatcher in ctx.waitUntil with the tick’s scheduledTime', async () => {
		let finished = false;
		vi.mocked(runScheduled).mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			finished = true;
		});
		const scheduledTime = new Date('2026-09-26T08:00:00Z');
		const controller = createScheduledController({ scheduledTime, cron: '0 * * * *' });
		const ctx = createExecutionContext();

		await worker.scheduled(controller, testEnv, ctx);
		expect(finished).toBe(false); // handed to waitUntil, not awaited inline
		await waitOnExecutionContext(ctx);
		expect(finished).toBe(true);

		const [passedEnv, passedCtx, now] = vi.mocked(runScheduled).mock.calls[0]!;
		expect(passedEnv).toBe(testEnv);
		expect(passedCtx).toBe(ctx);
		expect(now).toEqual(scheduledTime);
	});
});
