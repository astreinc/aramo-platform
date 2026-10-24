# C1 — Coverage & Completeness Report (baseline 12330b0f5049c97f01022df0b190035933345212)

Read-only recon artifact. Baseline commit SHA (frozen):
`12330b0f5049c97f01022df0b190035933345212`. Working tree confirmed at this SHA
(`git rev-parse HEAD`).

This report accounts for what the full-repository baseline recon pass (v2,
15 domain passes D01–D15) inspected versus the whole repository surface. Every
**denominator** below was **re-derived in this pass** with the exact shell
command recorded beside the number; where a re-derived number differs from the
supplied inventory or from a domain fragment, the re-derived number is used and
the discrepancy is flagged. The per-domain **citation-density** figures are a
reproducible `grep` for `path:line` tokens in each AS-BUILT doc — they measure
citation volume, **not** independently-verified claims, and are labelled as
such. "inspected" means the surface was enumerated and attributed to a domain
pass (name / declaration / route level confirmed); where handler bodies,
migration SQL, or FE component internals were not line-read, that depth gap is
recorded in the NOT-VERIFIED register, never hidden inside the headline count.

---

## Document Inventory

Fifteen domain documents were produced, each with an AS-BUILT file, an
AS-DESIGNED file, a coverage fragment, and a gaps fragment. The consolidated
gap register is `doc/recon/gaps/G1-gap-register.md`.

| Doc id | AS-BUILT path | AS-DESIGNED path |
|---|---|---|
| D01 System Context & Topology | `doc/recon/as-built/D01-system-context-topology.md` | `doc/recon/as-designed/D01-system-context-topology.md` |
| D02 Database & Data Model | `doc/recon/as-built/D02-database-data-model.md` | `doc/recon/as-designed/D02-database-data-model.md` |
| D03 Backend API Surface | `doc/recon/as-built/D03-backend-api-surface.md` | `doc/recon/as-designed/D03-backend-api-surface.md` |
| D04 Security / Identity / AuthZ | `doc/recon/as-built/D04-security-identity-authz.md` | `doc/recon/as-designed/D04-security-identity-authz.md` |
| D05 Talent Domain | `doc/recon/as-built/D05-talent-domain.md` | `doc/recon/as-designed/D05-talent-domain.md` |
| D06 Requisition / Job / VMS | `doc/recon/as-built/D06-requisition-job-vms.md` | `doc/recon/as-designed/D06-requisition-job-vms.md` |
| D07 Pipeline / Placement / Selection | `doc/recon/as-built/D07-pipeline-placement-selection.md` | `doc/recon/as-designed/D07-pipeline-placement-selection.md` |
| D08 Submittal / Engagement / Policy | `doc/recon/as-built/D08-submittal-engagement-policy.md` | `doc/recon/as-designed/D08-submittal-engagement-policy.md` |
| D09 Communications / Activity / Evidence | `doc/recon/as-built/D09-communications-activity-evidence.md` | `doc/recon/as-designed/D09-communications-activity-evidence.md` |
| D10 Documents & E-Signature | `doc/recon/as-built/D10-documents-esignature.md` | `doc/recon/as-designed/D10-documents-esignature.md` |
| D11 Search / Matching / Skills / Intel | `doc/recon/as-built/D11-search-matching-skills-intel.md` | `doc/recon/as-designed/D11-search-matching-skills-intel.md` |
| D12 Sourcing / Ingestion / Import | `doc/recon/as-built/D12-sourcing-ingestion-import.md` | `doc/recon/as-designed/D12-sourcing-ingestion-import.md` |
| D13 Frontend Architecture & Screens | `doc/recon/as-built/D13-frontend-architecture-screens.md` | `doc/recon/as-designed/D13-frontend-architecture-screens.md` |
| D14 Cross-Cutting Platform & Integrations | `doc/recon/as-built/D14-cross-cutting-platform-integrations.md` | `doc/recon/as-designed/D14-cross-cutting-platform-integrations.md` |
| D15 Infra / Deploy / Quality Enforcement | `doc/recon/as-built/D15-infra-deploy-quality-enforcement.md` | `doc/recon/as-designed/D15-infra-deploy-quality-enforcement.md` |

