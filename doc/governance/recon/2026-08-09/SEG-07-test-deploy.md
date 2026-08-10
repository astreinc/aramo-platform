# SEG-07 — Test/Proof Architecture (§16), Shared Surfaces (§15), Deployment Reality (§17)

Baseline audited: origin/main = `ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589).
Working tree = detached `3a4a3a4` (PR #588), one merge behind. PR #589 files read via
`git show origin/main:<path>`. READ-ONLY; no mutation performed.

================================================================================
## SECTION 16 — PROOF / TEST ARCHITECTURE
================================================================================

### 16.1 Integration-roots system (GROUNDED)
- Registry: `/Users/purushpurushothaman/projects/aramo-platform/ci/integration-roots.json`
  - `roots`: EXACTLY 35 (3 apps + 32 libs). apps/api, apps/auth-service, apps/platform-admin;
    libs: ai-draft, auth-storage, canonicalization, client-talent-restriction, common, consent,
    engagement, evidence, examination, identity, identity-index, ingestion, job-domain, matching,
    metering, object-storage, outbox-publisher, pipeline, placement, policy-store, portal-identity,
    pre-start-requirement, reporting, requisition, resume-parse, settings, skills-taxonomy,
    sourced-talent, submittal, talent-evidence, talent-record, talent-trust.
  - `coverageAliases`: EXACTLY 1 — `libs/tenant-reset` coveredBy `apps/api`, proof
    `apps/api/src/tests/tenant-reset.integration.spec.ts` (integration-roots.json:41-46).
  - `exemptions`: EXACTLY 0 (integration-roots.json:48).
- Guard: `ci/scripts/check-integration-roots.ts` — DEFAULT-DENY. Discovers every
  `*.integration.(spec|test).ts` OR any spec with a real `(describe|it|test).(skipIf|runIf)(… ARAMO_RUN_INTEGRATION)`
  gate (SPEC_RE line 36, INTEGRATION_SUFFIX_RE line 37, GATE_RE line 39), maps each to the nearest
  `project.json`, and FAILS on: uncovered bearing project (Rule 1, l.223), empty root (Rule 2, l.167),
  bad alias (Rule 3), stale exemption (Rule 4), divergent runner embedding root literals (l.278),
  frozen root count (Rule 10, l.294). Enrolled runners it audits: `ci/scripts/ci-integration.sh`,
  `ci/scripts/prepush.ts`, `package.json` `tests:integration` (surfaces[] l.248-277).
- CI wiring: `.github/workflows/ci.yml` `integration-roots-check` job is a `deployment-gate` need.

### 16.2 MEMORY claim re reporting/export/visibility — DIVERGENCE (substrate moved)
MEMORY asserts `libs/reporting, libs/export, libs/visibility` have ZERO lib-local integration
specs (enrolment = no-op). AS OF `ca09740`:
- `libs/reporting` — **CLAIM STALE / FALSE.** It NOW owns
  `libs/reporting/src/tests/capacity-projection-edge.integration.spec.ts` (added Track 4
  Increment 1, commit `5c4fa12`; `describe.skipIf(ARAMO_RUN_INTEGRATION!=='1')` at l.29, boots a
  real Postgres 17 testcontainer, imports `@aramo/placement` CapacityProjectionRepository). It is
  correctly enrolled in roots (integration-roots.json:29). Enrolment is NO LONGER a no-op.
- `libs/export` — CONFIRMED ZERO lib-local integration spec. Only unit specs
  (`field-catalog.spec.ts`, `csv-stringifier.spec.ts`). NOT in roots (correct). Its vitest.config.ts
  merely references ARAMO_RUN_INTEGRATION for exclude/timeout (config, not a bearing spec).
- `libs/visibility` — CONFIRMED ZERO spec files of any kind. NOT in roots (correct).
Typed finding: (iii) substrate moved since MEMORY baseline — reporting gained integration coverage.

### 16.3 Integration-spec inventory per module (suffix `.integration.spec.ts`, exact)
apps/api 77 · apps/auth-service 4 · apps/platform-admin 4 · libs/ai-draft 1 · libs/auth-storage 2 ·
libs/canonicalization 1 · libs/client-talent-restriction 1 · libs/common 1 · libs/consent 4 ·
libs/engagement 3 · libs/evidence 2 · libs/examination 5 · libs/identity 6 · libs/identity-index 1 ·
libs/ingestion 2 · libs/job-domain 1 · libs/matching 2 · libs/metering 1 · libs/object-storage 1 ·
libs/outbox-publisher 1 · libs/pipeline 2 · libs/placement 3 · libs/policy-store 2 ·
libs/portal-identity 1 · libs/pre-start-requirement 1 · libs/reporting 1 · libs/requisition 3 ·
libs/resume-parse 1 · libs/settings 1 · libs/skills-taxonomy 1 · libs/sourced-talent 1 ·
libs/submittal 2 · libs/talent-evidence 1 · libs/talent-record 2 · libs/talent-trust 11.
Plus 13 ARAMO_RUN_INTEGRATION-gated non-suffixed specs — all in apps/api.

### 16.4 Test-type presence by type (grounded highlights)
- Unit / component (.spec.ts / .spec.tsx totals): apps/api 113, apps/ats-web 125, apps/auth-service 26,
  apps/platform-admin 7, apps/platform-web 2, apps/portal-web 10. (ats-web = FE component tests; it
  owns ZERO `.integration.spec.ts` — its cross-boundary proof is Pact-consumer + Playwright e2e.)
- Integration (real Postgres testcontainer): per 16.3.
- Contract (Pact): pact/consumers/* (see §15/Contract surface below).
- E2E (Playwright, live stack): `apps/ats-web/e2e/surfaces.spec.ts` (authority origin/main) — 7 tests,
  live recruiter session via auth.setup.ts, resilient to empty tenants ("content OR honest empty
  state"). Covers Requisitions list+detail, Placements nav+board+detail (AssignmentLifecyclePanel,
  no END for read-only recruiter), RouteGuard scope-gating, logout. This is the ONLY live-stack test.
- SQL / migration proof: curated `MIGRATIONS`/`resolve(...)` lists appear in 132 TS files under
  apps/api/src + libs (repo-wide grep). Curated-list COUNT is per MEMORY untrustworthy — find by
  filename grep, never remembered count. Dedicated SQL gate: `ci/scripts/verify-placement-sql.ts`
  (`placement:sql:check`).
- Structural gates (package.json → CI jobs): openapi:validate, openapi:lint (redocly),
  openapi:drift-check ($ref-integrity ONLY — no route↔handler axis, per MEMORY gap), portal/ats/
  ingestion refusal-check, version:sync-check, error-codes:check, repo-map:check, placement:sql:check,
  verify:vocabulary, lint:nx-boundaries, integration-roots-check, identity-index-privacy-wall,
  frontdoor-conf-check + frontdoor boot-smoke (ci.yml l.200-206).

### 16.5 Boundary categorization (for RED-first planning; D-1 BINDING)
- Genuine behavior boundaries (RED-first legit — real behaviour flip): new write ops / new refusal
  codes / lifecycle transitions / capacity-derivation cutover (Track 4 pattern). Non-vacuous =
  assert BEFORE value existed + EXACT after.
- Characterization boundaries: existing read projections, rollup aggregates (e.g. reporting
  company-metrics), FE render specs — assert current behaviour, not a flip.
- Structural boundaries (asserted, not walked): nx boundary tags (Pipeline⊥ATS wall ADR-0017),
  identity_index privacy wall, placement acyclicity (lifecycle trigger + self-ref CHECK),
  integration-roots default-deny, repo-map 3-file SET, vocabulary regex.
- Source-swap proofs: auth decoupling ports/adapters (auth-owned ports + app-local adapters, zero
  nx edges); Pact provider token overrides (DRAFT/DELIVERY provider tokens, verify-api.ts l.53-54).
- D-1 REMAINS BINDING: do not relabel historical proofs; do not manufacture RED for rename-only work.

### 16.6 Fixture gaps / live-stack-only blockers
- ACTIVE→END assignment path is FIXTURE-BLOCKED (per MEMORY T4-E): AssignmentLifecyclePanel END
  control component-proven GREEN, but live E2E of ACTIVE→END NOT established (no ACTIVE placement
  fixture in the live tenant). surfaces.spec.ts only asserts "no END for read-only recruiter".
- `pact:provider` needs `pact:consumer` generated FIRST (fresh worktree); fresh worktree needs
  `npm run prisma:generate` before typecheck (MEMORY).
- libs/reporting, libs/export, libs/visibility Class-B read coverage: export+visibility STILL have
  ZERO lib-local integration specs (registered follow-up); reporting now has one (see 16.2).
- Docker-saturation local flake (beforeAll ports bound / afterAll hook timeout) CI-invisible; run
  `--no-file-parallelism` (MEMORY). outbox-publisher publisher not in CI roots historically — now
  libs/outbox-publisher IS a root (1 integration spec).

================================================================================
## SECTION 15 — SHARED SURFACES (multi-track collision inventory)
================================================================================
Each surface = the file(s) that constitute it + the domains/tracks it tends to serve.

1. SEED — `libs/identity/prisma/seed.ts` (scope catalog + role matrix; the D-SEED-SCOPES-1 touchpoint set per new scope,
   D-SEED-SCOPES-1 guard), `libs/identity/prisma/seed-astre.ts`, `seed-platform-owner.ts`,
   `libs/auth-storage/prisma/seed.ts`, `apps/api/src/policy/seed-lifecycle.ts`. Serves: every
   track adding a scope/role/policy (auth, placement, requisition, portal, sourcing).
2. OpenAPI — `openapi/{ats,auth,common,ingestion,platform,portal}.yaml` (6 files). Gates:
   openapi:validate, openapi:lint, openapi:drift-check ($ref-only). Serves: every HTTP-surface track.
3. ERROR REGISTRY — `libs/common/src/lib/errors/error-codes.ts` (+ spec `.../tests/error-codes.spec.ts`;
   gate `ci/scripts/verify-error-codes.ts`). Serves: every track adding a refusal/error code.
4. REPO-MAP (3-file SET) — `doc/generated/repo-map.projects.json`, `repo-map.files.json`,
   `repo-map.coupling.json`; generator `ci/scripts/generate-repo-map.ts`; guard
   `ci/scripts/verify-repo-map.ts`. Scans git-TRACKED files only (untracked = map blind). Serves: all.
5. INTEGRATION-ROOTS — `ci/integration-roots.json` + guard `ci/scripts/check-integration-roots.ts`
   + runners ci-integration.sh / prepush.ts / package.json tests:integration. Serves: every track
   adding a lib-local integration spec.
6. CURATED MIGRATION LISTS — 132 TS files carry MIGRATIONS arrays / resolve() consts (apps/api tests,
   pact/provider/src/verify-api.ts, lib integration specs). NOT all flat arrays (ats-batch4a/ats-batch8
   use single-path resolve consts). Serves: every migration-bearing track.
7. TENANT RESET — `libs/tenant-reset/*`, `apps/api/src/tenant-reset/tenant-reset.command.ts`, proof
   `apps/api/src/tests/tenant-reset.integration.spec.ts`, escape migration
   `libs/placement/prisma/migrations/20260806090000_placement_tenant_reset_escape`. reset targets=20
   (Track4 Inc1 added ContractAssignment), restore paths=0. Serves: every track adding a resettable table.
8. app.module.ts — `apps/api/src/app.module.ts`, `apps/auth-service/src/app/app.module.ts`,
   `apps/platform-admin/src/app/app.module.ts`. Serves: every track wiring a new Nest module/provider
   (new ctor arg ripples hand-wired createTestingModule + new sites).
9. ATS ROUTING/NAV + SHARED FE — `apps/ats-web/src/App.tsx`, `src/shell/RecruiterShell.tsx` (both
   PR#589, read via origin/main), RouteGuard/nav, `apps/ats-web/src/*/‹domain›-api.ts` client modules,
   `libs/fe-foundation` (shared chrome via ui/index.ts side-effect import; ui/ui.css token exclusivity).
   Serves: every user-reachable FE track (placement, engagement, submittals, requisitions, trust).
10. PACT PROVIDER — `pact/provider/src/verify-api.ts` (aramo-core, apps/api), `verify.ts`
    (aramo-auth-service, apps/auth-service), `state-handlers.ts`, `auth-helpers.ts`. Any migration
    changing a returned shape must be registered here (engineering law). Serves: all HTTP tracks.
11. CI WORKFLOWS — `.github/workflows/ci.yml` (single monolith; deployment-gate aggregator),
    `.github/workflows/deploy-public-staging.yml`; `ci/scripts/*` (18 scripts). No `ci/workflows/` dir.
    Serves: all.
12. VOCABULARY — `scripts/verify-vocabulary.sh` (TIER2_TERMS_REGEX banned; TIER2_EXCLUDES allowlist).
    Mirror: `eslint.config.mjs` no-restricted-syntax (lockstep). Serves: any trust/match-class output track.
13. Other shared: nx boundary tags (project.json `tags`, lint:nx-boundaries) — Pipeline⊥ATS wall;
    `identity_index` schema (NO tenant_id, NO PII); scope↔id-map bijection.

### Vocabulary exemption allowlist (mandatory inventory)
- Banned list: `TIER2_TERMS_REGEX` (scripts/verify-vocabulary.sh:477-485) — banned Tier-2 trust
  vocabulary; referenced by script, NOT restated here (CLAUDE.md law).
- Exemption allowlist `TIER2_EXCLUDES` (l.94-470): EXACTLY 129 quoted path entries (includes globs
  `**/prisma/generated/**`, `doc/adr/**`, `libs/engagement/prisma/migrations/**/migration.sql`,
  `Aramo-*-LOCKED.docx`). Notable prod-source exemptions: openapi/common.yaml, openapi/ats.yaml,
  libs/common/src/lib/errors/error-codes.ts, libs/identity/src/lib/dto/scope.dto.ts,
  libs/identity/prisma/seed.ts, pact/provider/src/verify-api.ts, engagement message-delivery DTOs/repo,
  canonicalization repo+specs, all doc/generated/repo-map.*.json. NEW entries require Architect approval.
- R7 (Charter-refusal source-platform) allowlist `R7_ALLOWLIST` (l.36-55) + `R7_ALLOWLIST_GLOB` (l.59-65): sealed.
- Front-door retirement allowlist `FRONTDOOR_LEGACY_ALLOWLIST` (l.77-86): sealed.

### Contract surface (two DISTINCT numbers per CLAUDE.md)
- Consumer projects total: EXACTLY 5 — pact/consumers/{ats-web, auth-service-consumer,
  ingestion-consumer, portal-thin, prohibited-source-type}.
- Pact JSON files on disk: EXACTLY 6 (pact/pacts/) — includes RETIRED
  `tenant-console-consumer-aramo-core.json` (dead surface, not loaded).
- Consumers VERIFIED BY apps/api provider (aramo-core, verify-api.ts l.745-753): EXACTLY 4 —
  ingestion-consumer, prohibited-source-type, portal-thin, ats-web. tenant-console-consumer +
  thin-recruiter consumer RETIRED (verify-api.ts l.62-73).
- Consumers VERIFIED BY apps/auth-service provider (aramo-auth-service, verify.ts l.95, l.233):
  EXACTLY 1 — auth-service-consumer. (Separate provider — keep distinct from aramo-core count.)

================================================================================
## SECTION 17 — DEPLOYMENT REALITY (MERGED vs DEPLOYED)
================================================================================

### 17.1 Deployment substrate present in repo
- `deploy/`: RUNBOOK.md (stub → canonical doc/runbooks/RELEASE-box.md), migrate-prod.sh (+ .test.sh),
  seed-prod.sh (+ .test.sh), backup/ (pg-backup.sh, pg-restore.sh, s3 policies), nginx/ (Dockerfile,
  nginx.conf, templates/aramo.conf.template), systemd/ (aramo-singlebox.service, singlebox-compose.sh,
  pg-backup timer/service).
- `infrastructure/`: bootstrap/, environments/, modules/, README (the AWS-account IaC — NEVER run
  Terraform from the box; runs from Mac per CLAUDE.md).
- `infrastructure-lightsail/`: main.tf, backend.tf, provider.tf, outputs.tf, variables.tf,
  terraform.tfvars(.example), user_data.sh, README, ses-mailer-iam.json. UNTRACKED working-tree file
  `ses-mail-alignment.tf` (git status ??) — present locally, NOT committed at ca09740.
- Compose: docker-compose.yml, docker-compose.prod.yml, docker-compose.images.yml.
- Docs: doc/step4-{compute-iac, deploy-substrate-recon, singlebox-astre-seed-recon,
  singlebox-lightsail-tf, singlebox-runnable-prod-stack}.md; doc/go-live-known-limitations.md;
  doc/runbooks/{RELEASE-box, RELEASE-platform-console, singlebox-ops, frontdoor-cutover,
  frontdoor-pr0-apply, local-db-sync, local-run, run-layer, bootstrap-anthropic-secret,
  talent-rtbf-erasure}.md.

### 17.2 MERGED vs DEPLOYED posture
- The repo can only establish MERGED. NO CI job auto-deploys application containers: the only deploy
  workflow `.github/workflows/deploy-public-staging.yml` is `workflow_dispatch`-ONLY and builds/pushes
  the PUBLIC marketing site image to GHCR (`Deploy/apply is a PO-lane action; this workflow only
  produces the image`). App (api/auth/admin) deploy is a MANUAL box procedure (doc/runbooks/RELEASE-box.md
  + deploy/systemd/singlebox-compose.sh). DEPLOYED/RUNTIME state is therefore UNKNOWN from substrate.
- MERGED at ca09740 and relevant here: Track4 Inc1 (#586), assignment:read (#587), Track4 B2
  capacity cutover (#588), placement lifecycle UI (#589). Whether any is DEPLOYED = UNKNOWN (read-only).

### 17.3 HARD deploy-order constraint (Track4-B2) — GROUNDED
- Schema change: `libs/requisition/prisma/migrations/20260811120000_t4b2_drop_openings_available/migration.sql`
  — `ALTER TABLE "requisition"."Requisition" DROP COLUMN "openings_available";` (migration.sql l.16;
  header: "DEDICATED, irreversible DROP required by the locked ordering"). Public field
  openings_available UNCHANGED (now DERIVED = max(capacity_balance,0)). Migration class B (future
  structural, destructive DROP).
- Chain dependency: B2 requisition reads now depend on placement ContractAssignment
  (`libs/placement/prisma/migrations/20260809120000_placement_contract_assignment` + 3 follow-ons).
  Prod lacks the chain → an app-before-migration rollout makes req reads FAIL. Migration→application
  ordering is MANDATORY.
- Operationally ENFORCED (generic) by `deploy/migrate-prod.sh`: applies + GATES on zero-pending
  migrations BEFORE containers are (re)built/recreated (script header: "pull → migrate-prod.sh →
  build → recreate"; closes the E22 incident where a front-door cutover recreated app containers
  without migrating and requisitions returned 500). RELEASE-box.md HARD STOP: "Any window that
  rebuilds or recreates an application container IS a release — STEP 2 (backup) + STEP 3 (migrate)
  included."
- DIVERGENCE (typed, (i) tasking-assumption gap): the T4-B2 hard deploy-order constraint is NOT
  recorded as an explicit entry in `doc/go-live-known-limitations.md` (grep for placement/assignment/
  capacity/track 4 returns only team-scope + task-reassignment entries). It is covered generically by
  migrate-prod.sh, but there is no B2-specific register entry. Flag; do not resolve.

### 17.4 Production business-population facts (SEPARATE from schema)
- Per MEMORY (§6 preflight 2026-08-09): all six T4 classes = 0; ZERO prod placements; T4-A2 = NO-OP
  (ZERO-ROW, not skipped/waived). These are RUNTIME population facts, NOT observable from substrate.
  Typed finding: (ii) assumption unverifiable from repo (no DB access; read-only). Ground separately
  from schema state (schema DROP is grounded in 17.3; population is not).

### 17.5 SMOKE-obligation inventory (current)
- Generic (RELEASE-box.md STEP 9): `curl -sI https://astre.aramo.ai` → HTTP/2 200 (front door
  healthy) + "prove the *change*" (new endpoint/route/UI element per NOTES). No baked-in
  placement-specific deploy smoke script.
