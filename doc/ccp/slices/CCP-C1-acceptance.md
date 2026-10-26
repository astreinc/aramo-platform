# CCP-C1 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C1 row. Governing instruments: the Conversion Rule `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED` (C-22, C-23; C-13 and C-17 as consumers), the Charter (§1.3, §3 "External Stripe operations"), and the A6 hold semantics (`doc/ccp/slices/CCP-A6-acceptance.md`).

| | |
|---|---|
| **Slice** | CCP-C1: Stripe command outbox + webhook inbox |
| **Branch / baseline** | `wip/ccp-c1` at `078d4f78` (program HEAD after the A6 merge) |
| **Pre-execution record** | `doc/ccp/slices/CCP-C1-pre-execution.md` (choices C1-D1…C1-D11) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** No design step needs an external call inside a local transaction (proved by C1-TX-1/C1-TX-2). No live key is used anywhere; the dispatcher refuses a live-mode key (C1-LIVE-1). |
| **`guard_commercial_change_request()`** | **Not changed.** The pending-provider state lives on the new command table (C1-D1). `canTransitionFor` and A9-U-4 are unchanged. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| C1-0 | `CCP-C1: pre-execution check` | `doc/ccp/slices/CCP-C1-pre-execution.md` |
| C1-1 | `CCP-C1: command outbox and webhook inbox tables (migration + Prisma models)` | `libs/subscription/prisma/migrations/20261026020000_ccp_c1_stripe_command_inbox/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| C1-2 | `CCP-C1: the provider command port (cancel, expire, session read) on the Stripe adapter; retryable provider errors` | `libs/subscription/src/lib/billing/billing-provider.port.ts`; `libs/subscription/src/lib/billing/stripe-billing.provider.ts` |
| C1-3 | `CCP-C1: command outbox and webhook inbox services; confirmation in the applying transaction` | `libs/subscription/src/lib/billing/billing-provider-command.ts`, `billing-command.service.ts`, `billing-webhook-inbox.service.ts` (new); `subscription-lifecycle.service.ts`; `subscription.module.ts`; `src/index.ts` |
| C1-4 | `CCP-C1: sign-service webhook through the inbox; command worker (off by default) and its env wiring` | `apps/sign-service/src/app/billing/esign-billing-command.worker.ts` (new); `esign-billing.controller.ts`; `app.module.ts`; `docker-compose.prod.yml`; `.env.prod.example`; `.env.example` |
| C1-5 | `CCP-C1: read-only billing-operations routes, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-billing.controller.ts`, `dto/commercial-billing.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `ci/scripts/verify-orphan-scopes.ts` |
| C1-6 | `CCP-C1: tests (outbox, inbox, hold through the inbox, adapter, worker, per-role routes) and the shared helper` | `libs/subscription/src/tests/ccp-c1-command-inbox.integration.spec.ts`, `ccp-c1-stripe-commands.spec.ts`, `support/ccp-c1.ts`; `apps/sign-service/src/tests/ccp-c1-billing-commands.spec.ts`; `apps/platform-admin/src/tests/ccp-c1-billing-operations-authorization.spec.ts` (all new) |
| C1-7 | `CCP-C1: Pact — billing-operations routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| C1-8 | `CCP-C1: acceptance evidence` + `CCP-C1: regenerate repo map` | `doc/ccp/slices/CCP-C1-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **14 new files, 20 modified files (34 paths)**; `git diff --stat` over the modified files: 1039 insertions, 48 deletions. **Unchanged:** every existing migration; every existing spec file; `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `pact/provider/src/verify-sign.ts` (no sign-service shape changed); `stripe-wire.ts` (no new Stripe field name, no new vocabulary exemption); `doc/ccp/decisions.md`; checkout availability, `STRIPE_*` env and every billing default.

## 2. Design as implemented

**Command outbox** (`BillingProviderCommand`, `BillingCommandService`):
- **Enqueue** is a local INSERT. It can run inside the caller's transaction (the outbox, C1-ENQ-3) and takes the shared `billing:<tenant>` lock. The key is `(change_request_id, step)`. `idempotency_key` = `aramo-ccp-<change_request_id>-<step>`, enforced by a DB CHECK and two UNIQUE indexes (C-22).
- **Refused at enqueue:**
  - a request that has not completed its approval chain (service check and DB trigger);
  - a non-command action (C1: `CONVERSION` only);
  - another tenant or product;
  - a target the tenant does not own. A cancel targets an open SELF_SERVICE row, or a held activation's open flag. An expire targets a `CREATED` CheckoutIntent's session. A governed (MANUAL) row is never a target.
- **Dispatch:**
  - The claim is ONE autocommit `UPDATE … FOR UPDATE SKIP LOCKED` with a 5-minute lease.
  - The provider call runs with no local transaction open. It is preceded by a provider re-read: a tenant mismatch refuses; an operation already in effect is not repeated.
  - The outcome is recorded with an UPDATE fenced on `attempts`.
  - Accepted → `PENDING_PROVIDER`. Transient failure (network, 429, 5xx) → `RETRY_WAIT` with backoff (1, 2, 4 … minutes, cap 6 h), then `FAILED RETRIES_EXHAUSTED` after 8 attempts. A provider refusal (4xx) or a pre-call refusal → `FAILED` at once.
  - `FAILED → PENDING` is the explicit retry (`retryFailed`). DELETE is rejected at the DB, so a command is never dropped.
- **Confirmation (C-23):** `CONFIRMED` is written only inside the transaction that **applies** the provider-confirmed state, under the billing lock:
  - `applyProviderState` for `SUBSCRIPTION_CANCEL` (IMMEDIATE: the provider end; AT_PERIOD_END: the schedule or the end);
  - `syncCheckoutSession` for `CHECKOUT_SESSION_EXPIRE`.

  That state arrives by verified webhook (source `WEBHOOK`, with the event id) or by provider re-fetch (`reconcilePending`, source `REFETCH`). Nothing is confirmed on a command's own commit.

**Webhook inbox** (`BillingWebhookInbox`, `BillingWebhookInboxService`):
- The verified envelope (never the payload) is stored before processing, claimed with a lease, and processed through the unchanged `handleEvent`. That keeps the A6 hold, the `BillingEvent` dedupe and outcome evidence, and the confirmation.
- A failure is recorded `FAILED` and rethrown, so the route still answers 5xx and Stripe redelivers.
- A second delivery of a `PROCESSED` event, or one under a live `PROCESSING` lease, answers `DUPLICATE` without processing.
- The drain re-processes `RECEIVED` crash leftovers, due `FAILED` rows (up to 10 automatic attempts) and expired leases.

**Worker** `EsignBillingCommandWorker`:
- It runs only with `SIGN_BILLING_COMMANDS_ENABLED=1` (default off; interval `SIGN_BILLING_COMMANDS_INTERVAL_MS`, default 60 s, floor 10 s).
- Each tick: dispatch → re-fetch pending → drain the inbox. A subscribing owner is activated as the webhook route does.
- With no key it does nothing; with a live-mode key it dispatches nothing.

**Operator read surface:** `GET /platform/commercial/billing-commands` (filters: state, tenant_id, change_request_id; keyset cursor) and `GET /platform/commercial/billing-webhook-inbox` (status; cursor). Both are under `platform:billing:read` and read-only. Each command carries `pending_provider` (true until CONFIRMED) and `failure {code, detail}`.

## 3. Command and inbox test outputs (real Postgres 17, fake Stripe, no network, no key)

`libs/subscription/src/tests/ccp-c1-command-inbox.integration.spec.ts`: **23 / 23 passed** (run 3, after the Docker restart; 44.85 s).

| PBD C1 mandatory test / obligation | Test ID | Output |
|---|---|---|
| **No Stripe call inside a local DB transaction** | C1-TX-1, C1-TX-2 | On EVERY provider call across the spec (subscription and session reads, cancel, expire; from dispatch, re-fetch and inbox), the fake's probe saw **0 backends with an open transaction** (`pg_stat_activity.xact_start`) and **no locked command row** (`FOR UPDATE NOWAIT`). `violations = []`; probes > 40 (asserted). |
| **Duplicate webhooks idempotent** | C1-INBOX-1 | 2nd delivery → `DUPLICATE`; 1 inbox row `PROCESSED`, attempts 1; 1 `BillingEvent`; no 2nd re-fetch; row JSON unchanged |
| (concurrent duplicates) | C1-INBOX-2 | 5 concurrent deliveries of one event: 1 `APPLIED`, 4 `DUPLICATE`; 1 SELF_SERVICE row; 1 `BillingEvent`; intent `COMPLETED`; inbox attempts 1 |
| **Out-of-order webhooks idempotent** | C1-INBOX-3 | the newer "deleted" event first → `ACTIVE -> CANCELED`, command CONFIRMED; the older event later → `IGNORED "subscription already ended"`, row byte-identical, never reopened, `confirmed_at` unchanged; a state-changing reorder (past_due applied first, then an older paid event) re-fetches the CURRENT state: `PAST_DUE -> PAST_DUE`, no regression |
| **Retry after transient failure** | C1-RETRY-1 | 503 twice: `RETRY_WAIT` attempts 1, `next_attempt_at` = +1 min; not re-claimed 1 ms before due; attempts 2, +2 min; then `PENDING_PROVIDER` attempts 3; the SAME idempotency key on all 3 provider calls |
| **Failed commands visible** (never dropped) | C1-FAIL-1 | transient forever → `FAILED RETRIES_EXHAUSTED` after 8 attempts (8 provider calls); a 4xx → `FAILED PROVIDER_REFUSED` after 1; both in `list({state: FAILED})`; DELETE refused ("never deleted"); not re-dispatched automatically; `retryFailed` → `PENDING` (attempts kept), a 2nd retry → `NOT_FAILED`; then `PENDING_PROVIDER` attempts 2 |
| **Pending-provider until the confirming event is applied** | C1-PEND-1 | after dispatch: provider cancelled, command `PENDING_PROVIDER` attempts 1, `confirmed_at` null, local row still open (`[SELF_SERVICE]`); a 2nd dispatch makes no 2nd call; the verified webhook through the inbox → `ACTIVE -> CANCELED`, command `CONFIRMED`, source `WEBHOOK`, event id recorded, `confirmed_at` = the row's `ended_at` (same transaction) |
| (reconciliation by re-fetch) | C1-PEND-2 | no webhook: `reconcilePending` → `CONFIRMED`, source `REFETCH`; AT_PERIOD_END: row `cancel_at_period_end = true`, `ended_at` null |
| Conv. C-17 disposition (expire) | C1-SESS-1, C1-SESS-2 | expire accepted → `PENDING_PROVIDER`, intent still `CREATED`; `checkout.session.expired` through the inbox → `APPLIED "checkout session expired; intent EXPIRED; 1 command(s) confirmed"`, intent `EXPIRED`, command CONFIRMED (WEBHOOK); a completed session → `FAILED SESSION_COMPLETED`, 0 expire calls |
| Enqueue rules | C1-ENQ-1, C1-ENQ-2, C1-ENQ-3 | key derived; replay returns the same command; a different command on the same step → `IDEMPOTENCY_CONFLICT`; a free-text key → `BillingProviderCommand_idempotency_key_check`; refusals `CHANGE_REQUEST_NOT_APPROVED` (and the DB trigger "needs a completed approval chain"), `ACTION_NOT_COMMAND_ISSUING` (SUBSCRIPTION_END), `TENANT_PRODUCT_MISMATCH`, `TARGET_NOT_FOUND` (another tenant's subscription; a MANUAL row), 0 commands written; the outbox row rolls back with the caller's transaction and commits with it |
| Tenant isolation at the provider | C1-FAIL-2 | provider metadata names another tenant → `FAILED TENANT_MISMATCH`, 0 cancel calls |
| Crash recovery (commands) | C1-LEASE-1 | DISPATCHING with a live lease is not re-claimed; after expiry it is re-claimed (attempts 2) and accepted; the crashed attempt's late fenced update affects 0 rows |
| DB state machine | C1-SM-DB | `PENDING → PENDING_PROVIDER` refused; a skipped attempt count refused; `target_ref` / `params` edits refused (immutable); `CONFIRMED` terminal; an INSERT outside PENDING refused |
| Production hold | C1-LIVE-1 | live-mode provider → `skipped: LIVE_MODE`, command `PENDING` attempts 0, 0 calls |
| Inbox failure / recovery | C1-INBOX-4, C1-INBOX-5 | re-fetch failure → inbox `FAILED` attempts 1, `next_attempt_at` +1 min, error kept, 0 `BillingEvent`, listed under `status=FAILED`, rethrown (5xx); drain skips it before due, processes it after (`PROCESSED APPLIED`, attempts 2); a redelivery then → `DUPLICATE`. A `RECEIVED` crash leftover is drained; a live `PROCESSING` lease is left until it expires, then processed (attempts 2); PROCESSED terminal, envelope immutable, DELETE refused |
| Operator list | C1-LIST-1 | newest first; filters by tenant / change request; the cursor pages (1 + 1) and is refused under other filters |

**A6 hold through the inbox** (required):

| Test | Output |
|---|---|
| **C1-HOLD-1** | the A6-H-W1 scenario delivered through `inbox.receive`: `IGNORED` "governed_subscription_open: held for reconciliation…"; inbox `PROCESSED IGNORED` with the hold named; `BillingEvent IGNORED`; 1 open flag `governed_subscription_open`; intent `CREATED`; governed row byte-identical; open rows `[MANUAL]`. A redelivery → `DUPLICATE`; a drain 60 minutes later changes nothing (same flag, intent, row, open rows). |
| **C1-HOLD-2** | a held activation's live provider subscription, cancelled by a durable command under an APPROVED CONVERSION request: `PENDING_PROVIDER`, the flag **stays open** on local commit; the webhook-confirmed end → flag resolved (Conv. C-9), command CONFIRMED (event id), governed row byte-identical, open rows `[MANUAL]`, no SELF_SERVICE row, intent `CREATED`. (This is one C-9 resolution route; the C-29 / PBD §7.2 proof through the C2 conversion is C2's.) |

`libs/subscription/src/tests/ccp-c1-stripe-commands.spec.ts`: **10 / 10 passed**. These are unit tests:
- C1-U-1: TS state table = exactly 12 of 36 pairs, mirroring the DB trigger.
- C1-U-2: derived key.
- C1-U-3: backoff.
- C1-U-4: confirmation rule.
- C1-U-5: session envelope mapping.
- C1-U-6…U-9: the Stripe adapter against a 127.0.0.1 stand-in with a `sk_test_` placeholder. IMMEDIATE = DELETE and AT_PERIOD_END = POST `cancel_at_period_end=true`, both with the command key; expire = POST `…/expire` with the key; 4xx not retryable, 429/503/network retryable; `checkout_session_ref` present only on `checkout.session.*` events, so the pre-C1 envelope is unchanged.
- C1-U-10: `SubscriptionModule` and `.forRoot()` bind the command port into the lifecycle and provide both services.

`apps/sign-service/src/tests/ccp-c1-billing-commands.spec.ts`: **5 / 5 passed**:
- C1-S-1: the webhook goes through the inbox, never directly to the lifecycle, and the owner is activated.
- C1-S-2: an inbox failure is still 503; a forged event never reaches the inbox.
- C1-S-3, C1-S-4: the worker is off unless `=1`; no timer is started without the flag.
- C1-S-5: one tick runs dispatch, re-fetch and drain, activates the owner, and a failing tick never throws.

## 4. Routes, Pact and gates

| Run | Result |
|---|---|
| `apps/platform-admin/src/tests/ccp-c1-billing-operations-authorization.spec.ts` (real JwtAuthGuard + RolesGuard) | **18 / 18**. Both routes: allowed 200 for platform_owner, finance_admin, commercial_ops, support_admin and read_only_auditor (a FAILED command visible, `pending_provider: true`); refused 403 `missing_scopes [platform:billing:read]` for catalog_manager and super_admin; 401 with no token; 403 for a tenant-tier token; filters typed; 7 × 400 `VALIDATION_ERROR`; 400 `invalid_cursor` from both services. (The first run under load had 10 hook-timeout failures; the re-run alone passed 18 / 18.) |
| Consumer `platform-web-consumer` | **45 interactions** (A6 recorded 37; +8): commands allowed 200 (FAILED list), inbox allowed 200, catalog_manager 403 × 2, super_admin 403 × 2, tenant tier 403 × 2 |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`, after the Docker restart) | **2 / 2 provider tests passed**: the CCP route coverage gate (now including the 2 C1 routes) and the verification of all 45 interactions. New states: `a failed billing command exists`, `a failed billing webhook event exists`. The first run after the restart failed one state handler (a SQL parameter typed two ways); fixed with a cast; re-run green. |
| Consumer vs provider counts (A10: reported separately) | 45 consumer interactions; 45 verified by the platform-admin provider |
| `contract-parity:check` | 680 live routes (678 governed), 511 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (A6: 678 / 676 / 509; +2 / +2 / +2) |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (equal to the A6 baseline) |
| `orphan-scopes:check` | ok. `platform:billing:read` moves from ACTIVE_RESERVED to literally enforced (entry removed); 2 read reservations remain |
| `env:passthrough-check` | ok (109 passthrough + 3 required-interp + 2 guarded; the 2 new vars are documented passthroughs) |
| `error-codes:check`, `tests:integration:check` | ok (no new error code; 49 integration roots) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok. Run under a temporary `GIT_INDEX_FILE` with intent-to-add entries (real index untouched) |
| ESLint on every changed or new `.ts` | 0 errors, 12 warnings: non-null assertions in test files, plus 1 pre-existing unused-disable in `verify-platform-admin.ts:19` |
| `nx run-many -t build -p subscription sign-service platform-admin --skip-nx-cache` | 3 projects + 29 dependency tasks succeeded; dist markers checked (`BillingCommandService` in `dist/libs/subscription/src/index.d.ts`; the wired-port confirmation in the dist lifecycle) |
| `bash scripts/verify-vocabulary.sh` | OK: Tier 1, Tier 2 and front-door clean. No exemption touched; the `stripe-wire.ts` exemption is unchanged and unused. The write hook flagged one Tier-2 token (a Stripe event-type string in a test) during authoring; it was replaced with a neutral event name before any gate run |

