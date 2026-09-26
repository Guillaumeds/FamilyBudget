// Official Workers Vitest integration: tests run inside workerd with the bindings from
// wrangler.jsonc (D1 via Miniflare). https://developers.cloudflare.com/workers/testing/vitest-integration/
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
	const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

	return {
		plugins: [
			cloudflareTest({
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// Test-only binding so test/apply-migrations.ts can apply the real migrations.
					bindings: { TEST_MIGRATIONS: migrations },
				},
			}),
		],
		test: {
			setupFiles: ['./test/apply-migrations.ts'],
		},
	};
});
