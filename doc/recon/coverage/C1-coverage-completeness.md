# C1 — Coverage & Completeness Report (baseline 680907fc06620845944794e0a529918c980f5124)

Read-only recon artifact. Baseline commit SHA (frozen):
`680907fc06620845944794e0a529918c980f5124`. The working tree is branch
`docs/recon-refresh-680907fc`, a docs-only commit on top of this SHA; the code
tree is identical to it (`git diff 680907fc -- . ':!doc/recon' ':!.gitignore'`
is empty), and every count below was derived against the commit itself
(`git ls-tree` / `git grep` / `git show` at `680907fc`), never the working tree.

This report accounts for what the full-repository recon refresh (15 domain
passes D01–D15, refreshed from baseline 12330b0f) inspected versus the whole
repository surface. Every **denominator** below was **re-derived in this pass**
with the exact shell command recorded beside the number; where a re-derived
number differs from a domain fragment, the re-derived number is used and the
discrepancy is flagged. The per-domain **citation-density** figures are a
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
mermaid diagrams `grep -c '^```mermaid' <as-built>`.

| Doc | `path:line` tokens | mermaid diagrams |
|---|---|---|
| D01 | 74 | 2 |
| D02 | 158 | 8 |
| D03 | 203 | 3 |
| D04 | 237 | 4 |
| D05 | 96 | 4 |
| D06 | 187 | 3 |
| D07 | 182 | 5 |
| D08 | 195 | 4 |
| D09 | 182 | 3 |
| D10 | 251 | 5 |
| D11 | 165 | 4 |
| D12 | 182 | 5 |
| D13 | 193 | 4 |
| D14 | 209 | 4 |
| D15 | 81 | 4 |
| **Total** | **2595** | **62** |

(Totals are the arithmetic sum of a reproducible token count; they are a volume
metric, not an assertion that 2595 distinct claims were each independently
re-verified. At 12330b0f the same command gave 1559 tokens and 47 diagrams.)

---

## Surface Coverage Accounting

Every ground-truth total below was re-derived in this pass with the quoted
command, run against `680907fc` (`S=680907fc`; `NS='\.spec\.|\.test\.|/tests/|\.d\.ts'`).
"% enumerated" = `inspected / ground-truth`. Depth beyond enumeration is in the
NOT-VERIFIED register. Old-baseline figures are given in parentheses.

