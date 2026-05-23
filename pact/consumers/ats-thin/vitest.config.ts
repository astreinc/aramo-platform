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
      isolate: true,
      // F39 — disable inter-file parallelism — all test files write
      // to the same pact/pacts/ats-thin-aramo-core.json. Parallel file
      // execution can race the merge, losing interactions. Mirrors
      // M3 PR-9 portal-thin precedent.
      fileParallelism: false,
    },
  }),
);
