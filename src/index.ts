/**
 * Wallet Budget Companion — Worker entry point.
 *
 * Static dashboard files in ./public are served by Workers Assets without invoking this code; the
 * Worker runs first only for /api/* and /webhook* (see `assets.run_worker_first` in wrangler.jsonc)
 * and for paths that match no asset (e.g. /health).
 */
import type { Env } from './env';
import { runScheduled } from './scheduled';

function notImplemented(module: string): Response {
	return Response.json({ ok: false, error: 'not_implemented', module }, { status: 501 });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);

		if (pathname === '/health') {
			return Response.json({ ok: true });
		}

		if (pathname.startsWith('/webhook')) {
			// TODO(phase 6): WhatsApp webhook — GET verify + POST signature check, fast ACK, work in ctx.waitUntil.
			// return handleWebhook(request, env, ctx) from ./whatsapp/webhook.ts
			return notImplemented('whatsapp/webhook.ts');
		}

		if (pathname === '/api' || pathname.startsWith('/api/')) {
			// TODO(phase 9): dashboard JSON API, session auth and admin endpoints.
			// return handleApi(request, env, ctx) from ./api/routes.ts
			return notImplemented('api/routes.ts');
		}

		return env.ASSETS.fetch(request);
	},

	async scheduled(controller, env, ctx): Promise<void> {
		await runScheduled(env, ctx, new Date(controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;