## 5. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription`, whole lib, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2` (23 files) | First full run: 425 / 456. The 31 failures were in 3 pre-C1 specs that pin a narrowed schema (up to A5, no A3) and so lack the command table. Fixed in code, not in the specs (TD-C1-6). Re-run of those 3 files + the C1 spec: 91 / 92; the 1 failure was a 30 s timeout on the 150-send loop under load. That file re-run alone: **14 / 14**. The other 20 files passed in the full run. |
| `apps/sign-service`: `billing.spec`, `ccp-c1-billing-commands.spec`, `personal-free.integration`, `sign-account.integration`, `sign-legal.integration`, `storage-quota.spec` | **6 files, 49 / 49** |
| `apps/sign-service` `ccp-a4-ats-sign-consumption.integration` (ATS-triggered Sign consumption golden) | **3 / 3** (equal) |
| `apps/platform-admin`: C1, A6 apply-routes, A3 routes, A1 role authorization, A2 audit authorization | **5 files, 167 / 167** |
| **Not run:** the full `nx run api` (instructed); `verify-sign`, `verify-api`, `verify.ts`, `verify-ti.ts` Pact providers (no sign-service or apps/api returned shape changed; the webhook response is unchanged); `apps/platform-web` / `sign-web` (backend-only slice) | — |

