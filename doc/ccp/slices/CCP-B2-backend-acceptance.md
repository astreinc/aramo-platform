# CCP-B2-backend — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3. Assigned by the Architect disposition **TD-A6-13** (`doc/ccp/decisions.md`, "Architect dispositions on A6 (2026-10-25)"):

> B2 owns the catalog publish/retire lifecycle. Its backend command (the governed apply of plan-version publish/retire through the approval engine) must land before B2 UI acceptance. It is built as **CCP-B2-backend** on the A6 apply infrastructure, in its own commit; A6 is not expanded.

| | |
|---|---|
| **Slice** | CCP-B2-backend: governed apply of plan-version publish / retire |
| **Branch / baseline** | `wip/ccp-a6` at program HEAD `e0b050ca` (A1–A6, A9, A10 merged) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **Validation (final state)** | the B2 spec 6 / 6 within the 59 / 59 A6-family run; `libs/subscription` 23 files 450 / 450; `apps/platform-admin` 21 files 451 / 451; `verify-platform-admin` 2 / 2 with the catalog publish interaction; build, lint, gates as in `CCP-A6-acceptance.md` §A6-R.5 |
| **HALT conditions hit** | **None.** No in-place edit of a published version exists (the A5 trigger refuses it; the apply only moves DRAFT → PUBLISHED and PUBLISHED → RETIRED through the A5 repository). |
| **UI** | Not built here (the B2 UI agent owns it). |

## 1. Schedule rows and action names (`path:line`)

| Fact | `path:line` |
|---|---|
| PBD B2 row: "**In:** draft, version, finance-then-owner publish, retire, grandfathering view. **Out:** editing a published version" | `Aramo/locked/Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md:111` |
| PBD A5 row ("**Out:** catalog UI (B2)") | same file `:77` |
| Action type `PLAN_VERSION_PUBLISH` ("A5 / B2 — publish a catalog plan version") | `libs/subscription/src/lib/commercial/commercial-change-request.ts:33`; requester `platform:catalog:draft` at `:81`; DB CHECK `libs/subscription/prisma/migrations/20261025120000_ccp_a3_change_request_approval/migration.sql:88` |
| Action type `PLAN_RETIRE` ("A5 / B2 — retire a plan or plan version") | `commercial-change-request.ts:34`; requester `:82`; DB CHECK `…20261025120000…/migration.sql:88` |
| **`PLAN_VERSION_RETIRE` does not exist** as an action type (reported, not invented). The retire action is `PLAN_RETIRE`; CCP-B2-backend applies it to a plan **version** (TD-B2-1) | — |
| Chain: Finance → Owner (catalog publish; the owner step also needs `platform:catalog:publish`) | `commercial-change-request.ts` `resolveRequiredChain` (`PLAN_VERSION_PUBLISH`, `PLAN_RETIRE` → `FINANCE_THEN_OWNER`); TD-A3-2 (`PLAN_RETIRE` uses the catalog-publish chain) |
| A5 repository methods used | `libs/subscription/src/lib/plan-version.repository.ts:135` `publish`, `:149` `retire`, `:164` `pinProviderPrice` (gains an optional `db` so the pin joins the apply transaction; otherwise unchanged) |

## 2. Commit map (proposed; label **CCP-B2-backend**)

