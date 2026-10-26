# CCP-C2 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C2: governed manual ↔ self-service conversion |
| **Schedule row** | PBD §5.2, row C2 (binding), `:92` |
| **Branch / baseline** | `wip/ccp-c2` at `6b5051a8` ("CCP-C1: Stripe command outbox + webhook inbox …"), i.e. C1 on top of A1–A6, A9, A10. Working tree clean at start. |
| **Drift since the previous slice** | The baseline is C1 itself. The program branch (`feat/ccp-commercial-control-plane` @ `18b2c032`) has moved on with `e0b050ca` (Architect dispositions on A6) and the D1 merge; C1 is not merged there yet. The rulings this slice depends on (TD-A6-3 as narrowed by TD-B2-3, TD-A6-5 / the apply TTL, DR-A6-1…4, TD-A6-R-1) are in the program branch's `doc/ccp/decisions.md` and were read from there (`git show feat/ccp-commercial-control-plane:doc/ccp/decisions.md`); the baseline's copy predates them. Parallel slices (A8, A6-R, B5 and others) add guard branches; the lead unions them at merge. |

## 1. Governing instruments (SHA-256 re-verified)

| Instrument | SHA-256 | Sidecar |
|---|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` | MATCH |
| `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` ("Conv.") | `040c90ee4f64a55b4ac583b6323b5853842e6547b6207081d8e81d9197866478` | MATCH |
| `Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0-LOCKED.md` ("AD") | `58dac8ed94ccf43bd7a29b28b83fde242588cef3b4da9ed76ea403dfc3346418` | no `.sha256` sidecar filed (recorded, not a blocker: the amendment's §5 gives the TTL implementation to A6-R / B5; C2 only honours it) |

Clauses relied on (OneDrive `Aramo/locked`):
- PBD `:92` (§5.2 row C2): "**In:** Conv. C-11…C-15 in both directions; release with expiry; pending-provider state; history preservation; audit. **Out:** console UI (B3)". Tests: "Governed → self-service release consumed exactly once, and an expired release falls back to the hold; self-service → governed through a durable command, with the governed row opened only after the provider-confirmed end; history never deleted; **C8 resolution test (§7.2)**". Recovery: "An unconsumed release expires; no destructive edit". HALT: "Any resolution path through SQL or a local edit that implies Stripe changed".
- PBD §7.2: the held activation must be provably resolvable through C2 with executed tests.
- Conv. `:142` C-11 (closed action type, distinct-human chain), `:143` C-12 (release with expiry; webhook-time end + open in one transaction under the lock; linked; audited; expired → C-6/C-7), `:147` C-13 (durable command; governed row only after the provider-confirmed end; pending-provider until then), `:151` C-14 (history never deleted or rewritten; ended rows never reopened; append-only audit), `:155` C-15 (no other path), C-21 (releasing a checkout is Aramo-owned, complete on commit), C-22/C-23 (Stripe-owned = durable command; never reported committed on local commit), C-29.
- AD §3: AD-2 (a request snapshotted under a version without the key has no deadline), AD-3 (half-open), AD-4 (never from APPLYING; retry only before the deadline), AD-8 (requester-only apply).

## 2. Prerequisites (PBD §5.2 C2 row: "C1, A3, A6 evidence")

| Prerequisite | Evidence |
|---|---|
| C1 | `doc/ccp/slices/CCP-C1-acceptance.md` (baseline commit `6b5051a8`): `BillingProviderCommand` (INSERT trigger requires a completed approval chain and action `CONVERSION`), `BillingWebhookInbox`, confirmation in the applying transaction, TD-C1-2/4/5/9 |
| A3 | `doc/ccp/slices/CCP-A3-acceptance.md`; `CONVERSION` in the closed action set, Finance-only chain (TD-A3-2) |
| A6 | `doc/ccp/slices/CCP-A6-acceptance.md`: the apply, the billing lock, the hold (`governed_subscription_open`), DB guard union |

## 3. `path:line` re-verification (at `6b5051a8`)

| Fact | Location |
|---|---|
| `CONVERSION` action, requester scope `platform:subscription:request` | `libs/subscription/src/lib/commercial/commercial-change-request.ts:41`, `:75` |
| The applying slice owns the payload schema (no CONVERSION case yet: `default: break`) | `commercial-change-request.ts:328-333`, `:398-399` |
| `canTransitionFor`: CONVERSION reaches no apply state today | `commercial-change-request.ts:173-178` |
| A6 apply refuses non-A6 actions (`ACTION_NOT_APPLICABLE`); scope check only (TD-A6-3 as built) | `libs/subscription/src/lib/commercial/commercial-apply.service.ts:205-211` |
| Guard function body to keep verbatim | `libs/subscription/prisma/migrations/20261025200000_ccp_a6_transactional_apply/migration.sql:104-228`; the A6 no-APPLYING-commit trigger `:233-252` (A6 actions only) |
| Checkout gate (early read + locked re-check) | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:154-160`, `:490`, `:500-501` |
| Webhook-time hold and flag | `subscription-lifecycle.service.ts:775-786`; `openRow` defence in depth `:925-929` |
| Confirmation in the applying transaction | `subscription-lifecycle.service.ts:741-743`; `billing-provider-command.ts:124-145` (returns the confirmed ids) |
| `checkout.session.expired` → re-fetch → intent EXPIRED (TD-C1-4) | `subscription-lifecycle.service.ts:630-631`, `:671-699` |
| An ended subscription is never reopened | `subscription-lifecycle.service.ts:839-841` |
| C1 enqueue gate admits APPROVED / APPLYING / APPLY_FAILED and CONVERSION; a held activation's open flag is a valid cancel target | `libs/subscription/src/lib/billing/billing-command.service.ts:206-226`, `:252-271`; `billing-provider-command.ts:30`, `:33` |
| IMMEDIATE cancel sends no proration parameters (TD-C1-5) | `libs/subscription/src/lib/billing/stripe-billing.provider.ts` (cancel = DELETE with the command key) |
| Apply route gate `platform:approval:read` | `apps/platform-admin/src/app/platform/platform-commercial-apply.controller.ts:31-34` |
| `NOT_REQUESTER` → 403 `not_requester` mapping exists | `apps/platform-admin/src/app/platform/platform-commercial-change-request.controller.ts:217-218` |

