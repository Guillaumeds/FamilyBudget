import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

// Setup files run outside the per-test-file storage isolation and may run several times.
// applyD1Migrations() only applies migrations that have not been applied yet, so this is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