Supporting fragment sets (one per domain): `doc/recon/coverage/_fragments/D01..D15.coverage.md`;
`doc/recon/gaps/_fragments/D01..D15.gaps.md`.

**Citation density (re-derived this pass — a `path:line` token count, NOT a verified-claim count):**
command per file `grep -oE "[A-Za-z0-9_./-]+\.(ts|tsx|prisma|yaml|sql|json|sh|mjs|conf|template|tf):[0-9]+" <as-built> | wc -l`;
mermaid diagrams `grep -c '```mermaid' <as-built>`.

| Doc | `path:line` tokens | mermaid diagrams |
|---|---|---|
| D01 | 52 | 2 |
| D02 | 76 | 6 |
| D03 | 116 | 2 |
| D04 | 145 | 3 |
| D05 | 44 | 3 |
| D06 | 131 | 3 |
| D07 | 136 | 4 |
| D08 | 154 | 3 |
| D09 | 95 | 2 |
| D10 | 125 | 3 |
| D11 | 97 | 3 |
| D12 | 144 | 4 |
| D13 | 90 | 3 |
| D14 | 99 | 3 |
| D15 | 55 | 3 |
| **Total** | **1559** | **47** |

(Totals are the arithmetic sum of a reproducible token count; they are a volume
metric, not an assertion that 1559 distinct claims were each independently
re-verified.)

---

## Surface Coverage Accounting

Every ground-truth total below was re-derived in this pass with the quoted
command. "% enumerated" = `inspected / ground-truth`. Depth beyond enumeration
is in the NOT-VERIFIED register.