## 4. Choices the schedule leaves to this record

| ID | Choice | Needs confirmation? |
|---|---|---|
| **C2-D1** | **Action type** stays the closed `CONVERSION` (A3). The payload carries a closed `direction`: `TO_SELF_SERVICE` (governed → self-service, C-12) or `TO_GOVERNED` (self-service → governed, C-13). Each direction has a closed key set (validated at create and again at apply, the A6 pattern TD-A6-15). | No (O-3 names fixed here) |
| **C2-D2** | **Release** = new append-only table `subscription."CommercialConversionRelease"`, one per request. States `RELEASED → CONSUMED → CONVERTED`, `RELEASED → CONVERTED` (adopting a held activation), `RELEASED → EXPIRED`. **Consumed exactly once** = bound to exactly one checkout (the CheckoutIntent created under the billing lock in the same transaction) or to exactly one held activation; `UNIQUE(intent_id)`; one `RELEASED` release per tenant × product (partial unique index). DB trigger: no DELETE, identity immutable, consumption only before `expires_at`, `CONVERTED` only with the self-service row and the ended governed row present. | No |
| **C2-D3** | **Release expiry value.** Charter §7 has no release-TTL policy key, and policy values must not be code constants. The expiry is therefore an **approved term of the request**: `release_expires_at` in the frozen payload, which the approvers sign. Apply refuses a passed expiry; a structural sanity bound (≤ 30 days after apply) refuses a unit slip. | **Yes: DR-C2-2** (a policy key would need a Charter amendment). Fail-closed meanwhile. |
| **C2-D4** | **Release expiry is a local Aramo-owned window, checkout expiry is not.** The release bounds only when the checkout may START (consumption). Whether that checkout later expires is derived only from authoritative provider evidence (verified `checkout.session.expired` → re-fetch, C1). A consumed release never moves the governed row; the governed row ends only in the webhook transaction that opens the provider-confirmed, sending SELF_SERVICE row. | No |
| **C2-D5** | **Governed → self-service request lifecycle:** apply (requester-only) is one local transaction (C-21: releasing a checkout is Aramo-owned): `APPROVED → APPLYING → APPLIED` with the release row and a `CommercialChangeApplication` (subscription = the governed row). The conversion itself completes later in the webhook transaction (C-12), linked through the release (request, governed row, self-service row, intent). | No |
| **C2-D6** | **Self-service → governed lifecycle, pending-provider without a new request state** (instructed preference): apply = `APPROVED → APPLYING` + the C1 `SUBSCRIPTION_CANCEL` command enqueued in the same transaction (outbox); the request **commits in APPLYING** (a CONVERSION-only rule: allowed only when a provider command exists for it). The C1 command state is the pending-provider state (C-23). The transaction that applies the provider-confirmed end (webhook or re-fetch) confirms the command (C1) and then, in the same transaction, opens the governed MANUAL row, grants the product capabilities and moves the request `APPLYING → APPLIED` (or `APPLY_FAILED` when a re-check fails). APPLYING keeps AD-4 protection: the apply TTL never expires a conversion whose provider round trip is in flight. `APPLYING → APPLY_FAILED` is refused at the DB while any command of the request is unconfirmed. | No |
| **C2-D7** | **Cancel mode = IMMEDIATE, as C1 built it** (TD-C1-5: no proration or invoice parameters). No other mode is chosen. A self-service row inside a commitment term (`commitment_end` in the future) is refused (`FINANCIAL_TREATMENT_UNDEFINED`, kind `COMMITMENT_TERM`): the cancellation would have an undefined financial treatment. | **Yes: DR-C2-1** (proration / credit for the unused period of an immediate cancel). Fail-closed meanwhile. |
| **C2-D8** | **Usage (T8).** Governed → self-service: the new row's first period must not strand usage (same rule as the A6 fresh open, DR-A6-2): otherwise the activation stays held. Self-service → governed: the MANUAL row keeps the self-service row's `period_anchor` (same period) and must be an upgrade-or-equal with no open reservation (the A6 rule as built); checked at apply (before any Stripe call) and again at completion. | Recorded; DR-C2-3 (usage of the ended governed period in a mid-period conversion) |
| **C2-D9** | **Held activation resolution (C-29).** Both directions accept a held activation: `TO_SELF_SERVICE` with `held_subscription_ref` (the release adopts that held provider subscription; after commit the service re-fetches it, and the applying transaction converts); `TO_GOVERNED` with `held_subscription_ref` (a durable cancel of the held provider subscription; the governed row is kept; the confirmed end resolves the flag, C-9). | No |
| **C2-D10** | **Apply authority: requester-only** (TD-A6-3 narrowed by TD-B2-3, AD-8): the actor must be `requested_by` (403 `not_requester`) and still hold `platform:subscription:request`; NC-5 re-check; immutable payload checksum. The completion step of C2-D6 is a system continuation of an apply already in progress (AD-4), audited with a system actor. | No |
| **C2-D11** | **Apply deadline (AD).** The C2 apply reads the request's SNAPSHOTTED policy version (NC-5): if its content declares `apply_deadline_hours`, entering APPLYING at or after `approved_at + hours` is refused with `APPLY_DEADLINE_PASSED` (half-open, AD-3); a malformed key fails closed. The `APPLY_EXPIRED` transition itself is A6-R's. v1 declares no key, so v1 requests have no deadline (AD-2). | Key name to be unified with A6-R / B5 at merge (TD-C2-n) |
| **C2-D12** | **Routes** (no new scope; gate `platform:approval:read` as every CCP request route): `POST /platform/commercial/change-requests/{id}/convert` (apply a CONVERSION) and `GET /platform/commercial/change-requests/{id}/conversion` (the conversion state: direction, `pending_provider`, release, commands; TD-C1-9 for the request). The A6 apply route is unchanged. | No |
| **C2-D13** | **Guard function:** a new migration re-creates `guard_commercial_change_request()` with the A6 body **verbatim** and one delimited CONVERSION block; `canTransitionFor` and A9-U-4 mirror it. `CommercialChangeApplication` CHECKs widened additively for CONVERSION. | No |