- Front-door BOOT smoke (CI, ci.yml l.200-206): `ci/scripts/frontdoor-boot-smoke.sh aramo/nginx:local`
  — nginx leg only; a SKIPPED smoke is a finding.
- Track4-derived obligations (from directive/MEMORY, expressed in ats-web e2e/surfaces.spec.ts but
  NOT wired as a deploy-time smoke): (a) B2 req-read continuity (requisitions list+detail still 200
  after the DROP); (b) Placements nav + /placements route reachability with EMPTY-state over 0 prod
  placements ("No placements visible to you yet."). surfaces.spec.ts asserts both against the LIVE
  stack but is a Playwright e2e, not the box STEP-9 smoke.
- Auth decoupling PR5 (MEMORY, ADR-0021): ONLY OPEN = batched 5a+5b post-deploy proof (both logins) —
  a standing post-deploy smoke obligation.

### 17.6 deployment-gate CI behavior (VERIFIED in .github)
- `.github/workflows/ci.yml` l.628-700: job `deployment-gate`, `if: always()`, `needs:` 25 jobs
  (openapi-validate/lint/drift-check, portal/ats/ingestion-refusal, frontdoor-conf-check,
  version-sync-check, error-codes-check, integration-roots-check, repo-map-check,
  identity-index-privacy-wall, pact-consumer, pact-provider, test-unit, tests-integration,
  lint-nx-boundaries, docker-build, terraform-fmt/validate/lint/sec, npm-audit). FAILS if any need is
  failure/cancelled/**skipped** (l.694). Override ONLY on `pull_request` events via label
  `override:ok-to-merge` + `Override-Justification:` ≥40 chars in body (l.660-687); NO override on
  merge_group/push. This CONFIRMS MEMORY's "deployment-gate is the sole required aggregator, blocks
  even admins outside the PR-label path." The GitHub ruleset bypass list itself is NOT in the repo →
  that portion (empty bypass list) is UNVERIFIABLE from substrate (typed finding (ii)).

================================================================================
## DIVERGENCES (typed — flagged, not resolved)
================================================================================
- (iii) substrate moved: `libs/reporting` now HAS a lib-local integration spec
  (capacity-projection-edge.integration.spec.ts, commit 5c4fa12) and is enrolled in roots — MEMORY's
  "ZERO lib-local integration specs / enrolment=no-op" is STALE for reporting. export+visibility
  still ZERO (claim holds for those two).
- (i) tasking/register gap: T4-B2 hard migration-before-app deploy-order constraint absent from
  doc/go-live-known-limitations.md (covered only generically by deploy/migrate-prod.sh).
- (ii) unverifiable from substrate: prod business population (0 placements, six-class=0); DEPLOYED
  runtime state of #586-#589; GitHub ruleset bypass-list emptiness.
- Note: untracked working-tree file `infrastructure-lightsail/ses-mail-alignment.tf` (git status ??)
  is NOT part of authority ca09740.

Baseline commit hash audited: ca0974090724b36b130f4d39ea5b1ef486d6adf4.
NO MUTATION PERFORMED — read-only git/grep/find/read only; no write, edit, commit, push, or DB/deploy action.
