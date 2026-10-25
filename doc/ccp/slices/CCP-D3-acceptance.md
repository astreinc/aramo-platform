# CCP-D3 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.4 D3 row (`:123`): "**In:** billing and approval metrics, alerts, exception management. **Out:** health or rating metrics (PLATFORM-UX-1 `:139`) | Alerts fire on injected failures | Revert | — | Alert test outputs".

| | |
|---|---|
| **Slice** | CCP-D3: observability (billing and approval metrics, alerts, exception management) |
| **Branch / baseline** | `wip/ccp-d3` at `6b5051a8` (CCP-C1 head) |
| **Pre-execution record** | `doc/ccp/slices/CCP-D3-pre-execution.md` (choices D3-C1…D3-C8) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** No code contradicts an instrument. No threshold is commercial policy (D3-C3): the 72 h approval expiry stays the active policy's and is read, never redefined. |
| **UI** | **Not built.** The pinned CCP-UI v1.0 handoff (`MANIFEST.sha256` verified 5 / 5 OK) has no alert, exception or observability surface. **The D3 UI needs a design release.** B1's rail and shell are untouched. |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| D3-0 | `CCP-D3: pre-execution check` | `doc/ccp/slices/CCP-D3-pre-execution.md` (new) |
| D3-1 | `CCP-D3: operational alert register (migration + Prisma model)` | `libs/subscription/prisma/migrations/20261026090000_ccp_d3_operational_alerts/migration.sql` (new); `libs/subscription/prisma/schema.prisma` |
| D3-2 | `CCP-D3: alert model, scanner, register reads and counts-and-states metrics` | `libs/subscription/src/lib/observability/commercial-alert.ts`, `commercial-alert.service.ts` (new); `libs/subscription/src/lib/subscription.module.ts`; `libs/subscription/src/index.ts` |
| D3-3 | `CCP-D3: platform-admin read routes, opt-in scanner worker and its env wiring; OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-observability.controller.ts`, `dto/commercial-observability.dto.ts`, `commercial-alert-scanner.service.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json`; `docker-compose.prod.yml`; `.env.example`; `.env.prod.example` |
| D3-4 | `CCP-D3: tests (alerts fire on injected failures, register invariants, per-role routes, worker)` | `libs/subscription/src/tests/ccp-d3-operational-alerts.integration.spec.ts`, `ccp-d3-alerts.spec.ts`; `apps/platform-admin/src/tests/ccp-d3-observability-authorization.spec.ts`, `ccp-d3-alert-scanner-worker.spec.ts` (all new) |
| D3-5 | `CCP-D3: Pact — alert and metrics routes (platform-web / verify-platform-admin)` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| D3-6 | `CCP-D3: acceptance evidence` + `CCP-D3: regenerate repo map` | `doc/ccp/slices/CCP-D3-acceptance.md` (new); `doc/generated/repo-map.{coupling,files,projects}.json` |

Totals: **12 new files, 14 modified files (26 paths)**. `git diff --stat` over the 14 modified files: 947 insertions, 3 deletions (the 3 regenerated repo-map files included). **Unchanged:** every existing migration; every existing spec file; `pact/provider/src/verify-api.ts` (no apps/api returned shape changed); `verify-sign.ts`; `ci/scripts/verify-orphan-scopes.ts` (both scopes were already literally enforced); the error-code registry (no new code); `doc/ccp/decisions.md`; B1's rail and shell; every source table the scanner reads.

## 2. Design as implemented

**Observability pattern found (D3-C1).** No metrics library, alert or notification mechanism exists in the repo. Background jobs log one structured JSON line through the NestJS `Logger` (`personal-signup-attempt-purge-sweeper.service.ts`, C1's and D1's workers). D3 reuses that pattern and adds the narrowest alert mechanism: an operator-visible record, structured log events, an opt-in scanner and read routes. No external paging service.

