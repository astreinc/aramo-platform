import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// Workspace-shared vitest config. Per-lib configs extend this so path-alias
// resolution and coverage settings stay consistent.
const root = resolve(fileURLToPath(import.meta.url), '..');

export default defineConfig({
  resolve: {
    alias: {
      // PR-14 Amendment v1.0 §2.1 (engineering Lead/Architect, 2026-05-17):
      // mirrors the tsconfig.base.json @aramo/api alias so vitest runtime
      // resolves the test-bootstrap import in pact/provider/src/verify-api.ts.
      // eslint-side boundary override extended in the same PR-14 §4.9 edit.
      '@aramo/api': resolve(root, 'apps/api/src/app.module.ts'),
      '@aramo/common': resolve(root, 'libs/common/src/index.ts'),
      '@aramo/auth': resolve(root, 'libs/auth/src/index.ts'),
      // Amendment v1.3 §3.2 (engineering Lead/Architect, 2026-05-15):
      // mirrors the tsconfig.base.json @aramo/auth-service alias so vitest
      // runtime resolves the test-bootstrap import in pact/provider/src/
      // verify.ts. eslint-side boundary override is scoped to that file pair.
      '@aramo/auth-service': resolve(root, 'apps/auth-service/src/app/auth/auth.module.ts'),
      '@aramo/auth-storage': resolve(root, 'libs/auth-storage/src/index.ts'),
      // PR-A1a §3 — new leaf lib hosting RolesGuard + @RequireScopes /
      // @RequireSiteMatch decorators. Mirrors tsconfig.base.json
      // @aramo/authorization alias so vitest runtime resolves the
      // AppModule import (apps/api wires AuthorizationModule).
      '@aramo/authorization': resolve(root, 'libs/authorization/src/index.ts'),
      '@aramo/consent': resolve(root, 'libs/consent/src/index.ts'),
      '@aramo/ai-draft': resolve(root, 'libs/ai-draft/src/index.ts'),
      '@aramo/audit': resolve(root, 'libs/audit/src/index.ts'),
      '@aramo/engagement': resolve(root, 'libs/engagement/src/index.ts'),
      // PR-A1b §2 — new leaf lib hosting EntitlementGuard + @RequireCapability
      // decorator. Mirrors tsconfig.base.json @aramo/entitlement alias so
      // vitest runtime resolves the AppModule import (apps/api wires
      // EntitlementModule).
      '@aramo/entitlement': resolve(root, 'libs/entitlement/src/index.ts'),
      '@aramo/entrustability': resolve(root, 'libs/entrustability/src/index.ts'),
      '@aramo/events': resolve(root, 'libs/events/src/index.ts'),
      '@aramo/evidence': resolve(root, 'libs/evidence/src/index.ts'),
      '@aramo/examination': resolve(root, 'libs/examination/src/index.ts'),
      '@aramo/identity': resolve(root, 'libs/identity/src/index.ts'),
      '@aramo/ingestion': resolve(root, 'libs/ingestion/src/index.ts'),
      '@aramo/job-domain': resolve(root, 'libs/job-domain/src/index.ts'),
      '@aramo/matching': resolve(root, 'libs/matching/src/index.ts'),
      // M6 PR-2 §4 — new leaf lib hosting the relocated outbox-publisher.
      // Mirrors tsconfig.base.json @aramo/outbox-publisher alias so
      // vitest runtime resolves the apps/api AppModule import.
      '@aramo/outbox-publisher': resolve(root, 'libs/outbox-publisher/src/index.ts'),
      // M3 PR-9 §4.4 — portal lib alias for vitest runtime so the
      // AppModule import in pact/provider/src/verify-api.ts (and the
      // apps/api negative-shape integration spec) resolves PortalModule.
      '@aramo/portal': resolve(root, 'libs/portal/src/index.ts'),
      '@aramo/skills-taxonomy': resolve(root, 'libs/skills-taxonomy/src/index.ts'),
      '@aramo/submittal': resolve(root, 'libs/submittal/src/index.ts'),
      '@aramo/talent': resolve(root, 'libs/talent/src/index.ts'),
      '@aramo/talent-evidence': resolve(root, 'libs/talent-evidence/src/index.ts'),
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
