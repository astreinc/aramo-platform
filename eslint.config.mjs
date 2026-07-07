// Aramo Core ESLint flat config (Nx 22 default format).
//
// Two-tier vocabulary enforcement (per ADR-0001 decision; precedent set in PR-1):
//   - This file: ESLint `no-restricted-syntax` flags identifiers and string
//     literals containing the locked-vocabulary anti-terms listed in
//     doc/02-claude-code-discipline.md Rule 5 (excluding `linkedin`).
//   - scripts/verify-vocabulary.sh: ripgrep gate that enforces the strict
//     R7 LinkedIn refusal across the entire repo with a sealed allowlist.
//
// `linkedin` deliberately does not appear in this file; it lives only in
// scripts/verify-vocabulary.sh and doc/03-refusal-layer.md (per R7).

import nx from '@nx/eslint-plugin';
import importX from 'eslint-plugin-import-x';

// I15 (ADR-0017) — the CIP(Pipeline)⊥ATS import wall, enforced by nx module
// boundaries via project scope tags (libs/<lib>/project.json "tags").
//   - scope:cip MUST NOT import scope:ats  ← THE WALL
//   - scope:ats MAY import scope:cip       ← the allowed direction (ATS consumes Pipeline)
//   - scope:boundary spans neither cluster's workflow (job-domain, consent)
//   - scope:shared is leaf infra (depends only on shared)
// The trailing '*' rule leaves untagged sources (apps composition roots, the
// pact provider harness) unconstrained — the wall governs the tagged libs.
// Proven to fire by libs/matching/src/tests/i15-negative-control.spec.ts.
const SCOPE_DEP_CONSTRAINTS = [
  { sourceTag: 'scope:cip', onlyDependOnLibsWithTags: ['scope:cip', 'scope:boundary', 'scope:shared'] },
  { sourceTag: 'scope:ats', onlyDependOnLibsWithTags: ['scope:ats', 'scope:cip', 'scope:boundary', 'scope:shared'] },
  { sourceTag: 'scope:boundary', onlyDependOnLibsWithTags: ['scope:boundary', 'scope:shared'] },
  { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
  { sourceTag: '*', onlyDependOnLibsWithTags: ['*'] },
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.nx/**',
      '**/prisma/generated/**',
      '**/playwright-report/**',
      '**/test-results/**',
      // I15 negative-control fixture: a committed, deliberate scope:cip →
      // scope:ats import that must NOT red the real gate. The wall-fires spec
      // (libs/matching/src/tests/i15-negative-control.spec.ts) lints it
      // explicitly with `eslint --no-ignore` to prove the boundary rule rejects
      // it. Also tsconfig.lib.json-excluded from the matching build.
      '**/i15-negative-control/**',
    ],
  },
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: SCOPE_DEP_CONSTRAINTS,
        },
      ],
    },
  },
  // PR-1 precedent: eslint-plugin-import-x substituted for eslint-plugin-import
  // due to the latter's peer range stopping at ESLint 9. Two rules enabled:
  // import-x/order (style consistency) and import-x/no-cycle (DAG discipline
  // across the 13-module monorepo). ADR-0001 (PR-1.1) will document this
  // substitution in Decision section 2 (tooling pins).
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    plugins: { 'import-x': importX },
    rules: {
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
        },
      ],
      'import-x/no-cycle': [
        'error',
        { maxDepth: Infinity },
      ],
    },
  },
  /**
   * Amendment v1.3 §3.2 (engineering Lead/Architect, 2026-05-15):
   * pact-provider verifier test-bootstraps apps/auth-service's
   * AuthServiceModule for contract verification.
   *
   * PR-14 §4.9 (2026-05-17): extended to also allow @aramo/api so the
   * provider verifier can bootstrap apps/api's AppModule for F7
   * (tenant-console-consumer + ingestion-consumer + prohibited-source-type
   * pact verification). Production code does not cross this app-boundary.
   * Test-environment exception narrowly scoped to this single project
   * (pact/provider/src → {@aramo/auth-service, @aramo/api}). Future
   * cross-app test bootstraps require separate amendment.
   */
  {
    files: ['pact/provider/src/**/*.{ts,tsx,js,jsx}'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          // PC-6 (Gate-5 amendment): the mock-infra increment overrides the
          // resume backends in the provider verifier — overrideProvider(Class)
          // needs the concrete class import, crossing the test boundary.
          // @aramo/ai-draft NOT added: its provider seam is a string token
          // ('DRAFT_PROVIDER_TOKEN'), overridden by value with no import.
          allow: [
            '@aramo/auth-service',
            '@aramo/api',
            '@aramo/object-storage',
            '@aramo/resume-parse',
          ],
          depConstraints: SCOPE_DEP_CONSTRAINTS,
        },
      ],
    },
  },
  {
    // Vocabulary discipline (per doc/02-claude-code-discipline.md Rule 5).
    // Scoped to product source only — eslint config, scripts, and docs are
    // not subject to identifier/literal scanning here.
    files: ['apps/**/*.{ts,tsx,js,jsx}', 'libs/**/*.{ts,tsx,js,jsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Identifier[name=/candidate/i]",
          message: "Use 'talent' (not 'candidate') — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/candidate/i]",
          message: "Use 'talent' (not 'candidate') in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/customer/i]",
          message: "Use 'tenant' (not 'customer') — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/customer/i]",
          message: "Use 'tenant' (not 'customer') in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/outreach/i]",
          message: "Use 'engagement' (not 'outreach' as entity name) — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/outreach/i]",
          message: "Use 'engagement' (not 'outreach' as entity name) in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/evaluation/i]",
          message: "Use 'examination' (not 'evaluation' as entity name) — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/evaluation/i]",
          message: "Use 'examination' (not 'evaluation' as entity name) in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Identifier[name=/submission/i]",
          message: "Use 'submittal' (not 'submission' as entity name) — see doc/02-claude-code-discipline.md Rule 5.",
        },
        {
          selector: "Literal[value=/submission/i]",
          message: "Use 'submittal' (not 'submission' as entity name) in string literals — see doc/02-claude-code-discipline.md Rule 5.",
        },
      ],
    },
  },
  // M5 PR-2 — engagement event-log substrate exemption.
  // The EngagementEventType enum carries `outreach_sent` per Group 2 §3
  // canonical "engagement outreach" product vocabulary. The substring
  // overlap with the Tier-2 forbidden `outreach` entity-name anti-term
  // is incidental — the canonical enum value names a specific event
  // type within the engagement domain, not a misuse of `outreach` as a
  // standalone entity name. Same rationale as the corresponding
  // scripts/verify-vocabulary.sh TIER2_EXCLUDES entries. Per M5 PR-2
  // directive Ruling 4 + §4.12.
  {
    files: [
      'libs/engagement/src/lib/engagement-event.ts',
      'libs/engagement/src/tests/engagement-event.repository.integration.spec.ts',
      'libs/evidence/src/tests/evidence.repository.cross-schema-validator.integration.spec.ts',
      // M5 PR-4 — HTTP surface specs + Pact consumer/provider tests for the
      // engagement endpoints. Same canonical-vocabulary rationale as the
      // M5 PR-2 entries above: `outreach_sent` appears in state-transition
      // fixture data, not as misuse of `outreach` as a standalone entity name.
      'apps/api/src/tests/engagement-create.negative-shape.spec.ts',
      'apps/api/src/tests/engagement-transition.negative-shape.spec.ts',
      'libs/engagement/src/tests/engagement.controller.spec.ts',
      'apps/api/src/tests/engagement.controller.integration.spec.ts',
      // M5 PR-6 — outreach-send HTTP surface + delivery port. Same
      // canonical-vocabulary rationale as the M5 PR-2 / PR-4 entries
      // above: `outreach` appears as the canonical engagement event-type
      // discriminant + new endpoint name, not as misuse of `outreach`
      // as a standalone entity name.
      // R7 BE-prereq — the engagement scope catalog (`engagement:outreach`
      // as the canonical scope-action vocabulary; same domain-scope-action
      // pattern as `compensation:edit:pay` / `submittal:create`). The
      // identity files carry the engagement scope key + grant bundle —
      // canonical scope naming, not misuse of `outreach` as a standalone
      // entity name. Mirrored in scripts/verify-vocabulary.sh.
      'libs/identity/src/lib/dto/scope.dto.ts',
      'libs/identity/prisma/seed.ts',
      // §5 Auth-Hardening D1 — recruiter-context integration spec asserts the
      // recruiter scope BUNDLE, which carries the canonical `engagement:outreach`
      // scope key (same canonical scope-naming rationale as the identity
      // scope-catalog entries above; not misuse of `outreach` as an entity
      // name). Mirrored in scripts/verify-vocabulary.sh.
      'apps/api/src/tests/auth-hardening-d1-recruiter-context.integration.spec.ts',
      'libs/engagement/src/index.ts',
      'libs/engagement/src/lib/dto/outreach-send-request.dto.ts',
      'libs/engagement/src/lib/dto/outreach-send-response.dto.ts',
      'libs/engagement/src/lib/dto/outreach-sent-payload.ts',
      // Outreach Draft/Preview Directive v1.0 / Amendment v1.1 — the draft
      // half of the split. Same canonical engagement-outreach vocabulary
      // rationale as the outreach-send DTOs above (`outreach_drafted` event
      // type + the draft endpoint name, not misuse of `outreach` as a
      // standalone entity name).
      'libs/engagement/src/lib/dto/outreach-draft-request.dto.ts',
      'libs/engagement/src/lib/dto/outreach-draft-response.dto.ts',
      'libs/engagement/src/lib/dto/outreach-drafted-payload.ts',
      'libs/engagement/src/lib/delivery/delivery-provider.interface.ts',
      'libs/engagement/src/lib/delivery/send-stub.provider.ts',
      'libs/engagement/src/lib/engagement.controller.ts',
      'libs/engagement/src/lib/engagement.repository.ts',
      'libs/engagement/src/tests/engagement.repository.spec.ts',
      'libs/engagement/src/tests/engagement.repository.integration.spec.ts',
      'apps/api/src/tests/outreach-send.negative-shape.spec.ts',
      'apps/api/src/tests/outreach-send.integration.spec.ts',
      'pact/provider/src/verify-api.ts',
      // M5 PR-7 — response-received HTTP surface. DTOs + Pact consumer +
      // negative-shape spec + integration spec carry the canonical
      // `outreach` vocabulary via the cross-event reference
      // `outreach_event_ref_id` (Ruling 4) and references to the prior
      // `outreach_sent` event. Same canonical-vocab rationale as the
      // M5 PR-6 entries above.
      'libs/engagement/src/lib/dto/record-response-request.dto.ts',
      'libs/engagement/src/lib/dto/record-response-response.dto.ts',
      'libs/engagement/src/lib/dto/engagement-response-received-payload.ts',
      'apps/api/src/tests/response-received.negative-shape.spec.ts',
      'apps/api/src/tests/response-received.integration.spec.ts',
      // M5 PR-8a — conversation-started specs traverse /outreach + /response to reach
      // responded precondition; same canonical-vocab rationale as M5 PR-6 + PR-7 entries above
      'apps/api/src/tests/conversation-started.negative-shape.spec.ts',
      'apps/api/src/tests/conversation-started.integration.spec.ts',
      'libs/engagement/src/lib/dto/record-conversation-started-response.dto.ts',
      'libs/engagement/src/lib/dto/engagement-conversation-started-payload.ts',
      // M5 PR-9b — consent-at-send refusal integration spec carries the
      // canonical `outreach` engagement-endpoint vocabulary by design
      // (the spec exercises POST /v1/engagements/{id}/outreach as the
      // gated send code path per Plan v1.5 §M5 Track B item 3 closure).
      'apps/api/src/tests/outreach-send-consent-revoked.integration.spec.ts',
      // M5 PR-11 Ruling 7: 4 BullMQ background job integration specs
      // (stale-consent + outbox-publisher + cross-schema-consistency +
      // skill-canonicalization). Matches F23 standing per-spec ESLint
      // exemption pattern paired with scripts/verify-vocabulary.sh
      // TIER2_EXCLUDES entries (M5 PR-6/PR-7/PR-8a/PR-9b precedent).
      // PR-11 is the first PL-66 Category 5 ratification PR
      // (ADR-0018 Decision 9).
      'libs/consent/src/tests/stale-consent.integration.spec.ts',
      'libs/consent/src/tests/outbox-publisher.integration.spec.ts',
      'libs/common/src/tests/cross-schema-consistency.integration.spec.ts',
      'libs/skills-taxonomy/src/tests/skill-canonicalization.integration.spec.ts',
      // PR-A1a Ruling B extension (Commit Plan v1.0 §1 + Lead authorization
      // on the F1 CI failure): `candidate` here is a JWT role-name (the
      // portal-user principal role identifier), NOT entity vocabulary for
      // the talent record. File-scoped to the same 4 identity paths the
      // scripts/verify-vocabulary.sh TIER2_EXCLUDES carries; the ESLint
      // no-restricted-syntax `candidate` rule still applies to every other
      // file in the tree. Paired with the parallel verify-vocabulary.sh
      // exclusion — the vocabulary enforcement has two surfaces (this
      // ESLint rule + verify-vocabulary.sh) and exclusions must be applied
      // to both in lockstep.
      'libs/identity/src/lib/dto/role.dto.ts',
      'libs/identity/prisma/seed.ts',
      'libs/identity/src/tests/seed.spec.ts',
      'libs/identity/src/tests/identity.integration.spec.ts',
      // Settings Rebuild D5 (Gate-5): the roles-catalog GET + the read-only
      // matrix + the catalog-backed RolePicker. The `candidate` token here is
      // the JWT role-name (the PR-A1a Ruling B portal-user principal role
      // identifier), NOT entity vocabulary for the talent record. D5 CLOSED
      // the FE hand-mirror — the role DATA now comes from the backend (the
      // seed/DB single source); these files carry the role-key in the catalog
      // metadata, test fixtures and the endpoint proof. (The old S5b
      // hand-mirror files no longer hold the token.) The ESLint `candidate`
      // rule still applies to every other file. Paired with the matching
      // scripts/verify-vocabulary.sh TIER2_EXCLUDES entries.
      'libs/identity/src/lib/role-catalog/role-catalog.view.ts',
      'libs/identity/src/tests/role-catalog.spec.ts',
      'apps/api/src/tests/settings-d5-roles-catalog.integration.spec.ts',
      'apps/ats-web/src/users/roles.fixture.ts',
      'apps/ats-web/src/users/RolePicker.spec.tsx',
      // PR-A8-2: the import-seam INBOUND-vocabulary synonym table. The
      // talent_record identity-field synonym sets accept "candidate" /
      // "applicant" as inbound CSV-header aliases (every OpenCATS /
      // Dice / Indeed / legacy-ATS export carries them) — the
      // heuristic translates them into the canonical `first_name` /
      // `last_name` target fields at the import boundary. NEVER
      // displayed, NEVER stored as a field name. Paired with the
      // parallel scripts/verify-vocabulary.sh TIER2_EXCLUDES entry
      // (vocabulary enforcement has the two surfaces; exclusions
      // applied in lockstep per the PR-A1a precedent above). The
      // ESLint `candidate` rule still applies to every other file in
      // the tree.
      'libs/import/src/lib/mapping/field-catalog.ts',
      // The paired unit spec exercises the inbound-vocabulary
      // carve-out: it constructs "Candidate" / "Applicant" header
      // strings as test input and asserts the heuristic translates
      // them into first_name / last_name. Same lockstep precedent
      // as the M5 PR-6 / PR-7 / PR-8a / PR-9b carve-out + spec
      // entries above (the assertion file needs the exemption the
      // source file needs).
      'libs/import/src/tests/mapping-suggestion.service.spec.ts',
      // PR-A8-4: OUTBOUND-vocabulary enforcement. The export field-
      // catalog unit spec + the integration spec carry an anti-token
      // list containing `candidate` / `applicant` / `joborder`
      // precisely because they assert the export's CSV header row
      // contains ZERO of those tokens (export speaks Talent; the
      // inbound carve-out at libs/import does NOT apply outbound).
      // Same refusal-enforcement-by-listing-the-anti-terms pattern
      // as the pre-existing PR-A8-2 + ci/scripts/verify-*.ts entries
      // above. Lockstep with the matching scripts/verify-vocabulary.sh
      // TIER2_EXCLUDES entries (the vocabulary enforcement has two
      // surfaces; exclusions applied to both per the PR-A1a precedent).
      'libs/export/src/tests/field-catalog.spec.ts',
      'apps/api/src/tests/ats-batch8-pr-a8-4-export.integration.spec.ts',
      // Recruiter R7 — the engagement FE surface (the ats-web
      // consumer of the engagement backend). `outreach` appears here as the
      // canonical engagement event-type discriminant (`outreach_drafted` /
      // `outreach_sent`), the response-picker source (a response answers a
      // prior `outreach_sent` event — `outreach_event_ref_id`), and the
      // recruiter-facing product vocabulary in copy ("Outreach sent" / "the
      // selected outreach") — NOT a misuse of `outreach` as a standalone
      // entity name competing with `engagement`. Same canonical-vocabulary
      // rationale as the libs/engagement M5 PR-2/PR-6/PR-7 entries above;
      // file-scoped (the rule still applies to every other ats-web
      // file). Paired in lockstep with the scripts/verify-vocabulary.sh
      // TIER2_EXCLUDES entries.
      'apps/ats-web/src/engagement/types.ts',
      // engagement-api.ts carries `outreach` in comments only (the script
      // surface scripts/verify-vocabulary.sh is grep-based and catches
      // comments; ESLint is AST-based and would not flag it) — listed here
      // for lockstep symmetry with the verify-vocabulary.sh exclusion.
      'apps/ats-web/src/engagement/engagement-api.ts',
      'apps/ats-web/src/engagement/EventLog.tsx',
      'apps/ats-web/src/engagement/ResponseLogger.tsx',
      'apps/ats-web/src/engagement/EngagementDetailView.tsx',
      'apps/ats-web/src/engagement/error-messages.ts',
      'apps/ats-web/src/engagement/EngagementDetailView.spec.tsx',
      // Recruiter R7 PR-2 — the draft→preview→send outreach composer. Same
      // canonical-vocabulary rationale as the PR-1 entries above: `outreach`
      // names the engagement event-type discriminant + the draft/send
      // endpoints + the recruiter-facing product copy ("Send outreach" /
      // "Outreach prompt"), NOT a misuse of `outreach` as a standalone entity
      // name. Paired in lockstep with the scripts/verify-vocabulary.sh
      // TIER2_EXCLUDES entries.
      'apps/ats-web/src/engagement/OutreachComposer.tsx',
      'apps/ats-web/src/engagement/OutreachComposer.spec.tsx',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
];
