# CCP-C8-PR — pre-execution record (PAYMENT_RECORD)

| | |
|---|---|
| **Slice** | CCP-C8-PR, PAYMENT_RECORD and enterprise payment-gated activation |
| **Branch / base** | `wip/ccp-c8pr` at `eefa795d` (the integrated program branch after R-SYNC) |
| **Authority (LOCKED, sidecars verified)** | `Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED.md` SHA-256 `4409e3a146730e2a642921ebae736e164145bf637ada3357aa838cd2915b304a` (PR-1 … PR-13, §4 K-2, §6). `Aramo-CCP-A1-Amendment-A2-Payment-Request-Scope-v1_0-LOCKED.md` SHA-256 `20941cccf1f63cd37cea5819f94171d501ec43d5a8fb6f65787352f60a9b3d42` (PS-1 … PS-6). `Aramo-CCP-Program-Build-Directive-Amendment-A1-Commercial-Action-Catalog-v1_0-LOCKED.md` SHA-256 `ad862360aab001858d3eb093a97e3331e5360bffe46893a62bebdfb425e60e60` (catalog, 15 → 16). MP-A2 N-2 … N-4 (`Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md`). `doc/ccp/decisions.md` (Architect ratification "PAYMENT_RECORD A2 + Charter A2", 2026-10-25). |
| **Scope rule (Lead, during the slice)** | The Architect froze CCP scope: C8-PR is completed exactly as the LOCKED amendment defines it. Anything else is recorded and classified (A blocking security/financial, B external, C deferred, D resolved); only A is implemented, smallest change. No UI. |
| **Not authorized** | push, PR, merge to main, production migration, deployment, payment recording in production, subscription activation (amendment §6). |

## 1. Plan (what is built)
| Area | Build |
|---|---|
| Catalog (A1-amendment §2) | `PAYMENT_RECORD` in `COMMERCIAL_ACTION_TYPES` / `COMMERCIAL_ACTIONS` (billing, tenant-scoped, requester scope `platform:payment:request`); operations RECORD and CORRECT (closed). |
| Scope (CCP-A1 A2) | `platform:payment:request` (0x336) → commercial_ops, finance_admin; identity migration `20261028070000_ccp_a1a2_payment_request_scope`; seed; totals recomputed 25 / 207 / 989; orphan-scope registry; compensation. |
| PR-3 chain | Resolved ONCE inside the create transaction from the requester's live roles and the live roster (`resolvePaymentRecordChain`); snapshotted in `required_chain`. |
| PR-1 terms | `contract.payment_terms` required on a B4 contract record; stored on `Contract` (5 ADDED columns); obligations in `ContractPaymentObligation`. |
| §4.1 / §4.2 | `CommercialPaymentReceipt` with the linkage CHECKs, the provisional identity and its partial unique index, the `CONTRACT_REF_TAKEN` check, insert and update guards. |
| PR-4 | A6 apply branch (`CommercialApplyService`, domain step `applyPaymentRecordInTx`), guard-union and constraint-union blocks labelled CCP-C8-PR, deferred "never commit in APPLYING" trigger, `canTransitionFor` mirror. |
| PR-7 / §4.3 | The PREPAID SUBSCRIPTION_OPEN apply runs the 8 steps in one transaction; refused at create (K-1) and at apply without a matching receipt. |
| PR-9 / PR-10 / PR-11 | CORRECT (REPLACE / VOID), derived status in the contract timezone, `GET /platform/commercial/contracts/{id}/payments` with the amount scope; `PAYMENT_RECORD` in R3's `MONETARY_ACTION_TYPES`. |
| §4.3 step 5 | Unlinked receipts in the C6 reconciliation report and the D3 alert `PAYMENT_RECEIPT_UNLINKED` (alert-type union block). |
| UI | None. The B4 Payments panel needs a CCP-UI design addition (recorded, §4). |