**The register** (`subscription."CommercialOperationalAlert"`):
- One row per detected condition on one subject; at most **one OPEN row per (alert_type, subject_id)** (partial unique index `CommercialOperationalAlert_one_open_key`).
- `OPEN → RESOLVED` only. RESOLVED is terminal. INSERT must be OPEN with one detection. The identity columns are immutable (id, type, family, subject kind and id, tenant, product, first detection). Detections never go backwards. DELETE is rejected, so the exception register keeps its history (trigger `guard_commercial_operational_alert`).
- The type CHECK pins each type to its family and subject kind. Product is the A4 closed registry (`sign`). No money column, no grade.

**Alert types (D3-C2):**

| Family | Type | Condition (source) | Resolves when |
|---|---|---|---|
| BILLING | `COMMAND_PENDING_PROVIDER_STUCK` | `BillingProviderCommand` PENDING_PROVIDER, `provider_accepted_at` ≥ threshold ago (TD-C1-10) | state leaves PENDING_PROVIDER |
| BILLING | `COMMAND_FAILED` | `BillingProviderCommand` FAILED (TD-C1-7 visibility) | state leaves FAILED (retry, or re-fetch confirms) |
| BILLING | `HELD_ACTIVATION` | open `BillingReconciliationFlag` with reason `governed_subscription_open` (A6, Conv. C-7/C-8) | the flag is resolved (Conv. C-9) |
| BILLING | `WEBHOOK_INBOX_FAILED` | `BillingWebhookInbox` FAILED | status leaves FAILED (drain or redelivery) |
| BILLING | `USAGE_NOT_RECONCILED` | the latest D1 `UsageRollupRun` of a metric is NOT_RECONCILED | a later run is RECONCILED |
| APPROVAL | `APPLY_FAILED` | `CommercialChangeRequest` APPLY_FAILED (A6) | state leaves APPLY_FAILED (retry applies) |
| APPROVAL | `APPROVAL_NEARING_EXPIRY` | PENDING_APPROVAL with `expires_at` in (now, now + lead] (A3) | approved, rejected, withdrawn, or the expiry is reached |
| APPROVAL | `APPROVAL_PAST_EXPIRY` | PENDING_APPROVAL with `expires_at` ≤ now (lazy expiry, TD-A3-10) | the request leaves PENDING_APPROVAL (e.g. `expireDue` → EXPIRED) |

**The scanner** (`CommercialAlertService.scan`):
- One transaction under `pg_try_advisory_xact_lock(hashtextextended('ccp-d3:alert-scan', 0))`. A concurrent scan skips (`LOCKED`).
- It reads every source, diffs against the OPEN alerts, and then raises, refreshes (`detection_count + 1`, evidence and `last_detected_at`) or resolves (`resolution_detail` = what the subject became).
- **Read-only on every source table** (D3-REG-2). It writes the register only.
- A source that was not read in full is `unavailable` (absent table) or `truncated` (more than 1000 rows). Such a source never resolves its open alerts: absence of evidence is not resolution.
- After commit it logs one JSON line per raise (`ccp_alert_raised`, warn), one per resolve (`ccp_alert_resolved`) and one per scan (`ccp_alert_scan`). The lines carry ids, types and states only.

**Exception management (D3-C5)** is the register's lifecycle. Resolving the underlying condition stays on its governed path: `retryFailed`, the change-request apply retry, the C2 conversion, the A3 expiry. D3 adds no acknowledge, mute or retry route (PLATFORM-UX-1 A1-2).

**The worker** (`CommercialAlertScannerWorker`, platform-admin):
- Runs only with `CCP_ALERTS_ENABLED=1`. Interval `CCP_ALERTS_INTERVAL_MS` (default 300000, floor 10000).
- Thresholds are read from env on each tick (D3-C3):
  - `CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES` (default 1440);
  - `CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES` (default 720).

  Each takes 1–43200 minutes. A malformed or out-of-range value falls back to the default.
- All four variables are documented in `.env.example` and `.env.prod.example`, and passed through to `platform-admin` in `docker-compose.prod.yml`.

