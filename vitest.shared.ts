import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workspace-shared vitest config. Per-lib configs extend this so path-alias
// resolution and coverage settings stay consistent.
const root = resolve(fileURLToPath(import.meta.url), '..');

export default defineConfig({
  resolve: {
    alias: {
      '@aramo/common': resolve(root, 'libs/common/src/index.ts'),
      '@aramo/auth': resolve(root, 'libs/auth/src/index.ts'),
      '@aramo/consent': resolve(root, 'libs/consent/src/index.ts'),
      '@aramo/audit': resolve(root, 'libs/audit/src/index.ts'),
      '@aramo/engagement': resolve(root, 'libs/engagement/src/index.ts'),
      '@aramo/entrustability': resolve(root, 'libs/entrustability/src/index.ts'),
      '@aramo/events': resolve(root, 'libs/events/src/index.ts'),
      '@aramo/evidence': resolve(root, 'libs/evidence/src/index.ts'),
      '@aramo/examination': resolve(root, 'libs/examination/src/index.ts'),
      '@aramo/identity': resolve(root, 'libs/identity/src/index.ts'),
      '@aramo/ingestion': resolve(root, 'libs/ingestion/src/index.ts'),
      '@aramo/matching': resolve(root, 'libs/matching/src/index.ts'),
      '@aramo/skills-taxonomy': resolve(root, 'libs/skills-taxonomy/src/index.ts'),
      '@aramo/talent': resolve(root, 'libs/talent/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Coverage applies to product source only. Generated Prisma clients,
      // tests themselves, and the PrismaService connection wrapper (covered
      // by the integration suite, not unit tests) are excluded.
      include: ['src/lib/**/*.ts'],
      exclude: [
        'src/tests/**',
        '**/*.spec.ts',
        '**/*.test.ts',
        '**/prisma/generated/**',
        'src/lib/prisma/prisma.service.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
