# CCP-A11 — pre-execution record (Astre backfill tooling, dry-run only)

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-A11 (PBD §5.1 row A11; §4 order row 12) |
| **Branch / baseline** | `wip/ccp-a11` at `1754d857` (CCP-A7 on A1–A6, A9, A10). No drift: the worktree was clean at start; the only base commit since A6 is A7 itself. |
| **Binding row (PBD §5.1 A11)** | **In:** dry-run tooling with deterministic counts, an exception report and a no-service-change proof; the read-only production fact-check script. **Out:** any execution against production. **Tests:** dry-run on a production-like fixture; effective service byte-identical; usage unchanged; idempotent re-run. **Recovery:** compensating migration documented. **HALT:** any effective-service difference; any production read without separate authorization. |
| **Production** | NOT read, NOT connected, by this slice. The known facts below are the PO's read-only check of 2026-10-25, restated, not re-read. |

## 1. Prerequisites (row A11: "A5, A6, A7 evidence")

| Prerequisite | Evidence |
|---|---|
| A5 (plan versions, v1 pin) | `doc/ccp/slices/CCP-A5-acceptance.md` §2 (5 v1 checksums; 14 → 14 pinned), TD-A5-1 ratified (`doc/ccp/decisions.md`, TD-A5-1 rows) |
| A6 (governed apply, checkout/webhook hold) | `doc/ccp/slices/CCP-A6-acceptance.md` (A6-ASTRE-1 at `:158`; the C-16 read-only check `libs/subscription/src/lib/billing/checkout-cutover-check.ts`) |
| A7 (entitlement provenance, revoke, ledger) | `doc/ccp/slices/CCP-A7-acceptance.md` §1–§2 (pre-A7 rows backfilled `MIGRATION`, ledger `GRANTED`, A7-E-1) |

## 2. Known production facts (PO read-only check 2026-10-25; not re-read)

- Astre holds exactly 1 open subscription: `MANUAL`, `ACTIVE`, plan `aramo-sign-included-v1`, started 2026-10-19, no Stripe link.
- Astre's entitlements: `core`, `ats`, `portal`, `sign`.
- 0 `CheckoutIntent` rows; 0 `SELF_SERVICE` subscriptions.
- Identity catalog 19 / 194 / 973 vs seed 19 / 190 / 939 (TD-A1-1).
- Production runs the pre-CCP schema (PROD = `52ea8de6`; no CCP migration has been executed there, PBD §7.5). The fact-check therefore has to work on BOTH the pre-CCP and the post-A7 schema.

## 3. The question A11 answers, and the recon

"What does the governed data model need for Astre's existing state to be represented under CCP, without any change to Astre's effective service?"