| Surface | Ground-truth total | Inspected (enumerated/attributed) | NOT VERIFIED | % enumerated | Method / command (re-derived this pass) |
|---|---|---|---|---|---|
| Applications | 10 (8) | 10 | 0 | 100% | `git ls-tree -d --name-only $S apps/ \| wc -l` → api, ats-web, auth-service, home-web, platform-admin, platform-web, portal-web, sign-service, sign-web, talent-intelligence-service; each attributed to D01/D03/D04/D10/D11/D13 |
| Libraries | 80 (76) | 80 | 0 (enumerated); source-depth partial | 100% enum | `git ls-tree -d --name-only $S libs/ \| wc -l` = 80 (+7 added, −3 retired, 3 renames — see D01); all tagged/enumerated in D01; source-level depth is per-domain |
| Backend NestJS controller files (excl spec/test) | 131 (97) | 131 | 0 (classified); handler-body depth partial | 100% | `git grep -lE "^@Controller\(" $S -- 'apps/*.ts' 'libs/*.ts' \| grep -vE "$NS" \| wc -l` = **131**, matching `api-surface-manifest.json` controllers (131). A bare `git grep -l "@Controller"` returns **132**; the extra file is the comment false-positive `libs/fe-foundation/src/auth/consumer.ts:4` (not a Nest controller), as at 12330b0f |
| `@Controller(...)` decorator occurrences (excl spec/test) | 137 (105) | 137 | 0 | 100% | `git grep -nE "^@Controller\(" $S -- 'apps/*.ts' 'libs/*.ts' \| grep -vE "$NS" \| wc -l` = 137. Unanchored `"@Controller("` returns 141; the 4 extra hits are comments (`apps/api/src/tenant-llm/tenant-llm.controller.ts:46`, `libs/auth-core/src/lib/portal-auth.controller.ts:19`, `:20`, `libs/fe-foundation/src/auth/consumer.ts:4`) |
| `@Module` files (excl spec/test) | 165 (141) | n/a (structural) | — | — | `git grep -l "@Module" $S -- 'apps/*.ts' 'libs/*.ts' \| grep -vE "$NS" \| wc -l` = 165; D01's 172 is the same grep without the spec/test filter |
| `@Injectable` files (excl spec/test) | 573 (459) | per-domain load-bearing subset | majority (body-level) | partial | `git grep -l "@Injectable" $S -- 'apps/*.ts' 'libs/*.ts' \| grep -vE "$NS" \| wc -l` = 573; D01's 580 is the same grep without the filter. The old C1's 458 was an on-disk grep; the git command at 12330b0f gives 459 |
| HTTP handler decorators (Get/Post/Put/Patch/Delete) | 667 (466) | 667 | 0 | 100% | per-verb `^\s*@<Verb>\(` count over the 131 controller files (read via `git show $S:<file>`): Get 281, Post 310, Put 16, Patch 31, Delete 29 (+1 `@Sse`, D03) |
| `@RequireScopes(...)` applications (excl spec) | 533 (443) | 533 | 0 | 100% | `git grep -n "@RequireScopes(" $S -- 'apps/*.ts' 'libs/*.ts' \| grep -vE "\.spec\.\|/tests/" \| wc -l` = 533 (text matches, includes comments); decorator lines only (`^[[:space:]]*@RequireScopes\(`) = 496 |
| Distinct scope-key literals in controllers | 122 (106) | 122 | 0 | 100% | `git grep -hoE "@RequireScopes\([^)]*\)" $S -- 'apps/*.ts' 'libs/*.ts' \| grep -oE "'[a-z][a-z0-9_]*:[a-z0-9_:]+'" \| sort -u \| wc -l` = 122; on live decorator lines only = 120 (the 2 comment-only keys are `requisition:edit` and `sign:envelope:send`, D03) |
| Seed scope-catalog keys (`scope.dto.ts`) | 190 (167) | 190 | 0 | 100% | `git show $S:libs/identity/src/lib/dto/scope.dto.ts \| sed -n '27,516p' \| grep -cE "^\s*'[a-z][a-z0-9_:-]*',"` (range = `SEED_SCOPE_KEYS = [` to its `] as const`; the old range was `28,464p`) |
| Seed role-catalog keys (`role.dto.ts`) | 18 (18) | 18 | 0 | 100% | `git show $S:libs/identity/src/lib/dto/role.dto.ts \| awk '/SEED_ROLE_KEYS = \[/{f=1;next} /\] as const/{f=0} f' \| grep -cE "^\s*'[a-z_]+',"` = 18. The old command's `grep -cE "'"` now returns 19 because one comment line inside the array carries an apostrophe; the anchored form is used. Composition changed: `ats_admin` / `tenant_admin` renamed rows, `esign_*` → `sign_*`, `sign_owner` retired |
| Tenant capability catalog (`CAPABILITY_VALUES`) | 6 (5) | 6 | 0 | 100% | `git grep -n "CAPABILITY_VALUES" $S -- libs/entitlement/src/lib/capability.ts` → `['core','ats','portal','sourcing','sign','intelligence']` (authoritative; DEFAULT_TENANT_CAPABILITIES is a subset, excluded) |
| Git-tracked `schema.prisma` | 54 (53) | 54 | 0 (enum); 17 read in full or by changed section (D02) | 100% enum | `git ls-tree -r --name-only $S \| grep -c 'schema.prisma$'` = 54 (5 added, 4 removed — see D02). On-disk `find` counts are not used: they are dominated by copies under `.claude/worktrees/*`, `dist/*` and per-lib `generated/client` |
| `model` declarations (tracked) | 283 (209) | 283 | 0 (field-level partial) | 100% | `git grep -hE '^model ' $S -- '*schema.prisma' \| wc -l` |
| `enum` declarations (tracked) | 98 (97) | 98 | 0 | 100% | `git grep -hE '^enum ' $S -- '*schema.prisma' \| wc -l` |
| Tracked `migration.sql` files / migration dirs | 314 / 314 (253 / 253) | 314 (counted) | SQL bodies largely unread | 100% count | `git ls-tree -r --name-only $S \| grep -cE '/migrations/[^/]+/migration.sql$'` = 314; `… \| xargs -n1 dirname \| sort -u \| wc -l` = 314 dirs; 4 apply to the separate TI database (`libs/intelligence-core`). Trigger/CHECK SQL read only where a domain required it |
| OpenAPI specs | 9 (8) | 9 | 0 | 100% | `git ls-tree --name-only $S openapi/ \| grep -c yaml` → ats, auth, common, documents, ingestion, intelligence, platform, portal, sign (`esign.yaml` renamed `sign.yaml`; `intelligence.yaml` added) |
| OpenAPI path-items (total) | 435 (243) | 435 | 0 | 100% | per-spec `git show $S:<spec> \| awk '/^paths:/{p=1;next} /^[a-z]/{p=0} p&&/^  \//{c++} END{print c}'`: ats 205, sign 71, platform 68, documents 35, intelligence 25, portal 16, auth 7, common 6, ingestion 2 |
| OpenAPI `operationId` count (total) | 499 (281) | 499 | 0 | 100% | `for f in openapi/*.yaml; do git show $S:$f \| grep -cE "operationId:"; done` → ats 236, platform 80, sign 75, documents 48, intelligence 27, portal 17, auth 8, common 6, ingestion 2 |
| ADR / LOCKED `.md` files | 36 (35) | partial (heads/titles) | majority not line-read | 100% enum | `git ls-tree --name-only $S doc/adr/ \| grep -c '\.md$'` = 36 (+`0036-talent-intelligence-service.md`); per-domain passes read the anchors they cited (ADR-0007/0011/0015/0017/0018/0019/0023/0024/0029/0030/0033/0036 appear across fragments); remainder title/head-level |
| Pact consumer projects / tracked files | 13 / 128 (10 / 109) | 13 (dir) | contract bodies | 100% dir | `git ls-tree -r --name-only $S pact/consumers \| awk -F/ 'NF>2{print $3}' \| grep -v gitkeep \| sort -u \| wc -l` = 13; `git ls-tree -r --name-only $S pact/ \| wc -l` = 128; 1 provider project with 4 verifier suites (D15); interaction counts per D10 consumer recorded by D10, bodies not audited |
| Terraform files (both tracks) | 70 (70) | partial | dev/staging + `modules/*` internals | partial | `git ls-tree -r --name-only $S \| grep -E '^infrastructure' \| grep -c '\.tf$'` = 70 (lightsail 8 + `infrastructure/environments` 20 + `infrastructure/modules` 42; no `.tf` under `infrastructure/` changed since 12330b0f; `doc4-esign.tf` renamed `doc4-sign.tf`); lightsail 8 read (D15), prod `compute.tf` / `talent-intake.tf` + talent-intake-events `main.tf` read; remainder not line-read |
| docker-compose files | 4 (3) | 4 | 2 partial | 100% | root: `git ls-tree -r --name-only $S \| grep -cE '^docker-compose.*\.yml$'` = 3, plus `deploy/geoip/docker-compose.geoip.yml` = 1; `.prod.yml` (10 services) and the geoip file read in full, the other two headers + diff only |
| CI guard scripts (`ci/scripts/*.ts`) | 26 (26) | 26 (named) | 20 name-level only (6 read at symbol level) | 100% name | `git ls-tree --name-only $S ci/scripts/ \| grep -c '\.ts$'` = 26; symbol-level (D15): check-integration-roots, verify-env-passthrough, verify-api-contract-parity, verify-frontdoor-conf, prepush, release-manifest |
| CI integration roots registry | 49 (47) | 49 | 0 | 100% | `git show $S:ci/integration-roots.json \| python3 -I -c "import json,sys;print(len(json.load(sys.stdin)['roots']))"` = 49 |
| ats-web tracked `.tsx` / `.ts` | 427 / 257 (410 / 242 by the `**/` glob) | 12 / 3 | 413 / 252 | 2.8% / 1.2% of the D13 glob | `git ls-tree -r --name-only $S \| grep -E '^apps/ats-web/src/.*\.tsx$' \| wc -l` = 427 and `… '\.ts$'` = 257 (all tracked, specs included). D13's `git ls-files 'apps/ats-web/src/**/*.tsx'` / `'**/*.ts'` = 425 / 255 drops the src-root `App.tsx`, `main.tsx`, `feature-flags.ts` and `test-setup.ts`; inspected / NOT VERIFIED are D13's figures against its glob (shell/entry + sampled; bodies NOT read) |
| ats-web `*-api.ts` FE→BE wiring modules | 63 (65) | enumerated; D13 read 1, domains read theirs | component bodies | partial | `git ls-tree -r --name-only $S \| grep -E '^apps/ats-web/src/.*-api\.ts$' \| grep -vc '\.spec\.'` = 63 |
| Other FE apps / FE libs (non-spec source files) | home-web 10 · platform-web 33 · portal-web 10 · sign-web 49 · org-admin-web 54 · document-templates-web 12 · fe-foundation 53 | 6 · 3 · 2 · 9 · 4 · 2 · 10 | 4 · 30 · 8 · 40 · 50 · 10 · 43 | partial | D13 fragment commands (`git ls-files <pkg>/src … \| grep -vc spec`); home-web, org-admin-web and document-templates-web are new since 12330b0f |

**Method corrections recorded by the fragments** (old counts that came from a
working-tree / on-disk grep, re-derived from git at both SHAs):
- **D01 `@Injectable`** — the old fragment's 465 was an on-disk grep; `git grep -l "@Injectable" 12330b0f -- 'apps/*.ts' 'libs/*.ts' | wc -l` = 466 (580 at 680907fc by the same command).
- **D01 infra modules** — the old fragment's 17 was an on-disk `ls`; `git ls-tree -d --name-only <sha> infrastructure/modules/` = 14 at both SHAs.
- **D04 lib files** — the old recorded 242 came from a working-tree `find`; the `git ls-tree` command over the D04 libs gives 206 at 12330b0f and 227 at 680907fc.
- Also reported: D06 integration lifecycle/mapping models (old 10 was a transcription slip; 12 at both SHAs), D06 ats-web requisition FE files (old 56 from `find`; 81 at 12330b0f, 98 at 680907fc), D07 per-schema model/enum split (54 at both SHAs; old split misrecorded), D08 `submitted_to_ats` comment occurrences (10 at both SHAs; old 9), and the C1 role-key command above.

---

## Per-Domain Coverage (rollup from fragments)

Each row summarises the domain's coverage fragment. "Depth read" names what was
opened in full; "Enumerated only" names what was counted/grepped but not
line-read.

- **D01 System Context & Topology** — 10 apps, 80 libs, 106 tracked `project.json`, 85 tagged apps+libs projects (5 apps untagged), 5 backend ports, 5 FE dev ports, 137 `@Controller` / 172 `@Module` / 580 `@Injectable` files (unfiltered), 54 schemas, 314 migrations, 84 `@aramo/*` path mappings, 9 OpenAPI specs, 36 ADRs, 4 compose files, 10 prod services, 4 nginx host classes, 5 baked SPA roots, 5 backend Dockerfiles, 14 infra modules: all enumerated. NV: running-prod runtime selection (incl. whether TI runs), `.env` values (out of tree), per-lib tag-to-cluster correctness vs ADR-0029 D5 / ADR-0036 (79 of 80 not checked).
- **D02 Database & Data Model** — 54 tracked schemas (17 read in full or by changed section, 37 model-name/namespace grep); 283 models, 98 enums, 51 distinct `@@schema` namespaces, 382 `@@schema` lines, 4 multi-namespace datasources, 314 migrations (84 added, 23 deleted, 5 renamed since 12330b0f; 4 TI-database), 9 S2 erasure migrations, 13 outbox-style tables, 18 AS-DESIGNED anchors. NV: 247 of 314 migration trigger-classifications; 2 outbox drains with no reader found (documents, offer); endpoint↔table + FE↔table mapping (out of scope); live-DB/FK and drop-migration / TI-database application status (static only).
- **D03 Backend API Surface** — 5 HTTP apps, 131 controller files / 137 decorators (manifest-classified: AP 100 / SS 16 / PZ 7 / XP 5 / IZ 2 / AD 1), 667 handler decorators, 533 `@RequireScopes` matches (496 decorator lines), 122 distinct scope keys, 61 composite-boundary applications, 29 controller files with no `@UseGuards` line, 9 specs / 435 path-items (3 of 9 with `servers:`), 185-entry `transitionalUndocumented` ratchet, 10 route overrides. NV: seeded scope-catalog single cardinality; 3 of 4 contract-parity dimensions (schema/scope/security); per-handler → spec cross-walk (667); 37 lib-authored controllers' host composition; runtime boot.
- **D04 Security / Identity / AuthZ** — 227 D04 lib source files (48 read), 21 security controllers (6 read), 5 schemas (models grepped), 23 new migrations since 12330b0f (IC-1, ROLES-1 last-owner and S2 bodies read), 8 auth endpoints + 8 consent endpoints read, 190 scope-catalog + 18 role-catalog keys counted, 7 authorization services and 7 Personal-signup risk-control files read, no `APP_GUARD` confirmed. NV: 179 lib files, 15 controllers, per-route audit behind 101 `JwtAuthGuard` / 92 `@RequireScopes` / 86 `@RequireCapability` files, 4 `EsignSenderBoundary` users (D10), 4 FE auth files, 9 auth-service files, 4 ADR anchors head/title only, 8 LOCKED directives cited at title/§ level only.
- **D05 Talent Domain** — 2 lib controllers / 29 endpoints, 25 talent-identity routes (9 controllers), 23 education + screening routes (5 read), 25 `@Injectable` files, 29 models / 20 enums, 8 new talent migrations (each read), 5 ADRs, 12 canonical LOCKED instruments. NV: TI service bodies (9 controllers / 28 handlers + 17 intelligence-core classes, 45 items), 18 `ScreeningSessionController` routes, 7 of 11 intake-consumer files, 45 of 46 FE talent files, 2 BullMQ processor bodies.
- **D06 Requisition / Job / VMS** — 4 core libs, 3 controllers (Requisition 13 + VMS mapping-admin 7 + pre-start 13 endpoints), 7 requisition models / 5 enums / 24 migrations, 4 new hold columns, 9 `RecruitingStatus` values, 8 governed transition actions, 12 integration lifecycle models+enums, `requisition.repository.ts` (2752 lines; every changed hunk read), 98 ats-web requisition FE files, 2 documented requisition operations. NV: ReconciliationDrainService internals, LifecyclePollProducer schedule, ActivityNote linkage, scope seeding cross-check, Talent × Requisition 360 FE (10 files), runtime/tests.
- **D07 Pipeline / Placement / Selection** — 5 libs, 3 in-lib + 4 apps/api controllers, 4 new `libs/pipeline` port adapters, 6 state-machine modules read, 54 model/enum decls (31 models), 2 new migrations (headers read), 52 raw endpoint decorators (36 as-built table rows), 42 OpenAPI D07 paths, 135 lib source files (load-bearing subset read), 37 FE files referencing D07 routes. NV: 4 placement sub-lifecycle internal guards, migration triggers / partial indexes, 16 FE spec files, view-component bodies.
- **D08 Submittal / Engagement / Policy** — 8 controllers (+ `talent-journey-audit`), 26 handlers, 18 `@Injectable` files (12 read), 4 models, 1 new migration, 13 pure decision functions read, 14 `ats.yaml` domain paths, 7 ats-web callers, 8 canonical LOCKED directives. NV: 6 services (per-module PrismaServices, policy gateway read paths, eligibility reader), 2 pact files, ADR-0027/0029/0030 sections, S2 amendment beyond migration headers; `/v1/client-submittal-policy/*` + `.../restrictions` absent from OpenAPI (gap G-028).
- **D09 Communications / Activity / Evidence** — 4 libs / 13 models, 11 in-scope controllers + the new apps/api Microsoft surface, evidence core (pipeline-state, pipeline.repository, evidence-admissibility, verifier) read, provider-observation orchestrator read (0 production callers), 2 error codes and 422 mappings confirmed. NV: 16 of 25 migrations, 10 communications specs, 12 + 11 + 19 lib src files (communications / activity / contact + calendar), 21 + 2 + 20 apps/api files (communications / talent-journey / microsoft), 22 of 24 ats-web communications files, 3 scheduling FE files.
- **D10 Documents & E-Signature** — Core Documents 35 OpenAPI paths / 48 operations = 43 lib controller ops + 5 seam ops; Sign 71 paths / 75 operations vs 79 sign-service controller ops (4 signer ops undocumented — gap G-029); 10 apps/api D10 controllers (41 methods), 2 Sign signup controllers, schemas read in full (documents 17, sign 22, subscription 14, signature_routing 4 models), D10 scope catalog groups, 6 pact consumer sets (36 interactions counted), Sign host nginx. NV: 38 of 41 migration SQL files across the 4 schemas, 14 + 28 + 44 + 13 + 2 src files (documents / sign / sign-service / subscription / signature-routing), 21 provider-routing files, 44 sign-web files, 12 document-templates-web files, 30 FE template / RTR / provider screens, Sign SNS/KMS/storage Terraform.
- **D11 Search / Matching / Skills / Intel** — 8 D11 libs + 6 new TI / screening libs and apps, 4 lib + 4 apps/api D11 controllers + 2 intelligence/screening controllers, 47 D11 HTTP routes, 20 D11 models, 4 BullMQ processors, 3 dark-gate flags + 3 TI gates, 12 composition wirings, 6 ADRs + 9 LOCKED. NV: 20 D11 + 27 TI `@Injectable` bodies, 7 TI controllers (route-decls by grep), 28 TI handlers, 36 TI / screening models field-level, 18 + 6 migration bodies, 7 FE surfaces line-level, TR-SCREEN-1 DDR (headers only).
- **D12 Sourcing / Ingestion / Import** — 7 libs, 5 models, 12 service/repo files (11 read), 21 HTTP routes fully read + 12 at signature level, 2 ingestion OpenAPI paths (imports / attachments / resume-upload-url / sourcing confirmed ABSENT), the PR #1007 DOCX / redaction change (2 files), 3 ADRs, 5 canonical LOCKED instruments. NV: 8 of 13 DTO bodies, `talent-extraction.service.ts` full body (3142 lines), 5 no-llm-boundary specs, 28 lib specs, 3 FE wiring files (route-grepped), s3-resume-bucket Terraform.
- **D13 Frontend Architecture & Screens** — 5 SPAs (ats-web, home-web, platform-web, portal-web, sign-web) + platform-admin confirmed backend, 72 ats-web routes from `App.tsx`, 26 sign-web `/v1` strings, 13 FE nx tag rows, FE build/eslint G1 guard and scope constraints read, front door (5 server blocks, 5 SPA roots), 14 FE-touching LOCKED directives. NV: 413 ats-web `.tsx` + 252 `.ts` bodies, 58 screen components, 62 `*-api.ts` modules, 227 of 235 distinct `/v1` strings, 30 platform-web + 8 portal-web + 40 sign-web + 4 home-web + 50 org-admin-web + 10 document-templates-web + 43 fe-foundation files, 28 org-admin-web `/v1` strings.
- **D14 Cross-Cutting Platform & Integrations** — libs/events (5/5), outbox-publisher (7/8), talent-intake-consumer (10/11), ats-talent-events (3/6), intelligence-integration (4/14), mailer (5/9), object-storage (4/8), microsoft-graph (3/12), subscription billing (4/17), Sign integration files (5), signup-risk ports (4), external e-signature providers (6/15), tenant LLM (4), task (2/16), audit (2/2), 19 `@Processor` files (1 read in depth), 12 `setInterval` workers (6 gates read), 14 `@aws-sdk/*` consumers (9 read), talent-intake Terraform module + prod `talent-intake.tf`, 10 LOCKED directives. NV: 18 processor bodies, 6 interval workers, 5 aws-sdk sites, most adapter files, 8 cross-cutting leaf libs (anchor-only).
- **D15 Infra / Deploy / Quality Enforcement** — lightsail IaC 8/8 read, platform IaC 62 (2 read in full), 9 Cognito trigger files (README read), 4 compose (2 full), 10 prod services, nginx 4 (template read), CI 2 workflows (`ci.yml` read at the governed sections), 26 guard scripts (6 symbol-level), 49 integration roots, 18 deployment-gate members, 13 pact consumer projects / 128 files, 10 deploy scripts (4 read), vocabulary gate anchors + nx boundary wall read. NV: dev/staging + 14 `modules/*` Terraform internals, 8 Cognito trigger sources, 20 guard-script bodies, pact contract bodies, 27 ADRs for D15, internals of 6 deploy scripts, `deploy-public-staging.yml`.

---

## Explicit NOT-VERIFIED Register (every uninspected surface, by domain)

| Domain | NOT-VERIFIED surface | Magnitude (re-derived where countable) |
|---|---|---|
| D01 | Running-prod compose/IaC track selection; whether TI runs on the box | 1 (out of tree) |
| D01 | `.env` runtime values | out of tree |
| D01 | Per-lib tag ↔ ADR-0029 D5 / ADR-0036 cluster correctness | 79 of 80 |
| D02 | Schemas not read in full (grep-only) | 37 of 54 |
| D02 | Migration trigger-classification | 247 of 314 |
| D02 | Outbox drain status with no reader found (documents, offer) | 2 |
| D02 | Endpoint↔table / FE↔table mapping; live-DB/FK; drop-migration and TI-database application status | all (out of scope / static only) |
| D03 | Seeded scope-catalog single cardinality | 1 (additive, not derivable) |
| D03 | Contract-parity dimensions beyond method+path | 3 of 4 (schema/scope/security) |
| D03 | Per-handler → OpenAPI spec cross-walk | 667 |
| D03 | Lib-authored controller → host app composition | 37 of 40 |
| D03 | Runtime boot | app not launched |
| D04 | D04 lib source files not read | 179 of 227 |
| D04 | Security controllers not read in full | 15 of 21 |
| D04 | Per-route audit behind `JwtAuthGuard` / `@RequireScopes` / `@RequireCapability` files | 101 / 92 / 86 (counts only) |
| D04 | `EsignSenderBoundary` users in sign-service | 4 of 5 (D10) |
| D04 | FE auth surface files not deeply inspected | 4 (AuthShell, portal-web, sign-web signup routes, platform-web `PersonalReviewView`) |
| D04 | auth-service app source not read | 9 of 12 |
| D04 | ADR anchors head/title only; LOCKED directives at title/§ level only | 4 / 8 |
| D05 | Talent Intelligence service bodies (controllers + intelligence-core classes) | 45 |
| D05 | `ScreeningSessionController` routes (decorator-only) | 18 of 20 |
| D05 | talent-intake-consumer files | 7 of 11 |
| D05 | FE talent files | 45 of 46 |
| D05 | BullMQ processor bodies | 2 |
| D06 | ReconciliationDrainService / LifecyclePollProducer internals | 2 |
| D06 | ActivityNote requisition linkage | 1 (cross-domain, partial) |
| D06 | Requisition scope seeding cross-check | 1 |
| D06 | Talent × Requisition 360 FE | 10 files (list only) |
| D06 | Runtime/tests | static-only |
| D07 | Placement sub-lifecycle internal guards | 4 (offer/commercial/permanent/remedy) |
| D07 | Migration triggers / partial indexes | all (not opened beyond the 2 S2 headers) |
| D07 | FE files referencing D07 routes (spec only) | 16 of 37 |
| D08 | `@Injectable` services not opened | 6 of 18 |
| D08 | Pact files (located, not opened) | 2 |
| D08 | ADR-0027/0029/0030 sections; S2 amendment beyond migration headers | 3 / 1 |
| D09 | Migrations not read | 16 of 25 |
| D09 | communications test specs | 10 |
| D09 | lib src files not read (communications / activity / contact + calendar) | 12 of 20 / 11 of 16 / 19 of 21 |
| D09 | apps/api files not read (communications / talent-journey / microsoft) | 21 of 33 / 2 of 4 / 20 of 25 |
| D09 | ats-web communications files; scheduling FE files | 22 of 24 / 3 (grep only) |
| D10 | documents / sign / subscription / signature_routing migration SQL | 16 of 17 / 13 of 14 / 7 of 8 / 2 of 2 |
| D10 | lib/app src files not read (documents / sign / sign-service / subscription / signature-routing) | 14 of 18 / 28 of 31 / 44 of 50 / 13 of 16 / 2 of 3 |
| D10 | apps/api provider routing + external providers | 21 of 25 |
| D10 | sign-web / document-templates-web src files | 44 of 49 / 12 of 12 |
| D10 | FE template + RTR + provider screens | 30 |
| D10 | 4 undocumented Sign signer ops (gap G-029); DOC-1b reconciliation wiring; Sign SNS/KMS/storage Terraform | 4 / not audited / not audited |
| D11 | `@Injectable` bodies (D11 libs / TI surface) | 20 of 30 / 27 of 31 |
| D11 | TI controllers and handlers | 7 of 9 controllers; 28 handlers (guards read on 2 controllers) |
| D11 | TI / screening model field-level detail | 36 |
| D11 | Migration SQL bodies (D11 libs / TI + screening) | 18 / 6 |
| D11 | FE D11 surfaces line-level; TR-SCREEN-1 DDR | 7 / 1 |
| D12 | DTO bodies | 8 of 13 |
| D12 | `talent-extraction.service.ts` full body | 3142 lines |
| D12 | HTTP routes at signature level only | 12 |
| D12 | no-llm-boundary specs; lib integration/unit specs | 5 / 28 |
| D12 | FE wiring files route-grepped only | 3 of 4 |
| D12 | ADR anchors by role/title only; s3-resume-bucket Terraform | 3 / 1 |
| D13 | ats-web `.tsx` / `.ts` bodies | 413 / 252 |
| D13 | Screen components; `*-api.ts` modules; distinct `/v1` strings | 58 / 62 / 227 of 235 |
| D13 | platform-web / portal-web / sign-web / home-web bodies | 30 / 8 / 40 / 4 |
| D13 | org-admin-web / document-templates-web / fe-foundation bodies | 50 / 10 / 43 |
| D13 | org-admin-web distinct `/v1` strings | 28 (listed, not paired) |
| D14 | `@Processor` bodies | 18 of 19 |
| D14 | `setInterval` worker files (named only) | 6 of 12 |
| D14 | `@aws-sdk/*` consumer sites | 5 of 14 |
| D14 | Adapter / support files not opened (outbox-publisher, talent-intake-consumer, ats-talent-events, intelligence-integration, mailer, object-storage, microsoft-graph, apps/api Graph adapters, subscription, e-signature providers, task) | 1 / 1 / 3 / 10 / 4 / 4 / 9 / 20 / 13 / 9 / 14 |
| D14 | Cross-cutting leaf libs (anchor-only); talent-intake Terraform `variables.tf` / `outputs.tf`; `Aramo-ADR-0018-…-LOCKED.md` mirror | 8 / 2 / 1 |
| D15 | Platform Terraform internals (dev/staging + `modules/*`) | 60 of 62 (lightsail 8 + prod `compute.tf` + `talent-intake.tf` read) |
| D15 | Cognito trigger function sources and harness | 8 of 9 |
| D15 | CI guard-script bodies | 20 of 26 (6 read at symbol level) |
| D15 | nginx `nginx.conf`, `README.md`; `deploy-public-staging.yml` | 2 / 1 |
| D15 | Deploy-script internals (singlebox-compose, pg-restore, 4 `*.test.sh`) | 6 of 10 |
| D15 | Pact contract bodies; D15-relevant ADRs | 128 files / 27 ADRs |
| Cross | Pact contract bodies (all domains) | 128 tracked files, bodies unopened |
| Cross | Live/runtime verification (no app booted) | static read at frozen SHA |

---

## Completeness Statement

1. **Structural surfaces are fully enumerated.** Every app (10), lib (80),
   backend controller (131 real; a bare grep returns 132 due to one comment
   false-positive at `libs/fe-foundation/src/auth/consumer.ts:4`), HTTP handler
   decorator (667), scope application (533), distinct scope-key literal (122),
   seed scope-catalog key (190), seed role key (18), capability value (6),
   tracked Prisma schema (54), model (283), enum (98), migration (314), OpenAPI
   spec (9) / path-item (435) / operationId (499), and ADR file (36) was
   re-derived and accounted for at SHA `680907fc`.

2. **Depth is deliberately uneven and fully registered.** Backend domain logic
   (D02–D12, D14) was read at load-bearing-symbol depth: state machines, policy
   merges, decision functions, evidence gates, repositories, and schema models
   were opened and cited; several domains (e.g. D06, D07, D08) read every
   hunk changed since 12330b0f in their load-bearing files via
   `git diff 12330b0f 680907fc`. The explicit
   NOT-VERIFIED register above lists every surface counted-but-not-line-read; it
   is exhaustive by domain and is not folded into any headline coverage
   percentage.

3. **The frontend is the largest depth gap.** ats-web alone has 427 tracked
   `.tsx` + 257 `.ts` files, and the new home-web, sign-web, org-admin-web and
   document-templates-web packages add 125 non-spec source files; the recon
   opened the shell/entry/route surface and each domain's `*-api.ts` wiring but
   did not line-read screen component bodies (413 `.tsx` + 252 `.ts` ats-web
   files NOT read). FE coverage is wiring-and-route level, not component-behavior
   level.

4. **The new Talent Intelligence service is enumerated, not deep-read.** Its 9
   controllers / 28 handlers, 31 `@Injectable` files across the TI surface and
   36 TI / screening models are inventoried at decl / route level (D05, D11);
   bodies and guards beyond 2 controllers are NOT VERIFIED.

5. **Three surfaces are categorically out of a static pass:** running-prod
   runtime selection and `.env` values (out of tree), live-database / applied-
   migration / FK-presence confirmation (no DB inspected; this includes whether
   the destructive ATI-SEP-1 drop migration or the TI database are applied
   anywhere), and pact contract bodies (128 files enumerated, none opened).

6. **Count-discipline corrections surfaced this pass** (re-derived numbers win):
   bare `@Controller` grep = 132 but true backend controllers = 131 (one comment
   false-positive); unanchored `@Controller(` = 141 vs 137 decorators (4 comment
   hits); `@Module` / `@Injectable` = 165 / 573 excluding specs and tests (D01's
   172 / 580 are unfiltered); the role-key command was anchored (the old form
   returns 19 because of a comment apostrophe; true count 18); on-disk
   `schema.prisma` counts are dominated by worktree, `dist` and generated
   copies — the authoritative surface is the **54 git-tracked** schemas. The
   fragment-reported method corrections for D01 `@Injectable`, D01 infra modules
   and D04 lib files are listed under Surface Coverage Accounting.

> No number in this report carries a tilde; every count is reproducible with the
> command recorded beside it at SHA `680907fc06620845944794e0a529918c980f5124`.
> Per-domain citation-density figures are a `path:line` token volume, explicitly
> not a count of independently re-verified claims.
