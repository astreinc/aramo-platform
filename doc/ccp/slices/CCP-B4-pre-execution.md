# CCP-B4 — pre-execution record

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, §2.5 and the §5.3 **B4** row. Governing instruments: MP-A2 N-2, N-3, N-4 (`Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md:97-107`); Charter L6 (`Aramo-CCP-Program-Charter-v1_0-LOCKED.md:119`); PLATFORM-UX-1 Amendment A1, A1-4/A1-4a/A1-5/A1-6 (`…-Amendment-A1-CCP-Scope-v1_0-LOCKED.md:61-77`); Conversion Rule §3.1 definition (b) and O-5 (`Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md:106`, `:266`).

| | |
|---|---|
| **Slice** | CCP-B4: enterprise contracts (backend `Contract` + `ContractAmendment`, and the Contracts screen) |
| **Branch / baseline** | `wip/ccp-b4` at `078d4f78ca3006b4fe8b73e274779f1670b712c5` (program HEAD: A1–A6, A9, A10 merged). Drift since A6: none (A6 merge is the baseline commit). |
| **B4 row (binding)** | **In:** backend `Contract` + `ContractAmendment` meeting MP-A2 N-3, and the UI. **Out:** CPQ (Charter L6). **Tests:** N-3(a)–(d) with `path:line`; evidence attachments. **Recovery:** UI revert; additive migration with a documented compensating migration. **HALT:** N-3 cannot be met (N-4). |
| **Migration** | `libs/subscription/prisma/migrations/20261026030000_ccp_b4_enterprise_contracts/migration.sql` (additive) |

## 1. Pinned design input (PBD §2.5; A1-5)

Release **CCP-UI v1.0**, `OneDrive/Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`. `shasum -a 256 -c MANIFEST.sha256`: all 5 files OK. Copied byte-identical into `doc/design-reference/ccp/CCP-UI-v1_0/` (the parity harness reads it there, as PLATFORM-UX-1 does with `doc/design-reference/platform-admin/`); the copy re-verifies OK.

| File | SHA-256 |
|---|---|
| `MANIFEST.sha256` | `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e` |
| `Commercial Control Plane v1.0.dc.html` | `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` |
| `ccp-data.js` | `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` |
| `support.js` | `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` |
| `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` | `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` |
| `handoff/Commercial Control Plane - design amendments log v1.0.md` | `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` (no amendments recorded) |

Rows covered (handoff §11): "Contracts: list, terms, hashed documents, amendments timeline" (5.5); "Contracts: Record amendment / End contract" (5.5). "Contracts: commitment ending" (5.5, backend C6) is shown from the governed subscription's `commitment_end` (no C6 dependency is introduced). Prototype elements: `Commercial Control Plane v1.0.dc.html:227-258` (screen), `:761-766` (`dlgContract`), `:879-886` (values), `:497-525` (dialog pattern), `ccp-data.js:97-114` (`C0`). Design owner of contract evidence: B4 (`doc/ccp/decisions.md` B4-C).

## 2. Prerequisites

| Prerequisite | Evidence |
|---|---|
| A6 evidence recorded | `doc/ccp/slices/CCP-A6-acceptance.md` (the transactional apply; 36 / 36 A6 specs) |
| Governed transitions T1–T12 ratified | `doc/ccp/decisions.md` "Transition controls T1–T12" |
| Backend owner of contract evidence = B4 | `doc/ccp/decisions.md` B4-C |
| A6 left definition (b) to B4 | `CCP-A6-acceptance.md` TD-A6-2; `libs/subscription/src/lib/billing/governed-subscription.ts:22-30` |

## 3. `path:line` re-verification (what the design relies on)

