/**
 * Wallet Budget Companion — Worker entry point.
 *
 * Static dashboard files in ./public are served by Workers Assets without invoking this code; the
 * Worker runs first only for /api/* and /webhook* (see `assets.run_worker_first` in wrangler.jsonc)
 * and for paths that match no asset (e.g. /health), which fall through to env.ASSETS here.
 */
import { handleApiRequest } from './api/routes';
import { logRun } from './db/repo';
import type { Env } from './env';
import { runScheduled } from './scheduled';
import { handleWebhookGet, handleWebhookPost } from './whatsapp/webhook';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === '/health') {
				return Response.json({ ok: true });
			}

			if (pathname === '/webhook') {
				if (request.method === 'GET') return handleWebhookGet(request, env);
				if (request.method === 'POST') return await handleWebhookPost(request, env, ctx);
				return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, POST' } });
			}

			if (pathname === '/api' || pathname.startsWith('/api/')) {
				return (await handleApiRequest(request, env, ctx)) ?? Response.json({ error: 'Not found' }, { status: 404 });
			}

			return await env.ASSETS.fetch(request);
		} catch (error) {
			// Details go to run_log / Workers Logs only — never into the response.
			const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
			await logRun(env.DB, 'ERROR', 'fetch', `Unhandled error on ${request.method} ${pathname}: ${detail}`);
			return Response.json({ error: 'Internal server error' }, { status: 500 });
		}
	},

	// https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/ — scheduledTime is the
	// tick's intended time (ms since epoch, UTC), so a delayed or replayed run still dispatches correctly.
	scheduled(controller, env, ctx): void {
		ctx.waitUntil(runScheduled(env, ctx, new Date(controller.scheduledTime)));
	},
} satisfies ExportedHandler<Env>;
