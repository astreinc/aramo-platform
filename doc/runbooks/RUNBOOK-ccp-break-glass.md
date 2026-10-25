# Runbook — CCP break-glass (Conversion Rule C-15; A9 platform last-owner guard)

> **Design approval is not production migration authority (ruling A0-C15).** This runbook authorizes
> nothing. **Every break-glass use needs its own, explicit, written PO authorization** for one named
> operation, recorded before anything runs. Without it, stop.

**Status:** operator procedure (CCP-D5). **Owner:** the PO (authorizes); a platform engineer with box
superuser access (executes); the Lead (second person present, reviews the evidence).
**Governing text:** `Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` C-8, C-14,
C-15, C-21…C-23; Program Build Directive §12; `Aramo-T2-F1-H3-Production-Platform-Owner-Bootstrap-Directive-Amendment-A1-CCP-Confirmation-v1_0-LOCKED.md`
A1-4; ROLES-1 break-glass precedent (`doc/runbooks/tenant-last-owner-invariant.md`).
**Dry run:** `doc/ccp/runbook-dry-runs-20261025.md` §3.

## 1. The rule, as LOCKED

> **C-15.** No conversion path, console action, script or SQL outside C-11 may end, re-source or re-point a
> governed subscription. Break-glass is covered by the CCP recovery runbook (D5) under PO authorization only.

(Conversion Rule §3.4.) C-11 is the governed change request. This runbook is the D5 break-glass that C-15
names; `RUNBOOK-ccp-recovery.md` routes here. Related LOCKED text that every break-glass keeps:

> **C-8** … The provider subscription may be live and charging while held. The hold therefore MUST NOT be
> resolved by any local data edit that implies the Stripe side changed (§3.7).

> **C-23.** An external financial change MUST NOT be reported as committed on local commit alone.

**Never a SQL edit implying a Stripe change.** Break-glass never touches a provider-linked (Stripe-owned) row, a
`BillingReconciliationFlag`, a `CheckoutIntent`, a `BillingEvent`, a `BillingProviderCommand`, a
`BillingWebhookInbox` row or a `CommercialConversionRelease`. A Stripe-side change goes only through a C1 durable
command (C-22). History is never deleted or rewritten (C-14).

## 2. Part A — ending one governed subscription (C-15)

### 2.1 When (all must hold)

1. The governed path (C-11: a SUBSCRIPTION_END change request, Finance-only chain, applied by its requester) cannot
   run in the time the harm requires — for example platform-admin is down, a defect blocks the apply, or the chain
   cannot be satisfied by eligible distinct humans (NC-4 / Q5).
2. Leaving the governed row open causes harm the PO names (for example a tenant that must stop sending at once).
3. The row is **MANUAL**, open, **not provider-linked**, **not linked to an enterprise contract** (B4), and the tenant has
   **no open reconciliation flag**, **no other open row for the product**, **no open change request** for the tenant ×
   product and **no unconfirmed Stripe command**. The SQL below refuses otherwise.
4. The PO has authorized, in writing, exactly this tenant, this subscription id and this operation.

Break-glass covers **one operation only: ending one governed MANUAL row**, with the governed apply's own
semantics (`ended_at = now()`, `status` ACTIVE → CANCELED; the entitlement is not revoked, C-20 / A7). Opening,
changing, re-sourcing or re-pointing a row is **not** a break-glass operation: HALT and use C-11.

### 2.2 Who

| Role | Person | Duty |
|---|---|---|
| Authorizer | the PO | writes the authorization: tenant id, subscription id, reason, the harm, the evidence location |
| Executor | platform engineer with box superuser access | runs §2.4 exactly; changes nothing else |
| Second person | the Lead | present during the run; reviews the before/after evidence |

No commercial role holder executes it: break-glass is not a substitute for a missing approver.

### 2.3 Evidence required before the run

- The PO authorization reference (`po_ref`), recorded in the evidence folder (`OneDrive/Aramo/documents/…`).
- Why C-11 could not be used (§2.1 condition 1), and the harm (condition 2).
- `RUNBOOK-ccp-recovery.md` §2–§8 queries for the tenant (open requests, commands, flags), showing all clear.
- A fresh backup (`RUNBOOK-ccp-migration-validation.md` §3 P1).

