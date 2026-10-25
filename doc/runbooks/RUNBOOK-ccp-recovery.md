# Runbook — CCP recovery (change requests, Stripe commands, webhooks, usage, alerts, holds, policy)

> **Design approval is not production migration authority (ruling A0-C15).** Nothing in this runbook
> authorizes a migration, a deploy or an activation. **Every production step below needs its own,
> separate PO authorization**, recorded before the step runs.

**Status:** operator procedure (CCP-D5). **Owner:** platform on-call; commercial actions are taken by
the commercial role named in each step, never by on-call on their behalf.
**Governing text:** Program Build Directive §5.4 row D5, §7.2, §7.3, §12; Conversion Rule C-6…C-15,
C-21…C-24; Charter Amendment A1 (AD-1…AD-8); `doc/ccp/decisions.md` (TD-A3-0, TD-A6-3, TD-B2-3, TD-B5-1,
TD-C1-4, TD-D3-2, TD-D3-9).
**Dry run:** `doc/ccp/runbook-dry-runs-20261025.md` §2 (every query and action below, with its real output).

## 0. Rules that hold for every section

- **No approval bypass through SQL (PBD §12).** Never `UPDATE` a `CommercialChangeRequest`, `CommercialApproval`,
  `BillingProviderCommand`, `BillingWebhookInbox`, `BillingReconciliationFlag`, `CommercialConversionRelease`
  or `TenantSubscription` row by hand. Every recovery below goes through the product path.
- **Never a local edit that implies Stripe changed (C-8, C-22, C-23).** A Stripe-owned change is a durable
  command, confirmed by a verified webhook or a provider re-fetch.
- **Signing continuity (C-24).** No step here touches an in-flight envelope, an executed document or its evidence.
- The only exception path is `RUNBOOK-ccp-break-glass.md`, under PO authorization.
- Every query below is read-only (`BEGIN TRANSACTION READ ONLY … ROLLBACK`). Run them as:

```bash
PG() { sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'; }
```

The console reads the same data: Approvals inbox and request drawer (`platform:approval:read`),
`GET /platform/commercial/billing-commands` and `GET /platform/commercial/billing-webhook-inbox`
(`platform:billing:read`), `GET /platform/commercial/alerts/billing` (`platform:billing:read`),
`GET /platform/commercial/alerts/approvals` (`platform:approval:read`). super_admin holds none of these.

## 1. Alert triage (CCP-D3)

The scanner runs only with `CCP_ALERTS_ENABLED=1` in platform-admin (tick `CCP_ALERTS_INTERVAL_MS`,
default 300000). Alerts never take a financial action (TD-D3-2); they resolve themselves when the
underlying state clears. There is no acknowledge, mute or retry route (TD-D3-3).

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT family, alert_type, status, count(*) AS n
  FROM subscription."CommercialOperationalAlert" GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
SELECT alert_type, subject_kind, subject_id, tenant_id, detection_count, first_detected_at, left(detail, 100) AS detail
  FROM subscription."CommercialOperationalAlert" WHERE status = 'OPEN' ORDER BY first_detected_at, id;
