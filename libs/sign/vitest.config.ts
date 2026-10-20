import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

// DOC-4 — esign now imports @aramo/documents-rendering (executed-document
// production), so its tests need the workspace path-alias resolution the shared
// config provides. Mirrors libs/documents/vitest.config.ts.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/tests/**/*.spec.ts'],
      exclude: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? [] : ['**/*.integration.spec.ts'],
      testTimeout: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? 120_000 : 5_000,
    },
  }),
);
