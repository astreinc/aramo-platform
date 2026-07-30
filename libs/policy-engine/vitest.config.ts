import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

// New-lib convention: a per-lib vitest.config.ts that merges the workspace
// shared config and pins `include` to src/tests/** (a co-located spec outside
// src/tests would silently never run). policy-engine is a pure, synchronous
// evaluator — no integration specs — but the ARAMO_RUN_INTEGRATION shape is
// kept for symmetry with the other leaf libs.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/tests/**/*.spec.ts'],
      exclude: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? [] : ['**/*.integration.spec.ts'],
      testTimeout: process.env['ARAMO_RUN_INTEGRATION'] === '1' ? 120_000 : 5_000,
    },
  }),
);