**Run conditions.** The Docker daemon was hung from about 08:50 (HTTP 500). The integration and Pact results above are all from runs after the lead restarted it. Load averages during the runs were 38 to 58.

## 6. Recovery and rollback

- Commands are retryable: automatic backoff, then `retryFailed`. Failed commands are surfaced on the read route and never dropped (DB rejects DELETE). Inbox failures are retried by provider redelivery and by the drain.
- The worker can be disabled with `SIGN_BILLING_COMMANDS_ENABLED` unset. That stops dispatch and draining; the webhook route still records and processes inline.
- Code: revert C1-1…C1-7.
- **Compensating migration** (documented, not shipped; never run against production, PBD §7.5), in one transaction:
  ```sql
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM subscription."BillingProviderCommand" WHERE state <> 'CONFIRMED')
       OR EXISTS (SELECT 1 FROM subscription."BillingWebhookInbox" WHERE status <> 'PROCESSED') THEN
      RAISE EXCEPTION 'CCP-C1 compensation refused: an unconfirmed command or an unprocessed inbox event exists';
    END IF;
  END $$;
  DROP TRIGGER "billing_provider_command_guard" ON subscription."BillingProviderCommand";
  DROP TABLE subscription."BillingProviderCommand";
  DROP FUNCTION subscription."guard_billing_provider_command"();
  DROP TRIGGER "billing_webhook_inbox_guard" ON subscription."BillingWebhookInbox";
  DROP TABLE subscription."BillingWebhookInbox";
  DROP FUNCTION subscription."guard_billing_webhook_inbox"();
  ```
  The confirmed command and processed inbox history is dropped with the tables. Export both tables first if that evidence must be kept: `BillingEvent` keeps the event outcomes, but not the command history.

