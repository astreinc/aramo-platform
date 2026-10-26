# CCP-C6 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C6: renewals, outstanding payments, billing reconciliation report |
| **Schedule row** | PBD §5.2, row C6 (binding), PBD `:96` |
| **Branch / baseline** | `wip/ccp-c6` at `6b5051a8` ("CCP-C1: Stripe command outbox + webhook inbox …"). Working tree clean at start. |
| **Drift since the previous slice** | None. C1 is the head commit; C6 starts on it. Other slices (B1 and the remaining Phase B/C/D slices) run in parallel worktrees; overlaps are merge items for the lead (acceptance record §8). |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars: MATCH, 5 of 5)

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` ("Conv.") | `040c90ee4f64a55b4ac583b6323b5853842e6547b6207081d8e81d9197866478` |
| `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` ("UX-A1") | `9c84fbc9e5af5bbf790553723f1080739b2318c30fa9431a9bdbc9f377c7a50c` |
| `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-v1_0-LOCKED.md` ("UX-1") | `e94fa124341ecaa125dcd170066999549f1c8599756437f4294db4ae1361ac2c` |
| `Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md` ("A1") | `44ac30ce8e06d354e303bb824f0cd194d0f50471328d19578c92463cfa8aa716` |

Clauses relied on (verbatim, `path:line` in OneDrive `Aramo/locked`):
- PBD `:96` (§5.2 row C6): "**In:** renewals queue; outstanding payments; billing reconciliation report including held activations (Conv. C-8). Monetary figures only on dedicated Finance screens (A0-C6). **Out:** dashboard money" · Tests: "Report reconciles to commercial records and effective entitlements in Stripe test mode; held activations listed" · Recovery: "Read-only; revert" · HALT: "Any figure not derived from commercial records" · Evidence: "Reconciliation output".
- PBD `:31` (§2.5): "CCP Phase B UI slices (and the UI parts of C and D) also need their **pinned Claude Design handoff**."
- PBD `:104` (§5.3 common HALT): "an unpinned design change".
- Conv. `:130` C-8: "A held activation MUST be surfaced to platform operators for reconciliation: the CCP subscriptions workbench and the reconciliation report (B3, C6)." and the sub-bullet: the hold "MUST NOT be resolved by any local data edit that implies the Stripe side changed".
- UX-A1 `:68` A1-4a: "Monetary metrics … SHALL appear **only on dedicated Finance screens**, never on the dashboard."
- UX-A1 `:70` A1-5: a CCP UI slice "SHALL NOT implement unpinned design changes".
- UX-1 §3 (pixel parity): "Every screen and every designed state matches the design file at 1440×900 and 900×900"; "The reference is the `.dc.html` rendered at the same viewport".
- A1 `:118` (§4.1 matrix): `platform:billing:read` — PO ●, FA ●, CO ●, CM —, SA ●, RA ●, SU —.

## 2. Pinned design input (UX-A1 A1-5; PBD §2.5)

OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`, `shasum -a 256 -c MANIFEST.sha256` on 2026-10-25: **5 of 5 OK**.

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (no entries) |

### 2.1 Finding: the pinned release has NO C6 Finance screen (HALT H-C6-1, UI part only)

The slice instruction asks for the handoff's "Finance screens section (renewals, outstanding payments)". The pinned release contains none:
- Handoff §5 (`handoff …v1.0.md`, §5.1–§5.11) designs Approvals, the CR drawer, Subscriptions, Catalog, Contracts, Policy, Audit, Platform admins, Tenant › Commercial, the dialog pattern and ⌘K. There is no renewals queue, no outstanding-payments screen and no reconciliation-report screen.
- Handoff "Scope › Out of scope" lists "revenue charts (no MRR/ARR)" and "the dashboard commercial panel (deferred)"; handoff §8 note: "D2 needs its own design release later".
- Handoff §11 (screen-to-slice map) names C6 only as a **backend** slice: "Commitment ending filter, past-due / in grace | 5.3 | C6 | **B3**" and "Contracts: commitment ending | 5.5 | C6 | **B4**". No row has UI slice C6.
- The `.dc.html` route set is `approvals`, `subscriptions`, `catalog`, `contracts`, `policy`, `audit`, `admins`, `tenant` (its "Screen inventory" lists the same 10 screens). A text search of all 5 files for "renewal", "outstanding", "reconciliation report" and "finance screen" finds only mock change-request copy in `ccp-data.js` (CR-1043 "30% renewal discount" and similar), never a screen.
- The amendments log has 0 entries; no v1.1 release exists under `ccp/`.

Building a C6 Finance screen therefore has no design reference. It would be an **unpinned design change** (PBD `:104`; UX-A1 A1-5 `:70`), and UX-1 §3 pixel parity cannot be measured against a design file that does not exist. **The UI part of C6 HALTS** until a design release (v1.1 or an amendment with a new manifest) adds the Finance screens, or the Lead rules otherwise. The B3 and B4 surfaces the map assigns to C6 data belong to B3 and B4 (and B1 owns the rail), so C6 builds none of them.

**The backend part of C6 is not affected** and proceeds: PBD `:96` In/Tests/Evidence are all satisfiable without a screen (read-only routes, the reconciliation output and the reproduction tests). The dashboard no-money obligation ("Out: dashboard money"; UX-A1 A1-4a) is checked against the existing dashboard.

## 3. Prerequisites (PBD `:96`: "A6, C1 evidence")

