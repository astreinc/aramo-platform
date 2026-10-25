# CCP-B4 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.3 **B4** row (acceptance evidence: "N-3 statement; parity"). Governing instruments: MP-A2 N-2, N-3, N-4; Charter L6; PLATFORM-UX-1 Amendment A1 (A1-4, A1-4a, A1-5, A1-6); Conversion Rule §3.1 definition (b) and O-5. Pre-execution record: `doc/ccp/slices/CCP-B4-pre-execution.md` (design hashes, D-1…D-9).

| | |
|---|---|
| **Slice** | CCP-B4: enterprise contracts (backend `Contract` + `ContractAmendment`, and Commercial › Contracts) |
| **Branch / baseline** | `wip/ccp-b4` at `078d4f78` (program HEAD after A6) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** N-3(a)–(d) are met (§1). `guard_commercial_change_request()` is **not** changed. No direct console mutation, no component promotion into `fe-foundation`, no unpinned design change. |
| **Rail item for B1** | `Commercial › Contracts` → route **`/commercial/contracts`** (registered in `apps/platform-web/src/App.tsx`, gated on `platform:subscription:read`). Visible to platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; **not** catalog_manager (TD-B4-3) and not super_admin. B4 does not edit the rail, the shell, `crumbs.tsx` or `permissions.ts`. |

## 1. N-3 statement (MP-A2 N-4)

Both tables are created additively by `libs/subscription/prisma/migrations/20261026030000_ccp_b4_enterprise_contracts/migration.sql` (below: `M`).

| Clause | How it is met | `path:line` | Test |
|---|---|---|---|
| **(a)** lives in the `subscription` schema | `CREATE TABLE "subscription"."Contract"`, `CREATE TABLE "subscription"."ContractAmendment"`; Prisma `@@schema("subscription")` | `M:90`, `M:129`; `libs/subscription/prisma/schema.prisma` (models `Contract`, `ContractAmendment`) | B4-N3-a (`ccp-b4-contracts.integration.spec.ts:118`) |
| **(b)** references its parent authority row by FK | `Contract.tenant_subscription_id UUID NOT NULL` → `TenantSubscription(id)` ON DELETE RESTRICT; one contract per row (unique); `ContractAmendment.contract_id` → `Contract(id)`; both reference the governing `CommercialChangeRequest` | `M:95`, `M:114`, `M:122`, `M:154` | B4-N3-b (`:126`: the 4 FKs, `NOT NULL`, and a `DELETE` of the referenced subscription refused) |
| **(c)** never answers "which plan, allowance or subscription does T hold for P" | No plan, version, product, allowance, commitment, quota, capability or tenant column. The read model takes plan, version, commitment and state **through** `TenantSubscription` (join). The terms are evidence text; no resolver reads the tables. | columns `M:90-120`, `M:129-158`; read join `libs/subscription/src/lib/commercial/commercial-contract.repository.ts:289-296` | B4-N3-c (`:144`: exact column list; allowance status byte-equal after recording a contract whose terms text says 999,999 envelopes; static scan of `libs/subscription`, `libs/entitlement`, `libs/metering`, `apps/sign-service`: 0 readers outside the contract module and the A6 wiring) |
| **(d)** no second subscription-like, entitlement-like or ledger table; no open/closed state; no usage ledger | No status/state/ended/period/usage column; ACTIVE / ENDED is `TenantSubscription.ended_at` (`status: r.ended_at === null ? 'ACTIVE' : 'ENDED'`); both tables append-only; usage stays in `AllowanceUsage`. `ContractAmendment.kind = 'END'` is the end's **evidence**, inserted only after the subscription row has ended in the same transaction; it is never read as state. | `commercial-contract.repository.ts:310`; append-only `M:166-180`; END guard `M:247-250` | B4-N3-d (`:187`: no state column, no FK to/from a usage table, the end leaves the contract row byte-identical, usage rows unchanged, UPDATE/DELETE refused on both tables) |

**No direct mutation (PBD §5.3 HALT).** A contract is written only inside the CCP-A6 apply transaction of an approved request: the optional `contract` block on `SUBSCRIPTION_OPEN` / `SUBSCRIPTION_CHANGE`, `contract_amendment` on `SUBSCRIPTION_CHANGE`, `contract_end` on `SUBSCRIPTION_END` (`commercial-change-request.ts:375`, `:386`, `:393`; `commercial-apply.service.ts:242`, `:486`). The insert guards refuse any row not written by a request in `APPLYING` of the matching action, tenant and product, with `recorded_by` = the requester and provenance = the request kind (`M:185-220`, `M:222-264`). Test B4-GUARD-1 (`:333`).