### 2.4 Procedure

One transaction. It takes the shared billing lock (`pg_advisory_xact_lock(hashtextextended('billing:' || tenant_id, 0))`,
Conversion Rule §3.1), re-checks every §2.1 condition under the lock, prints the before image, ends the row,
writes one `CommercialAuditEvent` (`COMMERCIAL_BREAK_GLASS_SUBSCRIPTION_ENDED`, `is_exception = true`) and prints
the after image. Any refusal rolls everything back.

```bash
cat > /tmp/ccp-break-glass-end.sql <<'SQL'
-- CCP break-glass (Conv. C-15): end ONE governed MANUAL subscription row, PO-authorized.
-- Variables (psql -v): tenant_id, subscription_id, po_ref, operator, evidence, reason.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('ccp_bg.tenant_id', :'tenant_id', true),
       set_config('ccp_bg.subscription_id', :'subscription_id', true),
       set_config('ccp_bg.po_ref', :'po_ref', true),
       set_config('ccp_bg.evidence', :'evidence', true);
SELECT pg_advisory_xact_lock(hashtextextended('billing:' || :'tenant_id', 0));
DO $$
DECLARE
  s subscription."TenantSubscription"%ROWTYPE;
  t uuid := current_setting('ccp_bg.tenant_id')::uuid;
BEGIN
  IF length(trim(current_setting('ccp_bg.po_ref'))) < 3 OR length(trim(current_setting('ccp_bg.evidence'))) < 3 THEN
    RAISE EXCEPTION 'break-glass refused: a PO authorization reference and an evidence location are required';
  END IF;
  SELECT * INTO s FROM subscription."TenantSubscription"
   WHERE id = current_setting('ccp_bg.subscription_id')::uuid AND tenant_id = t FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'break-glass refused: no such subscription for this tenant'; END IF;
  IF s.ended_at IS NOT NULL THEN RAISE EXCEPTION 'break-glass refused: the row is already ended (an ended row is never reopened)'; END IF;
  IF s.source <> 'MANUAL' THEN RAISE EXCEPTION 'break-glass refused: source % is not a governed MANUAL row', s.source; END IF;
  IF s.billing_provider IS NOT NULL OR s.billing_subscription_ref IS NOT NULL THEN
    RAISE EXCEPTION 'break-glass refused: the row is provider-linked (Stripe-owned operations go through C1 commands only)';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."Contract" c WHERE c.tenant_subscription_id = s.id) THEN
    RAISE EXCEPTION 'break-glass refused: an enterprise contract is linked to this row (B4); a contract ends only through SUBSCRIPTION_END';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."BillingReconciliationFlag" f WHERE f.tenant_id = t AND f.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'break-glass refused: an open reconciliation flag exists for the tenant (a provider subscription may be live); resolve it through C2';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."TenantSubscription" o
              WHERE o.tenant_id = t AND o.product_key = s.product_key AND o.ended_at IS NULL AND o.id <> s.id) THEN
    RAISE EXCEPTION 'break-glass refused: another open row exists for this tenant and product';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."CommercialChangeRequest" r
              WHERE r.tenant_id = t AND r.product_key = s.product_key
                AND r.state IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'APPLYING', 'APPLY_FAILED')) THEN
    RAISE EXCEPTION 'break-glass refused: an open change request exists for this tenant and product; complete, withdraw or let it expire first';
  END IF;
  IF EXISTS (SELECT 1 FROM subscription."BillingProviderCommand" c WHERE c.tenant_id = t AND c.state <> 'CONFIRMED') THEN
    RAISE EXCEPTION 'break-glass refused: an unconfirmed Stripe command exists for the tenant';
  END IF;
END
$$;
SELECT row_to_json(ts)::text AS before_image FROM subscription."TenantSubscription" ts WHERE ts.id = :'subscription_id';
UPDATE subscription."TenantSubscription"
   SET ended_at = now(), status = CASE WHEN status = 'ACTIVE' THEN 'CANCELED' ELSE status END
 WHERE id = :'subscription_id' AND tenant_id = :'tenant_id' AND ended_at IS NULL AND source = 'MANUAL';
INSERT INTO subscription."CommercialAuditEvent"
  (id, actor_id, actor_type, actor_role_keys, event_type, is_exception, tenant_id, subject,
   change_request_id, policy_version_id, payload, correlation_id)
SELECT gen_random_uuid(), NULL, 'system', ARRAY[]::text[], 'COMMERCIAL_BREAK_GLASS_SUBSCRIPTION_ENDED', true,
       ts.tenant_id, 'tenant_subscription:' || ts.id, NULL,
       (SELECT pv.id FROM subscription."CommercialPolicyVersion" pv WHERE pv.status = 'ACTIVE'),
       jsonb_build_object(
         'exception_kind', 'BREAK_GLASS',
         'instrument', 'Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0 C-15',
         'po_authorization_ref', :'po_ref',
         'executed_by', :'operator',
         'evidence', :'evidence',
         'reason', :'reason',
         'subscription_id', ts.id,
         'source', ts.source,
         'from_plan_version_id', ts.plan_version_id,
         'effective_at', ts.ended_at),
       'ccp-d5-break-glass:' || ts.id
  FROM subscription."TenantSubscription" ts
 WHERE ts.id = :'subscription_id' AND ts.ended_at IS NOT NULL;
SELECT row_to_json(ts)::text AS after_image FROM subscription."TenantSubscription" ts WHERE ts.id = :'subscription_id';
SELECT event_type, is_exception, payload->>'po_authorization_ref' AS po_ref
  FROM subscription."CommercialAuditEvent"
 WHERE subject = 'tenant_subscription:' || :'subscription_id' AND event_type = 'COMMERCIAL_BREAK_GLASS_SUBSCRIPTION_ENDED';
COMMIT;
SQL
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v tenant_id=<tenant uuid> -v subscription_id=<subscription uuid> \
  -v po_ref="<PO authorization reference>" -v operator="<executor name>" \
  -v evidence="<evidence folder path>" -v reason="<one-line reason>"' < /tmp/ccp-break-glass-end.sql
rm /tmp/ccp-break-glass-end.sql
```

