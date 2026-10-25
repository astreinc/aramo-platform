# CCP-C4 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.2 C4 row. Governing instruments: the PBD (§5.2 row C4 `:94`, §6, §7, §10 `:203`/`:208`, §12), the Charter (§6.4 NC-1…NC-5, §7 D5 values), the Conversion Rule (C-22, C-23), Charter Amendment A1 (Apply Deadline, AD-2…AD-8), DDR v1.2 §3.1–§3.2, the A1 role/scope matrix, and the rulings in `doc/ccp/decisions.md` (TD-B2-3 requester-only apply, TD-A3-0 / NC-5, T8, DR-C2-1, the TD-C3-5 Finance amount ruling).

| | |
|---|---|
| **Slice** | CCP-C4: credits, refunds, discounts |
| **Status** | **NOT DELIVERED** (PBD §10: "C4 refunds and credits — Refund policy (legal)"). Built in **Stripe test mode** with the designed disabled states: credits and discounts run end to end against the C1 dispatcher, which refuses a live-mode key (TD-C1-3); REFUND is built and **disabled by design** (`REFUND_POLICY_NOT_APPROVED`) unless `CCP_REFUND_EXECUTION_ENABLED=1`, a flag that defaults off, appears in no compose or `.env*` file, and is set only in tests. |
| **Branch / baseline** | `wip/ccp-c4` at `41a0e3b5` (the integrated program head) |
| **Pre-execution record** | `doc/ccp/slices/CCP-C4-pre-execution.md` (choices C4-D1…C4-D13) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor; no `git stash` used. |
| **HALT conditions hit** | **None.** No money movement without a completed chain: the enqueue gate (service + DB trigger) admits a command only for an APPROVED / APPLYING / APPLY_FAILED request; the dispatcher additionally refuses a C4 command whose request is not APPLYING; the request reaches APPLYING only through its requester's apply after APPROVED (C4-MONEY-1). No external call inside a local transaction (C4-TX-1). No code contradicted an instrument. |
| **Pinned design** | CCP-UI v1.0, `MANIFEST.sha256` → 5 / 5 OK; manifest SHA-256 `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| C4-0 | `CCP-C4: pre-execution check` | `doc/ccp/slices/CCP-C4-pre-execution.md` |
| C4-1 | `CCP-C4: REFUND action type, closed C4 payloads, chains, transition mirror; guard-union and constraint-union CCP-C4 blocks; the C4 migration and Prisma model` | `libs/subscription/src/lib/commercial/commercial-change-request.ts`; `libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/migration.sql`; `…/20261027000100_ccp_constraint_union/migration.sql`; `…/20261028010000_ccp_c4_billing_adjustments/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| C4-2 | `CCP-C4: adjustment command kinds, the adjustment provider port and its Stripe adapter; dispatch, re-read and webhook confirmation` | `libs/subscription/src/lib/billing/billing-provider-command.ts`, `billing-provider.port.ts`, `billing-command.service.ts`, `billing-webhook-inbox.service.ts`, `subscription-lifecycle.service.ts`, `stripe-billing.provider.ts`, `stripe-wire.ts` |
| C4-3 | `CCP-C4: requester-only billing-adjustment apply, the in-transaction completion ledger, explanations, module and exports` | `libs/subscription/src/lib/commercial/commercial-billing-adjustment.ts`, `commercial-billing-adjustment.ledger.ts`, `commercial-billing-adjustment.service.ts` (new); `commercial-apply-records.ts`; `commercial-change-request.service.ts` (`applyActionable`); `libs/subscription/src/lib/subscription.module.ts`; `libs/subscription/src/index.ts` |
| C4-4 | `CCP-C4: billing-adjustment routes (apply + read), Finance amount interim on C4 reads, OpenAPI and manifest` | `apps/platform-admin/src/app/platform/platform-commercial-billing-adjustment.controller.ts`, `dto/commercial-billing-adjustment.dto.ts` (new); `platform-commercial-billing.controller.ts`; `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| C4-5 | `CCP-C4: tests (unit, integration, routes per role), the shared C4 harness, compensating SQL; re-based expectations` | new: `libs/subscription/src/tests/ccp-c4-billing-adjustments.spec.ts`, `ccp-c4-billing-adjustments.integration.spec.ts`, `support/ccp-c4.ts`, `fixtures/ccp-c4-compensating.sql`, `apps/platform-admin/src/tests/ccp-c4-billing-adjustment-routes.integration.spec.ts`; modified: `support/ccp-c1.ts` (probe `protected`), `stripe-wire.spec.ts`, `commercial-approval-eligibility.spec.ts`, `ccp-a9-role-change.spec.ts`, `ccp-a6-apply.integration.spec.ts`, `ccp-a6r-apply-deadline.integration.spec.ts`, `ccp-guard-union.integration.spec.ts`, `ccp-merge-train-compensation.integration.spec.ts`, `fixtures/ccp-guard-union-compensating.sql`, `fixtures/ccp-constraint-union-compensating.sql` |
| C4-6 | `CCP-C4: Pact — billing-adjustment routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| C4-7 | `CCP-C4: the Stripe-side Applying chip (CCP-UI v1.0 §4) with parity, axe and keyboard` | `apps/platform-web/src/commercial/commercial-model.ts`, `ChangeRequestDrawer.tsx`, `commercial-model.spec.ts`; `apps/platform-web/e2e/fixtures/commercial.ts`, `e2e/visual/states-ccp.ts`, `e2e/keyboard/ccp-journeys.spec.ts`; new references `e2e/visual/__screenshots__/ccp-drawer-stripe-sent-{1440,900}.{png,masks.json}` |
| C4-8 | `CCP-C4: acceptance evidence` + `CCP-C4: regenerate repo map` | `doc/ccp/slices/CCP-C4-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **17 new files, 40 modified files (57 paths)**. `git diff --stat` over the 40 modified files (after the final repo-map regeneration): 1570 insertions, 56 deletions. **Unchanged:** every existing migration other than the two integrator-owned union files (labelled `CCP-C4` blocks only); `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `docker-compose.prod.yml`, `.env.example`, `.env.prod.example` (the refund flag is deliberately not wired); `scripts/verify-vocabulary.sh` (no exemption added); `doc/ccp/decisions.md`.

