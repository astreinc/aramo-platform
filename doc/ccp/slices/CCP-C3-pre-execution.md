# CCP-C3 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C3: read-through invoice and payment status |
| **Schedule row** | PBD §5.2, row C3 (binding), `:93` |
| **Branch / baseline** | `wip/ccp-c3` at `6b5051a8` ("CCP-C1: Stripe command outbox + webhook inbox …"). Working tree clean at start. |
| **Drift since the previous slice** | None. C1 is the head commit, and C3 starts on it. Other slices run in parallel worktrees, so any overlap is a merge item for the lead (§6). |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars: MATCH)

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` | `82d328eb11b586eb0df5d183d9c88c6899053c9257be7b5245f77e212c54b788` |
| `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` | `040c90ee4f64a55b4ac583b6323b5853842e6547b6207081d8e81d9197866478` |
| `Aramo-PLATFORM-UX-1-…-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` | `9c84fbc9e5af5bbf790553723f1080739b2318c30fa9431a9bdbc9f377c7a50c` |
| `Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md` | `44ac30ce8e06d354e303bb824f0cd194d0f50471328d19578c92463cfa8aa716` |

Clauses relied on (`path:line` in OneDrive `Aramo/locked`):
- PBD `:93` (row C3): "**In:** a read-only adapter inside the Stripe wire boundary; portal configuration. The existing `stripe-wire.ts` vocabulary exemption only; no new exemption. **Out:** any write to Stripe". Tests: "Adapter is read-only; Stripe test mode; vocabulary gate". HALT: "A need for a new vocabulary exemption". Evidence: "NOT DELIVERED until its external dependency is verified (§10)".
- PBD `:87`: "All Phase C slices run in **Stripe test mode** with designed disabled states (§10)."
- PBD `:207` (§10): "| C3 portal configuration | `STRIPE_PORTAL_CONFIGURATION` |".
- Charter `:92`: "Payments, invoices, tax, card data, proration, dunning retries | **Stripe** | Aramo SHALL mirror status only. Aramo SHALL NOT build a competing payment ledger."
- Charter `:118` (L5): "Invoices and payment methods are managed only in the Stripe hosted billing portal … A read-through adapter inside the Stripe wire boundary (slice CCP-C3)".
- UX-1 A1 `:68` (A1-4a): "Monetary metrics … SHALL appear **only on dedicated Finance screens**, never on the dashboard."
- A1 directive `:118` (matrix row `platform:billing:read`: PO, FA, CO, SA, RA; not CM, not SU) and `:317` ("`platform:billing:{read,request,approve}` | Phase C (C3/C4)").

## 2. Prerequisites (row C3: "A6, C1 evidence; external: `STRIPE_PORTAL_CONFIGURATION`")

| Prerequisite | Evidence |
|---|---|
| A6 acceptance recorded | `doc/ccp/slices/CCP-A6-acceptance.md` (present at `6b5051a8`) |
| C1 acceptance recorded | `doc/ccp/slices/CCP-C1-acceptance.md` (present at `6b5051a8`; `platform:billing:read` literally enforced, TD-C1-15) |
| External `STRIPE_PORTAL_CONFIGURATION` | **Not verified.** The variable is a documented passthrough (`docker-compose.prod.yml:498`, `.env.prod.example:384-388`). Release D18 (`doc/runbooks/RELEASE-sign-standalone-billing.md:141`) requires a portal configuration whose cancellation settings match the approved annual terms. Nobody has recorded that such a configuration exists and was verified. **C3 is therefore built in test mode with designed disabled states, and it is reported NOT DELIVERED.** |

## 3. `path:line` re-verification (at `6b5051a8`)

| Fact | Location |
|---|---|
| The wire file is the only place Stripe's own identifiers appear, and it holds no Aramo logic | `libs/subscription/src/lib/billing/stripe-wire.ts:1-8` |
| The vocabulary exemption covers exactly `stripe-wire.ts` and `stripe-wire.spec.ts` | `scripts/verify-vocabulary.sh:188-194` |
| The adapter's single HTTP entry takes `GET \| POST \| DELETE` | `libs/subscription/src/lib/billing/stripe-billing.provider.ts:161` |
| The portal session read takes `STRIPE_PORTAL_CONFIGURATION`, and commitment plans are refused without it (`PORTAL_NOT_CONFIGURED`) | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:605-612` |
| `BillingProviderPort` has 6 test fakes, and C1 added a separate port so they stay unchanged | `CCP-C1-acceptance.md` TD-C1-14 |
| Self-service rows: `source = 'SELF_SERVICE'`, with `billing_account_ref` and `billing_subscription_ref` | `libs/subscription/prisma/schema.prisma:191, 199-200` |
| `platform:billing:read` is literally enforced (C1) | `ci/scripts/verify-orphan-scopes.ts:94` |

