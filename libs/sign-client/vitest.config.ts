import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

// Client Rule Consolidation C2-5 — the SAME spec files run here (vitest, the web side)
// and under mobile/sign Jest (jest.config.js roots + testMatch). They use the shared
// globals (describe / it / expect) only, so no runner-specific import is needed.
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