## 7. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-C1-1 | Design choice | A separate command table carries pending-provider; no new change-request state; `guard_commercial_change_request()`, `canTransitionFor` and A9-U-4 untouched (C1-D1) | Recorded (instructed preference) |
| TD-C1-2 | Scope | Closed kinds `SUBSCRIPTION_CANCEL` (IMMEDIATE / AT_PERIOD_END) and `CHECKOUT_SESSION_EXPIRE`. A **price-change** command is not built: it needs a proration decision (Charter L3; T8 forbids an unruled usage treatment). Credits, refunds and discounts are C4 | **Price change needs a ruling** before any slice adds it |
| **TD-C1-3** | Fail-closed choice | The dispatcher refuses a live-mode key (`skipped: LIVE_MODE`; commands stay PENDING, visible). It enforces "Out: live Stripe" and the §7.3 hold, but **must be lifted** by the live-billing release authorization | **For the PO at live release** |
| **TD-C1-4** | Behaviour change | A verified `checkout.session.expired` event now re-fetches the session and, when it is expired, moves its `CREATED` CheckoutIntent to `EXPIRED` (the CHECK value existed and was never written). This applies to every expired session, not only command-driven ones; before C1 such events were `IGNORED`. It mirrors provider state and makes the C-16(a) count exact | **Needs PO / Architect confirmation** (self-service regression obligation) |
| TD-C1-5 | Provider semantics | IMMEDIATE cancel is the provider DELETE, which ignores the idempotency header. Idempotency comes from the pre-dispatch re-read (an end already in effect is not repeated), the DELETE semantics, and confirmation by applied state. No proration or invoice parameters are sent: provider defaults apply, so there is **no prorated credit** on an immediate cancel | Mode and credit treatment per conversion: **C2 / C4 / PO** |
| TD-C1-6 | Wiring | Confirmation runs only in a lifecycle wired with the command port. `SubscriptionModule` and `.forRoot()` always bind it (C1-U-10), and commands are dispatched only through it. An unwired lifecycle never confirms, so a command stays pending-provider: fail-safe for C-23. This keeps the pre-C1 specs that pin a narrowed schema (no A3) unchanged | Recorded |
| TD-C1-7 | Gap | No console retry route (PLATFORM-UX-1 A1-2). `retryFailed` is a service method with no `CommercialAuditEvent` row | **D5 runbook / D3** to own the operator retry and its audit |
| TD-C1-8 | Scope boundary | The enqueue gate admits `CONVERSION` only (TS constant + DB trigger). C4 must widen both for CREDIT / DISCOUNT | For C4 |
| **TD-C1-9** | Partial (C-23) | Pending-provider is shown on the command (`pending_provider`, state) and readable per request (`forChangeRequest`). Showing it on **the change request and the affected subscription** (account view, workbench) is not built | **For C2 (request) and B3 (subscription view)** |
| TD-C1-10 | Gap | A `PENDING_PROVIDER` command whose effect never appears (for example, an AT_PERIOD_END cancel reverted at the provider) stays pending indefinitely; no expiry or alert | For D3 (observability) |
| TD-C1-11 | Gap | No retention or purge for inbox rows (or `BillingEvent`) | Retention ruling |
| TD-C1-12 | Choice | The re-fetch reconciliation also probes `FAILED` commands (an effect already present confirms them; FAILED → CONFIRMED is allowed). Bounded at 50 per tick | Recorded |
| TD-C1-13 | Choice | Automatic inbox drain stops after 10 attempts; provider redelivery can always retry; rows stay `FAILED` and visible | Recorded |
| TD-C1-14 | Contract addition | `VerifiedBillingEvent.checkout_session_ref` (optional; present only for `checkout.session.*`) and `BillingProviderUnavailableError.retryable` (default true). Existing callers and fakes are unchanged; a separate `BILLING_PROVIDER_COMMAND_PORT` leaves the 6 existing `BillingProviderPort` fakes untouched | Recorded |
| TD-C1-15 | Scope reading | `platform:billing:read` is now enforced by the C1 operations views. Its A1 reservation text named "billing status read routes (C3/C4)" | **Confirm** the scope fits operational views (else a new scope is a catalog change) |
| TD-C1-16 | Test-only | Two raw-SQL fixtures needed a `::uuid` / `::text` cast (one in the spec, one in the Pact provider state); the C1 spec asserts per command because the dispatch queue is shared across tests; the 2 first-run failures came from load and the Docker outage | Recorded |
| TD-C1-17 | Merge note | Expected overlap with the parallel slices: `schema.prisma`, `src/index.ts`, `subscription.module.ts`, `subscription-lifecycle.service.ts` (A7 / A8 may touch it), `openapi/platform.yaml`, `api-surface-manifest.json`, `verify-orphan-scopes.ts`, the platform-web consumer and `verify-platform-admin.ts`, `platform.module.ts`, `doc/generated/repo-map.*`. Migration `20261026020000` must sort after every earlier program migration | For the lead |

No correction-1 trigger (PBD §2.4) arose. Production DB facts are as recorded by A6: one database and one owning role. C1 needs no cross-system transaction: each provider call is outside any transaction by construction.

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: OK. Tier 1, Tier 2 and front-door retirement are clean. No exemption allowlist was touched; the Stripe wire exemption (`stripe-wire.ts`) is unchanged and not used by C1.
