import { defineConfig, mergeConfig } from 'vitest/config';

// eslint-disable-next-line @nx/enforce-module-boundaries -- workspace-root vitest config is allowed
import shared from '../../vitest.shared.js';

// PUB-1a — public-web vitest config. Mirrors the platform-admin shape. The only
// spec here is the scope:public wall-fires negative control, which spawns
// `nx show projects` + `eslint` subprocesses, so the timeout matches the
// platform control's 300s ceiling.
export default mergeConfig(
  shared,
  defineConfig({
    test: {
      include: ['src/tests/**/*.spec.ts'],
      testTimeout: 300_000,
    },
  }),
);