| Surface | Ground-truth total | Inspected (enumerated/attributed) | NOT VERIFIED | % enumerated | Method / command (re-derived this pass) |
|---|---|---|---|---|---|
| Applications | 8 | 8 | 0 | 100% | `ls -d apps/*/ \| wc -l` → api, auth-service, esign-service, platform-admin, ats-web, platform-web, portal-web, sign-web; each attributed to D03/D04/D10/D13 |
| Libraries | 76 | 76 | 0 (enumerated); source-depth partial | 100% enum | `ls -d libs/*/ \| wc -l` = 76; all tagged/enumerated in D01; source-level depth is per-domain (see Per-Domain rollup) |
| Backend NestJS controller files (excl spec/test) | 97 | 97 | 0 (classified); handler-body depth partial | 100% | `grep -rl --include=*.ts "@Controller" apps libs \| grep -vE "\.spec\.\|\.test\.\|/tests/" \| wc -l` = **98**, of which `libs/fe-foundation/src/auth/consumer.ts:4` is a **comment false-positive** (not a Nest controller); true count = 97, matching `api-surface-manifest.json` controllers (97) |
| `@Controller(...)` decorator occurrences (excl spec/test) | 105 | 105 | 0 | 100% | `grep -rn --include=*.ts "@Controller(" apps libs \| grep -vE "\.spec\.\|\.test\.\|/tests/\|\.d\.ts" \| wc -l` |
| `@Module` files (excl spec/test) | 141 | n/a (structural) | — | — | `grep -rl --include=*.ts "@Module" apps libs \| grep -vE "\.spec\.\|\.test\.\|/tests/" \| wc -l` (inventory said 140; re-derived 141) |
| `@Injectable` files (excl spec/test) | 458 | per-domain load-bearing subset | majority (body-level) | partial | `grep -rl --include=*.ts "@Injectable" apps libs \| grep -vE "\.spec\.\|\.test\.\|/tests/" \| wc -l` = 458; load-bearing services read per domain, remainder decl-level |
| HTTP handler decorators (Get/Post/Put/Patch/Delete) | 466 | 466 | 0 | 100% | D03 per-verb grep over the controller set: Get 209, Post 208, Put 9, Patch 19, Delete 21 |
| `@RequireScopes(...)` applications (excl spec) | 443 | 443 | 0 | 100% | `grep -rn "@RequireScopes(" apps libs --include=*.ts \| grep -vE "\.spec\.\|/tests/" \| wc -l` |
| Distinct scope-key literals in controllers | 106 | 106 | 0 | 100% | `grep -rhoE "@RequireScopes\([^)]*\)" apps libs --include=*.ts \| grep -oE "'[a-z][a-z0-9_]*:[a-z0-9_:]+'" \| sort -u \| wc -l` |
| Seed scope-catalog keys (`scope.dto.ts`) | 167 | 167 | 0 | 100% | `sed -n '28,464p' libs/identity/src/lib/dto/scope.dto.ts \| grep -cE "^\s*'[a-z][a-z0-9_:-]*',"` |
| Seed role-catalog keys (`role.dto.ts`) | 18 | 18 | 0 | 100% | `awk '/SEED_ROLE_KEYS = \[/{f=1;next} /\] as const/{f=0} f' libs/identity/src/lib/dto/role.dto.ts \| grep -cE "'"` |
| Tenant capability catalog (`CAPABILITY_VALUES`) | 5 | 5 | 0 | 100% | `grep -nE "CAPABILITY_VALUES" libs/entitlement/src/lib/capability.ts` → `['core','ats','portal','sourcing','esign']` (authoritative; DEFAULT_TENANT_CAPABILITIES is a subset, excluded) |
| Git-tracked `schema.prisma` | 53 | 53 | 0 (enum); 12 read in full | 100% enum | `git ls-files '*schema.prisma' \| wc -l` = 53. On-disk `find . -name schema.prisma -not -path '*/node_modules/*'` = 5091 — dominated by **5039 copies under `.claude/worktrees/*`** + 42 under `*/dist/*` + per-lib `generated/client`; NOT the baseline surface |
| `model` declarations (tracked) | 209 | 209 | 0 (field-level partial) | 100% | `git ls-files '*/prisma/schema.prisma' \| xargs grep -hE '^model ' \| wc -l` |
| `enum` declarations (tracked) | 97 | 97 | 0 | 100% | `git ls-files '*/prisma/schema.prisma' \| xargs grep -hE '^enum ' \| wc -l` |
| Tracked `migration.sql` files / migration dirs | 253 | 253 (counted) | SQL bodies largely unread | 100% count | `git ls-files '*/migrations/*/migration.sql' \| wc -l` = 253; `... \| xargs -n1 dirname \| sort -u \| wc -l` = 253 dirs. Trigger/CHECK SQL read only where a domain required it |
| OpenAPI specs | 8 | 8 | 0 | 100% | `ls openapi/*.yaml \| wc -l` → ats, auth, common, documents, esign, ingestion, platform, portal |
| OpenAPI path-items (total) | 243 | 243 | 0 | 100% | per-spec `awk` under `paths:`: ats 154, platform 28, documents 22, portal 14, esign 11, auth 6, common 6, ingestion 2 |
| OpenAPI `operationId` count (total) | 281 | 281 | 0 | 100% | `for f in openapi/*.yaml; do grep -cE "operationId:" $f; done` → ats 176, platform 35, documents 29, portal 15, esign 11, auth 7, common 6, ingestion 2 |
| ADR / LOCKED `.md` files | 35 | partial (heads/titles) | majority not line-read | 100% enum | `git ls-files 'doc/adr/*.md' \| wc -l` = 35; per-domain passes read the anchors they cited (ADR-0005/0006/0007/0011/0012–0020/0023/0024/0027/0029/0030/0031/0032/0033 appear across fragments); remainder title/head-level |
| Pact consumer projects / tracked files | 10 / 109 | 10 (dir) | contract bodies | 100% dir | `git ls-files 'pact/consumers/' \| awk -F/ 'NF>2{print $3}' \| grep -v gitkeep \| sort -u \| wc -l` = 10; `git ls-files pact/ \| wc -l` = 109 (bodies not opened — D15) |
| Terraform files (both tracks) | 70 | partial | dev/staging + most `modules/*` internals | partial | `git ls-files 'infrastructure*/*.tf' 'infrastructure*/**/*.tf' \| wc -l` = 70 (lightsail 8 + `infrastructure/environments` 20 + `infrastructure/modules` 42; the bare `infrastructure*/**/*.tf` glob drops the 8 top-level lightsail files); lightsail 8 read in full (D15), prod `compute.tf`/`talent-intake.tf` + talent-intake-events `main.tf` read; remainder not line-read |
| docker-compose files | 3 | 3 | 2 partial | 100% | `git ls-files \| grep -cE '^docker-compose.*\.yml$'` = 3; `.prod.yml` read in full, other two headers only |
| CI guard scripts (`ci/scripts/*.ts`) | 26 | 26 (named) | 19 name-level only (7 read at symbol level) | 100% name | `git ls-files 'ci/scripts/*.ts' \| wc -l` = 26; symbol-level: run-integration, check-integration-roots, verify-env-passthrough, verify-api-contract-parity, prepush, verify-vocabulary |
| CI integration roots registry | 47 | 47 | 0 | 100% | `python3 -c "import json;print(len(json.load(open('ci/integration-roots.json'))['roots']))"` = 47 |
| ats-web tracked `.tsx` / `.ts` | 410 / 242 | 15 / 6 | 395 / 236 | 3.7% / 2.5% | `git ls-files 'apps/ats-web/src/**/*.tsx' 'apps/ats-web/src/*.tsx' \| wc -l` = 410; `...*.ts` (excl `.tsx`) = 242 — the bare `src/**/*` glob drops the src-root `App.tsx`/`main.tsx` (2 `.tsx`) and `test-setup.ts` (1 `.ts`) (D13 opened shell/entry + sampled; bodies NOT read) |
| ats-web `*-api.ts` FE→BE wiring modules | 65 | enumerated; D13 read 1, domains read theirs | component bodies | partial | `git ls-files 'apps/ats-web/src/**/*-api.ts' \| grep -vcE '\.spec\.'` = 65 |

