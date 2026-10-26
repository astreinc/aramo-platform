# CCP-C7 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C7: multi-product self-service |
| **Schedule row** | PBD §5.2, row C7 (binding), `:97` |
| **Branch / baseline** | `wip/ccp-c7` at `41a0e3b5` ("CCP: record Architect program acceptance disposition …"). Working tree clean at start. |
| **Drift since the previous slice** | None. The baseline is the program head after the merge train and the Architect acceptance disposition. |
| **Delivery status** | **NOT DELIVERED** (PBD §10 `:210`: "C7 / self-service at scale \| APPROVED legal terms"). Built in Stripe TEST mode with a designed disabled state. |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars: MATCH)

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-E-Sign-Multi-Provider-…-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md` | `7f4698bf434a8cf28d1ee673a78107e65f7cbfe021b4ace7446f162a4df481ba` |
| `Aramo-CCP-A0-Disposition-Row18-ADR-0035-Conditional-v1_0-LOCKED.md` | `da476a76968a40363e1aa6da0cbf509b1ac7a1a39a3a885308909c360cf6b937` |
| `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` | `040c90ee4f64a55b4ac583b6323b5853842e6547b6207081d8e81d9197866478` |

Clauses relied on (`path:line` in OneDrive `Aramo/locked`):
- PBD `:97` (row C7). Prerequisites: "C2, A4 evidence; external: legal terms APPROVED; **row 18 trigger:** if non-Sign tenant billing actions are in scope, the ADR-0035 successor amendment is LOCKED first …; any registry value beyond `sign` needs approved pricing". In: "self-service visibility and upgrade/cancel through Stripe for registered products". Out: "any invented plan; any product without approved pricing". Tests: "Per-product isolation (MP-A2 N-12) on real registry values; owner-only billing". Recovery: "Revert; Stripe-side changes by durable command". HALT: "Missing legal terms; row 18 trigger without its LOCKED amendment; a product without approved pricing". Evidence: "NOT DELIVERED until legal terms (§10)".
- PBD `:87`: "All Phase C slices run in **Stripe test mode** with designed disabled states (§10)."
- PBD `:202-210` (§10): "These slices SHALL be built in Stripe test mode with the designed disabled states. They SHALL be reported as **NOT DELIVERED** until their external decision is made and verified" … "C7 / self-service at scale | APPROVED legal terms".
- PBD `:164-168` (§7.1): registry `sign` only; no invented plans; a value beyond `sign` needs approved pricing.
- PBD `:225-236` (§12): no external Stripe call inside a local DB transaction; no silent override of manual subscriptions by checkout; no live Stripe or public signup while the §7.3 hold applies.
- MP-A2 `:136` (N-12): the fixture tenant with an open base `sign` subscription and an open base subscription of a second key registered only inside the test database; every caller resolves the `sign` row only; removing the second row leaves every Sign result byte-identical.
- Row-18 disposition `:52` (trigger: "C7 extends tenant self-service visibility or billing actions to a product other than Sign"), `:61` (R18-2: no tenant billing authority to `tenant_admin`, `sign_admin`, `ats_admin`), `:63` (R18-4).
- Conversion Rule `:155` (C-15: no path outside C-11 may end, re-source or re-point a governed subscription), `:194` (C-22: Stripe-owned operations are durable commands with a key derived from the request and step), `:195` (C-23: pending-provider until the provider-confirmed state is applied), `:125`/`:130` (C-7 hold, C-8 tenant surfacing).
- Charter `:95` ("Self-service subscriptions | Stripe-owned rows | … SHALL act on them only through Stripe commands"), `:99` ("Tenant-side billing self-service stays a tenant-tier, owner-only act"), `:116` (L3: proration is owned by Stripe).
- `doc/ccp/decisions.md:137` DR-C2-1 (keep `FINANCIAL_TREATMENT_UNDEFINED` for committed self-service rows: no early cancellation, credit or refund); `:27` T8 usage rule (an undefined usage transition fails closed with a typed decision request); `doc/ccp/slices/CCP-C1-acceptance.md:167` TD-C1-2 (a price-change command needs a proration ruling before any slice adds it), `:170` TD-C1-5.

## 2. Reading of the HALT row (recorded as instructed)

"Missing legal terms" is read together with §10 and `:87`: the slice is **built** in Stripe test mode, every new self-service action is refused while the terms are not APPROVED (a designed disabled state with a stable code), and the slice is reported **NOT DELIVERED**. It is not read as forbidding the build. Nothing in the slice activates anything: there is no checkout enablement, no env default, no live key, and no public-signup change.

## 3. Prerequisites

| Prerequisite | Evidence |
|---|---|
| C2 acceptance recorded | `doc/ccp/slices/CCP-C2-acceptance.md` (present at `41a0e3b5`; integrated by TD-MERGE-21…23) |
| A4 acceptance recorded | `doc/ccp/slices/CCP-A4-acceptance.md` (present; N-12 fixture `libs/subscription/src/tests/fixtures/ccp-a4.ts`) |
| External: legal terms APPROVED | **Not met.** `libs/subscription/src/lib/legal/legal-documents.ts:39-41`: `sign.terms_of_service` version `0.1.1`, `status: 'DRAFT'`, `url: null`. → designed disabled state; NOT DELIVERED. |
| Row-18 trigger | **Does not fire.** The registry is `sign` only (`libs/subscription/src/lib/product-registry.ts:19` `PRODUCT_KEYS = ['sign']`). C7 adds no non-Sign product, plan, price or tenant billing action. Authority stays `sign:billing:manage` (tenant_owner only; `apps/sign-service/src/app/billing/esign-billing.controller.ts:63`, `:69`). No ADR-0035 successor amendment is needed. |
| Approved pricing | Sign only: the A1 catalog (approved). No registry value beyond `sign` is added. |

## 4. `path:line` re-verification (at `41a0e3b5`)

- `apps/sign-service/src/app/billing/esign-billing.controller.ts:63` `export const BILLING_MANAGE_SCOPE = ESIGN_SCOPE.BILLING_MANAGE;` and `:69` `assertCanManageBilling` (owner-only, ROLES-1 §3.4, ADR-0035 D-3).
- `apps/sign-service/src/app/billing/esign-billing.controller.ts:113` the existing `TERMS_NOT_APPROVED` mapping (checkout in LIVE mode only).
- `libs/subscription/src/lib/billing/billing-provider-command.ts:30` `BILLING_COMMAND_ACTIONS = ['CONVERSION']`, `:38` the derived key.
- `libs/subscription/prisma/migrations/20261026020000_ccp_c1_stripe_command_inbox/migration.sql:35` `"change_request_id" UUID NOT NULL`, `:65` the idempotency-key CHECK, and the `guard_billing_provider_command()` body (re-created ONLY by C1 before this slice; verified by grep over every migration).
- `guard_commercial_change_request()` is NOT touched (no change-request action, state or transition is added), so the integrator union file `20261027000000_ccp_guard_union` needs no CCP-C7 block.

## 5. Choices this record makes (for Lead / Architect confirmation; none blocks execution)

| ID | Choice | Why |
|---|---|---|
| C7-D1 | **A tenant-originated request, not a change request.** A new append-only `SelfServiceBillingRequest` (owner-made) is the origin of the C1 command; `BillingProviderCommand` gains `self_service_request_id` (ADD), `change_request_id` becomes nullable, exactly one origin (CHECK), key `aramo-ccp-ss-<request>-<step>` (derived, CHECK). | Charter `:99` (tenant-tier, owner-only act) and R18-3 (platform commercial roles are not tenant roles): the platform maker-checker change request is the wrong instrument for a tenant owner's own act. C-22 still holds: the key is derived from the request and the step. |
| C7-D2 | **Cancel = AT_PERIOD_END only.** No IMMEDIATE self-service cancel. | DR-C2-1 / TD-C1-5: an immediate cancel has no approved credit or refund treatment. Inside a commitment term the cancel is refused `FINANCIAL_TREATMENT_UNDEFINED` (no early cancellation); at the last commitment period it is a non-renewal. |
| C7-D3 | **Upgrade = gated, then refused `FINANCIAL_TREATMENT_UNDEFINED`.** No price-change command kind is added. | TD-C1-2 ("price change needs a ruling before any slice adds it"); T8 (no proration or usage-transition policy is authorized); Charter L3. Raised as decision request **DR-C7-1**. |
| C7-D4 | **Gate order:** product → terms APPROVED → governed row (A6) → held activation (A6) → open CONVERSION / live release (C2) → open self-service row → pending provider change → action rules. One evaluator serves the view and the actions. | The terms gate is first so the designed disabled state is what every tenant sees today, whatever else is true. |
| C7-D5 | **Guard placement.** `guard_billing_provider_command()` is re-created in the slice migration (`20261028030000_ccp_c7_self_service_commands`) with the C1 body verbatim plus ONE block marked `>>> CCP-C7 self-service origin`. | The integrator union file covers only `guard_commercial_change_request()`, which C7 does not change. If C4 later re-creates the command guard, the integrator must union it (merge note). |
| C7-D6 | **UI:** no tenant-side Sign design pins a cancel or upgrade element (the Sign prototype and handoff notes in `Aramo/design/aramo-Prototype` contain no billing-change screen; the existing Billing page is the A1 build). Backend + designed disabled state only; `apps/sign-web` gains only typed API client functions, no screen. | Instruction: build only pinned elements. |
| C7-D7 | **Per-product isolation:** the real registry (`sign`) plus the A4 test-database-only key (`ISOLATION_TEST_PRODUCT_KEY`), registered in the test database only. The C7 tables carry their own `product_key` registry CHECK (`sign`). | MP-A2 N-12; no shipped fixture registry. |

No correction-1 trigger (PBD §2.4) has arisen: no instrument contradiction, no new product, no new pricing, no new scope, no vocabulary exemption. Production DB facts are as recorded by A6 (one database, one owning role); C7 needs no cross-system transaction (the provider call is outside every local transaction by C1's construction).