| Need | Already delivered by (path:line, re-verified at `1754d857`) | What A11 adds |
|---|---|---|
| Product identity (`product_key`, `composition_role`) | A4 migration backfills every row: `libs/subscription/prisma/migrations/20261025140000_ccp_a4_product_dimension/migration.sql:34-35` (`UPDATE … SET "product_key" = 'sign'`, `… "composition_role" = 'BASE'`); count guard `:65-66`; index `:81` | Nothing written. The dry run **verifies** it per open row (exception `PRODUCT_DIMENSION_INVALID`). |
| Version pin | A5 migration pins every row to its plan's PUBLISHED v1: `…/20261025160000_ccp_a5_plan_version/migration.sql:259-266`; checksum functions `:48` (`ccp_plan_version_checksum`), `:57` (`ccp_plan_live_content`) | Nothing written. The dry run **verifies** the pinned version's checksum integrity and reports whether it still equals the live rows and the A5-recorded seed checksum (TD-A1-1-style catalog drift is reported, never "fixed"). |
| Entitlement provenance | A7 migration backfills every pre-A7 row `granted_source = 'MIGRATION'` (`libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/migration.sql:35`) and opens the ledger with one `GRANTED` event per row (`:71-74`) | Nothing written. `MIGRATION` is the truthful value (pre-CCP provenance unknown, non-commercial). Re-sourcing `sign` to `MANUAL` would need a change request (`TenantEntitlement_commercial_source_check`, `:47-48`) and would modify Astre's entitlements: **not done** (decision request DR-A11-2). |
| Commercial audit trail | None for a pre-CCP row. `CommercialAuditEvent` (`…/20261024180000_ccp_a2_commercial_audit_policy/migration.sql:146-173`) is written only by CCP paths. | **The one gap.** One append-only `CommercialAuditEvent` per open governed (`MANUAL`) row that has no governed open record: event `COMMERCIAL_PRE_CCP_GRANT_RECORDED`, subject `subscription:<id>`, system actor, no change request. |
| A governed record of the pre-CCP manual grant | `CommercialChangeRequest.kind` admits `MIGRATION` (`…/20261025120000_ccp_a3_change_request_approval/migration.sql:94`), but creation refuses every non-`NORMAL` kind (`libs/subscription/src/lib/commercial/commercial-change-request.service.ts:269-272`, TD-A3-14; TD-B4-7 on the parallel B4 branch) | The same audit event is the record. A `MIGRATION`-kind request is **not** created: an `APPLIED` request needs approvals and a `CommercialChangeApplication` that never happened (it would invent approval history, contrary to the preserved "no invented history" provision, MP-A2 §4). Decision request DR-A11-1. |

Writes the backfill would make if ever executed: **only** `subscription."CommercialAuditEvent"`. No effective-service reader reads that table (`AllowanceService`, `CapacityService`, `SubscriptionLifecycleService.account`, `EntitlementRepository`, `EntitlementGuard`; re-verified by search: none references `commercialAuditEvent`).

## 4. Choices left to the record

| # | Choice | Decision | Needs confirmation? |
|---|---|---|---|
| C-1 | Schema change | **None.** No `20261026100000_ccp_a11_*` migration. | No |
| C-2 | Execute mode | The CLI has **no execute path**: `--execute` is refused unconditionally (separate PO authorization). The library apply function exists only so the fixture tests can prove the writes are service-neutral and idempotent; nothing wires it to a command. | Recorded |
| C-3 | Refusal guards | No `--dry-run` → refused. URL host not `localhost` / `127.0.0.1` / `::1`, a `host`/`hostaddr` query override, or a socket path → refused. Exit 2, nothing connected. | No |
| C-4 | Fact-check against a non-local URL | Requires `--po-authorization-ref <ref>`; without it, refused before connecting. Read-only session only. | Running it in production is a separate PO authorization (row A11 HALT) |
| C-5 | Scope of the record | Every open `MANUAL` BASE row without a governed open (`CommercialChangeApplication` `SUBSCRIPTION_OPEN`/`_CHANGE` on that row) and without an existing record. Production: Astre's 1 row. `SELF_SERVICE` (Stripe-owned) and `FREE` (system) rows are counted, never recorded. | Recorded |
| C-6 | Determinism | Record id and correlation id derive from the subscription id; the report carries no timestamps of the run. | No |
| C-7 | Compensation | The audit stream is append-only (DELETE rejected). Compensation appends a `COMMERCIAL_PRE_CCP_GRANT_RECORD_WITHDRAWN` event per record; nothing is deleted. | Recorded |

## 5. Correction-1 triggers (§2.4)

None has arisen. No schema change, no new commercial decision, no governing-contract amendment. DR-A11-1 / DR-A11-2 are questions about a **future** execution, raised as decision requests; they do not block the dry-run tooling.

## 6. Typed divergence noted at pre-execution

- **TD-A11-1:** the instruction cites a standing rule "Preserve Astre's existing MANUAL subscription and entitlements without modification" in `doc/ccp/decisions.md`. That text is not in `doc/ccp/decisions.md` at `1754d857` (searched, also in the LOCKED CCP instruments). The same rule is carried by Charter §1.5, Conversion Rule `:234`, MP-A2 §4 and PBD §12 ("No change to Astre's effective service"). A11 applies it as binding.