**Conversion Rule §3.1 (b) ⊆ (a).** The contract insert guard admits only an open MANUAL BASE row with no provider link (`M:201-204`), so `isGovernedSubscription` (`libs/subscription/src/lib/billing/governed-subscription.ts:30`) needs no change; its comment now records (b). This closes A6's TD-A6-2 hand-off.

## 2. Design as implemented

- **Record.** `SUBSCRIPTION_OPEN` (or `SUBSCRIPTION_CHANGE` on the open governed row) with `contract: { contract_ref, terms[], documents[], evidence_ref? }` → `Contract` + audit `COMMERCIAL_CONTRACT_RECORDED`.
- **Amend.** `SUBSCRIPTION_CHANGE` with `contract_amendment: { contract_id, summary, terms?, documents[], evidence_ref? }`. The plan version may stay the same (a terms-only amendment): the subscription row is then not written, there is no re-pin, no usage transition and no `COMMERCIAL_SUBSCRIPTION_CHANGED` (`commercial-apply.service.ts:426`). Without a contract block a same-version change is still `NO_CHANGE`. Audit `COMMERCIAL_CONTRACT_AMENDED`.
- **End.** `SUBSCRIPTION_END` of a contract-linked row MUST carry `contract_end.contract_id` naming that contract; otherwise `APPLY_FAILED CONTRACT_MISMATCH`. An open may not replace a contract-linked row. Audit `COMMERCIAL_CONTRACT_ENDED`.
- **New apply failure codes** (retryable, A6 semantics): `CONTRACT_ALREADY_RECORDED`, `CONTRACT_REF_TAKEN`, `CONTRACT_MISMATCH`. No new error code in `libs/common`; no new HTTP error code.
- **Read routes** (`apps/platform-admin/src/app/platform/platform-commercial-contract.controller.ts`, read-only, `@RequireScopes('platform:subscription:read')` at `:30`, `:42`): `GET /platform/commercial/contracts` (`tenant_id`, `status`, `limit` ≤ 200) and `GET /platform/commercial/contracts/{id}` (current terms, recorded terms, documents with recorder, amendments, `invoicing: { enabled: false, reason: "enterprise_invoicing_choice_pending" }`).
- **Evidence attachments** (TD-B4-1): metadata only — `{ name, sha256 (lowercase hex), byte_size?, media_type? }`, ≤ 20 per record, no repeats, closed keys; validated at create, again at apply, and by the DB CHECK (`ccp_b4_valid_evidence_documents`). No bytes stored, no `bytea` column. Each document is shown with its recorder and date.
- **UI** (`apps/platform-web/src/contracts/`): list beside the detail (facts, negotiated terms, documents table with `sha256:xxxxxxxx…yyyyyy`, amendments timeline newest first), designed loading and empty states, in-shell AccessDenied via the existing route gate. "Record amendment…" and "End contract…" (TypedConfirm = contract id) **create and submit** a change request; the toast says the contract changes once every step is signed. Actions are `aria-disabled` with the tooltip "Needs the Commercial ops role." without `platform:subscription:request`.

## 3. Parity record (PLATFORM-UX-1 §3; pinned CCP-UI v1.0, MANIFEST `12aa308b…7d65e`)

`apps/platform-web/e2e/visual/ccp-contracts.spec.ts`, references captured from the pinned file (`PW_CAPTURE_REFERENCE=1`, `e2e/support/ccp-proto.ts`), build compared at the suite's settings (threshold 0.2, ≤ 25 px). Image scope: the page content (`<main>`, to the viewport bottom) or the dialog box; the shell is B1's (TD-B4-6). Final run on `PW_E2E_PORT=4409`, after the Docker restart: **26 / 26 passed** (15 visual, 8 axe, 3 keyboard).

| State | 1440 | 900 | Masks (sanctioned, `e2e/visual/DIVERGENCES.md`) |
|---|---|---|---|
| `ccp-contracts-ops` (commercial_ops, CT-2024-007 selected) | ✅ | ✅ | DV-B4-1 (timeline) |
| `ccp-contracts-view-only` (read_only_auditor: actions at 45%) | ✅ | ✅ | DV-B4-1 |
| `ccp-contracts-ended` (CT-2024-019: no actions; timeline unmasked) | ✅ | ✅ | none |
| `ccp-contracts-empty` | ✅ | ✅ | none |
| `ccp-contracts-loading` (skeleton) | ✅ | ✅ | none |
| `ccp-contracts-amend-dialog` | ✅ | ✅ | DV-B4-2 (chain strip) |
| `ccp-contracts-end-dialog` (TypedConfirm) | ✅ | ✅ | DV-B4-2, DV-B4-3 (sub line, 2nd diff row) |

