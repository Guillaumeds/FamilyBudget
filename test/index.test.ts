import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listRunLog } from '../src/db/repo';
import worker from '../src/index';
import { resetDb } from './helpers';

// Correctly-typed Request for calling worker.fetch() directly (pattern from the official template).
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

beforeEach(resetDb);

describe('fetch', () => {
	it('GET /health → {ok:true}', async () => {
		const response = await exports.default.fetch('https://example.com/health');
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it.each([
		['/api/summary', 'api/routes.ts'],
		['/api', 'api/routes.ts'],
		['/webhook', 'whatsapp/webhook.ts'],
	])('%s → 501 placeholder', async (path, module) => {
		const response = await exports.default.fetch(`https://example.com${path}`);
		expect(response.status).toBe(501);
		expect(await response.json()).toMatchObject({ ok: false, module });
	});

	it('delegates everything else to the ASSETS binding', async () => {
		const assets = vi.fn(async () => new Response('asset'));
		const request = new IncomingRequest('https://example.com/some/page');
		const response = await worker.fetch(request, { ...env, ASSETS: { fetch: assets } as unknown as Fetcher }, createExecutionContext());
		expect(await response.text()).toBe('asset');
		expect(assets).toHaveBeenCalledWith(request);
	});
});

describe('scheduled', () => {
	it('records the tick in run_log', async () => {
		const controller = createScheduledController({ scheduledTime: new Date('2026-09-26T08:00:00Z'), cron: '0 * * * *' });
		const ctx = createExecutionContext();
		await worker.scheduled(controller, env, ctx);
		await waitOnExecutionContext(ctx);

		const [row] = await listRunLog(env.DB, 1);
		expect(row).toMatchObject({ level: 'INFO', action: 'scheduled' });
		expect(row!.message).toContain('2026-09-26T08:00:00.000Z');
	});
});
