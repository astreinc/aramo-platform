import { resolve } from 'node:path';

import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../../vitest.shared.js';

export default mergeConfig(
  shared,
  defineConfig({
    resolve: {
      alias: {
        // The client-only entry: the package barrel also exports Nest services
        // backed by Prisma clients, which the pact:consumer CI job never generates.
        '@aramo/intelligence-integration': resolve(__dirname, '../../../libs/intelligence-integration/src/client.ts'),
      },
    },
    test: {
      include: ['src/**/*.test.ts'],
      // Pact mock server start can be slow on cold cache
      testTimeout: 30_000,
      // Pact tests run sequentially — they share a per-suite mock server
      pool: 'forks',
      isolate: true,
    },
  }),
);
