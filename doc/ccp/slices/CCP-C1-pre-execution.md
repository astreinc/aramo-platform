# CCP-C1 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §2.3 and §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-C1: Stripe command outbox + webhook inbox |
| **Schedule row** | PBD §5.2, row C1 (binding) |
| **Branch / baseline** | `wip/ccp-c1` at program HEAD `078d4f78` ("Merge CCP-A6 … into the program branch"). Working tree clean at start. |
| **Drift since the previous slice** | None. A6 is the head commit's merge; C1 starts on it. Seven other slices (B1, B2, B5, D1, A7, A8, B4) run in parallel worktrees; any overlap is a merge item for the lead (§6 below). |

## 1. Governing instruments (SHA-256 re-verified against the `.sha256` sidecars: MATCH)

| Instrument | SHA-256 |
|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` |
| `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` ("Conv.") | `040c90ee4f64a55b4ac583b6323b5853842e6547b6207081d8e81d9197866478` |
| `Aramo-CCP-Program-Charter-v1_0-LOCKED.md` | `82d328eb11b586eb0df5d183d9c88c6899053c9257be7b5245f77e212c54b788` |

Clauses relied on (verbatim, `path:line` in OneDrive `Aramo/locked`):
- PBD `:91` (§5.2 row C1): "**In:** durable, idempotent Stripe commands (key from change request + step); webhook inbox; reconciliation by verified webhook or provider re-fetch; operator-visible failure states (Conv. C-22, C-23). **Out:** live Stripe; credits, refunds and discounts (C4); conversion workflow (C2)".
- Conv. `:194` C-22: "**Stripe-owned operations** SHALL be durable commands with an idempotency key derived from the change request and step, and SHALL be reconciled by the verified webhook or a provider re-fetch. They are never part of a local DB transaction."
- Conv. `:195` C-23: "An external financial change MUST NOT be reported as committed on local commit alone. … Until the provider-confirmed state is applied, the request and the affected subscription SHALL show a pending-provider state."
- Conv. `:147` C-13 (self-service → governed): ending the Stripe-owned row is a durable command; the governed row opens only after the provider-confirmed end. (C2 consumes C1 for this.)
- Conv. `:175` C-17: a C-16 conflict is disposed by "expire the provider session through a governed Stripe command" (C1 supplies that command).
- Charter `:25` §1.3 ("External commands SHALL use durable asynchronous coordination") and `:97` ("External Stripe operations | Durable command (outbox) plus inbox (webhook) | SHALL NEVER be part of a local DB transaction").
- PBD §7.3 / Conv. C-26…C-28: the production release hold. C1 changes no switch, adds no env default that enables billing, and uses no live key.

## 2. Prerequisites (PBD §5.2 C1 row: "A6 evidence")

| Prerequisite | Evidence |
|---|---|
| A6 acceptance recorded | `doc/ccp/slices/CCP-A6-acceptance.md` (present at `078d4f78`; A6 merged by the lead with TD-A6-25/26 fixes, `doc/ccp/decisions.md` "A6 merge") |
| A6 hold semantics C1 must preserve | `CCP-A6-acceptance.md` §2 and §4: G1 refuses Stripe-owned operations (`STRIPE_OWNED`); the shared lock `takeBillingLock` (`libs/subscription/src/lib/billing/governed-subscription.ts:17-19`); webhook-time hold with the `governed_subscription_open` flag (`subscription-lifecycle.service.ts:682-693`) |

## 3. `path:line` re-verification (at `078d4f78`)

| Fact | Location |
|---|---|
| Webhook dedupe is `BillingEvent` (provider, provider_event_id); a provider failure records nothing ("the redelivery retries") | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:598-628` |
| Every sync re-fetches the provider subscription (never trusts the payload) | `subscription-lifecycle.service.ts:631-635` |
| Provider state is applied under the billing lock in one local transaction | `subscription-lifecycle.service.ts:663-695` |
| The external re-fetch runs outside that transaction (`syncSubscription` fetches, then `applyProviderState` opens the tx) | `subscription-lifecycle.service.ts:633-634`, `:663` |
| An ended subscription is never reopened | `subscription-lifecycle.service.ts:747-750` |
| Provider HTTP: GET/POST only; idempotency-key header supported; every error is `BillingProviderUnavailableError` | `libs/subscription/src/lib/billing/stripe-billing.provider.ts:126-151` |
| The port (no cancel / expire / session read today) | `libs/subscription/src/lib/billing/billing-provider.port.ts:79-94` |
| Vocabulary exemption is `stripe-wire.ts` only | `stripe-wire.ts:1-8`; Charter `:240` |
| Webhook route verifies the signature, then `handleEvent`; failures propagate (5xx) so Stripe redelivers | `apps/sign-service/src/app/billing/esign-billing.controller.ts:257-284` |
| Reconcile worker pattern, opt-in env flag | `apps/sign-service/src/app/billing/esign-billing-reconcile.worker.ts:26-31`; `docker-compose.prod.yml:472-473`; `.env.prod.example:336-344` |
| `platform:billing:read` is catalog-only (ACTIVE_RESERVED), held by platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; not catalog_manager, not super_admin | `ci/scripts/verify-orphan-scopes.ts:104`; `libs/subscription/src/tests/support/ccp-a3-database.ts:40-46` |
| `CONVERSION` is in the closed action set; its payload schema is owned by the applying slice (C2) | `libs/subscription/src/lib/commercial/commercial-change-request.ts:41`, `:75`, `:329-333` |
| CheckoutIntent status CHECK includes `EXPIRED` | `libs/subscription/prisma/schema.prisma:271` ("// CHECK: CREATED \| COMPLETED \| EXPIRED"); `libs/subscription/prisma/migrations/20261019100000_subscription_lifecycle_billing/migration.sql:56` |

