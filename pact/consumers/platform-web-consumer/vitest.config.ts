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
      // CCP-B2: several files write the SAME pact (platform-web → platform-admin); parallel
      // writers race and drop or corrupt interactions, so the files run one after another.
      fileParallelism: false,
    },
  }),
);