## 5. HALT check

- **Any resolution path through SQL or a local edit that implies Stripe changed:** none in this design. Every Stripe-side change is a C1 durable command confirmed only by applied provider state; the governed row ends only in the transaction that applies a provider-confirmed sending subscription; no script, route or SQL path ends or re-points a governed row (C-15). No HALT.
- **Code vs instruments:** no contradiction found. The baseline lacks the post-A6 rulings in its `decisions.md` copy (drift, read from the program branch).
- **Correction-1 trigger (§2.4):** none. The release-expiry value (DR-C2-2), the proration of an immediate cancel (DR-C2-1) and mid-period usage (DR-C2-3) are recorded as typed decision requests and fail closed; no commercial decision is taken here.
- **Production hold (C-26…C-28):** no checkout enablement, no `STRIPE_*` default, no env var added. Tests use a fake Stripe; no key, no network.

## 6. Expected overlap with parallel slices (for the lead)

`libs/subscription/prisma/schema.prisma`, `src/index.ts`, `subscription.module.ts`, `commercial-change-request.ts` (payload switch, `canTransitionFor`), `subscription-lifecycle.service.ts`, the guard function (A8, A6-R, B5 branches), `ccp-a9-role-change.spec.ts` (A9-U-4), `openapi/platform.yaml`, `ci/config/api-surface-manifest.json`, `platform.module.ts`, the platform-web consumer and `verify-platform-admin.ts`, `doc/generated/repo-map.*`. Migration `20261026060000` sorts after C1's `20261026020000`.
