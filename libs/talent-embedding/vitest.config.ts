import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/tests/**/*.spec.ts'],
      // Integration tests are opt-in (require Docker/Testcontainers + the pgvector image).
      // CI's tests:integration job sets ARAMO_RUN_INTEGRATION=1 to include them.
      exclude: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? [] : ['**/*.integration.spec.ts'],
      testTimeout: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? 120_000 : 5_000,
    },
  }),
);