## 2. Design as implemented

**Action types and payloads (C4-D1, C4-D2).** CREDIT and DISCOUNT are the A3 types; **REFUND is added** to the closed set (TD-C4-1). Requester scope `platform:billing:request` (commercial_ops only, A1 `:119`); approve scope `platform:billing:approve` (finance_admin, platform_owner). Closed payload key sets: CREDIT `{amount_minor ≥ 1, currency, subscription_id?, compensates_change_request_id?}`; DISCOUNT `{discount_bps 1…10000, subscription_id?, compensates_change_request_id?}`; REFUND `{amount_minor ≥ 1, currency, provider_invoice_ref, subscription_id?}`.

**Chains (C4-D3).** Resolved once, at creation, from the ACTIVE policy and snapshotted (NC-5): CREDIT ≥ `credit_escalation_threshold_minor` (v1: 50 000 USD minor) and DISCOUNT ≥ `discount_escalation_threshold_bps` (v1: 2 000) → Finance → Owner, else Finance; inclusive (A2-B / TD-A2-2); a non-policy currency escalates (TD-A2-3). REFUND → Finance → Owner always (TD-C4-2). No policy value is a code constant.

**Apply (C4-D4, C4-D5).** `POST /platform/commercial/change-requests/{id}/billing-adjustment`, requester-only (TD-B2-3): user principal, requester scope, actor = `requested_by`; then the refund disabled state; then, under the tenant's billing lock, the lazy apply deadline (AD-7), the NC-5 re-check of every approval under the snapshotted chain, and the target checks. In ONE local transaction: APPROVED → APPLYING and the C1 durable command (outbox). The request **commits in APPLYING** (deferred trigger refuses it without a command). No provider call in the request. The dispatcher (no transaction open) re-reads the provider by command id (never repeats an effect already present; refuses another tenant's object), then writes once with the derived idempotency key `aramo-ccp-<request>-<step>`, recording the provider object (`provider_object_ref`, written once). **APPLIED** is written only in the transaction that applies the provider-confirmed effect — a verified webhook through the inbox (the event's object, or for a discount the subscription event) or a provider re-fetch — together with the command's CONFIRMED and the append-only `CommercialBillingAdjustment` record (`CommercialBillingAdjustmentLedger`). A FAILED command keeps the request APPLYING (`status: COMMAND_FAILED`); the requester's next apply re-arms **the same command** (same key). APPLY_FAILED arises only from a check that fails before any command exists; the guard refuses APPLY_FAILED while a command is unconfirmed (C-23).

**Stripe operations (C4-D6)** — a separate `BILLING_PROVIDER_ADJUSTMENT_PORT` bound to the Stripe adapter (every existing port and fake unchanged): CREDIT → a negative account-balance adjustment (applied to the next invoice); its compensation → the equal positive adjustment; DISCOUNT → a percent-off coupon with the deterministic id `aramo-ccp-<request>-discount_apply`, `duration=once`, attached to the subscription; its compensation → removal of that discount; REFUND → read the invoice (must be paid from the tenant's account), then one refund of its payment. Every write carries `metadata[aramo_command_id]` and `metadata[tenant_id]`.

**Target (C4-D7).** The tenant × product's open SELF_SERVICE base row with a provider account. A governed (MANUAL / contract) row is refused `TARGET_NOT_SELF_SERVICE` (contract invoicing is gated, PBD §10).

**Recovery (C4-D9).** A compensating Stripe command through a NEW change request naming `compensates_change_request_id` (full chain on its own amount; equal amount/currency or bps; at most once, UNIQUE). A refund has no compensation.

**Finance amount interim (C4-D10).** C4 routes return no tenant-specific amount: payload `amount_minor`, the chain basis amounts and the C4 command params' amount are replaced by `amount_withheld: "FINANCE_SCOPE_PENDING"`; the C1 `GET /platform/commercial/billing-commands` read does the same for C4 command kinds; C4 audit bodies carry no amount (C4-PEND-1 asserts it).

**UI (C4-D13).** The one CCP-UI v1.0 element pinned for C4 is built: the drawer stepper's Applying chip reads **"Sent to Stripe — awaiting confirmation"** for a CREDIT, DISCOUNT or REFUND in APPLYING (handoff §4), through B1's `stateSteps(state, action_type)` and the existing `CrStepper`. No credit, discount or refund request dialog, no drawer Apply action and no ApplyStatus panel is built (not pinned; TD-C4-8).

## 3. Mandatory tests (PBD C4 row) — outputs

`libs/subscription/src/tests/ccp-c4-billing-adjustments.integration.spec.ts` (real Postgres 17, real services, fake Stripe, no network, no key): **20 / 20 passed** (28.8 s).

| PBD C4 obligation | Test ID | Output |
|---|---|---|
| **Threshold escalation** (the chain changes at the boundary) | C4-TH-1 | credit 49 999 → FINANCE_ONLY, one Finance signature → APPROVED; **50 000 (exact, inclusive)** → FINANCE_THEN_OWNER, Finance alone leaves PENDING_APPROVAL, Owner → APPROVED; basis records `credit_escalation_threshold_minor: 50000`; EUR 1 → FINANCE_THEN_OWNER `CURRENCY_NOT_COVERED` |
| | C4-TH-2 | discount 1 999 bps → FINANCE_ONLY; **2 000 bps (exact, inclusive)** → FINANCE_THEN_OWNER, basis `discount_escalation_threshold_bps: 2000`; refund of 1 minor unit → FINANCE_THEN_OWNER (steps finance_admin, platform_owner with `platform:billing:approve`) |
| | C4-NC-5 | policy v2 (credit threshold 100 000, apply deadline 72 h) activated mid-flight: the in-flight 50 000 credit keeps v1 and Finance → Owner; a new 50 000 credit under v2 is FINANCE_ONLY |
| **No money movement before the chain completes** (zero provider calls before apply) | C4-MONEY-1 | at DRAFT, PENDING_APPROVAL, one of two steps signed, REJECTED, and APPROVED-not-applied (the dispatcher runs at each point): **0 adjustment provider calls, 0 provider writes, 0 commands**; the service enqueue → `CHANGE_REQUEST_NOT_APPROVED`, a raw DB insert → "needs a completed approval chain"; apply → `NOT_APPROVED` |
| **Pending until webhook** | C4-PEND-1 | apply → APPLYING with ONE command (PENDING), 0 provider writes; dispatch → exactly 1 write, command PENDING_PROVIDER with `provider_object_ref`, request still APPLYING, view `PENDING_PROVIDER`, a 2nd dispatch claims 0; an unrelated webhook → IGNORED; the webhook naming the object through the inbox → APPLIED, command CONFIRMED (WEBHOOK, event id), adjustment row; the redelivery → DUPLICATE; audit `…CREATED, SUBMITTED, APPROVAL_RECORDED, APPROVED, BILLING_ADJUSTMENT_PENDING_PROVIDER, BILLING_ADJUSTMENT_CONFIRMED, CHANGE_REQUEST_APPLIED`; no amount in the C4 audit bodies |
| | C4-PEND-2 | no webhook: stays APPLYING until `reconcilePending` → APPLIED, source REFETCH |
| | C4-PEND-3 | discount: deterministic coupon attached; a verified subscription event re-reads it → APPLIED (WEBHOOK) |
| **Idempotency** | C4-IDEM-1 | 2nd apply `replayed`, 1 command; enqueue replay returns the same command, a different command on the step → `IDEMPOTENCY_CONFLICT`; 2 transient failures + 1 lost provider response: the SAME key on all 3 provider writes, the 4th dispatch re-reads and does not write; **1 balance adjustment**; APPLIED after the webhook |
| Failed commands visible; recovery | C4-FAIL-1 | provider refusal → command FAILED `PROVIDER_REFUSED`, request APPLYING `COMMAND_FAILED`; APPLY_FAILED refused by the DB while the command is unconfirmed; another commercial_ops → `NOT_REQUESTER`; the requester re-arms the SAME command (same id and key, attempts kept; `…REARMED` audit) → accepted → APPLIED; 1 effect |
| | C4-FAIL-2 | MANUAL tenant → `TARGET_NOT_SELF_SERVICE` (APPLY_FAILED, attempt 1, no command); a stale named subscription → `TARGET_STALE`; 0 writes |
| **Refund designed disabled state** | C4-REFUND-1 | flag off: Finance → Owner approved REFUND, apply → `REFUND_POLICY_NOT_APPROVED`; state APPROVED, attempts 0, 0 commands, 0 provider calls, signatures byte-identical, exactly ONE `APPLY_REFUSED` audit row; view `refund_execution_disabled: true` |
| | C4-REFUND-2 | flag on (test only): one refund write, pending until the refund webhook, APPLIED; a refund command queued while on and dispatched after the flag is off → FAILED `REFUND_POLICY_NOT_APPROVED`, 0 writes; re-arm refused while off |
| **Recovery: compensating Stripe command through a new change request** | C4-COMP-1 | 55 000 credit applied, then its compensation (FINANCE_THEN_OWNER on its own amount) → `CREDIT_REVERSE` command → balance `[-55000, +55000]`, APPLIED; a 2nd compensation → `ALREADY_COMPENSATED`; a 699-for-700 compensation → `COMPENSATION_MISMATCH`; a discount's compensation removes exactly that coupon |
| **NC-1** concurrent approval | C4-NC-1 | two Finance approvers on one step at once: exactly 1 fulfilled, 1 `CommercialApprovalRefusedError`; 1 approval row; no double advance |
| **NC-2** reused identity / one person holding two roles / self-approval | C4-NC-2 | finance_admin + platform_owner signs step 0, refused step 1 `USER_ALREADY_APPROVED`; a requester also holding finance_admin → `SELF_APPROVAL` |
| **NC-3** stale chain | C4-NC-3 | exactly 72 h after submit: approve → `EXPIRED`; apply → `NOT_APPROVED`; 0 commands |
| **NC-4** role revocation | C4-NC-4 | revoked before approving → `STEP_SCOPE_MISSING`; revoked after signing → apply `APPROVER_NO_LONGER_ELIGIBLE`, state APPROVED, 0 commands, 0 writes, the signature byte-identical (TD-A3-0) |
| **NC-5** policy-version change | C4-NC-5 | (above) plus a v2-snapshotted credit not applied by its 72 h deadline → `APPLY_EXPIRED` (AD-4), never dispatched, 0 writes for its tenant |
| Requester-only (TD-B2-3) | C4-AUTH-1 | another commercial_ops `NOT_REQUESTER`; the Finance approver `REQUESTER_SCOPE_MISSING`; a service principal `NOT_HUMAN`; the generic `/apply` → `ACTION_NOT_APPLICABLE`; nothing written |
| DB backstops | C4-DB-1 | a DISCOUNT request cannot issue CREDIT_GRANT; closed C4 params enforced (`BillingProviderCommand_c4_params_check`); APPLYING without a command cannot commit; APPLIED without the adjustment refused; `provider_object_ref` written once; the adjustment record append-only (UPDATE and DELETE refused) |
| No provider call inside a local transaction | C4-TX-1 | the fake's probe ran on every provider call (> 20 asserted): `violations = []` |

`libs/subscription/src/tests/ccp-c4-billing-adjustments.spec.ts`: **12 / 12** (C4-U-1…U-10, U-12, U-14: closed set; payload schemas; thresholds as data at the exact values; the transition mirror; operations, steps, coupon id; closed command params; the amount withholding; the refund flag (only `"1"`); the Stripe adapter against a stubbed `fetch` (no network): one keyed POST per write, coupon then subscription update, an existing coupon tolerated, DELETE for the removal; the webhook envelope; the module wiring of `SubscriptionModule` and `.forRoot()`). `libs/subscription/src/tests/stripe-wire.spec.ts` adds C4-U-11 and C4-U-13 (the refund path: the invoice must be paid from the tenant account, otherwise non-retryable and no POST; one keyed refund POST; a pending refund is not the effect).

**Per role (6 roles + super_admin)** — `apps/platform-admin/src/tests/ccp-c4-billing-adjustment-routes.integration.spec.ts` (real JwtAuthGuard + RolesGuard + real services + real Postgres): **4 / 4**.

| Route | platform_owner | finance_admin | commercial_ops (requester) | catalog_manager | support_admin | read_only_auditor | super_admin |
|---|---|---|---|---|---|---|---|
| `POST …/billing-adjustment` | 403 requester_scope_missing | 403 requester_scope_missing | **200** (another commercial_ops: 403 not_requester) | 403 requester_scope_missing | 403 requester_scope_missing | 403 requester_scope_missing | 403 (gate) |
| `GET …/billing-adjustment` | 200 | 200 | 200 | 200 | 200 | 200 | 403 (gate) |

Plus: tenant tier 403; malformed id 400; unknown id 404; a non-C4 request 409 `action_not_applicable`; REFUND 409 `apply_refused` `REFUND_POLICY_NOT_APPROVED` with its explanation; a pre-command failure 409 `apply_failed` `TARGET_NOT_FOUND`; **no `35000`, `50000` or `4000` anywhere in a C4 route body**; the C1 billing-commands read of a C4 command returns `{subscription_id, currency, amount_withheld: "FINANCE_SCOPE_PENDING"}`.

**Guard union** — `ccp-guard-union.integration.spec.ts`: GUARD-UNION-1 probes the LIVE function for every action × kind × from × to (**15 × 3 × 10 × 10 = 4 500 probes**, REFUND included) and equals `canTransitionFor`; GUARD-UNION-2 the live body is the union file; GUARD-UNION-3; GUARD-UNION-4 re-based (TD-C4-9). 4 / 4.

## 4. Routes, Pact, UI and gates

| Run | Result |
|---|---|
| Pact consumer `platform-web-consumer` (pacts deleted first; serial, `--maxWorkers=1 --no-file-parallelism`) | **3 files, 176 / 176 tests**; `pact/pacts/platform-web-platform-admin.json` holds **177 interactions**. C4 adds 8 tests: apply by the requester (200 PENDING_PROVIDER, amounts withheld), finance_admin 403 `requester_scope_missing`, refund 409 `REFUND_POLICY_NOT_APPROVED`, read by read_only_auditor (200 pending_provider), and 2 routes × (super_admin, tenant tier) from GATE_ROUTES. Coverage header 30 → 32 CCP routes. A first run had 1 failure in the untouched B5 governance file (the mock server did not receive one super_admin request under load); the serial re-run from empty passed. |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2 provider tests passed** (third run): the CCP route coverage gate (now including the 2 C4 routes) and the verification of all 177 interactions. New states: `an approved credit on a self-service tenant exists`, `a credit is pending at the provider`, `an approved refund exists`; `CCP_REFUND_EXECUTION_ENABLED` pinned unset. Run 1 timed out at 600 s under load (no mismatch reported). Run 2: 176 OK, 1 failed — the refund state's seed invoice id `in_pact_c4_refund` was refused by the C4 payload rule (`^in_[A-Za-z0-9]+$`); the fixture became `in_pactc4refund`; run 3 green. |
| Consumer vs provider counts (A10: reported separately) | 177 consumer interactions; 177 verified by the platform-admin provider |
| `contract-parity:check` (temporary `GIT_INDEX_FILE` with intent-to-add entries; real index untouched) | 710 live routes (708 governed), 541 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (the existing config warnings) |
| `orphan-scopes:check` | ok (no scope added or newly enforced: the C4 routes gate on `platform:approval:read`; the service enforces `platform:billing:request`) |
| `env:passthrough-check` | ok (115 passthrough + 3 required-interp + 2 guarded; unchanged — `CCP_REFUND_EXECUTION_ENABLED` is deliberately not wired) |
| `error-codes:check`, `tests:integration:check` | ok (no new AramoError code: refusals ride `COMMERCIAL_CHANGE_REQUEST_CONFLICT` with `details.refusal`; 49 integration roots) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files); ok (temporary index) |
| `bash scripts/verify-vocabulary.sh` | OK: Tier 1, Tier 2 and front-door clean (see §8) |
| ESLint on every changed or new `.ts` / `.tsx` | 0 errors in C4 code after `--fix` of 2 import-order findings; 2 errors remain in files C4 edited that are **pre-existing at `41a0e3b5`** (`apps/platform-web/e2e/fixtures/commercial.ts` `no-this-alias`, `apps/platform-web/e2e/visual/states-ccp.ts` import order — checked with `git show HEAD:… \| eslint --stdin`); warnings are non-null assertions in tests |
| `nx run-many -t build typecheck -p subscription platform-admin aramo-platform-web platform-web-consumer-pact aramo-pact-provider --skip-nx-cache` | 5 projects + 30 dependency tasks succeeded |
| `tsc -p apps/platform-web/e2e/tsconfig.json` | clean |
| Visual parity (`PW_E2E_PORT=4470`, workers 2) | new element-level state **`ccp-drawer-stripe-sent`** (the prototype's finance persona approves CR-1042, which it sends to Stripe; the build shows the same credit APPLYING): references captured from the pinned file, **2 / 2 pass first attempt** (1440, 900); regression of the B1 states `ccp-drawer`, `ccp-dialog-reject`, `ccp-denied-super-admin`, `ccp-approvals*`: all pass |
| axe (`PW_STATE=ccp-d`, `ccp-approvals`) | 29 + 35 passed (incl. `axe ccp-drawer-stripe-sent`; the filters also ran the B5 and contracts axe states) |
| Keyboard | new **KC-C4** (History tab → row → drawer by keyboard; the current chip reads "Sent to Stripe — awaiting confirmation" with `aria-current="step"`; no Approve; Escape returns focus to the row) + KC1 + KC3: 3 / 3 |
| `apps/platform-web` unit (vitest) | 47 files, 541 / 541 (incl. the new stepper test) |

## 5. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription`, whole lib, `ARAMO_RUN_INTEGRATION=1`, `--maxWorkers=2` (50 files, 771 tests collected) | Final run (after every edit): **770 / 771**. The 1 failure is the known load-sensitive `commercial-catalog-a1` "150 sends" loop (30 s timeout; also seen by C1 under load); that file re-run alone with the C1 unit spec: **24 / 24**. An earlier full run (before the C4 unit spec and the re-bases): 754 / 757, the 3 failures being the expectation changes of TD-C4-9, then 46 / 46 on those 3 files. |
| `libs/subscription` unit (no integration) | 18 files, 303 / 303 (before the C4 unit additions); the C4 unit spec, the wire spec, A3-CH and A9-U: 125 / 125; with the C4 module-wiring test and the C1 unit spec: 22 / 22 |
| `ccp-merge-train-compensation.integration.spec.ts` (full chain, Postgres 17) | 4 / 4 (COMP-0…COMP-3 with C4: §6) |
| `apps/platform-admin`: C4 routes, C1 billing authorization, A3 authorization | 3 files, 106 / 106 |
| `apps/sign-service`: `ccp-c1-billing-commands.spec`, `billing.spec`, `personal-free.integration`, `sign-account.integration`, `ccp-a4-ats-sign-consumption.integration` | 5 files, 41 / 41 (19 + 22) |
| **Not run:** the full `nx run api` (PO 2026-10-16 ruling and PBD §8: before the single push, not per slice); `verify-api`, `verify-sign`, `verify.ts`, `verify-ti.ts` providers (no apps/api or sign-service returned shape changed); the full visual suite (only the B1 Commercial states and the new state were re-run) | — |

**Run conditions.** Host load averages 21–58 during the runs (parallel CCP agents). The first provider verification timed out at 600 s (no mismatch reported; a state handler then hit a closed client); see §4 for the re-runs. The scratchpad log directory was shared with a parallel executor (one full-suite log interleaved two runs); the C4 run was identified by its collected count (`vitest list`: 771 in `wip/ccp-c4`) and its failing file was re-run alone.

## 6. Recovery, rollback and the compensating SQL

- **Operational recovery:** a FAILED command is visible (`status: COMMAND_FAILED`, the C1 read) and re-armed by the requester's next apply (same key); a lost provider response is reconciled by re-read; a missed webhook by `reconcilePending`. A money movement already confirmed is undone only by a **compensating change request** (C4-D9).
- **Disable:** leave `SIGN_BILLING_COMMANDS_ENABLED` unset (nothing is dispatched; commands stay PENDING, visible); refunds stay disabled while `CCP_REFUND_EXECUTION_ENABLED` is unset.
- **Code:** revert C4-1…C4-7.
- **Compensating SQL** (documented, not shipped; never run against production, PBD §7.5 / A0-C15), in reverse order, each in its own transaction:
  1. `libs/subscription/src/tests/fixtures/ccp-c4-compensating.sql` — refused while any CREDIT / DISCOUNT / REFUND request, billing-adjustment command or adjustment record exists; then:
     ```sql
     DROP TRIGGER "commercial_change_request_billing_adjustment_applying_commit" ON "subscription"."CommercialChangeRequest";
     DROP FUNCTION "subscription"."guard_commercial_billing_adjustment_applying"();
     DROP TRIGGER "commercial_billing_adjustment_guard" ON "subscription"."CommercialBillingAdjustment";
     DROP TABLE "subscription"."CommercialBillingAdjustment";
     DROP FUNCTION "subscription"."guard_commercial_billing_adjustment"();
     DROP TRIGGER "billing_webhook_inbox_object_ref_guard" ON "subscription"."BillingWebhookInbox";
     DROP FUNCTION "subscription"."guard_billing_webhook_inbox_object_ref"();
     ALTER TABLE "subscription"."BillingWebhookInbox" DROP CONSTRAINT "BillingWebhookInbox_object_ref_check", DROP COLUMN "object_ref";
     DROP TRIGGER "billing_provider_command_object_ref_guard" ON "subscription"."BillingProviderCommand";
     DROP FUNCTION "subscription"."guard_billing_provider_command_object_ref"();
     DROP INDEX "subscription"."BillingProviderCommand_provider_object_ref_idx";
     ALTER TABLE "subscription"."BillingProviderCommand"
         DROP CONSTRAINT "BillingProviderCommand_c4_params_check",
         DROP CONSTRAINT "BillingProviderCommand_provider_object_ref_check",
         DROP COLUMN "provider_object_ref";
     -- then CREATE OR REPLACE guard_billing_provider_command() with the C1 body copied verbatim
     -- from 20261026020000 (in the fixture file).
     ```
  2. `ccp-constraint-union-compensating.sql` (extended) — also refused while a REFUND request or a C4-kind command exists; re-asserts the A3 action list without REFUND and the C1 command kinds `('SUBSCRIPTION_CANCEL', 'CHECKOUT_SESSION_EXPIRE')`.
  3. `ccp-guard-union-compensating.sql` (extended) — also refused while a CREDIT / DISCOUNT / REFUND request is APPROVED, APPLYING or APPLY_FAILED.

  The confirmed adjustment history is dropped with the table: export `CommercialBillingAdjustment` and the C4 commands first if that evidence must be kept (the audit stream keeps the events).
- **Proven** by `ccp-merge-train-compensation.integration.spec.ts` on a fresh Postgres 17 with the full chain: COMP-0 the C4 objects and lists are live; COMP-1 the C4, constraint-union and guard-union compensations are each refused with C4 data and change nothing; COMP-2 C4 → B5-R → constraint union → guard union → A1 apply with 0 errors (C4 objects gone; REFUND and the C4 kinds out of the CHECKs); COMP-3 the five migrations re-apply with 0 errors and the gated state is back. **4 / 4.**

## 7. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-C4-1** | New closed-set value | **REFUND** added to the change-request action types (TS list, DB CHECK via the constraint-union CCP-C4 block, OpenAPI enum). DDR v1.2 `:96` and the C4 row name refunds; the A3 set had none, and a refund is not an account credit. Ripple: A3-CH-15 (14 → 15), GUARD-UNION-1 (4 200 → 4 500 probes) | **Record / confirm** (Architect) |
| **TD-C4-2** | No policy value | Charter §7 defines no refund threshold; none is invented. REFUND always takes Finance → Owner (the escalated chain) | **For the refund policy** to set the rule |
| TD-C4-3 | Placement | `CommercialChangeRequest_action_type_check` (A3-only) and `BillingProviderCommand_kind_check` (C1-only) are re-asserted in the constraint union's labelled CCP-C4 block, as instructed; the new C4-only `BillingProviderCommand_c4_params_check` stays in the C4 slice migration | Recorded |
| **TD-C4-4** | Placement | `guard_billing_provider_command()` (C1's own function; no other slice re-creates it) is re-created in the **C4 slice migration**, C1 body verbatim + labelled CCP-C4 lines (C4 actions; per-action kinds). The guard union holds only `guard_commercial_change_request()` | **Confirm** (Lead) |
| **TD-C4-5** | Reading | "Zero provider calls before APPLIED": a Stripe-side request is APPLIED only after the provider confirms, so provider calls necessarily happen while it is APPLYING. Proven instead: zero provider calls at every state before the requester's apply, the first write only after APPROVED → APPLYING, APPLIED only after the confirming webhook / re-fetch (C4-MONEY-1, C4-PEND-*) | **Confirm** |
| **TD-C4-6** | Product term | DISCOUNT v1 supports only a one-off percent-off on the next invoice (`duration=once`); repeating / forever discounts and amount-off are not built (no ruling) | **PO** |
| **TD-C4-7** | Interim scope | The FA-6 withholding is applied to the C4 routes and to C4 command params on the C1 read. The generic change-request reads (`GET /platform/commercial/change-requests[/{id}]`, B1 inbox and drawer summaries) and the A3 `…CREATED` audit body (`chain_basis`) still carry the CREDIT / REFUND `amount_minor`: pre-existing A3 / B1 surfaces, not C4 routes; changing them changes the B1 contract | **For the Lead** (the FA-6 implementation) |
| **TD-C4-8** | UI scope | CCP-UI v1.0 pins no credit / discount / refund dialog, no drawer Apply action and no ApplyStatus panel ("sent" side value); none is built (apply is API-only). The plan-change dialog's Discount field stays disabled (DV-B3-5: it governs a MANUAL SUBSCRIPTION_CHANGE, not a Stripe command). REFUND has no label in the inbox (`ACTION_LABEL` falls back to the type) | **CCP-UI v1.1** |
| **TD-C4-9** | Expectation changes | Existing specs re-based because CREDIT / DISCOUNT became applyable and REFUND joined the set: A3-CH-15; A9-U-4 (APPLY_SET + the 3 types); A6-SM-DB (CREDIT now reaches APPLYING; without a command the C4 deferred backstop refuses the commit); A6R-TTL-DB (CREDIT now admits APPLY_EXPIRED under AD-4; probed in a rolled-back transaction); GUARD-UNION-4 (lists); the merge-train compensation spec (C4 added); `support/ccp-c1.ts` probe `private` → `protected` (test support) | Recorded |
| **TD-C4-10** | Reading | PBD §10 names "C4 refunds and credits" under the refund policy: the whole slice is NOT DELIVERED. Credits and discounts run end to end in test mode only (the production disabled state is the live-key refusal, TD-C1-3); REFUND has the additional explicit disabled state | Recorded |
| TD-C4-11 | Choice | A FAILED command keeps the request APPLYING (C2 parity), so AD-4 never expires it; the re-arm is the "apply in progress completes under recovery" path, allowed past the deadline | Recorded |
| **TD-C4-12** | Gap | A REFUND command FAILED with `REFUND_POLICY_NOT_APPROVED` (queued while the flag was on) keeps its request APPLYING and the Q14 slot until the policy is approved (the re-arm is refused while off); only reachable if the flag was ever set | **For the Lead** (with TD-ACC-1 withdraw options) |
| TD-C4-13 | Gap | A refund the provider accepts and later reports failed stays PENDING_PROVIDER (C1 admits only CONFIRMED from there) | For D3 (alert) / the refund policy |
| TD-C4-14 | Provider semantics | A credit's currency must match the provider account's; a mismatch is a provider refusal (FAILED `PROVIDER_REFUSED`), never converted. A non-USD credit also escalates (TD-A2-3) | Recorded |
| TD-C4-15 | Contract addition | `VerifiedBillingEvent.object_ref` (optional; set only for events with no subscription or session, so the C1 envelopes are unchanged) and `BillingWebhookInbox.object_ref` (written only when present; immutable) | Recorded |
| **TD-C4-16** | C-23 partial | Pending-provider is shown on the request (C4 view `pending_provider`, the drawer chip); the **affected subscription** view (B3) does not show a pending C4 adjustment | **For B3 / CCP-UI v1.1** (with TD-C1-9) |
| TD-C4-17 | Defence in depth | The dispatcher refuses a C4 command whose request is not APPLYING (`REQUEST_NOT_APPLYING`) or when the adjustment port is unbound (`ADJUSTMENTS_NOT_CONFIGURED`), before any provider call | Recorded |
| **TD-C4-18** | DR-C2-1 | C4 adds no automatic credit or refund on any cancellation and C2's `FINANCIAL_TREATMENT_UNDEFINED` refusal is untouched (C2 suite green in the full run). C4 cannot tell a manually requested credit's purpose: a governed CREDIT requested after an early cancellation is not technically prevented | **PO** (whether a manual governed credit is within DR-C2-1) |
| TD-C4-19 | Choice | `subscription_id` is optional in C4 payloads (A3-shaped CREDIT fixtures stay valid); when absent the apply resolves the open self-service row, when present it must still be that row (`TARGET_STALE`) | Recorded |
| TD-C4-20 | Choice | A compensation's chain is resolved on its own amount (a reversal of a ≥ $500 credit takes Finance → Owner) | Recorded |
| TD-C4-21 | Pre-existing lint | `apps/platform-web/e2e/fixtures/commercial.ts` (`no-this-alias`) and `e2e/visual/states-ccp.ts` (import order) fail ESLint at `41a0e3b5`; C4 edits both files but not those lines | For the B1 owner |
| TD-C4-22 | Merge note | Expected overlap with parallel slices (C5, C7, D2, D4, D5, R1, R3): `schema.prisma`, `index.ts`, `subscription.module.ts`, `subscription-lifecycle.service.ts`, `billing-command.service.ts`, the two union files, `openapi/platform.yaml`, `api-surface-manifest.json`, `platform.module.ts`, the platform-web consumer and `verify-platform-admin.ts`, `commercial-model.ts`, `states-ccp.ts`, `doc/generated/repo-map.*`. Migration `20261028010000` sorts after every program migration | For the lead |

No correction-1 trigger (PBD §2.4) arose.

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: **OK** (Tier 1, Tier 2 and front-door clean). Exemption inventory (CLAUDE.md law): no allowlist entry was added or changed. The existing file-scoped Stripe wire exemption (`scripts/verify-vocabulary.sh:193-194`: `stripe-wire.ts` and `stripe-wire.spec.ts`) is used for C4's Stripe translations (balance-adjustment, coupon, discount, invoice-payment and refund shapes) and for the Stripe-shaped invoice fixtures of C4-U-11 / C4-U-13; the C4 adapter reuses `wireAccountPath` for the account path, so no Stripe field or path literal appears in `stripe-billing.provider.ts`. C4 test event types are neutral strings. The write hook blocked one Tier-2 token in `ccp-c4-billing-adjustments.spec.ts` during authoring (a Stripe invoice fixture field); the test was moved into the exempt wire spec before any gate run.
