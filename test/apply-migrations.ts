import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';

// Setup files run outside the per-test-file storage isolation and may run several times.
// applyD1Migrations() only applies migrations that have not been applied yet, so this is safe.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// @cloudflare/vitest-plugin appends `import "<main>"` to cloudflare:test, so the Worker's whole
// import graph (src/index.ts and everything it reaches) is loaded before any test file runs.
// Without this reset, those already-instantiated modules keep their real dependencies and
// vi.mock() in test files silently has no effect.
vi.resetModules();