Mutation check: a 1px change of the H1 size fails `ccp-contracts-empty` at both viewports (3830 / 3838 px differ), so the comparison is live. **axe** (`e2e/a11y/ccp-contracts-axe.spec.ts`, 8 states incl. the catalog_manager AccessDenied): 0 blocking serious / critical; the two Lead-ruled design-palette rules are reported, not gated, as for PLATFORM-UX-1. **Keyboard** (`e2e/keyboard/ccp-contracts.spec.ts`): K-B4-1 select → amend → submit with only Tab/Enter/Space/typing, focus visible at every stop, focus returned, exactly 2 requests (`POST …/change-requests`, `POST …/{id}/submit`); K-B4-2 focus trap (Shift+Tab wraps) and Escape back to the opener, 0 requests; K-B4-3 disabled actions reachable with their reason, catalog_manager gets the in-shell AccessDenied.

## 4. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription` `ccp-b4-contracts.integration.spec.ts` (real Postgres 17, after the Docker restart) | **11 / 11** (B4-N3-a…d, REC-1, MIG-1, AMD-1, END-1, REC-2, GUARD-1, EVD-1). The pre-restart run is void (daemon down); the first post-restart run found 4 failures, fixed: a Prisma `Json?` column refused a plain `null` (now omitted = SQL NULL), and the A3 path admits no `MIGRATION` kind (test re-scoped, TD-B4-7) |
| `libs/subscription` unit `ccp-b4-contract-payload.spec.ts` | **3 / 3** |
| `libs/subscription` whole suite, `ARAMO_RUN_INTEGRATION=1 --maxWorkers=2` (23 files) | 437 / 438; the 1 failure was a 30 s timeout under load in `commercial-catalog-a1.integration.spec.ts`; that file alone **14 / 14** |
| `apps/platform-admin` whole suite, `ARAMO_RUN_INTEGRATION=1 --maxWorkers=2` (22 files, AppModule-booting specs included) | **464 / 464**; includes `ccp-b4-commercial-contract-authorization.spec.ts` **13 / 13** (per role: PO, FA, CO, SA, RA 200 on list and detail; catalog_manager and super_admin 403 `missing_scopes [platform:subscription:read]` on both, repository never reached; 401; tenant tier 403; 404; 400 ×5; read-only controller) |
| `apps/api` targeted (every lib migration applied): `ccp-a4-ats-sign-availability`, `s2-erasure-integrity`, `tenant-reset`, `tr15-b2-erasure`, `portal-p4b-rtbf` | **5 files, 35 / 35** |
| `apps/platform-web` unit (32 files) | 300 / 303 then 302 / 303 on two loaded runs; failures were in untouched files (`ProvisionTenantView`, `PlatformShell`, `DocumentTemplatesListView`) and differ per run; those 3 files serially **37 / 37** twice. `src/contracts` **9 / 9**; with `App.spec.tsx` **14 / 14** |
| Pact consumer `platform-web-consumer` | **46 interactions** (37 + 9: list allowed 200, list catalog_manager 403, detail allowed 200, detail 404, detail catalog_manager 403, 2 super_admin 403, 2 tenant-tier 403) |
| Pact provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`, after the restart) | **2 / 2** (the A10 CCP route coverage gate now over 11 CCP routes, and the verification). New provider state `an enterprise contract exists` records the contract through the HTTP surface: create → submit → approve (finance_admin) → apply (commercial_ops) |
| `nx run-many -t lint -p subscription platform-admin aramo-platform-web` | 0 errors (pre-existing warnings); touched platform-web files 0 errors |
| `nx run-many -t build -p subscription platform-admin aramo-platform-web --skip-nx-cache` | 3 projects + 30 dependency tasks succeeded; `dist/libs/subscription/src/index.d.ts` exports `ContractRepository` (HEAD marker) |
| `openapi:drift-check` / `redocly lint openapi/platform.yaml` | ok (9 files) / valid, 2 warnings (baseline) |
| `contract-parity:check` | 680 live routes (678 governed), 511 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A6: 678 / 676 / 509; +2 / +2 / +2) |
| `orphan-scopes:check` | ok (no new scope) |
| `repo-map:generate` → `repo-map:check` | ok; run under a temporary `GIT_INDEX_FILE` with every changed path staged (real index untouched); 3 files regenerated |
| `bash scripts/verify-vocabulary.sh` | OK (Tier 1, Tier 2, front-door clean; no exemption touched; `doc/design-reference/**` is the existing design-mockup exemption) |
| **Not run:** the full `nx run api` (instructed); `pact:provider` for `verify.ts` / `verify-api.ts` / `verify-sign.ts` / `verify-ti.ts` (no shape they verify changed); the full PLATFORM-UX-1 parity catalog (no shared component or shell file changed). | — |

`pact/provider/src/verify-api.ts`: **not changed** — the migration changes no apps/api returned shape (the 5 api specs above pass unchanged).

## 5. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-B4-1 | Narrowest design (no reusable pattern) | Evidence documents are metadata (name + SHA-256 + optional size and media type) in a validated `jsonb` array on each record; no bytes, no third table. `libs/documents` is `scope:boundary` (forbidden from `scope:shared` `libs/subscription`), `DocumentAssociation.resource_type` has no contract value, and `libs/object-storage` key conventions are talent-specific. The UI shows documents but offers no upload (the pinned design has none). | Recorded; a byte store needs a design and an ownership ruling |
| **TD-B4-2** | Ruling vs design | Contract amend / end ride `SUBSCRIPTION_CHANGE` / `_END`, which resolve to the **Finance-only** chain (PO ruling TD-A3-2). The design draws Finance → Owner ("Above threshold") for contract amend / end. The chain strip shows the server's chain (DV-B4-2). | **Needs PO confirmation** (changing it is a chain-resolution change in A3, not B4) |
| **TD-B4-3** | A1 matrix vs design | Reads gate on `platform:subscription:read`, which catalog_manager does not hold (A1 §4.1); the handoff shows "Commercial (all)" to catalog_manager. catalog_manager gets the in-shell AccessDenied. | B1 should hide the item for catalog_manager or keep the AccessDenied; PO to confirm |
| TD-B4-4 | Not delivered (PBD §10) | Contract invoicing is not built; the pinned design has no invoicing element, so none is drawn. The API states it: `invoicing.enabled = false`, `reason = enterprise_invoicing_choice_pending`. | NOT DELIVERED until the enterprise invoicing choice |
| TD-B4-5 | Copy (truthfulness) | End contract: the design says the end "revokes the Sign entitlement"; A6 `SUBSCRIPTION_END` does not revoke (A7, TD-A6-8). Sub line and the second diff row say the subscription ends and the entitlement is not revoked (DV-B4-3). | Recorded; revisit when A7's governed revoke can be composed |
| TD-B4-6 | Parity scope | B4 images are cropped to `<main>` / the dialog; the shell (Commercial rail group, crumb "Commercial / Contracts", the six-role AccessDenied card of handoff §2) is B1's. Until B1 merges, the route uses the existing `PlatformAccessDenied`, whose permission label for `platform:subscription:read` is the raw code. | For B1 (rail item, crumb, commercial AccessDenied variant, permission labels) |
| TD-B4-7 | Gap | "Migrated — provenance: migration" needs a `MIGRATION`-kind request; the A3 create path refuses that kind ("not created through this path"). Provenance follows the request kind (DB guard), so a migrated contract can only come from a future governed backfill path. | For the backfill owner (D-phase / migration slice) |
| TD-B4-8 | Design data vs record model | Timeline titles are "Contract recorded" / "Migrated into the commercial control plane" / "Amendment n" / "Contract ended"; the prototype's free-form titles and pre-migration history are sample data (DV-B4-1). | Recorded |
| TD-B4-9 | Semantics | A terms-only amendment applies with `from_plan_version_id = to_plan_version_id` and re-ensures the product bundle (idempotent, `capabilities_inserted = []`), satisfying the unchanged A6 APPLIED backstop. | Recorded |
| TD-B4-10 | Q14 interplay | A failing contract apply leaves the request `APPLY_FAILED`, which holds the tenant × product slot (TD-A6-5, open). | Inherits TD-A6-5 |
| TD-B4-11 | Read model | The list returns up to 200 rows (no cursor); contracts are few per platform. The tenant and operator names are read from `identity` by raw SQL in `libs/subscription` (precedent: the A6 apply's `identity."Tenant"` read); no new nx edge. | Recorded |
| TD-B4-12 | Merge note | Expected conflicts with parallel slices: `apps/platform-web/src/App.tsx` (routes), `commercial-change-request.ts` / `commercial-apply.service.ts` (C1/C2/A7/A8), `subscription.module.ts`, `src/index.ts`, `schema.prisma`, the platform-web consumer and `verify-platform-admin.ts`, `openapi/platform.yaml`, `api-surface-manifest.json`, `DIVERGENCES.md`, `doc/generated/repo-map.*`; `doc/design-reference/ccp/CCP-UI-v1_0/` may be added byte-identically by other UI slices. | For the lead |

## 6. Recovery and compensating migration

- UI: revert the platform-web files (§7, B4-3/B4-4). No commercial data is changed by the UI on its own; it only creates change requests.
- Code: revert B4-1/B4-2. A6 behaviour without contract blocks is unchanged (B4-AMD-1 asserts `NO_CHANGE` still holds).
- Compensating migration (documented, not shipped; never run against production, PBD §7.5 / A0-C15), one transaction:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM subscription."Contract") THEN
      RAISE EXCEPTION 'CCP-B4 compensation refused: contract records exist';
    END IF;
  END $$;
  DROP TABLE subscription."ContractAmendment";
  DROP TABLE subscription."Contract";
  DROP FUNCTION subscription."guard_contract_amendment_insert"();
  DROP FUNCTION subscription."guard_contract_insert"();
  DROP FUNCTION subscription."reject_contract_mutation"();
  DROP FUNCTION subscription."ccp_b4_valid_evidence_documents"(JSONB);
  DROP FUNCTION subscription."ccp_b4_valid_terms"(JSONB);
  ```
  Change requests whose frozen payloads carry contract blocks stay valid history; after a code revert a not-yet-applied one would fail its apply as `INVALID_PAYLOAD` (closed keys), never apply partially.

## 7. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| B4-0 | `CCP-B4: pre-execution record and the pinned CCP-UI v1.0 design reference` | `doc/ccp/slices/CCP-B4-pre-execution.md`; `doc/design-reference/ccp/CCP-UI-v1_0/**` (6 files, byte-identical to the pinned release) |
| B4-1 | `CCP-B4: Contract + ContractAmendment (additive migration, insert guards, append-only) and the contract blocks on the A6 actions` | `libs/subscription/prisma/migrations/20261026030000_ccp_b4_enterprise_contracts/migration.sql` (new); `libs/subscription/prisma/schema.prisma`; `libs/subscription/src/lib/commercial/commercial-contract.ts`, `commercial-contract.repository.ts` (new); `commercial-change-request.ts`; `commercial-apply.service.ts`; `subscription.module.ts`; `src/index.ts`; `src/lib/billing/governed-subscription.ts` (comment) |
| B4-2 | `CCP-B4: read-only contract routes, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-contract.controller.ts`, `dto/commercial-contract.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| B4-3 | `CCP-B4: Commercial › Contracts screen and change-request dialogs` | `apps/platform-web/src/contracts/{ContractsView.tsx,ContractRequestDialog.tsx,contracts-api.ts,contracts-format.ts,contracts.css}` (new); `apps/platform-web/src/App.tsx` |
| B4-4 | `CCP-B4: tests (N-3, lifecycle, guards, evidence, per-role, UI, parity, axe, keyboard)` | `libs/subscription/src/tests/ccp-b4-contracts.integration.spec.ts`, `ccp-b4-contract-payload.spec.ts`; `apps/platform-admin/src/tests/ccp-b4-commercial-contract-authorization.spec.ts`; `apps/platform-web/src/contracts/ContractsView.spec.tsx`; `apps/platform-web/e2e/{fixtures/contracts.ts,support/ccp-proto.ts,visual/ccp-contracts.spec.ts,a11y/ccp-contracts-axe.spec.ts,keyboard/ccp-contracts.spec.ts}`; `apps/platform-web/e2e/visual/__screenshots__/ccp-contracts-*` (14 PNG + 14 masks JSON); `apps/platform-web/e2e/visual/DIVERGENCES.md` (all new except DIVERGENCES.md) |
| B4-5 | `CCP-B4: Pact — contract routes (platform-web consumer, platform-admin provider state)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| B4-6 | `CCP-B4: acceptance evidence` + `CCP-B4: regenerate repo map` | `doc/ccp/slices/CCP-B4-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **55 new files, 16 modified files (71 paths)**. **Unchanged:** every existing migration (including `guard_commercial_change_request()` in `20261025200000`), `canTransitionFor`, A9-U-4, `pact/provider/src/verify-api.ts`, `fe-foundation`, the shell and rail, `permissions.ts`, `doc/ccp/decisions.md`.

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK — Tier 1, Tier 2 and front-door retirement clean. No exemption allowlist touched.
