import { defineConfig } from 'vitest/config';

// Runner for the tools/ scripts' unit specs (e.g. provision-e2e-recruiter).
// These specs are pure (no @aramo/* alias imports, no Nest boot), so a bare
// node-environment config suffices.
//   npx vitest run --config tools/vitest.config.ts
export default defineConfig({
  test: {
    root: __dirname,
    environment: 'node',
    include: ['**/*.spec.ts'],
  },
});
