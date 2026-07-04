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
      // PR-A5a Gate 5 — activity leaf (sidecar to the pipeline state
      // machine). Mirrors tsconfig.base.json alias so vitest runtime
      // resolves the apps/api AppModule import + the integration spec.
      '@aramo/activity': resolve(root, 'libs/activity/src/index.ts'),
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
      // PR-A6 Gate 5+6 (combined) — calendar leaf (recruiter-facing
      // event log; owner-or-admin edit/delete predicate, the A3 shape).
      // Mirrors tsconfig.base.json alias so vitest runtime resolves
      // the apps/api AppModule import + the A6 integration spec.
      '@aramo/calendar': resolve(root, 'libs/calendar/src/index.ts'),
      // T2-2a — canonicalization orchestrator leaf. Mirrors
      // tsconfig.base.json @aramo/canonicalization alias so vitest runtime
      // resolves the apps/api AppModule import + the canonicalization
      // integration / tripwire / drift specs.
      '@aramo/canonicalization': resolve(root, 'libs/canonicalization/src/index.ts'),
      // Cold-Ingest Extraction — the resolved-arrival → declared-evidence poll
      // (scope:cip). Mirrors tsconfig.base.json @aramo/cold-ingest-extraction so
      // vitest resolves the apps/api AppModule import + the lib's unit/integration
      // specs.
      '@aramo/cold-ingest-extraction': resolve(root, 'libs/cold-ingest-extraction/src/index.ts'),
      '@aramo/consent': resolve(root, 'libs/consent/src/index.ts'),
      // PR-A2 Gate 5 — first ATS-domain leaves (company + contact). Mirrors
      // tsconfig.base.json aliases so vitest runtime resolves the AppModule
      // imports + cross-lib edge contact -> company in the integration specs.
      '@aramo/company': resolve(root, 'libs/company/src/index.ts'),
      '@aramo/contact': resolve(root, 'libs/contact/src/index.ts'),
      '@aramo/ai-draft': resolve(root, 'libs/ai-draft/src/index.ts'),
      // PR-A4 Gate 5 — attachment leaf (polymorphic file metadata,
      // typed owner_type discriminator). Imports @aramo/talent-record
      // for service-layer owner validation on the `talent` owner path.
      '@aramo/attachment': resolve(root, 'libs/attachment/src/index.ts'),
      '@aramo/audit': resolve(root, 'libs/audit/src/index.ts'),
      '@aramo/engagement': resolve(root, 'libs/engagement/src/index.ts'),
      // PR-A1b §2 — new leaf lib hosting EntitlementGuard + @RequireCapability
      // decorator. Mirrors tsconfig.base.json @aramo/entitlement alias so
      // vitest runtime resolves the AppModule import (apps/api wires
      // EntitlementModule).
      '@aramo/entitlement': resolve(root, 'libs/entitlement/src/index.ts'),
      '@aramo/events': resolve(root, 'libs/events/src/index.ts'),
      '@aramo/evidence': resolve(root, 'libs/evidence/src/index.ts'),
      '@aramo/examination': resolve(root, 'libs/examination/src/index.ts'),
      // PR-A8-4 Gate 5 — export leaf (ATS CSV export, R10 + A3-visibility
      // guarded). Mirrors tsconfig.base.json @aramo/export alias so the
      // vitest runtime resolves the AppModule import (apps/api wires
      // ExportModule) and the apps/api integration spec.
      '@aramo/export': resolve(root, 'libs/export/src/index.ts'),
      // AUTHZ-D5 — field-masking leaf (the scope→field-set map + the
      // omit-by-scope function; cycle-safe terminal lib called from the
      // apps/api CompensationFieldMaskInterceptor). Mirrors
      // tsconfig.base.json @aramo/field-masking alias so vitest runtime
      // resolves the apps/api AppModule import + the D5 catalog tests.
      '@aramo/field-masking': resolve(root, 'libs/field-masking/src/index.ts'),
      '@aramo/identity': resolve(root, 'libs/identity/src/index.ts'),
      // Step 4b (ADR-0016) — identity-index leaf (the PII-free cross-tenant
      // resolution index; PersonCluster + the fingerprint store). Mirrors
      // tsconfig.base.json so vitest runtime resolves the @aramo/identity-index
      // import added to CanonicalizationModule (the first cross-lib runtime
      // importer). The add-alias-in-same-PR lesson.
      '@aramo/identity-index': resolve(root, 'libs/identity-index/src/index.ts'),
      // PR-A8-1 Gate 5 — import-engine leaf (audited reversible batches
      // + partial-commit). Mirrors tsconfig.base.json alias so vitest
      // runtime resolves the apps/api AppModule import + the A8-1
      // integration spec.
      '@aramo/import': resolve(root, 'libs/import/src/index.ts'),
      '@aramo/ingestion': resolve(root, 'libs/ingestion/src/index.ts'),
      '@aramo/job-domain': resolve(root, 'libs/job-domain/src/index.ts'),
      '@aramo/matching': resolve(root, 'libs/matching/src/index.ts'),
      // PR-A1c §2 — new leaf lib hosting the recordUsage helper. Mirrors
      // tsconfig.base.json @aramo/metering alias so vitest runtime
      // resolves the helper from engagement + submittal repos (the two
      // domains that emit metered events inside their existing
      // $transaction arrays). Leaf: deps = @aramo/common + 'uuid'; no
      // back-edge into any domain.
      '@aramo/metering': resolve(root, 'libs/metering/src/index.ts'),
      // Email-S1 — generic transactional mailer leaf. Invite-S2 wires
      // MailerModule into IdentityModule (the invite/acceptance email path),
      // so apps/api + libs/identity specs that boot that graph resolve
      // @aramo/mailer at vitest runtime. Mirrors tsconfig.base.json.
      // (The add-alias-in-same-PR lesson.)
      '@aramo/mailer': resolve(root, 'libs/mailer/src/index.ts'),
      // A8-3a — new leaf lib hosting the S3 object-storage substrate
      // (S3 client + presigned PUT/GET helpers + tenant-scoped key
      // convention + PII-floor access-log redaction). Mirrors
      // tsconfig.base.json @aramo/object-storage alias so vitest
      // runtime resolves the apps/api AppModule import.
      '@aramo/object-storage': resolve(root, 'libs/object-storage/src/index.ts'),
      // M6 PR-2 §4 — new leaf lib hosting the relocated outbox-publisher.
      // Mirrors tsconfig.base.json @aramo/outbox-publisher alias so
      // vitest runtime resolves the apps/api AppModule import.
      '@aramo/outbox-publisher': resolve(root, 'libs/outbox-publisher/src/index.ts'),
      // M3 PR-9 §4.4 — portal lib alias for vitest runtime so the
      // AppModule import in pact/provider/src/verify-api.ts (and the
      // apps/api negative-shape integration spec) resolves PortalModule.
      '@aramo/portal': resolve(root, 'libs/portal/src/index.ts'),
      // PR-A5a Gate 5 — pipeline state-machine leaf (sibling to activity).
      // Mirrors tsconfig.base.json alias so vitest runtime resolves the
      // apps/api AppModule import + the state-machine proof spec.
      '@aramo/pipeline': resolve(root, 'libs/pipeline/src/index.ts'),
      // PR-A7 Gate 5 — reporting + dashboard leaf (ATS-internal read
      // aggregator over the 8 ATS-side schemas; NO Core/engagement/
      // submittal read, the seam-exclusion is structural). Mirrors
      // tsconfig.base.json alias so vitest runtime resolves the
      // apps/api AppModule import + the A7 integration spec.
      '@aramo/reporting': resolve(root, 'libs/reporting/src/index.ts'),
      // PR-A3 Gate 5 — second ATS-domain leaf (requisition). Mirrors
      // tsconfig.base.json alias so vitest runtime resolves the
      // AppModule import + the assignment-visibility integration spec.
      '@aramo/requisition': resolve(root, 'libs/requisition/src/index.ts'),
      // A8-3b — résumé parse leaf (deterministic text-extraction + heuristic
      // field-extraction; NO LLM per ADR-0015 Decision 10). Mirrors
      // tsconfig.base.json @aramo/resume-parse alias so vitest runtime
      // resolves the apps/api AppModule import + the A8-3b integration spec.
      //
      // Lesson APPLIED PROACTIVELY (A8-3a 6th-place lesson, confirmed by
      // use here): adding the vitest alias entry IN THE SAME PR as the lib
      // introduction, instead of discovering at suite-load.
      '@aramo/resume-parse': resolve(root, 'libs/resume-parse/src/index.ts'),
      // PR-A6 Gate 5+6 (combined) — saved-list leaf (typed-polymorphic
      // static-list, the A4 shape generalized to all 4 ATS entities).
      // Mirrors tsconfig.base.json alias so vitest runtime resolves
      // the apps/api AppModule import + the A6 integration spec.
      '@aramo/saved-list': resolve(root, 'libs/saved-list/src/index.ts'),
      // Settings S1 — settings leaf (the tenant-config foundation:
      // TenantSettingService + the closed-set KNOWN_SETTINGS registry).
      // Mirrors tsconfig.base.json @aramo/settings alias so vitest runtime
      // resolves the apps/api AppModule import (SettingsModule wiring) +
      // the settings-tenant-get integration spec.
      '@aramo/settings': resolve(root, 'libs/settings/src/index.ts'),
      '@aramo/skills-taxonomy': resolve(root, 'libs/skills-taxonomy/src/index.ts'),
      // Fix-Slice-1 — sourced-talent L1 staging leaf (scope:cip). Mirrors the
      // tsconfig.base.json @aramo/sourced-talent path so vitest runtime resolves
      // the public surface. No consumer imports it yet (substrate-only slice);
      // the alias lands now for template parity + fix-slice-2's cross-lib wiring.
      '@aramo/sourced-talent': resolve(root, 'libs/sourced-talent/src/index.ts'),
      '@aramo/submittal': resolve(root, 'libs/submittal/src/index.ts'),
      '@aramo/talent': resolve(root, 'libs/talent/src/index.ts'),
      '@aramo/talent-evidence': resolve(root, 'libs/talent-evidence/src/index.ts'),
      // Gate-1 G1-A — talent-extraction (declared-evidence production; 3rd
      // ai-draft consumer per ADR-0015 v1.3).
      '@aramo/talent-extraction': resolve(root, 'libs/talent-extraction/src/index.ts'),
      // PR-A4 Gate 5 — talent-record leaf (the ATS recruiter-facing
      // talent record; renamed from `talent` to avoid collision with
      // Core libs/talent identity. Amendment §3.)
      '@aramo/talent-record': resolve(root, 'libs/talent-record/src/index.ts'),
      // TR-2a-1 — talent-trust (the trust ledger + within-tenant anchors). The
      // apps/api anchor producer imports it above the I15 wall.
      '@aramo/talent-trust': resolve(root, 'libs/talent-trust/src/index.ts'),
      // Tasks backend — task leaf (the actionable/assignable to-do; the last
      // core recruiter surface). Mirrors tsconfig.base.json @aramo/task alias
      // so vitest runtime resolves the apps/api AppModule import (TaskModule +
      // the TASK_ASSIGNEE_VALIDATOR override). The add-alias-in-same-PR lesson.
      '@aramo/task': resolve(root, 'libs/task/src/index.ts'),
      // AUTHZ-D4b Gate 6 — visibility leaf (the composed predicate +
      // global interceptor). Mirrors tsconfig.base.json @aramo/visibility
      // alias so vitest runtime resolves the apps/api AppModule import
      // and the authz-d4b-visibility-matrix integration spec.
      '@aramo/visibility': resolve(root, 'libs/visibility/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // Invite-S2 — the test environment uses the STUB mailer. Once
    // MailerModule is wired into IdentityModule, every spec that boots the
    // apps/api / libs/identity graph instantiates MAILER_PORT, whose factory
    // fails LOUD if MAILER_PROVIDER is unset. Defaulting it to 'stub' here
    // (one touch) keeps the existing integration specs green and preserves
    // the fail-loud posture for real boots (prod sets MAILER_PROVIDER=ses).
    // The mailer's own DI spec save/restores these keys, so it is unaffected.
    env: {
      MAILER_PROVIDER: 'stub',
      // Domain-Enforcement P2b — DnsResolverModule (wired into IdentityModule,
      // apps/api graph) binds DNS_RESOLVER_PORT via a factory that fails LOUD if
      // DNS_PROVIDER is unset. Defaulting it to 'stub' here (one touch) keeps the
      // integration specs green and preserves fail-loud for real boots (the box
      // sets DNS_PROVIDER=node). The DNS DI spec save/restores this key.
      DNS_PROVIDER: 'stub',
      // Step 4b — the canonicalization resolver fingerprints verified emails;
      // loadIdentityPepper fails LOUD if ARAMO_IDENTITY_PEPPER is unset. A
      // test-only default keeps specs that boot the canonicalization graph
      // green and preserves fail-loud for real boots (prod sets a real secret).
      // The pepper fail-loud proof save/restores this key for its one assertion.
      ARAMO_IDENTITY_PEPPER: 'vitest-shared-test-pepper',
    },
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
