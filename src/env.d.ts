/**
 * The Worker's `env` contract. Import it with `import type { Env } from './env'`.
 *
 * Bindings (DB, ASSETS) and vars are generated from wrangler.jsonc into worker-configuration.d.ts
 * (`npm run cf-typegen`, global `Cloudflare.Env`). Secrets are declared here instead of being
 * inferred from a local `.dev.vars`, so the type is identical on every machine and in CI. They are
 * optional on purpose: WhatsApp and Claude features must degrade gracefully when not configured.
 */

/** Set with `wrangler secret put <NAME>`; locally via `.dev.vars` (see `.dev.vars.example`). */
export interface Secrets {
	WALLET_API_TOKEN?: string;
	WHATSAPP_ACCESS_TOKEN?: string;
	WHATSAPP_PHONE_NUMBER_ID?: string;
	WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
	META_APP_SECRET?: string;
	ANTHROPIC_API_KEY?: string;
	DASHBOARD_PASSWORD?: string;
	SESSION_SECRET?: string;
}

type Vars = 'WALLET_API_BASE_URL' | 'WHATSAPP_API_VERSION';

export interface Env extends Omit<Cloudflare.Env, keyof Secrets | Vars>, Secrets {
	DB: D1Database;
	ASSETS: Fetcher;
	/** Wallet REST base URL (wrangler.jsonc vars). */
	WALLET_API_BASE_URL: string;
	/** Meta Graph API version for WhatsApp Cloud API calls, e.g. "v26.0" (wrangler.jsonc vars). */
	WHATSAPP_API_VERSION: string;
}