ROLLBACK;
SQL
```

| Alert | Family | Go to |
|---|---|---|
| `APPLY_FAILED` | APPROVAL | §3 |
| `APPROVAL_NEARING_EXPIRY` | APPROVAL | §4 (warns 720 min before, `CCP_ALERT_APPROVAL_EXPIRY_LEAD_MINUTES`) |
| `APPROVAL_PAST_EXPIRY` | APPROVAL | §4 |
| `COMMAND_FAILED` | BILLING | §5 |
| `COMMAND_PENDING_PROVIDER_STUCK` | BILLING | §5 (after 1440 min, `CCP_ALERT_PENDING_PROVIDER_STUCK_MINUTES`) |
| `WEBHOOK_INBOX_FAILED` | BILLING | §6 |
| `USAGE_NOT_RECONCILED` | BILLING | §7 |
| `HELD_ACTIVATION` | BILLING | §8 |

A request whose **apply deadline** has passed has no alert type; §4 (b) finds it.

## 2. A request stuck in APPLYING

**Expected: none should commit.** For every action except CONVERSION, APPLYING exists only inside the apply
transaction: the deferred triggers `commercial_change_request_no_applying_commit` (A6 + catalog), `_a7`, `_a8`
and `_b5r` refuse the commit (dry run: "cannot commit in APPLYING (the apply is one transaction)"). ROLE_GRANT /
ROLE_REVOKE have no deferred backstop; their single A9 apply transaction is the only guard. A **CONVERSION** may
commit in APPLYING, but only while a `BillingProviderCommand` exists for it (TO_GOVERNED, pending the provider).

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT r.id, r.action_type, r.tenant_id, r.apply_attempts, r.updated_at,
       c.id AS command_id, c.command_kind, c.step, c.state AS command_state, c.attempts AS command_attempts, c.last_error_code
  FROM subscription."CommercialChangeRequest" r
  LEFT JOIN subscription."BillingProviderCommand" c ON c.change_request_id = r.id
 WHERE r.state = 'APPLYING'
 ORDER BY r.updated_at;
SELECT count(*) AS applying_not_conversion
  FROM subscription."CommercialChangeRequest" WHERE state = 'APPLYING' AND action_type <> 'CONVERSION';
ROLLBACK;
SQL
```

- `applying_not_conversion > 0`: **HALT.** This is a defect, not an operational state. Do not edit the row.
  Capture the row and its audit events and escalate to the Lead.
- A CONVERSION row: read its command. `PENDING_PROVIDER` is normal until the webhook or the worker re-fetch
  confirms the provider end; `FAILED` / `RETRY_WAIT` / a long `PENDING_PROVIDER` → §5. The request completes
  (APPLIED) when the confirmed end is applied; an APPLYING CONVERSION never expires (AD-4).

## 3. APPLY_FAILED — retry by the requester

