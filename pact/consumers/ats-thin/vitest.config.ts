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
      // Pact tests run sequentially — they share a per-fork pact-rust
      // tokio runtime; the mock server teardown is signaled synchronously
      // through the FFI but completes asynchronously on the runtime.
      pool: 'forks',
      isolate: true,
      // F39 — disable inter-file parallelism — all test files write
      // to the same pact/pacts/ats-thin-aramo-core.json. Parallel file
      // execution can race the merge, losing interactions. Mirrors
      // M3 PR-9 portal-thin precedent.
      fileParallelism: false,
      // M6 PR-1 — afterEach setImmediate yield (see src/test-setup.ts)
      // closes the larger component of the pact-rust mock-server
      // port-reuse race (rate ~30% → ~7%). Stronger yields and per-test
      // PactV4 reinstantiation were tested and did not improve further.
      setupFiles: ['./src/test-setup.ts'],
    },
  }),
);
