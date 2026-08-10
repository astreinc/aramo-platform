# SEGMENT 02 — MODULE INVENTORY (Dir. §2) + DOMAIN/AGGREGATE OWNERSHIP (Dir. §3)

Baseline authority SHA: `ca0974090724b36b130f4d39ea5b1ef486d6adf4` (origin/main, PR #589).
Working tree: detached HEAD `3a4a3a44b5d635acc276dad7431d74514602616e` (PR #588), one merge behind.
Enumeration re-run from disk (`ls apps/`, `ls libs/`), NOT from the context list.
READ-ONLY. No file/git/DB mutation performed.

---

## 0. TOP-LINE COUNT DIVERGENCE (typed finding — read first)

- Disk enumeration: **6 apps, 60 libs** (`ls -1 apps | wc -l` = 6; `ls -1 libs | wc -l` = 60).
- RECON-CONTEXT.md:34 header states "libs (64)" AND the directive tasking states "every ... lib (64)".
- The RECON-CONTEXT list body itself enumerates only 60 names (activity … visibility). The literal "64" is not backed by any list of 64 items on disk or in context.
- **DIVERGENCE TYPE (i) conflict with tasking assumption:** tasking/context assert 64 libs; substrate at baseline SHA has 60. Flagged, not resolved. No lib was renamed/removed by me; this is a pre-existing count discrepancy in the tasking. All 60 disk libs are inventoried below.

---

## SECTION 2 — MODULE INVENTORY

### 2.1 Apps (6)

| dir | nx name (project.json) | type | tag/scope | alias (tsconfig.base) | barrel | prisma | ctrl/svc/repo/mod/proc | tests unit/integ/e2e | FE? | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|
| apps/api | `api` | application | (no tags) | `@aramo/api`→src/app.module.ts | n/a | 20/24/1/8/6 | 36/77/1 | no | ACTIVE PRODUCT (primary ATS API host) |
| apps/ats-web | `aramo-ats-web` | application | (no tags) | (none) | n/a | none | —/—/1 | 37/0/1 | yes | ACTIVE PRODUCT (recruiter FE) |
| apps/auth-service | `auth-service` | application | (no tags) | `@aramo/auth-service`→auth.module.ts | none | 0/0/0/2/0 | 22/4/0 | no | ACTIVE PRODUCT (ADR-0021 auth svc) |
| apps/platform-admin | `platform-admin` | application | scope:platform | (none) | none | 0/0/0/—/0 | 3/4/0 | no (main.ts backend) | ACTIVE PRODUCT (platform console BE) |
| apps/platform-web | `aramo-platform-web` | application | scope:platform | (none) | n/a | none | — | 1/0/0 | yes | ACTIVE PRODUCT (platform console FE) |
| apps/portal-web | `aramo-portal-web` | application | scope:portal | (none) | n/a | none | — | 1/0/0 | yes | ACTIVE PRODUCT (talent portal FE) |

Note: `apps/api` tags = `[]` (verbatim) — the primary API host carries NO nx boundary tags; enforce-module-boundaries cannot scope it. auth-service/ats-web also carry no tags.

### 2.2 Libs (60) — all have `src/index.ts` barrel AND a `@aramo/<name>` alias (0 missing on both axes)

Structural columns: ctrl=*.controller.ts, svc=*.service.ts, repo=*.repository/*.repo.ts, mod=*.module.ts, proc=processor/worker/consumer/publisher. Tests: unit/integ. Outbox = owns an `OutboxEvent` model in its source schema.prisma.

| lib | nx name | scope tag | prisma schema(s) declared | ctrl/svc/repo/mod/proc | unit/integ | outbox | STATUS |
|---|---|---|---|---|---|---|---|
| activity | activity | scope:ats | activity | 1/1/1/1/0 | 2/0 | no | ACTIVE PRODUCT |
| ai-draft | ai-draft | scope:shared | ai_draft | 0/3/1/1/0 | 5/1 | no | ACTIVE PRODUCT |
| attachment | attachment | scope:ats | attachment | 1/1/1/1/0 | 0/0 | no | ACTIVE PRODUCT (0 tests) |
| audit | audit | scope:shared | (single-schema, no multiSchema) | 0/0/0/1/0 | 0/0 | no | INFRASTRUCTURE |
| auth | auth | scope:shared | (single-schema) | 0/0/0/1/0 | 1/0 | no | INFRASTRUCTURE (JwtAuthGuard+AuthContext facade only) |
| auth-core | auth-core | scope:auth | (no prisma source) | 3/10/0/0/0 | 7/0 | no | ACTIVE PRODUCT (real auth logic; 6 *.port.ts) |
| auth-storage | auth-storage | scope:shared | auth_storage | 0/2/2/1/0 | 4/2 | no | ACTIVE PRODUCT (auth persistence) |
| authorization | authorization | scope:shared | (no prisma source) | 0/0/0/1/0 | 1/0 | no | INFRASTRUCTURE (authz primitives) |
| calendar | calendar | scope:ats | calendar | 1/1/1/1/0 | 0/0 | no | ACTIVE PRODUCT (0 tests) |
| canonicalization | canonicalization | scope:ats | canonicalization, **ingestion** | 0/2/2/1/1 | 2/1 | YES | ACTIVE PRODUCT |
| client-talent-restriction | client-talent-restriction | scope:ats | client_talent_restriction | 1/1/1/1/0 | 1/1 | no | ACTIVE PRODUCT (ADR-0027) |
| cold-ingest-extraction | cold-ingest-extraction | scope:cip | (no prisma source) | 0/1/0/1/1 | 3/0 | no | ACTIVE PRODUCT (CIP) |
| common | common | scope:shared | (single-schema) | 0/0/1/2/1 | 8/1 | no | FOUNDATION |
| company | company | scope:ats | company | 3/3/4/1/0 | 8/0 | no | ACTIVE PRODUCT |
| consent | consent | scope:boundary | consent, **audit** | 1/4/3/1/1 | 12/4 | YES | ACTIVE PRODUCT |
| contact | contact | scope:ats | contact | 1/1/1/1/0 | 3/0 | no | ACTIVE PRODUCT |
| engagement | engagement | scope:ats | engagement | 1/1/3/1/0 | 5/3 | YES | ACTIVE PRODUCT (hosts engagement message-delivery + submittal tables) |
| entitlement | entitlement | scope:shared | entitlement | 0/1/1/1/0 | 1/0 | no | ACTIVE PRODUCT |
| events | events | scope:shared | (single-schema) | 0/0/0/1/0 | 0/0 | no | INFRASTRUCTURE (EventsModule only) |
| evidence | evidence | scope:ats | evidence | 0/1/1/1/0 | 2/2 | no | ACTIVE PRODUCT |
| examination | examination | scope:cip | examination | 2/1/1/1/0 | 8/5 | no | ACTIVE PRODUCT (1 *.port.ts) |
| export | export | scope:ats | (no prisma source) | 1/1/0/1/0 | 2/0 | no | ACTIVE PRODUCT (no lib-local integ) |
| fe-foundation | fe-foundation | scope:shared | (no prisma) | 0/0/0/0/0 | 3/0 | no | FOUNDATION (FE) |
| field-masking | field-masking | scope:shared | (no prisma) | 0/0/0/0/0 | 2/0 | no | INFRASTRUCTURE (terminal masking lib) |
| identity | identity | scope:shared | identity | 7/14/7/3/0 | 43/6 | no | ACTIVE PRODUCT (tenant/org/RBAC — see §3 flag) |
| identity-index | identity-index | scope:cip | identity_index | 0/2/1/1/0 | 2/1 | no | ACTIVE PRODUCT (PII-free cluster index) |
| import | import | scope:ats | import | 1/3/0/1/0 | 2/0 | no | ACTIVE PRODUCT |
| ingestion | ingestion | scope:cip | ingestion | 1/2/1/1/0 | 6/2 | no | ACTIVE PRODUCT |
| job-distribution | job-distribution | scope:ats | job_distribution | 0/2/1/1/0 | 5/0 | no | ACTIVE PRODUCT |
| job-domain | job-domain | scope:boundary | job_domain | 0/1/1/1/0 | 3/1 | no | ACTIVE PRODUCT |
| mailer | mailer | scope:shared | (no prisma) | 0/0/0/1/0 | 1/0 | no | INFRASTRUCTURE (1 *.port.ts) |
| matching | matching | scope:cip | (single-schema) | 0/1/0/1/1 | 4/2 | no | ACTIVE PRODUCT |
| metering | metering | scope:shared | metering | 0/0/0/0/0 | 1/1 | no | ACTIVE PRODUCT (recordUsage fn only; no module) |
| object-storage | object-storage | scope:shared | (no prisma) | 0/1/0/1/0 | 3/1 | no | INFRASTRUCTURE |
| outbox-publisher | outbox-publisher | scope:ats | (no prisma source) | 0/0/0/1/1 | 0/1 | no (drainer) | INFRASTRUCTURE (outbox drain worker) |
| pipeline | pipeline | scope:ats | pipeline | 1/2/1/1/0 | 6/2 | no | ACTIVE PRODUCT (ADR-0017 wall) |
| placement | placement | scope:ats | placement | 0/1/4/2/0 | 5/3 | YES | ACTIVE PRODUCT (Track 3/4; ContractAssignment) |
| platform-trust | platform-trust | scope:shared | platform_trust | 0/1/1/1/0 | 1/0 | no | ACTIVE PRODUCT (trust surface) |
| policy-engine | policy-engine | scope:boundary | (no prisma) | 0/0/0/0/0 | 6/0 | no | INFRASTRUCTURE (ADR-0024 stateless evaluator) |
| policy-store | policy-store | scope:boundary | policy_store | 0/1/0/0/0 | 4/2 | no | ACTIVE PRODUCT (ADR-0024 store) |
| portal | portal | scope:ats | (single-schema) | 1/1/0/1/0 | 1/0 | no | ACTIVE PRODUCT (thin portal read surface) |
| portal-identity | portal-identity | scope:shared | portal_identity | 0/1/1/1/0 | 1/1 | no | ACTIVE PRODUCT |
| pre-start-requirement | pre-start-requirement | scope:ats | pre_start_requirement | 0/1/3/0/0 | 1/1 | no | ACTIVE PRODUCT (no module; controller in apps/api — §3 flag) |
| reporting | reporting | scope:ats | (no prisma source) | 2/1/0/1/0 | 2/1 | no | ACTIVE PRODUCT (see §Divergence D-4) |
| requisition | requisition | scope:ats | requisition | 1/5/2/1/0 | 14/3 | no | ACTIVE PRODUCT |
| resume-parse | resume-parse | scope:cip | (no prisma) | 0/1/0/1/0 | 3/1 | no | ACTIVE PRODUCT (CIP) |
| saved-list | saved-list | scope:ats | saved_list | 1/1/1/1/0 | 0/0 | no | ACTIVE PRODUCT (0 tests) |
| settings | settings | scope:ats | settings | 0/2/1/1/0 | 2/1 | no | ACTIVE PRODUCT |
| skills-taxonomy | skills-taxonomy | scope:cip | (single-schema) | 0/0/0/1/1 | 0/1 | no | ACTIVE PRODUCT |
| sourced-talent | sourced-talent | scope:cip | sourced_talent | 0/1/1/1/0 | 0/1 | no | ACTIVE PRODUCT (ADR-0019) |
| submittal | submittal | scope:ats | **engagement**, submittal | 1/1/3/1/0 | 5/2 | YES | ACTIVE PRODUCT (tables in engagement schema — §3 flag) |
| talent | talent | scope:ats | (single-schema, ZERO models) | 0/0/0/0/0 | 0/0 | no | **DEFERRED/STUB** (`index.ts` = `export {};`, schema has 0 models) |
| talent-evidence | talent-evidence | scope:cip | talent_evidence | 0/1/1/1/0 | 2/1 | no | ACTIVE PRODUCT |
| talent-extraction | talent-extraction | scope:cip | (no prisma) | 0/1/0/1/0 | 3/0 | no | ACTIVE PRODUCT (CIP) |
| talent-reconcile | talent-reconcile | scope:ats | (no prisma) | 0/2/0/1/2 | 6/0 | no | ACTIVE PRODUCT |
| talent-record | talent-record | scope:ats | talent_record | 1/4/2/2/1 | 5/2 | no | ACTIVE PRODUCT (person SOR, ADR-0016; 1 *.port.ts) |
| talent-trust | talent-trust | scope:cip | talent_trust | 0/4/1/1/0 | 15/11 | no | ACTIVE PRODUCT (trust surface) |
| task | task | scope:ats | task | 1/1/1/1/0 | 3/0 | no | ACTIVE PRODUCT (1 *.port.ts) |
| tenant-reset | tenant-reset | scope:boundary | tenant_reset | 0/2/0/0/0 | 2/0 | no | ACTIVE PRODUCT (reset; API-hosted integ per roots alias) |
| visibility | visibility | scope:ats | (no prisma) | 0/1/0/1/0 | 0/0 | no | ACTIVE PRODUCT (terminal masking lib; 0 tests) |

STATUS tallies (60 libs): FOUNDATION=2 (common, fe-foundation); INFRASTRUCTURE=9 (audit, auth, authorization, events, field-masking, mailer, object-storage, outbox-publisher, policy-engine); DEFERRED/STUB=1 (talent); ACTIVE PRODUCT=48; HISTORICAL/LEGACY-NAME-ONLY=0; COMPATIBILITY=0; UNKNOWN=0.

Zero-test libs (unit=0 AND integ=0): attachment, audit, calendar, events, saved-list, talent, visibility (7). (audit/events are INFRASTRUCTURE modules; talent is stub.)

Prisma source schema.prisma present: 44 libs. Absent (16): auth-core, authorization, cold-ingest-extraction, export, fe-foundation, field-masking, mailer, object-storage, outbox-publisher, policy-engine, portal(single-schema present, no multiSchema — see note), reporting, resume-parse, talent-extraction, talent-reconcile, visibility. (portal/audit/auth/common/events/matching/skills-taxonomy/talent HAVE schema.prisma but no `schemas=[...]` multiSchema block.)

Outbox (OutboxEvent model) owners = **5 libs**: canonicalization (schema.prisma:64), consent (:92), engagement (:145), placement (:169), submittal (:186). outbox-publisher owns the DRAIN worker, not a model.

Integration-roots (`ci/integration-roots.json`): 35 roots + 1 coverageAlias (libs/tenant-reset → apps/api) + 0 exemptions. Libs bearing integ test files but NOT in roots: talent-trust (integ=11) IS in roots; check — export/visibility not in roots (correct, 0 integ). NOTE: `libs/reporting` IS a root AND has `capacity-projection-edge.integration.spec.ts` (see D-4).

---

## SECTION 3 — LOGICAL DOMAIN / AGGREGATE OWNERSHIP MAP

Columns: logical domain | code owner (lib/app) | persistence owner (PG schema) | API owner (controller/module) | UI owner (FE dir) | event owner (outbox).

| logical domain | code owner | persistence (PG schema) | API owner | UI owner | outbox |
|---|---|---|---|---|---|
| identity/auth/authz | auth-core, auth, authorization, auth-storage; apps/auth-service | auth_storage | libs/auth-core (auth/jwks/portal-auth controllers); apps/auth-service | apps/ats-web/src/users; apps/portal-web/src (login) | none |
| tenant / org / company-admin / RBAC / sites | **libs/identity** (see FLAG-2) | identity | libs/identity/* controllers (tenant-profile, tenant-user, sites, role-catalog, domain-verification, audit, d4a) | ats-web/src/settings, /admin, /org, /teams, /users | none |
| company (client accounts) | libs/company | company | libs/company (company, address-lookup, d4a controllers) | ats-web/src/companies | none |
| contact | libs/contact | contact | libs/contact | ats-web/src/contacts | none |
| talent-record (person SOR, ADR-0016) | libs/talent-record | talent_record | libs/talent-record; apps/api/src/talent-identity/dossier | ats-web/src/talent | none |
| core-talent / identity-index (PII-free cluster) | libs/identity-index | identity_index (NO tenant_id/NO PII) | libs/identity-index (no controller; service) | — | none |
| talent-identity resolution (resolve/advisory/dispute/verify) | apps/api/src/talent-identity/*; identity-index; portal-identity; talent-reconcile | identity_index + portal_identity + talent_record | apps/api/src/talent-identity/* (10 controllers) | ats-web/src/identity-advisories | none |
| requisition / job | libs/requisition; libs/job-domain; libs/job-distribution | requisition; job_domain; job_distribution | libs/requisition; libs/job-distribution | ats-web/src/requisitions | none |
| examination / evidence | libs/examination; libs/evidence; libs/talent-evidence | examination; evidence; talent_evidence | libs/examination (match-list, override); apps/api/src/controllers/examine.controller.ts | (via requisitions/submittals) | none |
| selection / engagement | libs/engagement | engagement | libs/engagement | ats-web/src/engagement | engagement |
| submittal | libs/submittal | **engagement** (data) + submittal (outbox only) — FLAG-1 | libs/submittal | ats-web/src/submittals | submittal (outbox only) |
| pipeline | libs/pipeline | pipeline | libs/pipeline | ats-web/src/pipeline | none |
| placement | libs/placement | placement | **apps/api/src/placement/placement.controller.ts** (FLAG-6) | ats-web/src/placement | placement |
| ContractAssignment (Track 4) | libs/placement | placement | apps/api/src/placement | ats-web/src/placement (AssignmentLifecyclePanel) | placement |
| pre-start | libs/pre-start-requirement | pre_start_requirement | **apps/api/src/pre-start-requirement/*.controller.ts** (lib has 0 controllers/0 module — FLAG-8) | — | none |
| engagement message-delivery / ai-draft | **libs/engagement** (dto/delivery) + libs/ai-draft | engagement; ai_draft | libs/engagement | ats-web/src/engagement (message-composer FE; component name cited by source) | engagement |
| consent | libs/consent | consent + **audit** (ConsentAuditEvent — FLAG-4) | libs/consent | ats-web/src/consent; portal-web | consent |
| canonicalization / ingestion | libs/canonicalization; libs/ingestion; libs/cold-ingest-extraction | canonicalization + **ingestion** (RawPayloadReference — FLAG-5); ingestion | libs/ingestion; apps/api/src/webhooks/indeed-apply | ats-web/src/sourcing | canonicalization |
| search | (no dedicated lib; matching + saved-list) | — | — | ats-web/src/search | none |
| activity / task / calendar | libs/activity; libs/task; libs/calendar | activity; task; calendar | libs/activity; libs/task; libs/calendar | ats-web/src/activity; /task | none |
| saved-lists | libs/saved-list | saved_list | libs/saved-list | (via search/talent) | none |
| reporting | libs/reporting | (no schema — reads others) | libs/reporting (dashboard, reporting controllers) | ats-web/src/dashboard | none |
| settings | libs/settings | settings | libs/settings; apps/api/src/controllers/tenant-settings | ats-web/src/settings | none |
| import / export | libs/import; libs/export | import; (export no schema) | libs/import; libs/export | (settings/talent) | none |
| entitlement / metering | libs/entitlement; libs/metering | entitlement; metering | libs/entitlement (no controller); metering (fn only) | — | none |
| portal-identity / trust | libs/portal-identity; libs/portal; libs/platform-trust; libs/talent-trust | portal_identity; platform_trust; talent_trust | libs/portal; apps/api/src/talent-identity/portal-* | portal-web/src; ats-web/src/trust-proposals, /portal-disputes | none |
| policy | libs/policy-engine (stateless); libs/policy-store | policy_store | (embedded; policy-store service) | ats-web/src/admin (policy) | none |
| sourcing / sourced-talent | libs/sourced-talent; libs/talent-extraction; libs/resume-parse; libs/skills-taxonomy | sourced_talent; talent_extraction/reconcile (no schema); — | apps/api/src/talent-identity/sourcing.controller.ts | ats-web/src/sourcing | none |
| client-talent-restriction | libs/client-talent-restriction | client_talent_restriction | libs/client-talent-restriction | — | none |
| attachment / object-storage | libs/attachment; libs/object-storage | attachment | libs/attachment | — | none |
| tenant-reset | libs/tenant-reset | tenant_reset | (API-hosted) | — | none |
| audit | libs/audit | (writes into consent's audit schema etc.) | libs/identity/audit.controller | ats-web/src/admin | none |

### Logical != Physical ownership FLAGS (flag only, NOT defects)
- **FLAG-1 (directive's named example, CONFIRMED):** `libs/submittal` owns `TalentSubmittalRecord` (schema.prisma:102) and `TalentSubmittalEvent` (:226), but BOTH map `@@schema("engagement")` (:170, :253). Only `OutboxEvent` sits in `@@schema("submittal")` (:195). The submittal domain's business tables physically live in the **engagement** PG schema.
- **FLAG-2:** `libs/identity` (name = "identity") actually owns the **tenant / organisation / team / role-RBAC / sites / tenant-user / domain-verification** administration domain (src/lib dirs: tenant-profile, tenant-user, sites, role-catalog, domain-verification, team/tenant/role repos). It is NOT the talent-identity resolution domain (that is apps/api/src/talent-identity/* + identity-index + portal-identity). Name ≠ domain content.
- **FLAG-3:** The talent-identity resolution domain has **no single lib**: code is split across `apps/api/src/talent-identity/*` (10 controllers), `libs/identity-index`, `libs/portal-identity`, `libs/talent-reconcile`, `libs/talent-record`.
- **FLAG-4:** `libs/consent` `ConsentAuditEvent` model maps `@@schema("audit")` (schema.prisma:130) — consent domain writes into the **audit** PG schema (declared schemas = ["consent","audit"]).
- **FLAG-5:** `libs/canonicalization` `RawPayloadReference` (schema.prisma:94) maps `@@schema("ingestion")` (:134) — canonicalization lib writes into the **ingestion** PG schema (declared schemas = ["canonicalization","ingestion"]).
- **FLAG-6:** Placement API surface lives in `apps/api/src/placement/placement.controller.ts`, NOT in `libs/placement` (lib has 0 controllers). Code owner ≠ API owner.
- **FLAG-7:** Examination API is split: `libs/examination` (match-list, override controllers) + `apps/api/src/controllers/examine.controller.ts`.
- **FLAG-8:** `libs/pre-start-requirement` has 0 controllers AND 0 *.module.ts; its API/module wiring lives at `apps/api/src/pre-start-requirement/*`. Domain lib is repository-only.
- **FLAG-9:** `libs/talent` is a STUB (empty barrel, schema.prisma with zero models) whose NAME overlaps the real person-SOR `libs/talent-record` — naming residue risk (report only; not a rename recommendation).
- **FLAG-10:** Auth domain is fragmented across 4 code owners: `apps/auth-service`, `libs/auth` (guard facade), `libs/auth-core` (logic), `libs/auth-storage` (persistence). Only auth-storage owns a PG schema.
- **FLAG-11:** Two libs (`engagement`, `submittal`) share the single `engagement` PG schema.
- **FLAG-12:** No dedicated message-delivery / `delivery` lib exists; the engagement draft→send→response domain lives INSIDE `libs/engagement` (`src/lib/dto/` message-delivery DTOs + `src/lib/delivery/*`; exact DTO path fragment cited by source — it carries a Tier-2 substring and expanding it inline would fail `scripts/verify-vocabulary.sh`). `ai-draft` is a separate lib.

---

## VOCABULARY SURFACE (mandate §4 — required because §3 touches trust vocabulary: platform-trust, talent-trust, portal-identity, trust-proposals, identity-advisories)

`scripts/verify-vocabulary.sh` allowlist inventory (banned Tier-2 terms NOT restated per CLAUDE.md — reference the script):
- `TIER2_TERMS_REGEX` (line 477): **7** banned-term regex entries (lines 477-489).
- `TIER2_EXCLUDES` (line 94): **129** allowlisted path/glob entries (lines 94-470).
- `R7_ALLOWLIST` (line 36): **18** entries (R7 Charter-refusal source-platform, sealed).
- `R7_ALLOWLIST_GLOB` (line 59): **5** glob entries.
- `FRONTDOOR_LEGACY_ALLOWLIST` (line 77): **8** entries (ADR-0023 retired front-door name).
- **Trust-lib exposure:** NO `TIER2_EXCLUDES` entry names `libs/platform-trust`, `libs/talent-trust`, or `libs/portal-identity` as source. The only trust-adjacent allowlist entries are R10 leakage-detection UI SPECS: `apps/ats-web/src/trust-proposals/TrustProposalsView.spec.tsx` (line 452) and `apps/ats-web/src/identity-advisories/IdentityAdvisoriesView.spec.tsx` (line 446). Product source for the trust libs is NOT exempted → those libs are held clean of Tier-2 vocabulary.

---

## CONTRACT SURFACE (mandate §5 — Pact touched via dependency/API mapping)

- **Consumer count (total generated pacts / consumer test dirs): 6** — ats-web, auth-service-consumer, ingestion-consumer, portal-thin, prohibited-source-type, tenant-console-consumer (`pact/consumers/` = 6 dirs; `pact/pacts/` = 6 json).
- **Consumers verified by THIS provider (aramo-core, `pact/provider/src/verify-api.ts`): 4** — ingestion-consumer (:745), prohibited-source-type (:749), portal-thin (:751), ats-web (:753).
- **auth-service-consumer is verified by a SEPARATE provider** (aramo-auth-service, `pact/provider/src/verify.ts:95,103`) = 1 — kept distinct per CLAUDE.md.
- **DIVERGENCE note:** `pact/pacts/tenant-console-consumer-aramo-core.json` EXISTS on disk but is NOT in the aramo-core verify list (verify-api.ts comments :62-64 mark tenant-console-consumer "retired"). Generated-but-unverified consumer pact. Flag only.

---

## DIVERGENCES (typed; flagged, never resolved)

- **D-1 (i) conflict with tasking assumption:** tasking/RECON-CONTEXT say 64 libs; disk = 60. See §0.
- **D-2 (iii) substrate moved since baseline (MEMORY):** MEMORY asserts (multiple starred entries) `libs/reporting`, `libs/export`, `libs/visibility` have ZERO lib-local integration specs. At baseline SHA, `libs/reporting/src/tests/capacity-projection-edge.integration.spec.ts` EXISTS (matches `*.integration.spec.ts`). export=0, visibility=0 confirm. reporting no longer zero. (Not a defect — MEMORY is not authority; flag.)
- **D-3 (ii) assumption unverifiable from Section-2/3 scope:** whether the reporting integration spec is non-vacuous / actually enrolled-and-bearing cannot be determined from inventory alone (MEMORY warns "enrolment alone is a no-op"). Deferred to a test-execution segment.
- **D-4 (iii) substrate detail:** `libs/reporting` is in `ci/integration-roots.json` roots AND now carries an integration spec — consistent internally, but crosses the MEMORY "no-op enrolment" note. Flag for the coverage segment.
- **D-5 (i) tag gap:** `apps/api` (primary API host), `apps/ats-web`, `apps/auth-service` carry `tags: []` — no nx scope/boundary tag. enforce-module-boundaries cannot constrain these projects. Flag (may be intentional for app-tier).
- **D-6 (iii):** tenant-console-consumer pact generated but not verified by aramo-core (retired). See Contract Surface.

---

## CLOSING

- Baseline commit hash audited: **`ca0974090724b36b130f4d39ea5b1ef486d6adf4`** (origin/main, PR #589). Working tree observed at detached `3a4a3a44b5d635acc276dad7431d74514602616e` (PR #588); none of the 18 PR-#589 files affected the Section-2/3 module/domain inventory (they are ats-web/src/placement UI + doc/generated/repo-map artifacts, already reflected in the ats-web row and FE domain map).
- **No mutation was performed.** No file was written to the repo, no git state changed, no branch/commit/push/checkout, no DB write, no package install, no Terraform. All observations via read-only `ls`, `find`, `grep`, `git rev-parse`, `python3` JSON reads, and `Read`.