An apply failure rolls the whole apply back (no partial state) and records `APPLY_FAILED` with
`COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED` in a separate transaction.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT r.id, r.action_type, r.tenant_id, r.product_key, r.requested_by, r.apply_attempts, r.approved_at,
       (SELECT e.payload->>'failure' FROM subscription."CommercialAuditEvent" e
         WHERE e.change_request_id = r.id AND e.event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLY_FAILED'
         ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_failure
  FROM subscription."CommercialChangeRequest" r
 WHERE r.state = 'APPLY_FAILED'
 ORDER BY r.approved_at;
ROLLBACK;
SQL
```

1. Read `last_failure` and the request's audit events. Fix the cause first (a stale target, a usage rule
   refusal, a fault). If the cause is the request itself (wrong payload, wrong target), do not retry: the
   requester raises a new request (the payload is immutable).
2. **Only the original requester applies** (TD-A6-3 as narrowed by TD-B2-3). In the console the Apply / Retry
   apply button appears only when `GET /platform/commercial/change-requests/{id}` returns
   `apply_actionable: true` for the caller. API: `POST /platform/commercial/change-requests/{id}/apply`
   (CONVERSION: `POST …/{id}/convert`). Anyone else is refused `403 INSUFFICIENT_PERMISSIONS`, reason
   `not_requester`.
3. At apply time the backend re-checks state, every approval's eligibility under the snapshotted policy and
   chain (TD-A3-0), the requester's live authority, current eligibility and the apply deadline.
4. A retry before the deadline either APPLIES (`apply_attempts` + 1) or fails again. Past the deadline it is
   `APPLY_EXPIRED` (§4 b).
5. Known edge (TD-B5R-3, TD-ACC-1, open): a POLICY_ACTIVATE snapshotted under policy v1 has no apply deadline,
   so a v1-snapshotted APPLY_FAILED activation holds the policy slot until its requester applies it. There is
   no withdraw for APPLY_FAILED. Escalate to the Lead; do not edit it.

## 4. Expired requests

**(a) Approval window passed (PENDING_APPROVAL).** Expiry is lazy (TD-D3-9): a request past `expires_at` stays
PENDING_APPROVAL until a create, approve, reject or withdraw touches it; `expireDue` has no scheduled caller.
It cannot be approved: an approval attempt is refused `EXPIRED` and moves it to EXPIRED.
**(b) Apply deadline passed (APPROVED / APPLY_FAILED).** Only requests snapshotted under a policy version that
carries `apply_expiry_hours` have a deadline (AD-2). Any read, list or apply expires it to APPLY_EXPIRED; the
apply is refused `409 COMMERCIAL_CHANGE_REQUEST_CONFLICT`, reason `apply_expired`.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
-- (a) pending requests whose approval window has passed (they expire lazily, on the next touch)
SELECT id, action_type, tenant_id, product_key, requested_by, submitted_at, expires_at
  FROM subscription."CommercialChangeRequest"
 WHERE state = 'PENDING_APPROVAL' AND expires_at <= now()
 ORDER BY expires_at;
-- (b) approved or failed requests past the apply deadline of their OWN snapshotted policy version
SELECT r.id, r.action_type, r.state, r.approved_at,
       (pv.content->>'apply_expiry_hours')::int AS apply_expiry_hours,
       r.approved_at + make_interval(hours => (pv.content->>'apply_expiry_hours')::int) AS apply_deadline
  FROM subscription."CommercialChangeRequest" r
  JOIN subscription."CommercialPolicyVersion" pv ON pv.id = r.policy_version_id
 WHERE r.state IN ('APPROVED', 'APPLY_FAILED')
   AND pv.content ? 'apply_expiry_hours'
   AND r.approved_at + make_interval(hours => (pv.content->>'apply_expiry_hours')::int) <= now()
 ORDER BY r.approved_at;
-- (c) requests already expired, by state
SELECT state, count(*) AS n FROM subscription."CommercialChangeRequest"
 WHERE state IN ('EXPIRED', 'APPLY_EXPIRED') GROUP BY 1 ORDER BY 1;
ROLLBACK;
SQL
```

Recovery is always **a fresh request with fresh approvals** (AD-5). The expired request's payload, approvals and
audit stay as they are. Creating the fresh request for the same tenant × product expires the stale one in the
same transaction and takes the open-request slot (Q14).

## 5. A failed or stuck Stripe command (CCP-C1)

States: PENDING → DISPATCHING → PENDING_PROVIDER → CONFIRMED; DISPATCHING → RETRY_WAIT (transient, backoff
1, 2, 4 … min, capped at 6 h) or FAILED (provider refusal, or 8 attempts). A command is never deleted or
discarded. The worker runs in the sign container only with `SIGN_BILLING_COMMANDS_ENABLED=1`
(`SIGN_BILLING_COMMANDS_INTERVAL_MS`, default 60000); each tick dispatches due commands, re-fetches
PENDING_PROVIDER **and FAILED** commands (TD-C1-12) and drains the inbox.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT state, count(*) AS n FROM subscription."BillingProviderCommand" GROUP BY 1 ORDER BY 1;
SELECT id, change_request_id, step, command_kind, tenant_id, target_ref, state, attempts,
       last_error_code, next_attempt_at, lease_until, provider_accepted_at, failed_at, updated_at,
       (state = 'DISPATCHING' AND lease_until <= now()) AS lease_expired
  FROM subscription."BillingProviderCommand"
 WHERE state IN ('FAILED', 'RETRY_WAIT', 'PENDING_PROVIDER')
    OR (state = 'DISPATCHING' AND lease_until <= now())
 ORDER BY updated_at;
ROLLBACK;
SQL
```

| State | Meaning | Action |
|---|---|---|
| `RETRY_WAIT` | transient failure, backoff | none; the worker retries at `next_attempt_at` |
| `DISPATCHING` with `lease_expired = t` | a dispatcher died | none; the next claim takes the expired lease (C1-LEASE-1) |
| `PENDING_PROVIDER` | Stripe accepted it; not yet confirmed | none until 24 h; the webhook or the re-fetch confirms it. Past 24 h (`COMMAND_PENDING_PROVIDER_STUCK`): check the Stripe dashboard (read only) for the target object and escalate |
| `FAILED` | refused, or retries exhausted | below |

**FAILED.** First check whether Stripe acted anyway: the worker's re-fetch confirms a FAILED command whose
target already shows the intended state (`confirmation_source = REFETCH`). If it stays FAILED:
- **There is no operator retry path (TD-C1-7, open).** The only retry is the service method
  `BillingCommandService.retryFailed` (FAILED → PENDING, attempts kept), which has no route, no CLI and writes
  no `CommercialAuditEvent` row. Do not `UPDATE` the row to PENDING by SQL.
- Escalate to the Lead and PO with the command row and the provider error. Any retry needs a PO decision and a
  manual evidence record (the system writes none). The dry run proved the engineering path end to end on a
  local database (FAILED → retryFailed → dispatched → re-fetch CONFIRMED) and that it adds 0 audit rows.
- Never change the Stripe object by hand in the dashboard as a substitute: the command would then be confirmed
  by a re-fetch with no governed record of who acted.

## 6. A webhook inbox failure

Statuses RECEIVED → PROCESSING → PROCESSED (terminal) or FAILED. A processing failure is recorded FAILED and
rethrown, so the route answers 5xx and Stripe redelivers. The worker drain retries FAILED rows whose backoff is
due while `attempts < 10`, plus RECEIVED rows and expired PROCESSING leases.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT status, count(*) AS n FROM subscription."BillingWebhookInbox" GROUP BY 1 ORDER BY 1;
SELECT provider_event_id, event_type, product_key, status, attempts, next_attempt_at, lease_until,
       left(last_error, 120) AS last_error, received_at,
       (attempts >= 10) AS needs_provider_redelivery
  FROM subscription."BillingWebhookInbox"
 WHERE status = 'FAILED' OR (status = 'PROCESSING' AND lease_until <= now()) OR status = 'RECEIVED'
 ORDER BY received_at;
ROLLBACK;
SQL
```

- `attempts < 10`: none; fix the cause (usually the provider re-fetch) and the drain processes it after the
  backoff. A later redelivery of the same event is `DUPLICATE`.
- `needs_provider_redelivery = t` (10 or more attempts): the drain no longer takes it (TD-C1-13). After fixing the
  cause, the PO (or the engineer holding Stripe dashboard access) resends that one event (its `provider_event_id`) to the
  Aramo webhook endpoint from the Stripe dashboard. This is a provider redelivery, not a local edit. A redelivery processes a FAILED row whatever its
  attempts. Never `DELETE` or `UPDATE` the row (the trigger refuses both; `attempts` cannot be reset).
- Inbox and `BillingEvent` rows have no retention rule yet (TD-C1-11).

## 7. Usage NOT_RECONCILED (CCP-D1 rebuild)

The roll-ups are **derived**; the `AllowanceUsage` ledger is the authority and is never written by the roll-up.
Analytics routes refuse (`409 USAGE_ROLLUP_NOT_RECONCILED`) until totals reconcile.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT DISTINCT ON (metric_key) metric_key, mode, reconciliation, mismatch_count, pending_bucket_count, started_at, finished_at
  FROM subscription."UsageRollupRun" ORDER BY metric_key, started_at DESC, id DESC;
ROLLBACK;
SQL
```

```bash
# read-only status (prints the mismatches; writes nothing)
sudo docker run --rm --network aramo-singlebox_default -v /opt/aramo:/repo -w /repo -e DATABASE_URL="$DBURL" \
  node:22-bookworm npm run -s usage:rollup -- --reconcile-only
# rebuild every derived row (PO-authorized; writes only roll-up tables and the run log)
sudo docker run --rm --network aramo-singlebox_default -v /opt/aramo:/repo -w /repo -e DATABASE_URL="$DBURL" \
  node:22-bookworm npm run -s usage:rollup -- --rebuild
```

(`DBURL` is built as in `RUNBOOK-ccp-migration-validation.md` §3 P3; never echo it.) Exit codes: 0 RECONCILED,
1 NOT_RECONCILED / NOT_RUN / BUSY / CONFLICT, 2 fatal. A concurrent run returns BUSY (advisory lock
`ccp-d1:usage-rollup`); wait and re-run. If a rebuild is still NOT_RECONCILED with `ROLLUP_USAGE_EVENT` or
raw-event mismatches, the ledger and `metering."UsageEvent"` disagree: HALT and escalate (D1 HALT row: totals do
not reconcile). The worker (`CCP_USAGE_ROLLUP_ENABLED=1`) can be left off; disabling it is the D1 recovery.

## 8. A held activation (Conv. C-7, C-8)

A self-service activation that would end an open governed (MANUAL) row is held: no SELF_SERVICE row, the governed
row unchanged, a `BillingReconciliationFlag` with reason `governed_subscription_open`, the `BillingEvent`
IGNORED, the `CheckoutIntent` still CREATED. **The provider subscription may be live and charging.** The tenant
sees only "Subscription activation pending — contact support" (TD-A6-R-3).

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT f.tenant_id, f.subscription_ref, f.intent_id, f.detected_at,
       (SELECT string_agg(ts.source || ':' || ts.status, ',') FROM subscription."TenantSubscription" ts
         WHERE ts.tenant_id = f.tenant_id AND ts.ended_at IS NULL) AS open_rows,
       (SELECT ci.status FROM subscription."CheckoutIntent" ci WHERE ci.id = f.intent_id) AS intent_status,
       (SELECT count(*) FROM subscription."CommercialChangeRequest" r
         WHERE r.tenant_id = f.tenant_id AND r.action_type = 'CONVERSION'
           AND r.state IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED')) AS open_conversions
  FROM subscription."BillingReconciliationFlag" f
 WHERE f.reason = 'governed_subscription_open' AND f.resolved_at IS NULL
 ORDER BY f.detected_at;
ROLLBACK;
SQL
```

Resolve only through C2 (C-9, C-11…C-13), as a CONVERSION change request (Finance-only chain, TD-A3-2),
requested by commercial_ops and applied by the same requester:

| The PO decides the tenant should | Payload | Result |
|---|---|---|
| move to self-service (keep the paid provider subscription) | `{direction: TO_SELF_SERVICE, governed_subscription_id, plan_key, plan_version_id, release_expires_at (≤ 30 days), held_subscription_ref}` | the release adopts the held subscription; the re-fetch converts it in one transaction (governed row ended, SELF_SERVICE row opened, flag resolved, intent COMPLETED) — C2-C8-1 |
| stay governed (end the provider subscription) | `{direction: TO_GOVERNED, held_subscription_ref, governed_subscription_id}` | a durable `cancel_held_activation` command; the flag stays open until the webhook-confirmed end resolves it; the governed row is untouched — C2-C8-2 (see §2 while it waits) |

A release that expires before it is used leaves the activation held (C2-C8-3; `expireReleases` has no scheduled
caller, TD-C2-11, so expiry is enforced when the release is used). Refunds or credits for the held period are not
delivered (C4 NOT DELIVERED); record the PO's financial decision separately. Never end the governed row, resolve the
flag or edit the intent by SQL.

## 9. Policy rollback (re-activate the prior version)

A later policy version is rolled back by **re-activating the prior (RETIRED) version through POLICY_ACTIVATE**:
there is no SUPERSEDED state and no other activation path.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT id, version_number, status, content_checksum, activated_at, retired_at
  FROM subscription."CommercialPolicyVersion" ORDER BY version_number;
SELECT id, state, requested_by, payload->>'policy_version_id' AS target, apply_attempts, applied_at
  FROM subscription."CommercialChangeRequest" WHERE action_type = 'POLICY_ACTIVATE' ORDER BY created_at;
ROLLBACK;
SQL
```

1. A finance_admin creates POLICY_ACTIVATE with payload `{policy_version_id: <the prior version>}` (the server
   fills `target_content_checksum`), reason and evidence; submits it. Only one POLICY_ACTIVATE may be open.
2. Chain **Finance → Owner** (Q1): a different finance_admin signs step 0, a platform_owner signs step 1. One
   person never fills two steps.
3. **The requester applies** (`POST …/{id}/apply`); approvers are refused `not_requester`. APPROVED → APPLYING
   → APPLIED in one transaction (TD-B5-1): the target becomes ACTIVE, the current version RETIRED, and the
   activation event records `rollback: true` and `replaces: <the retired version>`.
4. Requests already open keep the policy version they snapshotted (NC-5). Only new requests use the re-activated
   version.

## 10. Evidence to record

For every recovery: the alert or query output before, the action (who, route, request id), the output after,
and, for §5 and §8, the PO decision. Store it in the incident evidence folder (`OneDrive/Aramo/documents/…`).