Refusals (each prints `break-glass refused: …` and exits 3 with nothing changed): no PO reference or evidence
location; no such row for the tenant; already ended (never reopened); not MANUAL; provider-linked; contract-linked;
open reconciliation flag; another open row for the product; an open change request; an unconfirmed Stripe command.

### 2.5 Audit

- In the database: the one `CommercialAuditEvent` row written in the same transaction (`actor_type system`,
  payload `exception_kind BREAK_GLASS`, the instrument, `po_authorization_ref`, `executed_by`, `evidence`, `reason`,
  `subscription_id`, `source`, `from_plan_version_id`, `effective_at`). It is append-only and shows in the commercial
  audit explorer (`platform:commercial:audit:read`).
- In the evidence folder: the authorization, the before and after images, the psql output, start and end times.
- Box access is attributed through CloudTrail and the key-custody record.

### 2.6 Reconciliation afterwards

1. Re-run `RUNBOOK-ccp-recovery.md` §8 and the C6 finance reconciliation report for the tenant: no SELF_SERVICE
   row, no flag, the row ended.
2. Sends for that product stop (`NOT_SUBSCRIBED`); in-flight envelopes are unaffected (C-24). The `sign` capability
   stays (C-20). A revoke, if wanted, is a governed ENTITLEMENT_REVOKE request (A7).
3. If the tenant should be served again, that is a **new governed SUBSCRIPTION_OPEN request** (C-11), never a reopen.
4. The Lead and the PO review the evidence and record, in `doc/ccp/decisions.md`, why the governed path could not run
   and what fixes it, so the same break-glass is not needed again.

## 3. Part B — the A9 platform last-owner guard (A1-4)

The platform must keep at least one effective `platform_owner` (five `ccp_a9_platform_last_owner_*` triggers,
`ENABLE ALWAYS`, no GUC or skip flag). A1-4: "The only break-glass is the documented superuser trigger-disable
runbook, PO-authorized, following ROLES-1 `:92`." Use it only when the normal hand-over (grant another owner
first, through ROLE_GRANT) is impossible, for one PO-authorized identity operation.