| Fact | Where | Verified |
|---|---|---|
| `TenantSubscription` is the single subscription authority; no contract column | `libs/subscription/prisma/schema.prisma:180-238` | ✅ |
| Commitment term lives on the subscription row | `libs/subscription/prisma/schema.prisma` `commitment_start` / `commitment_end` (A1 comment "the commitment term … separate from the monthly invoice period") | ✅ |
| A6 opens, changes and ends governed rows in ONE transaction | `libs/subscription/src/lib/commercial/commercial-apply.service.ts:334` (OPEN), `:410` (CHANGE), `:443` (END) | ✅ |
| CHANGE to the pinned version is refused today (`NO_CHANGE`) | `commercial-apply.service.ts:413` | ✅ (B4 admits it only when the payload carries a contract block; see D-1) |
| A6 payload schemas (closed keys) | `libs/subscription/src/lib/commercial/commercial-change-request.ts:371-387` | ✅ |
| Chain for SUBSCRIPTION_OPEN / _CHANGE / _END = Finance only (TD-A3-2) | `commercial-change-request.ts:276-277` (`default:` → `FINANCE_ONLY`) | ✅ |
| The guard function body (A6 ∪ A9) does not depend on payload content; same-version CHANGE satisfies the APPLIED backstop (`plan_version_id IS DISTINCT FROM to_plan_version_id` is false) | `libs/subscription/prisma/migrations/20261025200000_ccp_a6_transactional_apply/migration.sql:202-212` | ✅ **No change to `guard_commercial_change_request()`** |
| Raw cross-schema read precedent (identity tenant) inside libs/subscription | `commercial-apply.service.ts` `pinnedVersion` (`identity."Tenant"`) | ✅ |
| Read scope for subscription data | A1 matrix `platform:subscription:read` = PO, FA, CO, SA, RA (not CM, not SU) (`Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md:112`) | ✅ |
| No reusable file-bytes store within the nx boundary | `libs/subscription/project.json` `scope:shared`; `libs/documents` = `scope:boundary` (shared → boundary forbidden, root eslint config depConstraints); `DocumentAssociation.resource_type` has no contract value (`libs/documents/prisma/schema.prisma:142-157`); `LegalAcceptance` stores name + version + sha256 only (`libs/subscription/prisma/schema.prisma:375-393`) | ✅ → TD-B4-1 |

## 4. Choices this record fixes (and whether they need confirmation)

| ID | Choice | Confirmation |
|---|---|---|
| D-1 | **No new action type; the guard is not changed.** A contract is recorded, amended and ended only by an **A6-applied** change request: an optional `contract` block on `SUBSCRIPTION_OPEN` (record with the open) or on `SUBSCRIPTION_CHANGE` (record against the open governed row), a `contract_amendment` block on `SUBSCRIPTION_CHANGE` (the plan version may stay the same: a terms-only amendment), and a `contract_end` block on `SUBSCRIPTION_END`. The contract rows are written inside the A6 apply transaction; DB triggers refuse any insert not made by a request in `APPLYING` of the matching action and tenant. | Recorded (within the B4 row) |
| D-2 | **No contract state.** Active / Ended is derived from the referenced `TenantSubscription.ended_at`. `Contract` and `ContractAmendment` are append-only (UPDATE / DELETE raise). | Recorded (N-3(d)) |
| D-3 | Commitment, plan, version and allowance are read through `TenantSubscription` (and its pinned `PlanVersion`), never stored on the contract. | Recorded (N-3(c)) |
| D-4 | Evidence documents: metadata only (name, `sha256`, optional size and media type, recorded by, recorded at), as a validated `jsonb` array on `Contract` and `ContractAmendment`; no bytes, no third table. | **TD-B4-1** (narrowest design; no reusable pattern) |
| D-5 | Chains stay as resolved by A3 (Finance only, TD-A3-2); the handoff draws "Above threshold" (Finance → Owner) for contract amend / end. | **TD-B4-2, needs PO confirmation** |
| D-6 | Read routes gate on `platform:subscription:read`; catalog_manager and super_admin are refused. | **TD-B4-3** (handoff shows Commercial "all" to catalog_manager) |
| D-7 | Ending a contract-linked row requires the END payload to name the contract (`contract_end.contract_id`), else the apply fails `TARGET_STALE`; the entitlement is not revoked (A7, TD-A6-8). | Recorded |
| D-8 | Conversion Rule definition (b): a contract can reference only an open MANUAL BASE row with no provider link (DB trigger), so (b) ⊆ (a) and `isGovernedSubscription` needs no code change. | Recorded |
| D-9 | Contract invoicing is NOT built (PBD §10). The pinned design has no invoicing element; the API returns `invoicing: { enabled: false, reason: "enterprise_invoicing_choice_pending" }`. | **TD-B4-4** |

## 5. N-4 statement (planned; evidence in the acceptance record)

- **(a)** both tables are created in the `subscription` schema by the migration above.
- **(b)** `Contract.tenant_subscription_id` → `TenantSubscription(id)` (FK, NOT NULL, ON DELETE RESTRICT); `ContractAmendment.contract_id` → `Contract(id)`; both carry a FK to the governing `CommercialChangeRequest`.
- **(c)** no plan, version, allowance, product or open/closed column; the plan shown is read through the subscription; no resolver (allowance, capacity, entitlement, lifecycle) reads the contract tables (static scan test).
- **(d)** no status / ended / usage column (information_schema test); end is the subscription's `ended_at`; usage stays in `AllowanceUsage` (unchanged by any contract write, test).

No correction-1 trigger (§2.4) has arisen: no new commercial or regulatory decision, no governing-contract amendment and no architectural change (the guard function, the nx graph and the A6 transaction are unchanged in shape). D-5 and D-6 are reported as divergences for confirmation; neither blocks execution.
