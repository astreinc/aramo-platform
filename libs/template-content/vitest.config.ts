import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    test: {
      globals: true,
      include: ['src/__tests__/**/*.test.ts'],
      coverage: { include: ['src/lib/**/*.ts'] },
    },
  }),
);