## 4. Design input (PBD §2.5) — pinned handoff

`Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/MANIFEST.sha256` (manifest SHA-256 `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`); all 5 entries checked OK:

| File | SHA-256 |
|---|---|
| `Commercial Control Plane v1.0.dc.html` | `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` |
| `ccp-data.js` | `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` |
| `support.js` | `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` |
| `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` | `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` |
| `handoff/Commercial Control Plane - design amendments log v1.0.md` | `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` |

The screen-to-slice map in the handoff (`:502`) has one C3 row: "Tenant › Commercial: Managed in Stripe link-outs (invoices, payment methods, proration, cancellation) | 5.9 | C3 | B3". The UI slice for that row is **B3**. The handoff also puts "invoices and payment-method editing" out of scope (`:32`) and allows only links to real Stripe screens (`:31`).

**Decision C3-D0: C3 is backend only.** The handoff pins no C3-owned UI element. C3 supplies the read surface that B3's link-outs and status lines consume. No `apps/platform-web` file is touched, and the B1 rail and shell are not touched.

## 5. Choices the schedule leaves to the record

| ID | Choice | Needs confirmation? |
|---|---|---|
| C3-D1 | **A separate read-only port and adapter class.** `BILLING_PROVIDER_READ_PORT` is bound to a new `StripeBillingReadAdapter` whose only HTTP method is `GET`. It is not a method on `StripeBillingProvider`, which also holds POST and DELETE. This leaves the 6 `BillingProviderPort` fakes and the C1 command port unchanged, and it makes "no mutating Stripe method is reachable" provable structurally, not only by convention. | No (within row) |
| C3-D2 | **Wire translation.** Every Stripe identifier that would trip the vocabulary gate goes through `stripe-wire.ts`, the existing exemption. That covers the invoice's account field (through the existing `wireAccountRef`), and nothing new is added unless it is needed. Invoices are listed **by subscription** (`subscription=` filter), not by account, so no account-keyed query parameter is needed. No new exemption is created. | No |
| C3-D3 | **Scope `platform:billing:read`** for both routes, per the A1 matrix (`:118`) and its Phase C reservation (`:317`). Holders: platform_owner, finance_admin, commercial_ops, support_admin and read_only_auditor. Refused: catalog_manager and super_admin. | Recorded for the Architect (TD-C3, the A1-4a reading) |
| C3-D4 | **Money placement (A1-4a).** Invoice amounts (minor units + currency) appear only on the tenant billing-status route, which serves a dedicated Finance/billing screen. They never appear on a dashboard route or any aggregate. No totals are computed (Charter `:92`: mirror status only, no ledger). | Recorded |
| C3-D5 | **Designed disabled states (R-13; PBD `:87`).** The route answers 200 with an `availability` value instead of failing: `BILLING_UNAVAILABLE` (no key), `LIVE_MODE_HELD` (a live key: refused, as TD-C1-3), `NO_PROVIDER_SUBSCRIPTION` (no Stripe-owned row; MANUAL or contract rows have no Stripe invoices), `PROVIDER_UNAVAILABLE` (a read failed) and `AVAILABLE`. A tenant mismatch at the provider is refused and returns no provider data. | Live-mode lift for the PO at live release |
| C3-D6 | **Portal configuration** is read (GET) and reported as facts: `NOT_CONFIGURED` / `NOT_FOUND` / `INACTIVE` / `ACTIVE`, plus its feature flags. **An ACTIVE configuration does not mean "verified" in the §10 sense.** The §10 verification is an external decision (D18: cancellation settings match the approved terms), recorded by a person. The route never claims it. | No |
| C3-D7 | Payment-method details (card data) are **not** read. Charter `:92` assigns card data to Stripe, and the handoff links out for payment methods. | No |

## 6. Migration and overlap

- **No migration.** A read-through needs no schema change. The reserved timestamp `20261026070000_ccp_c3_*` stays unused.
- Expected merge overlap: `libs/subscription/src/index.ts`, `subscription.module.ts`, `billing-provider.port.ts`, `stripe-wire.ts`, `openapi/platform.yaml`, `ci/config/api-surface-manifest.json`, `platform.module.ts`, the platform-web Pact consumer, `verify-platform-admin.ts`, and `doc/generated/repo-map.*`.

## 7. Correction-1 statement (PBD §2.4)

No correction-1 trigger has arisen. C3 needs no architectural change, regulatory or commercial decision, or governing-contract amendment. The external portal-configuration decision is a §10 dependency, not a trigger.