| # | Proposed commit | Files |
|---|---|---|
| B2b-1 | `CCP-B2-backend: catalog apply migration (CommercialCatalogApplication; guard branch for publish / retire, current body verbatim)` | `libs/subscription/prisma/migrations/20261025220000_ccp_b2_catalog_apply/migration.sql` (new); `libs/subscription/prisma/schema.prisma` (model `CommercialCatalogApplication`) |
| B2b-2 | `CCP-B2-backend: governed catalog apply service on the A6 apply command` | `libs/subscription/src/lib/commercial/commercial-catalog-apply.service.ts` (new); `commercial-change-request.ts` (`B2_CATALOG_APPLY_ACTIONS`, `isCatalogApplicable`, `canTransitionFor` branch, the two payload schemas); `plan-version.repository.ts` (`pinProviderPrice(…, db?)`); `subscription.module.ts`, `src/index.ts` (registration / exports); the one-line dispatch in `commercial-apply.service.ts` |
| B2b-3 | `CCP-B2-backend: route DTO, OpenAPI and Pact (catalog_application)` | `apps/platform-admin/src/app/platform/platform-commercial-apply.controller.ts` (`catalog_application`), `dto/commercial-change-application.dto.ts`; `openapi/platform.yaml` (`CommercialCatalogApplication`, envelope); `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts` (+1 interaction); `pact/provider/src/verify-platform-admin.ts` (state `an approved plan-version publish change request exists`) |
| B2b-4 | `CCP-B2-backend: tests` | `libs/subscription/src/tests/ccp-b2-catalog-apply.integration.spec.ts` (new); `ccp-a9-role-change.spec.ts` (A9-U-4 mirror); `support/ccp-a6.ts` (harness); the payload of the A3 / A9 / route specs' publish fixtures (`'pv'` → a uuid) |
| B2b-5 | `CCP-B2-backend: acceptance evidence` | `doc/ccp/slices/CCP-B2-backend-acceptance.md` (new) |

Shared with A6-R (listed in the A6-R map): `commercial-apply-records.ts` (the refusal / failure records both applies use).

## 3. Design

- **Route and command:** the same `POST /platform/commercial/change-requests/{id}/apply`. `CommercialApplyService.apply` dispatches `PLAN_VERSION_PUBLISH` / `PLAN_RETIRE` to `CommercialCatalogApplyService`; the response carries `catalog_application` (and `application: null`).
- **Authority (TD-A6-3, same rules):** the original requester (catalog_manager, `platform:catalog:draft`), a person, re-checked live in the transaction; the NC-5 re-check of both approvals under the snapshotted chain.
- **One transaction:** `FOR UPDATE` on the request (an APPLIED request replays) → NC-5 → live requester authority → APPLYING → the A5 per-plan advisory lock → re-read the version →
  - publish: DRAFT required; optional `provider_price_ref` pinned first (`pinProviderPrice(…, tx)`); `publish(id, now, tx)` (the previous PUBLISHED version → RETIRED in the same transaction);
  - retire: PUBLISHED required; `retire(id, now, tx)`;
  → `CommercialCatalogApplication` → audit (`COMMERCIAL_PLAN_VERSION_PUBLISHED` / `_RETIRED`, `COMMERCIAL_CHANGE_REQUEST_APPLIED` with requester, reason, approvals, from/to status, effective timestamp) → APPLIED.
- **No subscription moves (TD-A5-1 ratified).** Neither path touches `TenantSubscription`.
- **Failures** (stable codes + operator explanations): `VERSION_NOT_FOUND`, `VERSION_NOT_DRAFT`, `VERSION_NOT_PUBLISHED`, `PRODUCT_NOT_REGISTERED`, `PRICE_PIN_CONFLICT`, `INVALID_PAYLOAD`, `UNEXPECTED` → rolled back; APPLY_FAILED (retryable) with one audit row. **Refusals:** `NOT_HUMAN`, `NOT_REQUESTER`, `REQUESTER_SCOPE_MISSING`, `REQUESTER_NO_LONGER_AUTHORIZED`, `NOT_APPROVED`, NC-5 reasons, `INTEGRITY` → nothing changes, one audit row.
- **DB guard (migration `20261025220000`):** the current function body (`20261025200000`, A3 ∪ A9 ∪ A6, with the TD-A6-25 generic `applied_at` check) is kept **verbatim**; added only the B2 branch: publish / retire take the A6 apply set (`APPROVED | APPLY_FAILED → APPLYING → APPLIED | APPLY_FAILED`), the same attempt / `applied_at` rules, and an APPLIED backstop (its `CommercialCatalogApplication` exists and matches, and the version is PUBLISHED / RETIRED). The no-APPLYING-commit constraint trigger is re-created with the two actions in its WHEN list. Mirrored in `canTransitionFor` and A9-U-4.
- **Payload schemas** (enforced at create and at apply): `PLAN_VERSION_PUBLISH {plan_version_id: uuid, provider_price_ref?}`, `PLAN_RETIRE {plan_version_id: uuid}`.
- **Requester-only** (TD-B2-3) and the **apply deadline** (Charter Amendment A1) apply to the catalog apply exactly as to the A6 apply (shared `preflightApply`, `applyDeadlineGate`).

