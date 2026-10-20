import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      testTimeout: 30_000,
      pool: 'forks',
      isolate: true,
    },
  }),
);