**Read routes** (read-only; platform consumer only; `PlatformCommercialObservabilityController`):

| Route | Scope | Content |
|---|---|---|
| `GET /platform/commercial/alerts/billing` | `platform:billing:read` | billing-family register; filters `status`, `alert_type` (billing types only), `tenant_id`; `first_detected_at DESC, id DESC`; keyset cursor pinned to the filters |
| `GET /platform/commercial/alerts/approvals` | `platform:approval:read` | approval-family register; same filters (approval types only) |
| `GET /platform/commercial/metrics/billing` | `platform:billing:read` | commands by state (6), commands pending at the provider past the threshold, inbox by status (4), open flags by reason, open billing alerts by type (5), thresholds |
| `GET /platform/commercial/metrics/approvals` | `platform:approval:read` | change requests by state (9), pending nearing expiry, pending past expiry, open approval alerts by type (3), thresholds |

The metrics are platform-wide counts by state. They are never per tenant, never ordered by tenant, never money, and carry no derived index (PLATFORM-UX-1 `:139`, R-19 `:78`, A1-4a `:68`). The metrics routes take no parameter (400 on any).

## 3. Alert test outputs (real Postgres 17, fake Stripe, no network, no key)

`libs/subscription/src/tests/ccp-d3-operational-alerts.integration.spec.ts`: **14 / 14 passed**. Run 3: 15.73 s for 4 files and 73 tests, together with C1 (23 / 23), A6 apply (26 / 26) and A6 hold (10 / 10). Thresholds in the spec come from env-shaped input: `CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES=30`, `CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES=360`.

**Every alert type fires on an injected failure** produced through the real services:

