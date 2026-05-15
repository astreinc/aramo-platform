import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      // Directive §4 names `verify.ts` as the main verifier entry point.
      // auth-helpers.ts and state-handlers.ts are imported by it; they
      // are not test files and are excluded from discovery.
      include: ['src/verify.ts'],
      // Provider verification starts a real Nest app + Postgres container.
      // Match the auth-service integration suite's wall-clock budget.
      testTimeout: 180_000,
      pool: 'forks',
      isolate: false,
    },
  }),
);
