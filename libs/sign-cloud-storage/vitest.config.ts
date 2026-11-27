import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

// SIGN-FREE-PARITY-1 S6 — the provider HTTP clients are tested with a mocked fetch only
// (no network).
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
