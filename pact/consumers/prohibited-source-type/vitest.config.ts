import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      // Pact mock server start can be slow on cold cache
      testTimeout: 30_000,
      // Pact tests run sequentially — they share a per-suite mock server
      pool: 'forks',
      isolate: false,
    },
  }),
);