## 4. Choices the schedule leaves to this record

| ID | Choice | Needs confirmation? |
|---|---|---|
| **C1-D1** | **A separate command table, not new request states.** `subscription."BillingProviderCommand"` carries the pending-provider state. `guard_commercial_change_request()` (`20261025200000_ccp_a6_transactional_apply`), `canTransitionFor` and A9-U-4 are **not changed**. C2 links a request to its commands (`change_request_id`). | No (instructed preference) |
| **C1-D2** | **Closed command kinds:** `SUBSCRIPTION_CANCEL` (params `mode`: `IMMEDIATE` \| `AT_PERIOD_END`) and `CHECKOUT_SESSION_EXPIRE` (C-17 disposition). **Not in C1:** a price change (needs a proration decision: Charter L3, T8 usage rule), credits, refunds and discounts (C4). C1 does not choose which cancel mode a conversion uses (C2 / PO). | Mode choice is C2's |
| **C1-D3** | **Idempotency key** = `aramo-ccp-<change_request_id>-<step>`, enforced by a DB CHECK (derived, not free text), `UNIQUE(change_request_id, step)` and `UNIQUE(idempotency_key)`. The same key is sent to the provider on every attempt (Stripe idempotency). `step` is a snake_case key chosen by the issuing slice. | No |
| **C1-D4** | **Enqueue gate:** the request exists, is `APPROVED`, `APPLYING` or `APPLY_FAILED` (a completed approval chain; DB trigger backstop), its action type is a command-issuing action (`CONVERSION` in C1; C4 widens to CREDIT / DISCOUNT), and tenant and product match. The target must belong to the tenant: a Stripe-linked SELF_SERVICE row or a held activation's open flag (cancel); a `CREATED` CheckoutIntent with that session (expire). The enqueue is a local INSERT and may run inside the caller's transaction (outbox). | No |
| **C1-D5** | **State machine:** `PENDING → DISPATCHING → PENDING_PROVIDER → CONFIRMED`; `DISPATCHING → RETRY_WAIT` (transient, backoff) `→ DISPATCHING`; `DISPATCHING → FAILED` (permanent, or retries exhausted); `FAILED → PENDING` (explicit retry); a confirming provider state moves any non-terminal state or `FAILED` to `CONFIRMED`. An expired DISPATCHING lease is re-claimable. `CONFIRMED` is terminal. DELETE rejected; identity columns immutable (trigger). No dropped/cancelled state: a command is never discarded. | No |
| **C1-D6** | **No provider call inside a local transaction.** Claim = one autocommit `UPDATE … FOR UPDATE SKIP LOCKED` statement; the provider call runs with no transaction open; the outcome is recorded with a fenced UPDATE (`attempts` = the claimed attempt). The test fake asserts, on every provider call, that no backend of the test database is `idle in transaction` and that the command row is not locked. | No |
| **C1-D7** | **Confirmation** is written in the SAME local transaction that applies the provider state (under the billing lock), so `CONFIRMED` exists only once the confirming state is applied: subscription commands in `applyProviderState`; session commands in a new `syncCheckoutSession` (the CheckoutIntent moves `CREATED → EXPIRED` when the provider reports the session expired). Source `WEBHOOK` (inbox) or `REFETCH` (worker). | No |
| **C1-D8** | **Webhook inbox:** `subscription."BillingWebhookInbox"` stores the verified envelope only (event id, type, created, subscription / session ref; never the raw payload). Receipt is durable before processing; processing is claimed with a lease; a failure is recorded `FAILED` (and still returns 5xx so Stripe redelivers); a drainer retries with backoff; `BillingEvent` stays the outcome evidence and the dedupe. A6's hold runs unchanged inside it. | No |
| **C1-D9** | **Operator read surface:** `GET /platform/commercial/billing-commands` and `GET /platform/commercial/billing-webhook-inbox` under `platform:billing:read` (moves from ACTIVE_RESERVED to literally enforced). Read-only (PLATFORM-UX-1 A1-2: no console mutation; the retry is a service method, D5 runbook). | No |
| **C1-D10** | **Worker:** `EsignBillingCommandWorker` in sign-service, off by default (`SIGN_BILLING_COMMANDS_ENABLED=1` to enable; `SIGN_BILLING_COMMANDS_INTERVAL_MS`, floor 10 s). Each tick: dispatch due commands, re-fetch pending-provider targets, drain the inbox. Wired through `docker-compose.prod.yml`, `.env.prod.example`, `.env.example`. | No |
| **C1-D11** | **A separate provider port** for commands (`BILLING_PROVIDER_COMMAND_PORT`: cancel, expire, session read), bound to the existing `StripeBillingProvider` (`useExisting`). The six existing test fakes of `BillingProviderPort` are untouched. Provider errors gain an optional `retryable` flag (4xx = permanent; 429, 5xx, network = transient); existing callers ignore it. No new Stripe field name is needed (no `stripe-wire.ts` change). | No |

## 5. HALT check

- **External call inside a local transaction:** not needed by this design (C1-D6). No HALT.
- **Live key:** none used; tests use an in-process fake provider, no network. `STRIPE_*` env untouched; no default enables billing. No HALT.
- **Correction-1 trigger (§2.4):** none. The cancel mode used by a conversion and any price-change command are commercial decisions left to C2 / a later ruling, not taken here.
- **`guard_commercial_change_request()`:** not changed (C1-D1).

## 6. Expected overlap with parallel slices (for the lead)

`libs/subscription/prisma/schema.prisma`, `libs/subscription/src/index.ts`, `subscription.module.ts`, `openapi/platform.yaml`, `ci/config/api-surface-manifest.json`, `ci/scripts/verify-orphan-scopes.ts` (`platform:billing:read`), `pact/consumers/platform-web-consumer`, `pact/provider/src/verify-platform-admin.ts`, `apps/platform-admin/src/app/platform/platform.module.ts`, `doc/generated/repo-map.*`.