## 2. Migrations
- `libs/subscription/prisma/migrations/20261030010000_ccp_c8pr_payment_record/migration.sql` (subscription; the slice's own objects).
- `libs/identity/prisma/migrations/20261028070000_ccp_a1a2_payment_request_scope/migration.sql` (identity; the next timestamp after `20261028060000`).
- Labelled `CCP-C8-PR` blocks, in place, in the integrator files `20261027000000_ccp_guard_union`, `20261027000100_ccp_constraint_union`, `20261029000100_ccp_alert_type_union`. No other block of those files is edited (DG edits the guard union in parallel; the C8-PR blocks are self-contained).

## 3. N-4 statement (MP-A2 N-3(a)–(d), amendment §4.4)
Two new commercial-domain tables: `ContractPaymentObligation` and `CommercialPaymentReceipt`. `Contract` gains 5 columns (ADD-not-rename).

**N-3(a) — both tables are in the `subscription` schema.**
- `libs/subscription/prisma/migrations/20261030010000_ccp_c8pr_payment_record/migration.sql:85` `CREATE TABLE "subscription"."ContractPaymentObligation"`.
- `…/20261030010000_ccp_c8pr_payment_record/migration.sql:147` `CREATE TABLE "subscription"."CommercialPaymentReceipt"`.
- Asserted live by `libs/subscription/src/tests/ccp-b4-contracts.integration.spec.ts` (B4-N3 family) and the full compensation chain fingerprint (identity / subscription / entitlement schemas only).

**N-3(b) — each references its parent by FK.**
- `Contract` keeps its NOT NULL FK to the `TenantSubscription` it governs: `libs/subscription/prisma/migrations/20261026030000_ccp_b4_enterprise_contracts/migration.sql:95` (`"tenant_subscription_id" UUID NOT NULL`) and `:114` (`Contract_tenant_subscription_id_fkey`). C8-PR does not touch it.
- The contract is created in the same transaction as its subscription: `libs/subscription/src/lib/commercial/commercial-apply.service.ts:582` (`tx.tenantSubscription.create`) precedes `:741` (`recordContractInTx`), inside one `$transaction`.
- `ContractPaymentObligation` → `Contract`, NOT NULL: `…/20261030010000_ccp_c8pr_payment_record/migration.sql:88` (`"contract_id" UUID NOT NULL`) and `:104` (`ContractPaymentObligation_contract_id_fkey`, RESTRICT).
- `CommercialPaymentReceipt` → its governing PAYMENT_RECORD `CommercialChangeRequest`, NOT NULL: `:150` (`"change_request_id" UUID NOT NULL`) and `:218` (`CommercialPaymentReceipt_change_request_id_fkey`); once linked, → `Contract` `:222` and → `ContractPaymentObligation` `:224` (both RESTRICT, nullable until the §4.3 link).
- No temporary subscription is invented; before linkage the receipt is a governance attestation, like `CommercialChangeApplication`.

**N-3(c) — neither table answers "which plan, allowance or subscription does tenant T hold for product P".**
- Neither table has a plan, version, allowance, capacity, commitment or status column (`…/20261030010000_ccp_c8pr_payment_record/migration.sql:85-110`, `:147-229`). The receipt carries `tenant_id` / `product_key` as its binding (the same as `CommercialChangeApplication`), never as a holding.
- No resolver reads them: the only readers are `libs/subscription/src/lib/commercial/commercial-payment-record.ts` (gate, link, derived status), `billing-finance-report.service.ts` and `commercial-alert.service.ts` (unlinked listing / alert, via `unlinkedReceipts`). The B4 static scan (`ccp-b4-contracts.integration.spec.ts` B4-N3-c) allowlists exactly the two C8-PR modules with that reason; allowance, capacity, entitlement, lifecycle and checkout code do not reference them.

**N-3(d) — no subscription-like or entitlement-like state, no usage ledger, no balance.**
- Payment status is derived at read (PR-10): `libs/subscription/src/lib/commercial/commercial-payment-terms.ts` `obligationPaymentStatus`; it is never stored and never written to `TenantSubscription.status` (static scan C8PR-U-10; C8PR-STAT-1 asserts the subscription rows byte-equal).
- The receipt's only mutable columns are the one-time §4.3 link and the one-time PR-9 supersession mark (guard function and trigger, `…/migration.sql:248-375`); everything else, and every DELETE, raises.
- `Contract`'s 5 new columns are negotiated payment terms (mode, currency, timezone, grace, POSTPAID marker), immutable with the append-only row; the B4-N3-d pattern (`status|state|active|ended|…|usage|period`) still finds no column.

N-3 is not relaxed. No HALT.

## 4. Decisions and readings taken before building (recorded in the acceptance record as divergences)
- **R-1 (POSTPAID marker evidence).** "an explicit, immutable `postpaid_approval` marker with its evidence": modelled as `{ statement, evidence_ref, documents? }` with `statement` and `evidence_ref` required.
- **R-2 (Owner exception rule name).** The exception chain reuses the existing rule `DISTINCT_PLATFORM_OWNER` (one platform_owner step with the billing approve scope) with `basis.exception: true`, so the chain parser, guard and UI enums are unchanged.
- **R-3 (PR-6 triple and corrections).** The triple is refused against every receipt, except that a REPLACE may keep the triple of the receipt it supersedes (same payment, corrected evidence).
- **R-4 (K-1 at create).** A PREPAID SUBSCRIPTION_OPEN is refused at creation as well as at apply when no matching receipt exists.
- **R-5 (PR-1 amendment).** v1 admits an amendment that only ADDS obligations; any other payment-terms change fails closed (`PAYMENT_TERMS_CHANGE_UNDEFINED`).
- **R-6 (UI).** No UI. The B4 Payments panel needs a CCP-UI design addition (class C, deferred).
