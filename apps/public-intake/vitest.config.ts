import { defineConfig } from 'vitest/config';

// PUB-5 — public-intake is a scope:public leaf with ZERO @aramo/* imports, so
// its vitest config is self-contained (no vitest.shared.js alias table — there
// is nothing to alias). The negative-control spec spawns nx + eslint
// subprocesses, hence the wide timeout.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    testTimeout: 300_000,
  },
});
