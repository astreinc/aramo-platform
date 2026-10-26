# CCP-C4 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C4: credits, refunds, discounts |
| **Schedule row** | PBD §5.2, row C4 (binding), `:94` |
| **Branch / baseline** | `wip/ccp-c4` at `41a0e3b5` ("CCP: record Architect program acceptance disposition …"), the integrated program branch after the merge train (A1–A11, B1–B6, C1–C3, C6, D1, D3, B5-R, the guard and constraint unions). Working tree clean at start except one untracked backlog note outside the slice (`doc/backlog/platform-console-forbidden-account-switch.md`, not touched). |
| **Drift since the previous slice** | None: the baseline is the integrated program head. The rulings this slice depends on are in this worktree's `doc/ccp/decisions.md` (TD-B2-3 requester-only, the A6 dispositions, T8, DR-C2-1 and the TD-C3-5 Finance amount ruling of the program acceptance disposition). |
| **Delivery status** | **NOT DELIVERED** (PBD §10: "C4 refunds and credits — Refund policy (legal)"). Built in Stripe test mode with the designed disabled states. |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars)

| Instrument | SHA-256 | Sidecar |
|---|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` | MATCH |
| `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` (Charter) | `82d328eb11b586eb0df5d183d9c88c6899053c9257be7b5245f77e212c54b788` | MATCH |
| `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` (Conv.) | `040c90ee4f64a55b4ac583b6323b5853842e6547b6207081d8e81d9197866478` | MATCH |
| `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED.md` (AD) | `58dac8ed94ccf43bd7a29b28b83fde242588cef3b4da9ed76ea403dfc3346418` | MATCH |
| `Aramo-Authorization-Model-DDR-Amendment-v1_2-CCP-Commercial-Authority-LOCKED.md` (DDR v1.2) | `9ef231941b9471002cc79909b91e53be7d56b842244d7c4105b0f80b970fb255` | MATCH |
| `Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0-LOCKED.md` (A1) | `44ac30ce8e06d354e303bb824f0cd194d0f50471328d19578c92463cfa8aa716` | MATCH |

Clauses relied on (OneDrive `Aramo/locked`):
- PBD `:94` (§5.2 row C4): "**Prerequisites:** C1, A3 evidence; external: refund policy (legal). **In:** change requests executed in Stripe by durable command; thresholds from the active policy (20% / $500). **Out:** any money movement before the approval chain completes." Tests: "Threshold escalation; idempotency; pending until webhook; NC-1…NC-5 on these action types". Recovery: "Compensating Stripe command through a new change request". HALT: "Any money movement without a completed chain". Evidence: "NOT DELIVERED until refund policy (§10)".
- PBD §10 `:203`: "These slices SHALL be built in Stripe test mode with the designed disabled states"; `:208`: "C4 refunds and credits | Refund policy (legal)".
- PBD §6, §7.3 (production release hold), §7.5 (no production migration), §12 (no external Stripe call inside a local DB transaction; no self-approval; no approval bypass through SQL).
- Charter §7 `:221-222`: discount escalation threshold **20%**, credit escalation threshold **$500 (USD)**, "policy data held in `CommercialPolicyVersion` v1 … NOT code constants". v1 content (`20261024180000_ccp_a2_commercial_audit_policy/migration.sql:214`): `discount_escalation_threshold_bps: 2000`, `credit_escalation_threshold_minor: 50000`, `currency: "USD"`. Boundary semantics A2-B / TD-A2-2: **inclusive** (≥).
- Charter §6.4 NC-1…NC-5 (`:207-211`); NC-5 rule as RATIFIED (decisions TD-A3-0).
- Conv. `:194` C-22: "Stripe-owned operations SHALL be durable commands with an idempotency key derived from the change request and step, and SHALL be reconciled by the verified webhook or a provider re-fetch. They are never part of a local DB transaction. These are: … credits, refunds and discounts …". `:195` C-23: "An external financial change MUST NOT be reported as committed on local commit alone … Until the provider-confirmed state is applied, the request and the affected subscription SHALL show a pending-provider state."
- AD-2, AD-3, AD-4 (APPLY_EXPIRED only from APPROVED / APPLY_FAILED, never APPLYING), AD-8 (requester-only apply).
- DDR v1.2 `:82` (finance_admin "Approves credits, discounts and subscription terms"), `:96` (commercial authority covers "credits, refunds and discounts").
- A1 `:119-120`: `platform:billing:request` = commercial_ops only; `platform:billing:approve` = platform_owner, finance_admin.

## 2. Prerequisites (PBD C4 row)

| Prerequisite | Evidence |
|---|---|
| C1 | `doc/ccp/slices/CCP-C1-acceptance.md`: the command outbox (`BillingProviderCommand`, derived key, enqueue gate needs a completed chain), the webhook inbox, confirmation only in the transaction that applies provider-confirmed state, the live-key refusal (TD-C1-3). TD-C1-8 hands the CREDIT / DISCOUNT widening to C4. |
| A3 | `doc/ccp/slices/CCP-A3-acceptance.md`: CREDIT and DISCOUNT are in the closed action set with requester scope `platform:billing:request`, domain `billing`; the chain resolver applies the policy thresholds; NC-1…NC-5 engine. |
| A6 / A6-R | the requester-only apply pattern (TD-B2-3), apply-time NC-5 re-check (`assertApplyEligible`), lazy apply expiry (`expireApplyIfDue`). |
| B5 | the active policy is read through `CommercialPolicyRepository.getActivePolicy`; POLICY_ACTIVATE changes it only through the governed apply. |
| External: refund policy (legal) | **ABSENT.** Hence NOT DELIVERED and the designed disabled state for REFUND (C4-D8). |

## 3. `path:line` re-verification (at `41a0e3b5`)

| Fact | Location |
|---|---|
| `CREDIT`, `DISCOUNT` in the closed set; no refund type | `libs/subscription/src/lib/commercial/commercial-change-request.ts:41-42` |
| Requester scope `platform:billing:request`, domain `billing` | `commercial-change-request.ts:81-82` |
| Chain: CREDIT / DISCOUNT at or above the policy threshold → Finance → Owner, else Finance; basis records the policy values | `commercial-change-request.ts:375-396` |
| Threshold predicates, inclusive (`>=`), non-policy currency escalates | `libs/subscription/src/lib/commercial/commercial-policy-boundaries.ts:47-51`, `:61-67` |
| A3 payload validation only (amount 0 admitted; no closed key set) | `commercial-change-request.ts:490-496` |
| C1 enqueue gate admits CONVERSION only (TS + DB) | `libs/subscription/src/lib/billing/billing-provider-command.ts:30`; `libs/subscription/prisma/migrations/20261026020000_ccp_c1_stripe_command_inbox/migration.sql:122` |
| C1 command kind and params CHECKs | `20261026020000_ccp_c1_stripe_command_inbox/migration.sql:62`, `:69-73` |
| The integrator-owned guard and its TS mirror | `libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/migration.sql:32-452`; `canTransitionFor` `commercial-change-request.ts:280-305` |
| Constraint union | `libs/subscription/prisma/migrations/20261027000100_ccp_constraint_union/migration.sql:19-25` |
| C2's commit-in-APPLYING-with-a-command pattern (the C4 model) | `20261026060000_ccp_c2_conversion/migration.sql:392-410`; guard union `:241-257` |
| Requester-only apply hint | `libs/subscription/src/lib/commercial/commercial-change-request.service.ts:1089-1101` |
| Webhook handling and confirmation | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:671-706`; inbox `billing-webhook-inbox.service.ts:93-119` |
| Live-key refusal | `libs/subscription/src/lib/billing/billing-command.service.ts:315-319` |
| The Stripe wire exemption (the only file that may carry Stripe's own field and path names) | `scripts/verify-vocabulary.sh:187-194` |
| DR-C2-1 refusal kept (no early-cancellation financial treatment) | `libs/subscription/src/lib/commercial/commercial-conversion.service.ts:319-322` |

## 4. Choices the schedule leaves to this record

| ID | Choice | Needs confirmation? |
|---|---|---|
| **C4-D1** | **Action types.** CREDIT and DISCOUNT are the A3 types (used as defined). The A3 closed set has **no refund type** while DDR v1.2 `:96` and the C4 row name refunds; a refund (money returned to a payment) is not an account credit, so **REFUND is added** to the closed set (TS list, DB CHECK through the constraint union, OpenAPI enum). Requester scope `platform:billing:request` (commercial_ops), domain `billing` (approve scope `platform:billing:approve`). | **Yes: TD-C4-1** (recorded new type) |
| **C4-D2** | **Payloads (C4 owns the full schema; closed key sets).** CREDIT `{amount_minor ≥ 1, currency, subscription_id?, compensates_change_request_id?}`; DISCOUNT `{discount_bps 1…10000, subscription_id?, compensates_change_request_id?}`; REFUND `{amount_minor ≥ 1, currency, provider_invoice_ref, subscription_id?}`. Existing CREDIT / DISCOUNT fixtures remain valid (they carry only `amount_minor ≥ 1` / `currency` / `discount_bps ≥ 1`). | No |
| **C4-D3** | **Chains.** CREDIT and DISCOUNT keep the A3 resolver: thresholds read from the ACTIVE policy at creation and snapshotted (NC-5); inclusive. No threshold for refunds exists in Charter §7, and none is invented: **REFUND always takes Finance → Owner** (the stricter, escalated chain). | **Yes: TD-C4-2** (the refund policy sets the rule) |
| **C4-D4** | **Apply.** A new requester-only command `POST /platform/commercial/change-requests/{id}/billing-adjustment` (and a read `GET …/billing-adjustment`), route gate `platform:approval:read`, then: user principal, requester scope, actor = `requested_by` (TD-B2-3), lazy apply deadline (AD-7), NC-5 `assertApplyEligible` in the transaction. Approval never applies. | No |
| **C4-D5** | **States (C2 model).** APPROVED → APPLYING and the C1 command are ONE local transaction (outbox); the request **commits in APPLYING** (pending-provider; a deferred trigger refuses an APPLYING C4 request without a command). The provider call runs later with no transaction open. APPLIED is written ONLY in the transaction that applies the provider-confirmed state (verified webhook through the inbox, or re-fetch), together with the command's CONFIRMED and an append-only `CommercialBillingAdjustment` record. A FAILED command (provider refusal, retries exhausted) leaves the request APPLYING (never a silent failure, never a second command); the requester's next apply **re-arms the same command** (same idempotency key). APPLY_FAILED arises only from a check that fails before any command exists. APPLY_EXPIRED per AD-4 (never from APPLYING). | No |
| **C4-D6** | **Stripe operations** (a separate adjustment port bound to the Stripe adapter; existing ports and fakes unchanged): CREDIT → a negative account balance adjustment (a credit to the next invoice); compensation → the equal positive adjustment; DISCOUNT → a percent-off coupon with a deterministic id `aramo-ccp-<request>-<step>` attached to the subscription, `duration=once`; compensation → removal of that discount; REFUND → a refund of the named invoice's payment for the amount. Every write carries the command's derived idempotency key and `aramo_command_id` metadata; every dispatch first re-reads the provider and never repeats an effect already present. Stripe paths and field names live in `stripe-wire.ts` (existing exemption, no new exemption); the account path reuses `wireAccountPath`. | **Yes: TD-C4-6** (`duration=once` is the only discount term v1 supports) |
| **C4-D7** | **Target.** The tenant × product's open SELF_SERVICE base subscription with a provider account (Stripe-owned). A governed (MANUAL / contract) tenant is refused at apply (`TARGET_NOT_SELF_SERVICE`, APPLY_FAILED): invoicing for contracts is gated (PBD §10, enterprise invoicing). A named `subscription_id` that is no longer that row is `TARGET_STALE`. | No |
| **C4-D8** | **Refund designed disabled state.** A REFUND can be created, submitted and approved; its **apply is refused** with the stable code `REFUND_POLICY_NOT_APPROVED` (no state change, one audit row, zero provider calls) unless `CCP_REFUND_EXECUTION_ENABLED=1`. The flag defaults off, is not in `docker-compose.prod.yml` or `.env*.example`, and is set only in tests. Defence in depth: a REFUND command found by the dispatcher while the flag is off is FAILED `REFUND_POLICY_NOT_APPROVED` with no provider call. | **Yes: refund policy (legal)** |
| **C4-D9** | **Recovery (PBD row).** A compensating Stripe command through a **new change request** naming `compensates_change_request_id`: the original must be APPLIED, of the same type, tenant and product, not yet compensated (UNIQUE), with equal amount / currency (CREDIT) or equal `discount_bps` (DISCOUNT); it runs the full chain (thresholds on its own amount). A refund has no compensation (refused at create). | No |
| **C4-D10** | **Finance amount interim** (decisions TD-C3-5 ruling; draft FA-6 marker). C4 routes never return a tenant-specific amount: the request payload's `amount_minor`, the chain basis amount and the C4 command params are omitted and marked `amount_withheld: "FINANCE_SCOPE_PENDING"`. The C1 billing-commands read applies the same to C4 command kinds. C4 audit bodies carry no amount. Discount percentages are not amounts and stay visible. | **Yes: TD-C4-7** (generic change-request reads are not C4 routes; see acceptance) |
| **C4-D11** | **DR-C2-1.** No automatic credit or refund on any cancellation. C4 adds no cancellation hook; C2's `FINANCIAL_TREATMENT_UNDEFINED` refusal is untouched. A C4 request is never derived from a cancellation. | No |
| **C4-D12** | **Guard placement.** The C4 transition, attempt, commit-in-APPLYING and APPLIED rules go in a labelled `CCP-C4` block of `20261027000000_ccp_guard_union`, mirrored in `canTransitionFor`; the action-type and command-kind CHECK widenings in a labelled `CCP-C4` block of `20261027000100_ccp_constraint_union`. The slice migration `20261028010000_ccp_c4_billing_adjustments` adds only C4's own objects (the adjustment table, two nullable columns, the C1 command guard widened for C4 actions, the deferred trigger). | No |
| **C4-D13** | **UI.** CCP-UI v1.0 pins no credit, refund or discount dialog: the tenant Commercial tab's action table (handoff §5.9) has none, and the plan-change dialog's discount field governs a SUBSCRIPTION_CHANGE of a MANUAL row (DV-B3-5, not a Stripe command). The one pinned C4 element is the drawer stepper chip "Sent to Stripe — awaiting confirmation" for a Stripe-side request in Applying (handoff §4). Only that is built, in B1's stepper model; everything else is recorded for CCP-UI v1.1. | **Yes: v1.1 design** |

## 5. Pinned design handoff

`/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`: `shasum -a 256 -c MANIFEST.sha256` → 5 / 5 OK (`Commercial Control Plane v1.0.dc.html`, `ccp-data.js`, `support.js`, both handoff files). `MANIFEST.sha256` itself: `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`. The repo copy `doc/design-reference/ccp/CCP-UI-v1_0/` is the same pinned set (B1).

## 6. Correction-1 triggers (PBD §2.4)

None. REFUND is a value DDR v1.2 `:96` and the C4 row already name; it is added to the closed list, not a new architecture. No external call runs inside a local transaction (the C1 dispatcher model). No policy value is introduced. The refund policy being absent is the designed NOT DELIVERED state of PBD §10, not a HALT.
