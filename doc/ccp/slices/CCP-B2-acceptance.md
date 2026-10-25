# CCP-B2 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.3 B2 row (`:111`: acceptance evidence "Parity; chain test").

| | |
|---|---|
| **Slice** | CCP-B2: product and plan catalog |
| **Branch / baseline** | `wip/ccp-b2` at the program HEAD `7f574fa5`. Built in parallel with CCP-B1. Pre-execution: `doc/ccp/slices/CCP-B2-pre-execution.md` |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** No in-place edit affordance exists on a published version (UI and backend); no console action mutates commercial state directly; no component is promoted into `fe-foundation`; the design pin is unchanged. |
| **Dependency (Architect ruling TD-A6-13)** | **B2 UI acceptance happens only after CCP-B2-backend lands.** B2 owns the catalog publish/retire lifecycle; the governed apply of an approved `PLAN_VERSION_PUBLISH` / `PLAN_RETIRE` is **CCP-B2-backend**, built separately on the A6 apply infrastructure. This slice builds **no** apply. The console executes an approved request through `POST /platform/commercial/change-requests/{id}/apply` (A6), coded against that contract and **mocked** in the specs (this worktree predates A6); the lead wires and verifies it at merge. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| B2-0 | `CCP-B2: pre-execution record (design pin verified)` | `doc/ccp/slices/CCP-B2-pre-execution.md` (new) |
| B2-1 | `CCP-B2: COMMERCIAL_CATALOG_CONFLICT error code` | `libs/common/src/lib/errors/error-codes.ts`, `aramo-error.ts`, `libs/common/src/tests/error-codes.spec.ts`, `openapi/common.yaml` |
| B2-2 | `CCP-B2: catalog read and DRAFT-only write service (libs/subscription)` | `libs/subscription/src/lib/commercial/commercial-catalog.ts`, `commercial-catalog.service.ts` (new); `plan-version.repository.ts` (additive: `createDraft` `exclusive` + caller transaction, `updateDraft` caller transaction, `PlanVersionDraftExistsError`); `subscription.module.ts`; `src/index.ts`; `src/tests/commercial-catalog.spec.ts` (new) |
| B2-3 | `CCP-B2: platform-admin catalog routes, OpenAPI, manifest, orphan scopes` | `apps/platform-admin/src/app/platform/platform-commercial-catalog.controller.ts`, `dto/commercial-catalog.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts` |
| B2-4 | `CCP-B2: per-role route gate + real-Postgres route and chain tests` | `apps/platform-admin/src/tests/ccp-b2-commercial-catalog-authorization.spec.ts`, `ccp-b2-commercial-catalog-routes.integration.spec.ts` (new); `libs/subscription/src/tests/support/ccp-a3-database.ts` (`applyCcpCatalogSchema`, one shared helper) |
| B2-5 | `CCP-B2: Pact consumer interactions + provider states for the catalog routes` | `pact/consumers/platform-web-consumer/src/platform-commercial-catalog.consumer.test.ts` (new); `pact/consumers/platform-web-consumer/vitest.config.ts` (`fileParallelism: false`); `pact/provider/src/verify-platform-admin.ts` |
| B2-6 | `CCP-B2: Catalog screen at /commercial/catalog` | `apps/platform-web/src/commercial/catalog/{CatalogView.tsx,catalog-api.ts,catalog-model.ts,catalog.css,catalog-test-data.ts,CatalogView.spec.tsx,catalog-model.spec.ts}` (new); `src/components/{ChainPreview.tsx,CommercialRequestDialog.tsx,commercial-components.css,commercial-components.spec.tsx}` (new); `src/components/index.ts`, `permissions.ts`; `src/theme.css` (4 CCP tokens); `src/App.tsx` (route) |
| B2-7 | `CCP-B2: visual parity, axe and keyboard against CCP-UI v1.0` | `doc/design-reference/platform-admin/ccp/CCP-UI-v1_0/**` (6 files, byte copy of the pinned release); `apps/platform-web/e2e/support/ccp-proto.ts`, `fixtures/ccp-catalog.ts`, `visual/states-ccp-catalog.ts`, `keyboard/ccp-catalog-journeys.spec.ts` (new); `fixtures/mock-api.ts`, `fixtures/session.ts`, `visual/state-types.ts`, `visual/states.ts`, `visual/capture-reference.spec.ts`, `visual/DIVERGENCES.md`; 28 baseline files `e2e/visual/__screenshots__/ccp-catalog-*-{1440,900}.{png,masks.json}` |
| B2-8 | `CCP-B2: acceptance evidence and repo map` | `doc/ccp/slices/CCP-B2-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **59 new files** (31 source/test/doc, 28 visual baselines) and **27 modified files** = **86 paths**. **No migration.** No returned shape of an existing route changes, so nothing is registered in `pact/provider/src/verify-api.ts`.

**No backend apply was built** (TD-A6-13): nothing in B2 calls `PlanVersionRepository.publish`, `retire` or `pinProviderPrice`; a source-scan test asserts it (B2-RT-NOPUB).

## 2. Routes (all `platform:catalog:*`; platform consumer only)

| Route | Scope | Behaviour |
|---|---|---|
| `GET /platform/commercial/catalog` | `platform:catalog:read` | Registry products (`sign` only), plans, every version with terms, open-subscription pin count, open publish/retire requests; the catalog-publish chain preview from the ACTIVE policy |
| `GET /platform/commercial/catalog/versions/{versionId}` | `platform:catalog:read` | One version: terms, checksum-verified content, pinned tenants (grandfathering view), open requests |
| `POST /platform/commercial/catalog/plans/{planId}/drafts` | `platform:catalog:draft` | A DRAFT copied from a version of the same plan; one DRAFT per plan (409 `draft_exists`); audited `COMMERCIAL_PLAN_VERSION_DRAFTED` |
| `PATCH /platform/commercial/catalog/versions/{versionId}` | `platform:catalog:draft` | Edits a DRAFT's price, envelopes per month, storage only; PUBLISHED/RETIRED → 409 `not_draft`; stale checksum → `stale`; contract price → `contract_priced`; no field for currency/interval (v1 locks), identity or new terms; audited `COMMERCIAL_PLAN_VERSION_DRAFT_UPDATED` |

Publish and retire: `POST /platform/commercial/change-requests` (`PLAN_VERSION_PUBLISH` / `PLAN_RETIRE`, payload `{ plan_version_id, evidence }`) then `POST …/{id}/submit`; Finance → Owner; executed via the A6 apply route (TD-A6-13).

Gates: `contract-parity:check` 681 live routes (679 governed), 512 OpenAPI ops, 0 orphan, 0 unclassified (A10 baseline 677 / 508: **+4 / +4**). `orphan-scopes:check` ok (`platform:catalog:read` reservation removed: now literally enforced) + self-test ok. `openapi:drift-check` ok (9 files). `scope-catalog-consistency` PASS.

## 3. The chain test (PBD B2 row: "Publish only through the chain")

Real guards + real services + real Postgres (`ccp-b2-commercial-catalog-routes.integration.spec.ts`, **6 / 6**):

| Test | Proves |
|---|---|
| B2-RI-CHAIN | catalog_manager drafts v2 → only catalog_manager may create `PLAN_VERSION_PUBLISH` (the other 5 roles 403 `requester_scope_missing`) → chain snapshot `FINANCE_THEN_OWNER` [finance_admin, platform_owner] → the catalog shows the open request on the draft → platform_owner on step 0 409 `OUT_OF_ORDER`, read_only_auditor 409 `STEP_SCOPE_MISSING`, requester 409 `SELF_APPROVAL` → finance_admin 201 → finance_admin again 409 `USER_ALREADY_APPROVED` → platform_owner 201 → **APPROVED**, and the draft is **still DRAFT**, v1 still PUBLISHED (B2 never applies) |
| B2-RI-RETIRE | `PLAN_RETIRE` takes Finance → Owner (TD-A3-2); v1 stays PUBLISHED until applied; after a v2 publish (simulated A6 apply), the subscriber stays pinned to v1 (RETIRED, 1 pinned; v2 0 pinned) |
| B2-RI-IMMUTABLE | PUBLISHED v1: 4 edits → 409 `not_draft`, checksum unchanged; other 5 roles + super_admin 403; direct SQL UPDATE refused by the N-16 trigger; RETIRED v1 and PUBLISHED v2 refused the same way |
| B2-RI-EDIT / B2-RI-DRAFT / B2-RI-READ | DRAFT edits, `stale`, `contract_priced`, `term_missing`, plan identity and v1 locks unchanged, audit events; one DRAFT per plan, `plan_mismatch`; per-role reads, registry `sign` only, 5 plans with PUBLISHED v1, pin counts count open subscriptions only |

UI side (`CatalogView.spec.tsx`): B2-W-CHAIN — "Request publish…" sends exactly `POST /change-requests` then `POST …/{id}/submit`; no publish/retire/apply URL is called. B2-W-APPLY — an APPROVED request is executed only through `POST …/{id}/apply` (mocked A6 contract).

## 4. Per-role visibility (6 roles + super_admin)

| Layer | Evidence | Result |
|---|---|---|
| Route gate (`ccp-b2-commercial-catalog-authorization.spec.ts`, real JwtAuthGuard + RolesGuard, service mocked) | reads admit all 6 CCP roles; draft routes admit catalog_manager only; the other 5 roles and super_admin 403 `missing_scopes` before the service; tenant tier 403, no token 401; 15 malformed bodies 400; 7 error mappings; NOPUB structural check | **57 / 57** |
| Screen (`CatalogView.spec.tsx`, real console route gate) | all 6 roles see the catalog; only catalog_manager has no view-only note and enabled actions; others see the note and disabled actions with "Needs the Catalog manager role."; super_admin sees the in-shell AccessDenied ("This account can't open Catalog", `platform:catalog:read`) and no catalog call is made | 7 role tests in **15 / 15** |

## 5. Parity record (PLATFORM-UX-1 §3; pinned CCP-UI v1.0)

Reference = the pinned `Commercial Control Plane v1.0.dc.html` (byte copy, manifest re-verified on every serve by `e2e/support/ccp-proto.ts`). **7 screen-states × 1440 / 900 = 14 comparisons: 14 / 14 pass** (`PW_E2E_PORT=4401`, after the Docker restart). Under `PW_STRICT=1` (0 px) 9 / 14 are pixel-exact; the rest differ by 2–202 glyph-edge pixels (AA-B2-01 on the two dialog states, 300 px, measured 202 max).

States: draft (catalog_manager), view only (platform_owner), published, retired (grandfathered), no plans (ATS), publish dialog, retire dialog.

axe (WCAG 2.2 AA + best practice): **7 / 7**, 0 serious/critical outside the existing design-conflict rules. Keyboard: **3 / 3** (B2-K1 select plan + version and submit a publish request; B2-K2 retire typed confirm, Escape returns focus to the opener; B2-K3 published fields disabled and skipped by Tab).

## 6. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| DV-B2-01 | Pending slice | Rail, breadcrumb, env-bar CCP context line, ⌘K placeholder (and the 900px identity truncation) masked: shell owned by CCP-B1 | **Lead: remove at the B1 + B2 merge and re-capture** |
| DV-B2-02 | Design data | No "SAMPLE" tag/suffix: the build shows the real catalog | Lead to confirm |
| DV-B2-03 | Data gap (R-13) | Seats: no seat term in the Sign plan model → empty disabled field, "—" in diffs | Recorded |
| DV-B2-04 | Data | Change request shown by short UUID, not "CR-1044" | Recorded; B1 may define a display id |
| DV-B2-05 | Fixture note | The parity fixture reproduces the prototype's two-PUBLISHED-versions sample, which the A5 store (one PUBLISHED per plan) never returns | Recorded; no mask |
| TD-B2-1 | Contract proposal (for A6 / B2-backend) | Catalog request payload = `{ plan_version_id, evidence }` (A3 does not validate catalog payloads; A3 has no evidence field) | **B2-backend to confirm** |
| TD-B2-2 | Interaction | Draft fields save on blur (PATCH with the read checksum); the design has no Save button | Recorded |
| TD-B2-3 | Contract (TD-A6-13) | Apply is `POST …/{id}/apply` (A6), mocked; response read as `{ request }`; the "Apply" / "Retry apply" button is shown on APPROVED / APPLY_FAILED for every catalog viewer and the server decides who may apply | **Lead: verify against A6 at merge**; align the button gating with A6's apply authority |
| TD-B2-4 | Substrate | A5 v1 version ids are md5-derived (`md5(...)::uuid`), not RFC 9562 variant-valid; the catalog routes validate the uuid **shape** (`UUID_SHAPE`) instead of `ParseUUIDPipe` / `IsUUID` | Recorded |
| TD-B2-5 | Harness | Two consumer files write one pact; parallel writers lost/corrupted interactions (25–48 of 50), so the consumer project runs files serially (`fileParallelism: false`) | Recorded |
| TD-B2-6 | Coordination | B2 adds `catalogRead` / `catalogDraft` to `permissions.ts`, CCP tokens to `theme.css`, two personas to `e2e/fixtures/session.ts`, the CCP design copy under `doc/design-reference/platform-admin/ccp/`, and `ChainPreview` / `CommercialRequestDialog` in `src/components/` — B1 may touch the same files | Lead: merge / dedupe with B1 |
| TD-B2-7 | Pending slice | super_admin sees the PLATFORM-UX-1 per-route AccessDenied; the commercial variant naming the six roles is B1's (handoff §11) | B1 |
| TD-B2-8 | Coverage | Catalog loading skeleton not pixel-compared (the CCP file draws none); covered by B2-W-SKELETON | Recorded |

## 7. Tests and gates run and not run (exact counts)

| Run | Result |
|---|---|
| `libs/subscription` `commercial-catalog.spec.ts` | 4 / 4; lib unit suite 191 passed, 186 skipped (integration-gated) |
| `libs/common` `error-codes.spec.ts` | 2 / 2 |
| `apps/platform-admin` unit suite | 12 files, **382 / 382** |
| `apps/platform-admin` targeted integration (`ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2`, after the Docker restart) | B2 routes **6 / 6**; A3 routes 7 / 7; `platform-me` + `dashboard` (AppModule boot with the new controller) 10 / 10 |
| Pact consumer (`platform-web-consumer`) | 2 files, 50 / 50; pact file **50 interactions** (A10's 32 + **18 B2**: 17 on the 4 catalog routes — 4 allowed, 5 role/state refusals, 8 gate refusals — and 1 catalog_manager `PLAN_VERSION_PUBLISH` create) |
| Pact provider `verify-platform-admin.ts` | 2 / 2 (coverage gate + verification); **50 / 50 interactions verified, 0 failures**, from 1 pact. Platform-admin verifies 1 pact; the repository's other consumer pacts are not verified by this provider (kept distinct) |
| `apps/platform-web` unit | B2 specs 24 / 24 (model 6, view 15, components 3); full suite 317 / 318 — the 1 failure is `ProvisionTenantView.spec.tsx` "walks the three steps…", a load-sensitive navigation race in a file B2 does not touch (passed 1 of 3 isolated runs under load average 41) |
| platform-web e2e (port 4401) | visual parity 14 / 14; axe 7 / 7; keyboard 3 / 3; regression sample `tenant-overview` parity 6 / 6 |
| lint (`aramo-platform-web`, `platform-admin`, `subscription`, `common`, `aramo-pact-provider`, `platform-web-consumer-pact`) | 0 errors (warnings only; B2 files: non-null assertions in tests only) |
| typecheck `aramo-platform-web`; `tsc` platform-admin; build `aramo-platform-web`, `platform-admin`, `subscription`, `common` | pass |
| `contract-parity:check`, `openapi:drift-check`, `orphan-scopes:check` + self-test, `scope-catalog-consistency`, `repo-map:generate` / `repo-map:check` | pass (temporary git index for the new files) |
| `scripts/verify-vocabulary.sh` | exit 0: Tier 1, Tier 2, front-door clean; no exemption touched |
| **Not run** | full `nx run api` and full platform-admin integration suite (CI / lead at program acceptance); full platform-web visual suite (only the 14 B2 + a 6-state regression sample); the A6 apply route itself (not on this base; mocked); B1 shell parity |

## 8. Recovery and rollback

UI revert (PBD B2 row) plus the route/service revert. No migration, no data written except audited DRAFT rows through the new routes. Versions are additive; a DRAFT is never published by B2.

## 9. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0; Tier 1, Tier 2, Front-Door clean. Design-copy terms passed unchanged; the design reference copy is excluded by `**/design-reference/**`.