---

## Per-Domain Coverage (rollup from fragments)

Each row summarises the domain's coverage fragment. "Depth read" names what was
opened in full; "Enumerated only" names what was counted/grepped but not
line-read.

- **D01 System Context & Topology** — 8 apps, 76 libs, 94 tracked `project.json`, 80 tagged projects, 4 backend ports, 4 FE dev ports, 17 infra modules: all enumerated (0 NV in-scope). NV: running-prod runtime selection, `.env` values (out of tree), per-lib tag-vs-ADR-0029 cluster correctness (76, out of D01 scope).
- **D02 Database & Data Model** — 53 tracked schemas (12 read in full, 41 model-name/namespace grep); 209 models, 97 enums, 50 distinct `@@schema` namespaces, 307 `@@schema` lines, 253 migrations all enumerated. NV: 200 of 253 migration trigger-classifications; 4 outbox drain statuses partially verified; endpoint↔table + FE↔table mapping (out of scope); live-DB/FK confirmation (static only).
- **D03 Backend API Surface** — 4 HTTP apps, 97 controllers (manifest-classified: AP 84 / SS 6 / PZ 3 / XP 2 / AD 1 / IZ 1), 466 handler decorators, 443 `@RequireScopes`, 177 `@RequireSiteMatch`, 128 `@UseGuards`, 8 specs / 243 path-items all enumerated. NV: seeded scope-catalog single cardinality (grown additively); 3 of 4 contract-parity dimensions (schema/scope/security — only method+path enforced); per-handler→spec cross-walk (466); runtime boot.
- **D04 Security / Identity / AuthZ** — 242 D04 lib source files (34 read), 21 security controllers (7 read), 6 schemas (model-grepped), 7 auth endpoints + 8 consent endpoints read, 167 scope-catalog + 18 role-catalog keys counted, global-guard wiring confirmed (no `APP_GUARD`). NV: 208 lib files, 14 controllers, FE auth surfaces (platform-web/portal-web/sign-web/platform-admin), 10 auth-service adapters (grep-only), 4 ADR anchors head/title only.
- **D05 Talent Domain** — 7 libs, 2 controllers / 31 endpoints, 30 `@Injectable` (key services read), 35 models, 16 enums, 4 ADRs. NV: 7 of 8 intake-consumer files, 37 of 38 FE talent files, 4 BullMQ processor bodies.
- **D06 Requisition / Job / VMS** — 4 core libs, 3 controllers (Requisition 13 + VMS mapping-admin 7 + pre-start 13 endpoints), 7 requisition models / 5 enums / 23 migrations, 9 `RecruitingStatus` values, 8 governed transition actions, `requisition.repository.ts` read (1–1880 of 2406). NV: tail 1880–2406, ReconciliationDrainService internals, LifecyclePollProducer schedule, scope seeding cross-check, runtime/tests.
- **D07 Pipeline / Placement / Selection** — 5 libs, 3 in-lib + 4 apps/api controllers, 38 distinct documented routes (52 raw decorators), 4 state-machine modules read, 50 model/enum decls, 126 lib source files (load-bearing subset read). NV: 4 placement sub-lifecycle internal guards (offer/commercial/permanent/remedy), migration triggers/partial-indexes (not opened), most view components.
- **D08 Submittal / Engagement / Policy** — 7 controllers (1 route-confirmed only), 26 handlers (25 traced), 17 `@Injectable` (11 read), 4 models, 11 pure decision functions read, 14 `ats.yaml` paths. NV: 6 services (PrismaServices/policy gateways/eligibility reader), `submittal-workspace.controller.ts` bodies, 2 pact files, ADR-0027/0029/0030 line-read; `/v1/client-submittal-policy/*` + `.../restrictions` absent from OpenAPI (gap D08-G1).
- **D09 Communications / Activity / Evidence** — 4 libs / 11 models, 11 controllers (routes read), evidence core (pipeline-state + pipeline.repository) read, `PIPELINE_STAGE_REQUIRES_EVIDENCE` 422 mapping confirmed. NV: 16 of 17 migrations, 10 communications specs, most lib/apps src bodies, 21 of 23 ats-web communications files; evidence-milestone LOCKED directive NOT located.
- **D10 Documents & E-Signature** — Core Documents 22 OpenAPI / 26 controller methods, E-Sign 11 OpenAPI / 15 controller methods (4 signer ops undocumented — gap G1), 4 apps/api D10 controllers read, 15 documents + 12 esign models (schemas read in full). NV: 11 documents SQL + 5 esign SQL migrations, most lib src files, RTR/Offer FE components, pact contracts, E-Sign SNS/KMS Terraform.
- **D11 Search / Matching / Skills / Intel** — 8 libs, 4 lib + 3 apps/api controllers, 44 HTTP routes, 18 models, 4 BullMQ processors, 3 dark-gate env flags confirmed, 8 apps/api composition wirings, 5 ADRs. NV: 19 `@Injectable` bodies, 15 models field-level, 22 migration SQL bodies, FE component bodies.
- **D12 Sourcing / Ingestion / Import** — 7 libs, 5 models, 11 service/repo files (import.service.ts head+grep), 21 HTTP routes fully read + 11 at signature level, 2 ingestion OpenAPI paths (imports/attachments/sourcing/resume-upload-url confirmed ABSENT from ats.yaml), 2 ADRs. NV: 8 DTO bodies, talent-extraction.service.ts full body (3048 lines), 3 no-llm-boundary specs, 27 test files, s3-resume-bucket Terraform.
- **D13 Frontend Architecture & Screens** — 4 SPAs + platform-admin (confirmed backend), 69 ats-web routes enumerated from `App.tsx`, FE build/eslint G1 guard read, 7 fe-foundation files read. NV: 395 ats-web `.tsx` + 236 `.ts` bodies, 61 screen components, 64 `*-api.ts` modules, 229 of 236 distinct `/v1` strings, most platform/portal/sign-web bodies.
- **D14 Cross-Cutting Platform & Integrations** — libs/events (5/5), outbox-publisher (7/8), talent-intake-consumer (7/8), mailer/object-storage/microsoft-graph/task/audit partially read, 26 `@Processor` files (1 read in depth), 14 `@aws-sdk/*` consumers (7 read), talent-intake Terraform module + prod `talent-intake.tf` read. NV: 25 processor bodies, 7 aws-sdk sites, most adapter files, 8 cross-cutting leaf libs (anchor-only).
- **D15 Infra / Deploy / Quality Enforcement** — lightsail IaC 8/8 read, platform IaC 62 (most not line-read), 3 compose (1 full), nginx 4 (template read), CI 2 workflows (ci.yml full), 26 guard scripts (symbol-level subset), 47 integration roots, 18 deployment-gate members, vocabulary gate read in full, nx boundary wall read. NV: dev/staging + `modules/*` Terraform internals, 18 guard-script bodies, pact contract bodies, 27 ADRs for D15, deploy-script internals.

