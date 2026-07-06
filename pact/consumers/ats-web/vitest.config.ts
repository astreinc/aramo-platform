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
      // PC-2 — the ats-web suite spans multiple domain files (engagement,
      // submittal) that all write the SAME ats-web-aramo-core.json. pact-js
      // merges interactions off disk, but parallel file execution races the
      // write (observed: 41 of 58 interactions survived). Force sequential
      // file execution + a single fork so each file merges the prior file's
      // interactions from disk (the portal-thin multi-file mechanism).
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true } },
    },
  }),
);
