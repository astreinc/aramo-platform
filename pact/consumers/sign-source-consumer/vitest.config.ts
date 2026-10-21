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
      // DOC-TEMPLATE-LIB-1 T-5 — three test files now merge interactions into ONE pact file
      // (sign-service-aramo-core.json); parallel forks race on that write (an interaction
      // was observed lost / the JSON truncated), so the files run one after another.
      fileParallelism: false,
    },
  }),
);