| Prerequisite | Evidence |
|---|---|
| A6 acceptance recorded | `doc/ccp/slices/CCP-A6-acceptance.md` (held activation = open `BillingReconciliationFlag` with reason `governed_subscription_open`, intent kept `CREATED`, governed row unchanged) |
| C1 acceptance recorded | `doc/ccp/slices/CCP-C1-acceptance.md` (command outbox and webhook inbox; `platform:billing:read` enforced by the C1 operator views; a held activation's provider subscription is a command `target_ref`) |
| A5 (pinned versions and their prices) | `doc/ccp/slices/CCP-A5-acceptance.md`; `TenantSubscription.plan_version_id` NOT NULL; the price lives in the checksum-verified `PlanVersion.content.plan` (`list_price_minor`, `currency`, `billing_interval`, `commitment_months`); no `PlanVersionPrice` row exists after the A5 migration (A5 acceptance `:69`) |
| A4 (product dimension) | `doc/ccp/slices/CCP-A4-acceptance.md`; closed registry `PRODUCT_KEYS = ['sign']` |

## 4. `path:line` re-verification (at `6b5051a8`)

| Fact | Location |
|---|---|
| Subscription status CHECK (TRIALING, ACTIVE, PAST_DUE, CANCELED, INCOMPLETE), grace, period end, commitment end, provider linkage | `libs/subscription/prisma/schema.prisma:180-238` |
| Flag model and reasons (incl. `governed_subscription_open`) | `libs/subscription/prisma/schema.prisma:314-334` |
| `GOVERNED_SUBSCRIPTION_OPEN = 'governed_subscription_open'` | `libs/subscription/src/lib/billing/governed-subscription.ts:33` |
| Checksum-verified version terms (fail closed) | `libs/subscription/src/lib/plan-version.ts:274-277` (`planVersionTerms`) |
| Product capability bundle `sign → ['core','sign']` | `libs/subscription/src/lib/product-registry.ts:86` |
| A command targets a held activation through its `subscription_ref` | `libs/subscription/src/lib/billing/billing-command.service.ts:256-262` |
| Effective entitlements = `entitlement."TenantEntitlement"` (no `revoked_at` column at this baseline; A7 adds revoke in parallel) | `libs/entitlement/prisma/schema.prisma:51-64` |
| Seeded USD prices in minor units | `libs/subscription/prisma/migrations/20261019140000_sign_commercial_catalog_a1/migration.sql:132-144` |
| `platform:billing:read` bundles | `libs/subscription/src/tests/support/ccp-a3-database.ts:40-46` |
| C1 read routes under `platform/commercial` | `apps/platform-admin/src/app/platform/platform-commercial-billing.controller.ts:96-131` |

## 5. Choices the schedule leaves to this record

| ID | Choice | Needs confirmation? |
|---|---|---|
| **C6-D1** | **Scope: `platform:billing:read`** for all 3 routes (A1 §4.1 `:118`: PO, FA, CO, SA, RA; never CM, never SU). It is the only billing read scope in the A1 catalog; a Finance-only read scope would be a catalog change (a new scope). Consequence: commercial_ops, support_admin and read_only_auditor see the monetary columns. | **Lead confirmation** (TD-C6-1) |
| **C6-D2** | **Finance route group** `GET /platform/commercial/finance/{renewals, outstanding-payments, reconciliation-report}`. Every monetary field is confined to these routes (A0-C6 / A1-4a); no dashboard, tenant or non-finance route gains a monetary field. | No |
| **C6-D3** | **Figures and their sources.** The only monetary figure is the **list price per billing interval of the plan version** (USD minor units): the subscription's PINNED version for subscriptions, the held plan's current PUBLISHED version for a held activation. It is read through `planVersionTerms` (checksum-verified). No amount owed, invoice total, proration, discount or sum is computed: invoices are C3 (NOT DELIVERED), so `amount_due` is `null` with reason `INVOICE_READ_NOT_DELIVERED`. Non-USD or missing prices are never shown (`unpriced_reason`). | No (HALT rule) |
| **C6-D4** | **No totals of money.** Reports carry per-row prices and **counts** only. MRR/ARR and revenue aggregates are D2. | No |
| **C6-D5** | **Read-only by construction.** Each report runs in one `REPEATABLE READ` transaction opened with `SET TRANSACTION READ ONLY` (a consistent snapshot; any write would raise). No migration. | No |
| **C6-D6** | Renewal kinds: `COMMITMENT_END` (any open row with `commitment_end` inside the horizon, or already past = `lapsed`) and `PERIOD_END` (a provider-linked row's `current_period_end`). Sources MANUAL and SELF_SERVICE only (FREE and DEVELOPMENT carry no commercial renewal). Horizon `within_days` 1–365, default 90. | No |
| **C6-D7** | Outstanding = open MANUAL or SELF_SERVICE rows in `PAST_DUE` or `INCOMPLETE`, with the grace state derived from `grace_until` (IN_GRACE / GRACE_ENDED / NO_GRACE_DATE). | No |
| **C6-D8** | Reconciliation (per open BASE row): expected capabilities `PRODUCT_CAPABILITIES[product]` vs the effective `TenantEntitlement` rows; version integrity; USD price; provider linkage per source (SELF_SERVICE needs a provider subscription; a provider-linked MANUAL row is flagged). Plus: product capabilities held without an open subscription; every open reconciliation flag, with `governed_subscription_open` flags listed as **held activations** (C-8) with the governed row, the intent, the held plan and its unconfirmed commands. If the entitlement table has a `revoked_at` column (A7), revoked rows are excluded. | No |

## 6. Correction-1 triggers (PBD §2.4)

None for the backend part: no architectural change, no new commercial or regulatory decision, no governing-contract amendment. The UI part is HALTED under PBD `:104` / UX-A1 A1-5 (§2.1), which is a design-input gap, not a correction-1 trigger.