---

## Explicit NOT-VERIFIED Register (every uninspected surface, by domain)

| Domain | NOT-VERIFIED surface | Magnitude (re-derived where countable) |
|---|---|---|
| D01 | Running-prod compose/IaC track selection | 1 (out of tree) |
| D01 | `.env` runtime values | out of tree |
| D01 | Per-lib tag ↔ ADR-0029 D5 cluster correctness | 76 |
| D02 | Schemas not read in full (grep-only) | 41 of 53 |
| D02 | Migration trigger-classification | 200 of 253 |
| D02 | Outbox drain status (offer/documents/esign/talent-evidence) | 4 |
| D02 | Endpoint↔table / FE↔table mapping; live-DB/FK | all (out of scope) |
| D03 | Seeded scope-catalog single cardinality | 1 (additive, not derivable) |
| D03 | Contract-parity dimensions beyond method+path | 3 of 4 (schema/scope/security) |
| D03 | Per-handler → OpenAPI spec cross-walk; runtime boot | 466 / app not launched |
| D04 | D04 lib source files not read | 208 of 242 |
| D04 | Security controllers not read in full | 14 of 21 |
| D04 | FE auth surfaces (platform-web/portal-web/sign-web/platform-admin) | not deep-read |
| D04 | auth-service adapters (grep-only) | 10 of 12 |
| D04 | ADR anchors head/title only | 4 |
| D05 | talent-intake-consumer files | 7 of 8 |
| D05 | FE talent files | 37 of 38 |
| D05 | BullMQ processor bodies | 4 |
| D06 | `requisition.repository.ts` tail | lines 1880–2406 |
| D06 | ReconciliationDrainService / LifecyclePollProducer internals | 2 |
| D06 | Requisition scope seeding cross-check; runtime/tests | 1 / static-only |
| D07 | Placement sub-lifecycle internal guards | 4 (offer/commercial/permanent/remedy) |
| D07 | Migration triggers / partial indexes | all (not opened) |
| D07 | FE view component bodies | subset of 35 |
| D08 | `@Injectable` services not opened | 6 of 17 |
| D08 | `submittal-workspace.controller.ts` handler bodies | 1 |
| D08 | Pact files (located, not opened); ADR-0027/0029/0030 line-read | 2 / 3 |
| D09 | Migrations not read | 16 of 17 |
| D09 | communications test specs | 10 |
| D09 | lib/apps src bodies; ats-web communications files | subset / 21 of 23 |
| D09 | Evidence-milestone LOCKED directive | NOT located |
| D10 | documents + esign migration SQL | 6 + 5 |
| D10 | lib src files not read | documents 11 of 13, esign 15 of 19 |
| D10 | 4 undocumented E-Sign signer ops (gap G1); RTR/Offer FE; pact; SNS/KMS Terraform | 4 / not audited |
| D11 | `@Injectable` bodies | 19 of 28 |
| D11 | Model field-level detail | 15 of 18 |
| D11 | Migration SQL bodies | 22 dirs |
| D12 | DTO bodies | 8 of 13 |
| D12 | `talent-extraction.service.ts` full body | 3048 lines |
| D12 | no-llm-boundary specs; integration/unit specs | 3 / 27 |
| D12 | s3-resume-bucket Terraform | 1 |
| D13 | ats-web `.tsx` / `.ts` bodies | 395 / 236 |
| D13 | Screen components; `*-api.ts` modules; distinct `/v1` strings | 61 / 64 / 229 of 236 |
| D13 | platform-web / portal-web / sign-web bodies | subset |
| D14 | `@Processor` bodies | 25 of 26 |
| D14 | `@aws-sdk/*` consumer sites | 7 of 14 |
| D14 | Cross-cutting leaf libs (anchor-only) | 8 |
| D15 | Platform Terraform internals (dev/staging + `modules/*`) | most of 70 (lightsail 8 + prod compute.tf + talent-intake.tf + talent-intake-events main.tf read) |
| D15 | CI guard-script bodies | 19 of 26 (7 read at symbol level) |
| D15 | Pact contract bodies; D15-relevant ADRs | 109 files / 27 ADRs |
| Cross | Pact contract bodies (all domains) | 109 tracked files, bodies unopened |
| Cross | Live/runtime verification (no app booted) | static read at frozen SHA |

