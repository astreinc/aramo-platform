import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/tests/**/*.spec.ts'],
      // Integration specs (ARAMO_RUN_INTEGRATION=1) drive real HTTP + Postgres and
      // some seed many rows per test (the sweep/pagination cases) — the 5s default
      // per-test timeout is too tight under container load. Raise it for integration
      // runs (mirrors libs/talent-trust). Unit runs keep the fast default.
      testTimeout: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? 120_000 : 5_000,
    },
  }),
);