## 4. Test outputs (real Postgres 17, `ccp-b2-catalog-apply.integration.spec.ts`, 6 / 6)

| Test ID | Output |
|---|---|
| B2-PUB-1 | Finance → Owner chain (2 approvals); applied: `catalog_application` {retired v1, pinned `price_b2_v2`, attempt 1}; v1 RETIRED, v2 PUBLISHED; the pin exists; **every TenantSubscription row byte-identical** and the v1 subscriber keeps limit 100; audit `…PLAN_VERSION_PUBLISHED`, `…APPLIED` (outcome, requester, from DRAFT to PUBLISHED, retired version, effective timestamp, 2 approvals); re-apply → `replayed: true`, same application |
| B2-RET-1 | v1 → RETIRED; subscribers byte-identical (grandfathered, limit 100); the plan leaves the catalog |
| B2-FAIL-1 | `VERSION_NOT_DRAFT`, `VERSION_NOT_PUBLISHED`, `VERSION_NOT_FOUND`, `PRICE_PIN_CONFLICT` (explanation "already pinned…"); after the conflict v2 stays DRAFT, v1 PUBLISHED, the existing pin only; request APPLY_FAILED attempt 1; one `…APPLY_FAILED` audit row |
| B2-FAULT-1 | fault after the catalog write → `FAILED:UNEXPECTED`; v1 PUBLISHED, v2 DRAFT, no pin, no catalog application; retry → APPLIED attempt 2 |
| B2-AUTH-1 | `NOT_REQUESTER` (platform_owner), `NOT_HUMAN`, `REQUESTER_SCOPE_MISSING`; versions unchanged; exactly 3 `…APPLY_REFUSED` rows; an unsubmitted request `NOT_APPROVED`; a bad payload refused at create (`INVALID_INPUT`); the requester then applies |
| B2-SM-DB | APPROVED → APPLIED refused; APPLYING without counting refused; a committed APPLYING refused at COMMIT; APPLIED without its catalog application refused; APPLIED frozen; catalog application DELETE refused |
| A9-U-4 (unit) | role actions +2 transitions; A6 **and** B2 actions the A6 apply set (incl. the Charter Amendment A1 `APPLY_EXPIRED` transitions); no other action reaches APPLYING |
| A6R-TTL-B2 (`ccp-a6r-apply-deadline.integration.spec.ts`) | a publish request snapshotted under the v2 fixture is refused `APPLY_EXPIRED` at its deadline; the version stays DRAFT |

Pact: §5 of the A6-R section in `CCP-A6-acceptance.md` (platform-web +1 interaction, `verify-platform-admin`).

## 5. Recovery and rollback

- APPLY_FAILED is retryable; nothing partial (B2-FAULT-1).
- A wrongly published version is retired by a new `PLAN_RETIRE` request, never edited; subscribers keep their pin.
- Compensating migration (documented, not shipped; never run against production, PBD §7.5): RAISE if any `CommercialCatalogApplication` row or any `PLAN_VERSION_PUBLISH` / `PLAN_RETIRE` request in APPLYING / APPLIED / APPLY_FAILED exists; drop the table and its function; restore the `20261025200000` body of `guard_commercial_change_request()` and the trigger's WHEN list.

## 6. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| **TD-B2-1** | `PLAN_RETIRE` is described as "retire a plan or plan version". Only **version** retire is implemented; retiring a whole plan (e.g. `Plan.status = INACTIVE`) has no defined repository method or payload. | For B2 / lead: a plan-level retire needs a definition |
| TD-B2-2 | `PlanVersionRepository.pinProviderPrice` gains an optional `db` (transaction) parameter; behaviour without it is unchanged | Recorded |
| TD-B2-3 | The publish / retire payload schemas are now enforced at create; 4 test fixtures that used `'pv'` / `'pv-1'` were given a uuid | Recorded |
| TD-B2-4 | Creating a DRAFT version (the "draft, version" part of the B2 row) stays a repository method with no route; drafting is the B2 UI agent's backend need | For B2 |
| TD-B2-5 | The catalog apply is not tenant-scoped: it takes the A5 per-plan advisory lock, not a billing lock | Recorded |