**Capture (before and after):**

```bash
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT c.relname, tg.tgname, tg.tgenabled FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid
 WHERE tg.tgname LIKE 'ccp_a9_platform_last_owner_%' AND NOT tg.tgisinternal ORDER BY 2;
SELECT count(*) AS effective_platform_owners
  FROM identity."UserTenantMembershipRole" r
  JOIN identity."UserTenantMembership" m ON m.id = r.membership_id
  JOIN identity."User" u ON u.id = m.user_id
  JOIN identity."Role" ro ON ro.id = r.role_id
 WHERE m.tenant_id = '01900000-0000-7000-8000-000000000100' AND m.is_active AND u.is_active AND ro.key = 'platform_owner';
ROLLBACK;
SQL
```

Expect 5 rows, all `A`, before; record the owner count.

**The window — one transaction.** Unlike the ROLES-1 procedure (disable, operate, re-enable in separate steps),
the disable, the authorized operation and the re-arm are one transaction: `ALTER TABLE … DISABLE TRIGGER` is
transactional, so no other session ever sees the guard off, and any failure rolls the disable back with the rest
(dry run BG-B5). Put the authorized operation, verbatim from the PO authorization, between the two parts:

```bash
cat > /tmp/ccp-a9-window.sql <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "identity"."UserTenantMembershipRole" DISABLE TRIGGER "ccp_a9_platform_last_owner_role_delete";
ALTER TABLE "identity"."UserTenantMembershipRole" DISABLE TRIGGER "ccp_a9_platform_last_owner_role_update";
ALTER TABLE "identity"."UserTenantMembership" DISABLE TRIGGER "ccp_a9_platform_last_owner_membership_delete";
ALTER TABLE "identity"."UserTenantMembership" DISABLE TRIGGER "ccp_a9_platform_last_owner_membership_update";
ALTER TABLE "identity"."User" DISABLE TRIGGER "ccp_a9_platform_last_owner_user_update";
-- >>> the ONE PO-authorized operation, verbatim from the authorization, goes here <<<
<the ONE authorized statement>
-- <<< end of the authorized operation >>>
ALTER TABLE "identity"."UserTenantMembershipRole" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_role_delete";
ALTER TABLE "identity"."UserTenantMembershipRole" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_role_update";
ALTER TABLE "identity"."UserTenantMembership" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_membership_delete";
ALTER TABLE "identity"."UserTenantMembership" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_membership_update";
ALTER TABLE "identity"."User" ENABLE ALWAYS TRIGGER "ccp_a9_platform_last_owner_user_update";
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'ccp_a9_platform_last_owner_%' AND NOT tgisinternal AND tgenabled = 'A') <> 5 THEN
    RAISE EXCEPTION 'A9 break-glass: the guard is not fully re-armed; nothing is committed';
  END IF;
END
$$;
SELECT count(*) FILTER (WHERE tgenabled = 'A') AS armed, count(*) AS total
  FROM pg_trigger WHERE tgname LIKE 'ccp_a9_platform_last_owner_%' AND NOT tgisinternal;
COMMIT;
SQL
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /tmp/ccp-a9-window.sql
rm /tmp/ccp-a9-window.sql
```

The last query must print `armed = 5, total = 5` before `COMMIT`. If the session is lost before `COMMIT`,
PostgreSQL rolls everything back. If the triggers are ever found not `A`, re-arm by replaying the migration
(idempotent: `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, `ENABLE ALWAYS`):

```bash
cd /opt/aramo
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q' \
  < libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql
```

Never re-arm with a plain `ENABLE TRIGGER` (that restores origin-only mode, which `session_replication_role = replica`
silences). An image rollback does not remove these triggers.

**After it.** The bootstrap is permanently inert once it has run (A1-2): with zero owners, the bootstrap command is
refused `ALREADY_BOOTSTRAPPED` (dry run). A platform left with no owner cannot approve role changes; record the
recovery plan with the Lead before the window, not after.

**Audit.** PostgreSQL writes no audit row for `ALTER TABLE … DISABLE TRIGGER`. Record the authorization, the
captures before and after, the exact statement, the owner count per step and the times in the evidence folder.