| Alert type | Test ID | Injected failure | Output |
|---|---|---|---|
| (baseline) | D3-ALERT-0 | none | empty platform: raised 0, refreshed 0, resolved 0, open 0; the D1 source is `unavailable` while `UsageRollupRun` is absent; the scan summary line is logged |
| `COMMAND_FAILED` | D3-ALERT-COMMAND_FAILED | the provider refuses the cancel (4xx) | 1 OPEN alert: BILLING / `billing_command`, tenant + `sign`, detail `SUBSCRIPTION_CANCEL FAILED PROVIDER_REFUSED after 1 attempt(s)`, evidence `{state FAILED, failure_code PROVIDER_REFUSED, change_request_id, attempts 1}`; exactly 1 `ccp_alert_raised` line. Repeat scan → same row, `detection_count 2`, `last_detected_at` advanced, no 2nd raised line. `retryFailed` → next scan RESOLVED, `command state now PENDING`, 1 `ccp_alert_resolved` line |
| `COMMAND_FAILED` | D3-ALERT-COMMAND_FAILED-RETRIES | transient 503 on all 8 attempts | 1 OPEN alert, detail `SUBSCRIPTION_CANCEL FAILED RETRIES_EXHAUSTED after 8 attempt(s)` |
| `COMMAND_PENDING_PROVIDER_STUCK` | D3-ALERT-COMMAND_PENDING_PROVIDER_STUCK | the provider accepts the cancel; the confirming webhook never arrives | no alert at 29 min; at 30 min 1 OPEN alert, `threshold_minutes 30`, detail `SUBSCRIPTION_CANCEL accepted by the provider 30 min ago and not yet confirmed (threshold 30 min)`, evidence `minutes_pending 30`; 1 raised line. The webhook end is applied → RESOLVED, `command state now CONFIRMED` |
| `HELD_ACTIVATION` | D3-ALERT-HELD_ACTIVATION | a checkout completes while a governed MANUAL row is open (A6 hold) | 1 OPEN alert on the flag, tenant + `sign` (via the held intent's plan), evidence `{reason governed_subscription_open, subscription_ref, intent_id}`; 1 raised line. The C-9 durable cancel is dispatched → still OPEN, `detection_count 2` (not resolved on local commit); the webhook-confirmed end → RESOLVED, `flag resolved at <instant>` |
| `WEBHOOK_INBOX_FAILED` | D3-ALERT-WEBHOOK_INBOX_FAILED | the provider re-fetch is unavailable during processing | 1 OPEN alert: tenant null, `sign`, detail `provider event subscription.updated failed processing after 1 attempt(s)`, evidence carries the event id and `last_error`; 1 raised line. The drain processes it → RESOLVED, `inbox status now PROCESSED (APPLIED)` |
| `USAGE_NOT_RECONCILED` | D3-ALERT-USAGE_NOT_RECONCILED | the latest D1 run of `sign.envelopes` is NOT_RECONCILED (2 mismatches) after a RECONCILED one | source `read`; 1 OPEN alert on `sign.envelopes` (`usage_metric`, `sign`), detail `latest usage roll-up run (FULL) did not reconcile: 2 mismatch(es)`; 1 raised line. A later RECONCILED run → RESOLVED, `latest usage roll-up run reconciled` |
| `APPLY_FAILED` | D3-ALERT-APPLY_FAILED | an injected fault after the subscription write in a governed SUBSCRIPTION_OPEN apply | 1 OPEN alert, APPROVAL / `change_request`, tenant + `sign`, detail `SUBSCRIPTION_OPEN apply failed after 1 attempt(s); retryable`; 1 raised line. The retry applies (APPLIED) → RESOLVED, `change request state now APPLIED` |
| `APPROVAL_NEARING_EXPIRY` / `APPROVAL_PAST_EXPIRY` | D3-ALERT-APPROVAL_EXPIRY | a submitted request no approver acts on; nothing expires it | `expires_at − submitted_at` = 72 h (the policy's, unchanged); no alert 361 min before expiry; NEARING at 360 min (`threshold_minutes 360`, `expires in 360 min (lead 360 min)`); 1 min after expiry NEARING → RESOLVED `expiry reached (see APPROVAL_PAST_EXPIRY)` and PAST OPEN (`still PENDING_APPROVAL 1 min after its expiry`); raised lines in order NEARING, PAST. `expireDue` → PAST RESOLVED, `change request state now EXPIRED` |

**Register invariants and scanner properties:**

| Test ID | Output |
|---|---|
| D3-REG-1 | a 2nd OPEN row for the same (type, subject) → `CommercialOperationalAlert_one_open_key`; a wrong family or subject kind, or an unknown type → `CommercialOperationalAlert_type_check`; INSERT as RESOLVED or with 2 detections → "starts OPEN"; DELETE → "never deleted"; `subject_id` / `tenant_id` edits → "immutable"; RESOLVED without `resolved_at` → `CommercialOperationalAlert_resolved_check`; `detection_count 0` → refused; RESOLVED → OPEN → "RESOLVED (terminal)"; after resolution the same subject can open a new episode |
| D3-REG-2 | the scanner is read-only: fingerprints (row count + md5 of every row) of the 9 source tables are equal before and after a scan that raised, refreshed and resolved |
| D3-REG-3 | 3 concurrent scans: at least 1 runs, 0 duplicate OPEN (type, subject) pairs; with the scan lock held by another session, a scan returns `skipped: LOCKED` with 0 raised and 0 resolved, and logs `ccp_alert_scan {skipped: LOCKED}` |
| D3-LIST-1 | BILLING lists only BILLING rows and APPROVAL only APPROVAL rows; newest first; filters ANDed; the cursor pages (1 + 1); a cursor reused under other filters or another family → `INVALID_CURSOR`; an approval type on the billing family → `INVALID_QUERY`; a malformed cursor → `INVALID_CURSOR` |
| D3-MET-1 | every metric equals a direct SQL count (FAILED commands, PROCESSED inbox events, open `governed_subscription_open` flags, open COMMAND_FAILED alerts, APPLIED requests, total requests, past-expiry pending); key sets fixed (6 command states, 5 billing types, 3 approval types); the serialized metrics contain no `amount`, `price`, `cents`, `currency` or `tenant_id` |

`libs/subscription/src/tests/ccp-d3-alerts.spec.ts`: **6 / 6 passed**:
- D3-U-1: the 8 types and 2 families equal the migration's type CHECK triples, parsed from the SQL.
- D3-U-2: threshold defaults are 1440 / 720. `45` and ` 60 ` are accepted. `''`, `abc`, `0`, `-5`, `1.5`, `43201` and `1e3` fall back to the default; `43200` is accepted.
- D3-U-3…U-5: the register diff (raise / refresh / resolve; a duplicate counts once; types are independent; an unread source never resolves).
- D3-U-6: `SubscriptionModule` and `.forRoot()` provide and export `CommercialAlertService`.

## 4. Routes, Pact and gates

| Run | Result |
|---|---|
| `apps/platform-admin/src/tests/ccp-d3-observability-authorization.spec.ts` (real JwtAuthGuard + RolesGuard, mocked service) | **28 / 28**. D3-R-0 pins the §4.1 matrix (5 holders of `platform:billing:read`, 6 of `platform:approval:read`, super_admin none). Billing family: 200 for platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor; 403 `missing_scopes [platform:billing:read]` for catalog_manager and super_admin, service never reached. Approval family: 200 for all 6 CCP roles; 403 `missing_scopes [platform:approval:read]` for super_admin. catalog_manager: approvals 200, billing 403. 401 with no token and 403 for a tenant-tier token on all 4 routes. Filters typed. 9 × 400 `VALIDATION_ERROR` (including the other family's type and any parameter on a metrics route). 400 `invalid_cursor` / `invalid_query` from the service |
| `apps/platform-admin/src/tests/ccp-d3-alert-scanner-worker.spec.ts` | **4 / 4**: off unless exactly `1` (`0`, `true`, `yes`, `''`, ` 1` are off); interval default 300000 with a 10000 floor; no timer when off; with the flag, the interval scans with the env thresholds (`90` / default `720`) and shutdown clears it; ticks report SCANNED / LOCKED / FAILED (never throws) / SKIPPED after shutdown |
| Consumer `platform-web-consumer` (run serially, `--maxWorkers=1`) | **58 interactions** (C1 recorded 45; +13): alerts/billing allowed 200 (finance_admin) and catalog_manager 403; alerts/approvals allowed 200 (catalog_manager); metrics/billing 200 (read_only_auditor); metrics/approvals 200 (support_admin); super_admin 403 × 4; tenant tier 403 × 4 (the 4 routes appended to `GATE_ROUTES`) |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`, serial) | **2 / 2 provider tests passed** (40.81 s): the CCP route coverage gate (now including the 4 D3 routes) and the verification of all 58 interactions (58 "has a matching body"; 0 failures). New states: `an open billing alert exists`, `an open approval alert exists`. `CCP_ALERTS_ENABLED` is unset in the verifier |
| Consumer vs provider counts (A10: reported separately) | 58 consumer interactions; 58 verified by the platform-admin provider |
| `contract-parity:check` | 684 live routes (682 governed), 515 OpenAPI ops, 185 transitional-debt, 0 orphan, 0 unclassified (C1: 680 / 678 / 511; +4 / +4 / +4). Run under a temporary `GIT_INDEX_FILE` with intent-to-add entries (the parity scan enumerates git-tracked controllers); real index untouched |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (equal to the C1 baseline) |
| `orphan-scopes:check` | ok (no entry changed: `platform:billing:read` and `platform:approval:read` were already literally enforced) |
| `env:passthrough-check` | ok: 113 passthrough (C1: 109; +4 documented `CCP_ALERT*` passthroughs) + 3 required-interp + 2 guarded |
| `error-codes:check`, `tests:integration:check` | ok (no new error code; 49 integration roots) |
| `repo-map:generate` / `repo-map:check` | regenerated (3 files modified); ok. Run under a temporary `GIT_INDEX_FILE` with intent-to-add entries |
| `nx run-many -t lint -p subscription platform-admin platform-web-consumer-pact --skip-nx-cache` | succeeded: 0 errors, 89 warnings (pre-existing non-null assertions in test files). ESLint on the 14 changed or new `.ts` files (`verify-platform-admin.ts` included): 0 errors, 0 warnings after one fix (a non-null assertion in the D3 spec) |
| `nx run-many -t build -p subscription platform-admin --skip-nx-cache` | 2 projects + 28 dependency tasks succeeded (Nx flagged `subscription:build` as flaky, then it passed). Dist markers checked: `CommercialAlertService` in `dist/libs/subscription/src/index.d.ts`; `dist/apps/platform-admin/src/app/platform/platform-commercial-observability.controller.js`; `dist/libs/subscription/src/lib/observability/commercial-alert.service.js` |
| `bash scripts/verify-vocabulary.sh` | exit 0. Tier 1, Tier 2 and front-door are clean. No exemption touched. Neutral wording was chosen throughout ("scan", "scanner", "detection") |

## 5. Tests run and not run

| Suite | Result |
|---|---|
| `libs/subscription` whole lib, unit (no integration flag), `--maxWorkers=2` | 25 files: 10 passed, 15 skipped (integration-gated); **218 passed**, 259 skipped |
| `libs/subscription` integration (`ARAMO_RUN_INTEGRATION=1`): D3, C1 command/inbox, A6 apply, A6 hold (each applies every subscription migration, including D3's) | **4 files, 73 / 73** |
| `apps/platform-admin` whole app, unit | **14 files, 375 / 375** (includes the 2 D3 specs) |
| `apps/platform-admin` integration: `ccp-a6-commercial-apply-routes`, `platform-me` | **2 files, 8 / 8** |
| Pact: `platform-web-consumer` (58) then `verify-platform-admin` (2 / 2, 58 verified) | serial |
| **Not run:** the full `nx run api` (instructed); `verify-api`, `verify-sign`, `verify.ts`, `verify-ti.ts` providers (no apps/api or sign-service shape changed); `apps/platform-web` / `sign-web` (no UI); the other `libs/subscription` integration specs (A3, A4, A5, A9: their schema helpers pin a narrowed chain without D3's migration, or do not reach D3 code); the whole-lib integration run (host loaded) | — |

No apps/api spec applies D3's migration. `ccp-a4-ats-sign-availability` reads only pre-A4 subscription migrations, and no erasure harness lists `subscription`.

## 6. Recovery and rollback

- **Disable:** leave `CCP_ALERTS_ENABLED` unset (the default). Nothing scans; the routes still read the register and compute the metrics live.
- The register is derived: every OPEN alert is recomputed by the next scan. A wrong row cannot be deleted (by design), but it resolves on the next scan once its condition is not observed.
- Code: revert D3-1…D3-5.
- **Compensating migration** (documented, not shipped; never run against production, PBD §7.5):
  ```sql
  DROP TRIGGER "commercial_operational_alert_guard" ON subscription."CommercialOperationalAlert";
  DROP TABLE subscription."CommercialOperationalAlert";
  DROP FUNCTION subscription."guard_commercial_operational_alert"();
  ```
  The alert history is dropped with the table; export it first if it must be kept. No source table depends on it.

## 7. Typed divergences

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| **TD-D3-1** | Baseline / merge | CCP-D1 is not an ancestor of `6b5051a8`. `USAGE_NOT_RECONCILED` reads `subscription."UsageRollupRun"` by raw SQL, guarded by `to_regclass` (`unavailable` when absent), with D1's committed column names (`73c33238`). The spec creates a stand-in with those columns only while the table is absent (`CREATE TABLE IF NOT EXISTS`). After the merge it inserts into D1's real table (FK to the seeded `sign.envelopes` metric; append-only allows INSERT). | **Lead:** re-run the D3 spec on the merged state |
| **TD-D3-2** | Configuration | Thresholds are operational env settings with defaults chosen here: stuck pending-provider 1440 min, approval-expiry lead 720 min, interval 300000 ms. No LOCKED instrument names an alerting lead time. They change no request, approval, price or expiry. | **PO to confirm the defaults** at the acceptance review |
| TD-D3-3 | Scope (A1-2) | There is no acknowledge, mute, assign or retry route; the register resolves itself. TD-C1-7's operator retry and its `CommercialAuditEvent` row stay open: `retryFailed` is still a service method. D3 makes failed commands visible and alerted. | **D5 runbook** (retry procedure). An acknowledge route needs a new scope, which is a catalog change |
| **TD-D3-4** | Scope | `HELD_ACTIVATION` covers `governed_subscription_open` only, as instructed. Open flags with the older reasons (`billing_country_not_supported`, `domain_not_authoritative`) are counted in `metrics/billing` (`open_reconciliation_flags_by_reason`) but raise no alert. | **Confirm** whether those reasons should alert too (an additive CHECK value) |
| TD-D3-5 | Choice | Alerts are not written to `CommercialAuditEvent`. They are observations, not commercial actions; the register keeps its own non-deletable history. The structured log lines are the event stream. | Recorded |
| TD-D3-6 | Activation | The scanner is off by default. Until it is enabled the register stays empty, but the metrics routes are live. Enabling it in production needs its own authorization (PBD §12). | For the PO at release |
| TD-D3-7 | UI | CCP-UI v1.0 pins no alert or exception surface, so no D3 screen was built. | **D3 UI needs a design release** |
| TD-D3-8 | Choice | Per-source read cap of 1000 rows per scan. A source at the cap is `truncated` and resolves nothing in that scan; it is named in the scan log line (`unread_sources`). | Recorded |
| **TD-D3-9** | Gap (A3) | The scanner never calls `expireDue` (it is read-only). A3's lazy expiry (TD-A3-10) is still unscheduled, so a request past expiry stays PENDING_APPROVAL until a create, approve, reject or withdraw touches it. D3 makes this visible (`APPROVAL_PAST_EXPIRY`) but does not change it. | **Ruling:** schedule `expireDue` (a D5 runbook step or a worker) |
| TD-D3-10 | Not built (HALT elsewhere) | An APPROVED request that is never applied (TD-A6-5, HALT pending a policy amendment, `e0b050ca`) raises no alert. Any "approved too long" threshold would interact with that pending policy decision. | After the TD-A6-5 amendment |
| TD-D3-11 | Choice | `WEBHOOK_INBOX_FAILED` is raised at the first FAILED attempt, with no grace period. A failure the drain recovers within a minute raises and then resolves on the next scan. | Recorded; a grace threshold could be added as env if this proves noisy |
| TD-D3-12 | Robustness | Scans with a non-monotonic clock (as in the spec) never move `last_detected_at` backwards, and `resolved_at` is clamped to at least `first_detected_at`. | Recorded |
| TD-D3-13 | Scope reading | The billing-family routes use `platform:billing:read`. Its A1 text names "billing status read routes (C3/C4)", the same reading as C1's TD-C1-15. | **Confirm** with TD-C1-15 |
| TD-D3-14 | Merge note | Expected overlap with parallel slices: `schema.prisma`, `src/index.ts`, `subscription.module.ts`, `platform.module.ts`, `openapi/platform.yaml`, `api-surface-manifest.json`, the platform-web consumer Pact and `verify-platform-admin.ts`, `.env.example`, `.env.prod.example`, `docker-compose.prod.yml` (inserted away from D1's anchors to reduce conflicts), `doc/generated/repo-map.*`. Migration `20261026090000` sorts after D1's `20261025240000` and C1's `20261026020000`. | For the lead |

No correction-1 trigger (PBD §2.4) arose. The slice needed no architectural change, no new commercial or regulatory decision, and no governing-contract amendment. Nothing health-like or rating-like was built: every figure is a count by state or a single subject's observed condition (PLATFORM-UX-1 `:139`).

## 8. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0. Tier 1, Tier 2 and front-door retirement are clean. No exemption allowlist was touched.
