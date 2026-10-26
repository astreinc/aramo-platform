# CCP-D2 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-D2: revenue reporting |
| **Schedule row** | PBD §5.4, row D2 (binding), PBD `:122` |
| **Branch / baseline** | `wip/ccp-d2` at `41a0e3b5` ("CCP: record Architect program acceptance disposition …"). Working tree clean at start. |
| **Drift since the previous slice** | None in code. The baseline is the integrated program branch after the D3, D1-R, B5-R and B3 merges (`debd033d`, `153aee2d`, `cc7804e9`, `8cae29e5`), the compensating-SQL commit (`621f1678`) and the disposition record (`41a0e3b5`). The disposition states "D2, D4 and D5 proceed now" (`doc/ccp/decisions.md:156`). |
| **Scope of this run** | **Backend only.** No UI, no migration. |

## 1. Governing instruments

SHA-256 re-verified against the `.sha256` sidecars: **MATCH, 3 of 3.**

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md` (A1) | `44ac30ce8e06d354e303bb824f0cd194d0f50471328d19578c92463cfa8aa716` |
| `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` (UX-A1) | `9c84fbc9e5af5bbf790553723f1080739b2318c30fa9431a9bdbc9f377c7a50c` |

**Clauses relied on** (verbatim; `path:line` in OneDrive `Aramo/locked`):
- **PBD `:122`** (§5.4 row D2):
  - "**In:** MRR/ARR and renewals derived from commercial records, not a ledger, **on dedicated Finance screens only**. The dashboard commercial panel (Inc-3 Closure successor §3.2) shows **counts, states and operational events only** (A0-C6). **Out:** monetary metrics on the dashboard"
  - Tests: "Figures reproduce from commercial records; dashboard renders no money".
  - Recovery: "Read-only; revert".
  - HALT: "Any monetary metric on the dashboard".
  - Evidence: "Report reproduction; dashboard check".
- **UX-A1 `:68`** (A1-4a): "Monetary metrics (for example MRR, ARR, revenue and credit totals) SHALL appear **only on dedicated Finance screens**, never on the dashboard."
- **UX-A1 `:70`** (A1-5): a CCP UI slice "SHALL NOT implement unpinned design changes".
- **A1 `:118`** (§4.1 matrix): `platform:billing:read`: PO ●, FA ●, CO ●, CM —, SA ●, RA ●, SU —.

**Rulings and drafts that bind the exposure** (not LOCKED instruments; read as the lead instructed):
- `doc/ccp/decisions.md:138` (Architect disposition 2026-10-25, TD-C3-5 / TD-C6-1 / TD-D3-13): "Invoice amounts, payment amounts and tenant-specific finance figures need a **dedicated Finance scope**; amend the A1 scope catalog BEFORE exposing them."
- `doc/ccp/decisions.md:57` (TD-B1-2): "No monetary data on general dashboard widgets; money stays on authorized Finance surfaces."
- Draft `Aramo/documents/CCP-A1-Finance-Amount-Scope-Amendment-DRAFT-20261025.md`:
  - FA-3 (`:32`): "**Platform-wide aggregate revenue** (D2) needs the new scope."
  - FA-6 (`:43`): "every tenant-specific amount is withheld for **all** callers, with the marker `amount_withheld: "FINANCE_SCOPE_PENDING"`."
  - The draft is **not LOCKED**, so the new scope does not exist. The D2 route therefore withholds **every** amount for **every** caller (FA-6 applied to the aggregate under FA-3).

## 2. Prerequisites (PBD `:122`: "A5, A6, C6 evidence")

| Prerequisite | Evidence |
|---|---|
| **A5** (pinned versions and their prices) | `doc/ccp/slices/CCP-A5-acceptance.md`. `TenantSubscription.plan_version_id` is NOT NULL (`libs/subscription/prisma/schema.prisma:229`). The price is in the checksum-verified `PlanVersion.content.plan` (`list_price_minor`, `currency`, `billing_interval`), read through `planVersionTerms` (`libs/subscription/src/lib/plan-version.ts:274`, fails closed). |
| **A6** (governed MANUAL rows, apply) | `doc/ccp/slices/CCP-A6-acceptance.md`. The D2 fixtures open governed rows through the real request → approve → apply path. |
| **C6** (Finance reports; money rules) | `doc/ccp/slices/CCP-C6-acceptance.md`. `BillingFinanceReportService` (`libs/subscription/src/lib/billing/billing-finance-report.service.ts`). USD only (`FINANCE_CURRENCY`, `:27`); commercial sources (`FINANCE_SOURCES`, `:31`); `priceFigure` withholds a contract-priced, missing or non-USD price with a reason (`:246`). C6 explicitly left aggregates to D2 (C6 acceptance TD-C6-4). |
| **B4** (contracts) | `doc/ccp/slices/CCP-B4-acceptance.md`. `subscription."Contract".tenant_subscription_id` is a unique FK to the subscription row (`libs/subscription/prisma/migrations/20261026030000_ccp_b4_enterprise_contracts/migration.sql:95`, `:122`). The contract terms are evidence text, not a price, so a contract-linked row has no derivable recurring price. |

## 3. `path:line` re-verification (at `41a0e3b5`)

| Fact | Location |
|---|---|
| Subscription status, period end, commitment end, provider linkage | `libs/subscription/prisma/schema.prisma:191-229` (`status` `:196`, `current_period_end` `:201`, `commitment_end` `:213`, `product_key` `:220`, `composition_role` `:224`, `plan_version_id` `:229`) |
| Plan billing interval CHECK is `NULL` or `MONTH` | `libs/subscription/prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql:41` |
| Seeded USD prices in minor units (Business 2000, Professional 1500, Enterprise contact-sales with no price) | same migration `:132-144` |
| Closed product registry `['sign']` | `libs/subscription/src/lib/product-registry.ts:19` |
| `platform:billing:read` bundles (test restatement of A1 §4.1) | `libs/subscription/src/tests/support/ccp-a3-database.ts:40-46` |
| C6 Finance routes under `platform/commercial/finance` | `apps/platform-admin/src/app/platform/platform-commercial-finance.controller.ts` |
| Dashboard no-money spec (extended by D2) | `apps/platform-web/src/dashboard/DashboardView.no-money.spec.tsx` |

## 4. Design input (UX-A1 A1-5)

- The only pinned release on disk is **CCP-UI v1.0** (`Aramo/design/Platform-Admin-prototype/ccp/` contains `CCP-UI-v1_0` only). Its handoff lists "revenue charts (no MRR/ARR)" as out of scope (CCP-C6 pre-execution §2.1).
- The **Finance › Revenue** screen is specified only in the **CCP-UI v1.1 design brief**: `Aramo/documents/ARAMO-Claude-Design-Prompt-CCP-UI-v1_1-Finance-Ops-20261025.md`, SHA-256 `ac9bc7c9dcd01de6c29052a40f6b7d7d4bd47dcc4cdf244d5ac8c84733158f88`, §3.5 (`:56-59`).
  - §3.5 reads "Finance › Revenue (D2; design only, backend later)" and gives the route `/commercial/finance/revenue`, with "Same visibility as §3.1".
  - §3.1 (`:26`) gives that visibility as "read scope `platform:billing:read` … Hidden for catalog_manager and super_admin".
  - A brief is not a release: there is no v1.1 manifest.
- **The screen is therefore not built** (instructed; it would also be an unpinned design change). It waits for the CCP-UI v1.1 release.

## 5. Choices this record makes

| ID | Choice | Needs confirmation? |
|---|---|---|
| **D2-D1** | **Scope: `platform:billing:read`** on the route (the C6 Finance gate; the v1.1 brief §3.1 / §3.5 visibility). It admits 5 of the 6 CCP roles; catalog_manager and super_admin are refused 403. Because every amount is withheld, the 5 readers receive counts only. | No. The future amount scope (FA-1/FA-2) is a separate gate, and its holders are a subset of these 5. |
| **D2-D2** | **Amounts withheld for every caller** (FA-6 interim). The route omits `mrr_minor`, `arr_minor` and every bucket amount. The report and each money-bearing object carry `amount_withheld: "FINANCE_SCOPE_PENDING"`. The projection builds each field explicitly and never reads an amount, so exposure needs a code change once the scope is LOCKED, not a flag. | No (instructed) |
| **D2-D3** | **MRR basis.** Open BASE subscriptions with source MANUAL or SELF_SERVICE (C6 `FINANCE_SOURCES`), status ACTIVE or PAST_DUE. Each contributes the PINNED version's `list_price_minor`, when it is USD and per `MONTH`. ARR = MRR × 12. Integer minor units; a sum past the safe-integer range fails closed. | **Lead confirmation** on the status set (TD-D2-1) |
| **D2-D4** | **Exclusions.** One reason per excluded row, first match: `STATUS_NOT_REVENUE_BEARING` (TRIALING, INCOMPLETE, open CANCELED), `PLAN_VERSION_INTEGRITY`, `CONTRACT_PRICED` (a B4 contract on the row, or a contact-sales plan with no price), `NO_LIST_PRICE`, `NON_USD_CURRENCY`, `NON_MONTHLY_INTERVAL`. Every reason is counted (zero-filled). FREE and DEVELOPMENT rows are counted apart (`not_commercial_by_source`); they are not exclusions. | **Lead confirmation** that a contract-linked row on a list-priced plan is excluded (TD-D2-2) |
| **D2-D5** | **Renewal pipeline by month.** The C6 renewal events (`COMMITMENT_END` for any commercial row; `PERIOD_END` for a provider-linked row), grouped by UTC calendar month. The window starts in the as_of month and runs for `months` 1–24 (default 12). An event on or before as_of goes to `LAPSED`. A bucket counts events (priced / unpriced) and sums the MRR of the included rows renewing in it. | No |
| **D2-D6** | **No tenant filter and no per-tenant row on the route.** Per-tenant revenue is FA-1 material. The service keeps the per-row classification for the oracle only. A `tenant_id` parameter is refused with 400. | No |
| **D2-D7** | **Read-only by construction.** One `REPEATABLE READ` transaction opened `READ ONLY`. No migration, no table, no stored figure. | No |
| **D2-D8** | **A separate controller and service** (`PlatformCommercialRevenueController`, `BillingRevenueReportService`), on the same `platform/commercial/finance` base path as C6. This leaves C6's controller, DTOs and spec untouched. | No |

## 6. Correction-1 triggers (PBD §2.4)

None. There is no architectural change, no new commercial or regulatory decision and no governing-contract amendment. Withholding the amounts implements the Architect's disposition. It does not amend the scope catalog.