---

## Completeness Statement

1. **Structural surfaces are fully enumerated.** Every app (8), lib (76),
   backend controller (97 real; a bare grep returns 98 due to one comment
   false-positive at `libs/fe-foundation/src/auth/consumer.ts:4`), HTTP handler
   decorator (466), scope application (443), distinct scope-key literal (106),
   seed scope-catalog key (167), seed role key (18), capability value (5),
   tracked Prisma schema (53), model (209), enum (97), migration (253), OpenAPI
   spec (8) / path-item (243) / operationId (281), and ADR file (35) was
   re-derived and accounted for at SHA `12330b0f`.

2. **Depth is deliberately uneven and fully registered.** Backend domain logic
   (D02–D12, D14) was read at load-bearing-symbol depth: state machines, policy
   merges, decision functions, evidence gates, repositories, and schema models
   were opened and cited. The explicit NOT-VERIFIED register above lists every
   surface counted-but-not-line-read; it is exhaustive by domain and is not
   folded into any headline coverage percentage.

3. **The frontend is the largest depth gap.** ats-web alone has 410 tracked
   `.tsx` + 242 `.ts` files; the recon opened the shell/entry/route surface and
   each domain's `*-api.ts` wiring but did not line-read screen component bodies
   (395 `.tsx` + 236 `.ts` NOT read). FE coverage is wiring-and-route level, not
   component-behavior level.

4. **Three surfaces are categorically out of a static pass:** running-prod
   runtime selection and `.env` values (out of tree), live-database / applied-
   migration / FK-presence confirmation (no DB inspected), and pact contract
   bodies (109 files enumerated, none opened).

5. **Count-discipline corrections surfaced this pass** (re-derived numbers win):
   bare `@Controller` grep = 98 but true backend controllers = 97 (one comment
   false-positive); `@Module` re-derived = 141 (inventory said 140);
   on-disk `schema.prisma` = 5091 excl `node_modules` but is dominated by 5039
   `.claude/worktrees/*` copies + 42 `dist/*` copies — the authoritative
   baseline surface is the **53 git-tracked** schemas. The supplied inventory's
   model-decl / on-disk-schema / module figures are superseded by the re-derived
   209 tracked models / 53 tracked schemas / 141 module files respectively.

> No number in this report carries a tilde; every count is reproducible with the
> command recorded beside it at SHA `12330b0f5049c97f01022df0b190035933345212`.
> Per-domain citation-density figures are a `path:line` token volume, explicitly
> not a count of independently re-verified claims.
