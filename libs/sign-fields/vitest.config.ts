import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

// FIELD-PARITY-1 P1-1 — like libs/sign-client, the SAME spec files run here (vitest) and under
// mobile/sign Jest (jest.config.js roots + testMatch). Globals only (describe / it / expect).
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
