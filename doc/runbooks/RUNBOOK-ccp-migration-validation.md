# Runbook — CCP migration validation (the 27 CCP migrations)

> **Design approval is not production migration authority (ruling A0-C15).** Approving the CCP
> schema designs, this runbook or any CCP instrument does not authorize running a migration against
> production (`Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §2.6, §7.5).
> **Every production step below needs its own, separate PO authorization**, recorded before the
> step runs. This runbook authorizes nothing by itself.

**Status:** operator procedure (CCP-D5). **Owner:** platform on-call, under the release lead.
**Governing text:** Program Build Directive §5.4 row D5, §7.3, §7.5, §12; Conversion Rule
`Aramo-CCP-Sign-Billing-Manual-Subscription-Conversion-Rule-v1_0-LOCKED.md` C-16, C-17;
Charter Amendment A1 (apply deadline). **Migration list:** `doc/ccp/program-gate-20261025.md` §6.
**Box mechanics:** `doc/runbooks/RELEASE-box.md` (compose `-p aramo-singlebox -f docker-compose.prod.yml`;
box git and docker need `sudo`; build ≠ recreate; `nginx -t` in its own ssh call).
**Dry run:** `doc/ccp/runbook-dry-runs-20261025.md` §1 (every command below, with its real output).

## 1. What this covers

The CCP program ships 27 migrations (21 at the program gate; 6 more from merge train 2: CCP-C4, CCP-C7,
CCP-R3's alert type and Finance amount scope, and the integrator-owned command-guard and alert-type unions). They are applied **before any CCP code is built or recreated**
(`deploy/migrate-prod.sh` runs after `git pull` and before the image build, `RELEASE-box.md` STEP 3).

| # | Migration | Compensation (documented, not shipped) | Form |
|---|---|---|---|
| 1 | `identity/20261024120000_ccp_a1_commercial_role_catalog` | `libs/identity/src/tests/fixtures/ccp-a1-compensating.sql` | SQL file |
| 2 | `subscription/20261024180000_ccp_a2_commercial_audit_policy` | `libs/subscription/src/tests/fixtures/ccp-a2-compensating.sql` | SQL file |
| 3 | `subscription/20261025120000_ccp_a3_change_request_approval` | `libs/subscription/src/tests/fixtures/ccp-a3-compensating.sql` | SQL file |
| 4 | `subscription/20261025140000_ccp_a4_product_dimension` | `libs/subscription/src/tests/fixtures/ccp-a4-compensating.sql` | SQL file |
| 5 | `subscription/20261025160000_ccp_a5_plan_version` | `libs/subscription/src/tests/fixtures/ccp-a5-compensating.sql` | SQL file |
| 6 | `identity/20261025180000_ccp_a9_platform_last_owner_invariant` | `libs/identity/src/tests/fixtures/ccp-a9-compensating.sql` | SQL file |
| 7 | `subscription/20261025180100_ccp_a9_role_change_apply_bootstrap` | `libs/subscription/src/tests/fixtures/ccp-a9-compensating.sql` | SQL file |
| 8 | `subscription/20261025200000_ccp_a6_transactional_apply` | `libs/subscription/src/tests/fixtures/ccp-a6-compensating.sql` | SQL file |
| 9 | `subscription/20261025220000_ccp_b2_catalog_apply` | `libs/subscription/src/tests/fixtures/ccp-b2-compensating.sql` | SQL file |
| 10 | `subscription/20261025240000_ccp_d1_usage_rollups` | `libs/subscription/src/tests/fixtures/ccp-d1-compensating.sql` | SQL file |
| 11 | `entitlement/20261026000000_ccp_a7_entitlement_revoke_provenance` | `libs/entitlement/src/tests/fixtures/ccp-a7-compensating.sql` | SQL file |
| 12 | `subscription/20261026000100_ccp_a7_entitlement_revoke_apply` | `libs/subscription/src/tests/fixtures/ccp-a7-compensating.sql` | SQL file |
| 13 | `subscription/20261026010000_ccp_a8_support_extension_overlay` | `libs/subscription/src/tests/fixtures/ccp-a8-compensating.sql` | SQL file |
| 14 | `subscription/20261026020000_ccp_c1_stripe_command_inbox` | `libs/subscription/src/tests/fixtures/ccp-c1-compensating.sql` | SQL file |
| 15 | `subscription/20261026030000_ccp_b4_enterprise_contracts` | `libs/subscription/src/tests/fixtures/ccp-b4-compensating.sql` | SQL file |
| 16 | `subscription/20261026050000_ccp_a6r_apply_deadline` | `libs/subscription/src/tests/fixtures/ccp-a6r-compensating.sql` | SQL file |
| 17 | `subscription/20261026060000_ccp_c2_conversion` | `libs/subscription/src/tests/fixtures/ccp-c2-compensating.sql` | SQL file |
| 18 | `subscription/20261026090000_ccp_d3_operational_alerts` | `libs/subscription/src/tests/fixtures/ccp-d3-compensating.sql` | SQL file |
| 19 | `subscription/20261027000000_ccp_guard_union` | `libs/subscription/src/tests/fixtures/ccp-guard-union-compensating.sql` | SQL file |
| 20 | `subscription/20261027000100_ccp_constraint_union` | `libs/subscription/src/tests/fixtures/ccp-constraint-union-compensating.sql` | SQL file |
| 21 | `subscription/20261027000200_ccp_b5r_policy_activate_apply` | `libs/subscription/src/tests/fixtures/ccp-b5r-compensating.sql` | SQL file |
| 22 | `subscription/20261028010000_ccp_c4_billing_adjustments` | `libs/subscription/src/tests/fixtures/ccp-c4-compensating.sql` | SQL file |
| 23 | `subscription/20261028030000_ccp_c7_self_service_commands` | `libs/subscription/src/tests/fixtures/ccp-c7-compensating.sql` | SQL file |
| 24 | `subscription/20261028050000_ccp_r3_entitlement_alert` | `libs/subscription/src/tests/fixtures/ccp-r3-alert-compensating.sql` | SQL file |
| 25 | `identity/20261028060000_ccp_a1a1_finance_amount_scope` | `libs/identity/src/tests/fixtures/ccp-a1a1-compensating.sql` | SQL file |
| 26 | `subscription/20261029000000_ccp_command_guard_union` | `libs/subscription/src/tests/fixtures/ccp-command-guard-union-compensating.sql` | SQL file |
| 27 | `subscription/20261029000100_ccp_alert_type_union` | `libs/subscription/src/tests/fixtures/ccp-alert-type-union-compensating.sql` | SQL file |

All 27 have an executable compensating SQL file (CCP-FIX1 wrote the 14 that were prose; merge train 2 added
the R3 alert and the two new unions). The full reverse chain 27 → 1 and the re-apply are proven with 0 errors
on a fresh Postgres 17 by `libs/subscription/src/tests/ccp-full-compensation-chain.integration.spec.ts` (§6).

## 2. HALT conditions (stop and report; do not improvise)

- No recorded PO authorization for this production migration (A0-C15).
- The box HEAD is not the authorized `TARGET_SHA` (`RELEASE-box.md` STEP 1).
- No verified backup (§3, P1).
- The pending set (§3, P2) is not exactly the CCP migrations, **or** it contains any non-CCP migration
  without its own authorization. Two known cases:
  - **ATI-SEP-1** (`talent-record/20261024170000_ati_sep_1_drop_legacy_trust_schemas`, the destructive drop,
    G-073) sorts between CCP-A1 and CCP-A2. A bounded run cannot skip it. If it is pending, the CCP apply
    HALTs until the PO decides the ATI-SEP-1 drop separately.
  - **`origin/main` after the program branch was cut** (at `ac24e234`): `auth-storage/20261025120000_native_device_sessions`
    sorts between CCP-A2 and CCP-A3, and the four `sign/20261026100000…100300_sign_mobile_*` migrations sort
    between CCP-D3 and the guard union. After the sync-forward they are in the same global order. Each needs
    its own release authority or must already be applied.
- The Talent Intelligence database has pending migrations (`deploy/migrate-prod.sh` applies them after the
  shared database). That is ATI-SEP-1 scope, not CCP.
- The `.env` has no `INTELLIGENCE_DB_USER=` line (§4, known defect D5-DEF-1).
- TD-A1-1 pre-check (P4) shows any A1 id or key already present, or `platform:tenant:read` missing.
- C-16(a) (P5) returns any row (Conversion Rule C-17: each row needs a PO-recorded disposition first).
- Any post-check (§5) differs from its expected value.

## 3. Pre-checks (all read-only)

Run on the box from `/opt/aramo`. `PG` below means:

```bash
PG() { sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'; }
```

**P1 — backup (precondition; `RELEASE-box.md` STEP 2).** `deploy/migrate-prod.sh` does not take one.

```bash
sudo docker exec aramo-prod-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  | sudo tee /opt/aramo/pre-ccp-migration-backup-$(date +%Y%m%d-%H%M%S).sql > /dev/null
ls -l /opt/aramo/pre-ccp-migration-backup-*.sql | tail -1
sudo grep -c 'PostgreSQL database dump complete' "$(ls -t /opt/aramo/pre-ccp-migration-backup-*.sql | head -1)"
```

Expect a non-zero size and `1`. Use `grep -c`, not `tail -1`: with `pg_dump` 17 the last line is a
`\unrestrict …` line, so the `tail -1` check in `RELEASE-box.md` STEP 2 no longer shows the completion marker
(dry run §1.1). The Talent Intelligence database (`aramo_intelligence`) is not in this dump (G-082); CCP does
not touch it.

**P2 — ledger status and the exact pending set.**

```bash
ls -d libs/*/prisma/migrations/*/ | grep -v '^libs/intelligence-core/' | sort > /tmp/ccp-ondisk.txt
sudo docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "SELECT name FROM public._local_migrations"' | sort > /tmp/ccp-ledger.txt
comm -23 /tmp/ccp-ondisk.txt /tmp/ccp-ledger.txt | awk -F/ '{print $(NF-1)"\t"$0}' | sort | cut -f2 > /tmp/ccp-pending.txt
cat /tmp/ccp-pending.txt
echo "pending=$(wc -l < /tmp/ccp-pending.txt) ccp=$(grep -c _ccp_ /tmp/ccp-pending.txt) non_ccp=$(grep -vc _ccp_ /tmp/ccp-pending.txt)"
```

Expect the 27 names of §1 in that order and `non_ccp=0`, unless the PO has separately authorized the
non-CCP names listed. Any other result is a HALT.

**P3 — the read-only fact-check (CCP-A11).** It refuses a non-local database unless it is given a
PO authorization reference, and connects to nothing when it refuses.

```bash
DBURL="postgresql://$(sudo grep -E '^POSTGRES_USER=' .env | tail -1 | cut -d= -f2-):$(sudo grep -E '^POSTGRES_PASSWORD=' .env | tail -1 | cut -d= -f2-)@postgres:5432/$(sudo grep -E '^POSTGRES_DB=' .env | tail -1 | cut -d= -f2-)"
sudo docker run --rm --network aramo-singlebox_default -v /opt/aramo:/repo -w /repo -e DATABASE_URL="$DBURL" \
  node:22-bookworm npm run -s ccp:astre-fact-check -- --po-authorization-ref "<PO authorization reference>"
unset DBURL
```

Never echo `DBURL`. Record the output: schema stage `pre-CCP`; (3) Astre's one MANUAL row; (6) the identity
catalog counts (TD-A1-1: production was 19 / 194 / 973 at A1 pre-execution).

**P4 — TD-A1-1 catalog pre-check.** The A1 migration is fixed-id and fail-closed (one `DO` block; any `RAISE`
applies nothing). This confirms in advance that none of its ids or keys exists.

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT (SELECT count(*) FROM identity."Role") AS roles,
       (SELECT count(*) FROM identity."Scope") AS scopes,
       (SELECT count(*) FROM identity."RoleScope") AS role_scopes;
SELECT count(*) AS a1_ids_or_keys_already_present FROM (
  SELECT id FROM identity."Role"
   WHERE id BETWEEN '01900000-0000-7000-8000-0000000002c0' AND '01900000-0000-7000-8000-0000000002c5'
      OR key IN ('platform_owner','finance_admin','commercial_ops','catalog_manager','support_admin','read_only_auditor')
  UNION ALL
  SELECT id FROM identity."Scope"
   WHERE id BETWEEN '01900000-0000-7000-8000-000000000326' AND '01900000-0000-7000-8000-000000000334'
      OR key IN ('platform:catalog:read','platform:catalog:draft','platform:catalog:approve','platform:catalog:publish',
                 'platform:subscription:read','platform:subscription:request','platform:subscription:approve','platform:subscription:support',
                 'platform:entitlement:request','platform:entitlement:approve',
                 'platform:billing:read','platform:billing:request','platform:billing:approve',
                 'platform:approval:read','platform:commercial:audit:read')
) x;
SELECT count(*) AS tenant_read_scope FROM identity."Scope" WHERE key = 'platform:tenant:read';
ROLLBACK;
SQL
```

Expect: the catalog counts recorded in P3; `a1_ids_or_keys_already_present = 0`; `tenant_read_scope = 1`.

**P5 — C-16 pre-cutover check (Conversion Rule C-16, C-17).**

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
-- (a) CREATED checkout intents for a tenant that holds an open MANUAL row
SELECT ci.tenant_id, ci.id, p.key, ci.created_at, (ci.provider_session_ref IS NOT NULL) AS has_session
  FROM subscription."CheckoutIntent" ci
  JOIN subscription."Plan" p ON p.id = ci.plan_id
 WHERE ci.status = 'CREATED'
   AND EXISTS (SELECT 1 FROM subscription."TenantSubscription" ts
                WHERE ts.tenant_id = ci.tenant_id AND ts.ended_at IS NULL AND ts.source = 'MANUAL');
-- (b) open subscription rows by source and status
SELECT source, status, count(*) AS n FROM subscription."TenantSubscription" WHERE ended_at IS NULL GROUP BY 1, 2 ORDER BY 1, 2;
-- (c) open reconciliation flags by reason
SELECT reason, count(*) AS n FROM subscription."BillingReconciliationFlag" WHERE resolved_at IS NULL GROUP BY 1 ORDER BY 1;
-- (d) every tenant with an open MANUAL row
SELECT ts.tenant_id, p.key AS plan_key, ts.period_anchor, ts.status
  FROM subscription."TenantSubscription" ts JOIN subscription."Plan" p ON p.id = ts.plan_id
 WHERE ts.ended_at IS NULL AND ts.source = 'MANUAL' ORDER BY ts.tenant_id;
ROLLBACK;
SQL
```

Record all four results as gate evidence. (a) must return 0 rows; otherwise HALT (C-17).

**P6 — Astre snapshot (before).** Compare it with the snapshot after the apply (§5).

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT t.slug, ts.source, ts.status, p.key AS plan_key, ts.period_anchor, ts.started_at, ts.ended_at,
       (ts.billing_subscription_ref IS NOT NULL) AS provider_linked
  FROM subscription."TenantSubscription" ts
  JOIN subscription."Plan" p ON p.id = ts.plan_id
  JOIN identity."Tenant" t ON t.id = ts.tenant_id
 WHERE t.id = '019000a0-0000-7000-8000-000000000001' ORDER BY ts.started_at;
SELECT string_agg(capability::text, ',' ORDER BY capability::text) AS entitlements
  FROM entitlement."TenantEntitlement" WHERE tenant_id = '019000a0-0000-7000-8000-000000000001';
ROLLBACK;
SQL
```

## 4. Apply (only with the recorded PO authorization)

Known defect **D5-DEF-1**: `deploy/migrate-prod.sh:196` reads `INTELLIGENCE_DB_USER` with `read_env`
under `set -euo pipefail`. When the `.env` has no such line (it is optional and commented out in
`.env.prod.example:69`), the script exits 1 after the shared-database gate has passed, with no message
other than the generic STOP banner. The shared-database migrations are then already applied and recorded,
but the Talent Intelligence step has not run. Before the apply, confirm the line exists:

```bash
sudo grep -c '^INTELLIGENCE_DB_USER=' /opt/aramo/.env   # expect 1; if 0, HALT and ask the PO to authorize adding INTELLIGENCE_DB_USER=aramo_intelligence
```

Then apply, bounded at the last CCP migration:

```bash
cd /opt/aramo
sudo bash deploy/migrate-prod.sh --until 20261029000100_ccp_alert_type_union
```

**Gate:** `db:sync:local — 27 applied`, then `pending-before-stop — 0`, `verified — no migration beyond the
stop point was applied by this run`, `[migrate] OK — zero pending …`, and `[migrate] Safe to build + recreate
containers.` Any `FAILED <name>` stops the run: each migration is applied with `--single-transaction`, so the
failing one left nothing, and every earlier one is applied and recorded. Do not build or recreate; go to §6.

## 5. Post-checks (read-only)

```bash
PG <<'SQL'
BEGIN TRANSACTION READ ONLY;
-- Q1 identity catalog after A1 + A1-A1: +6 roles, +16 scopes, +48 role-scopes
SELECT (SELECT count(*) FROM identity."Role") AS roles,
       (SELECT count(*) FROM identity."Scope") AS scopes,
       (SELECT count(*) FROM identity."RoleScope") AS role_scopes,
       (SELECT count(*) FROM identity."Role" WHERE id BETWEEN '01900000-0000-7000-8000-0000000002c0' AND '01900000-0000-7000-8000-0000000002c5') AS ccp_roles;
-- Q2 nobody holds a commercial role yet (no grant ships with the migrations)
SELECT count(*) AS commercial_role_grants
  FROM identity."UserTenantMembershipRole" mr
 WHERE mr.role_id BETWEEN '01900000-0000-7000-8000-0000000002c0' AND '01900000-0000-7000-8000-0000000002c5';
-- Q3 commercial policy: exactly one version, v1 ACTIVE
SELECT version_number, status, content_checksum FROM subscription."CommercialPolicyVersion" ORDER BY version_number;
-- Q4 every open subscription carries a product key and a pinned plan version
SELECT product_key, source, status, count(*) AS n,
       count(*) FILTER (WHERE plan_version_id IS NULL) AS unpinned
  FROM subscription."TenantSubscription" WHERE ended_at IS NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
-- Q5 plan versions: one PUBLISHED v1 per plan
SELECT p.key, v.version_number, v.status FROM subscription."PlanVersion" v JOIN subscription."Plan" p ON p.id = v.plan_id ORDER BY 1, 2;
-- Q6 the A9 platform last-owner guard is armed (5 triggers, all 'A')
SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'ccp_a9_platform_last_owner_%' AND NOT tgisinternal ORDER BY 1;
-- Q7 the live change-request guard is the integrator union body
SELECT (SELECT count(*) FROM regexp_matches(pg_get_functiondef('subscription.guard_commercial_change_request()'::regprocedure), '\[union block', 'g')) AS union_blocks;
-- Q8 the deferred "never commit in APPLYING" backstops exist
SELECT tgname FROM pg_trigger WHERE tgname LIKE 'commercial_change_request_%applying%' AND NOT tgisinternal ORDER BY 1;
-- Q9 dark operational tables are empty: nothing ran
SELECT (SELECT count(*) FROM subscription."CommercialChangeRequest") AS change_requests,
       (SELECT count(*) FROM subscription."BillingProviderCommand") AS provider_commands,
       (SELECT count(*) FROM subscription."BillingWebhookInbox") AS inbox_rows,
       (SELECT count(*) FROM subscription."CommercialOperationalAlert") AS alerts,
       (SELECT count(*) FROM subscription."UsageRollupRun") AS rollup_runs,
       (SELECT count(*) FROM subscription."CommercialOperatorAttestation") AS attestations,
       (SELECT count(*) FROM subscription."CommercialAuditEvent") AS audit_events,
       (SELECT count(*) FROM subscription."CommercialBillingAdjustment") AS billing_adjustments,
       (SELECT count(*) FROM subscription."SelfServiceBillingRequest") AS self_service_requests;
-- Q11 the live command guard and alert-type CHECK are the integrator unions
SELECT (SELECT count(*) FROM regexp_matches(pg_get_functiondef('subscription.guard_billing_provider_command()'::regprocedure), '>>> CCP-C(4|7)', 'g')) AS command_guard_blocks,
       (SELECT count(*) FROM regexp_matches(pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'CommercialOperationalAlert_type_check')), 'alert_type = ', 'g')) AS alert_types;
-- Q10 entitlement provenance: every row carries an explicit source
SELECT capability::text, granted_source, count(*) AS n FROM entitlement."TenantEntitlement" GROUP BY 1, 2 ORDER BY 1, 2;
ROLLBACK;
SQL
```

| Query | Expected in production |
|---|---|
| Q1 catalog | the P3 counts + 6 roles, + 16 scopes, + 48 role-scopes (A1 15 / 45 + CCP-R3's `platform:billing:amount:read` 1 / 3; from 19 / 194 / 973: 25 / 210 / 1021); `ccp_roles = 6` |
| Q2 commercial role grants | 0 (no grant ships with any migration) |
| Q3 policy | exactly one row: version 1, ACTIVE, checksum `bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5` |
| Q4 open subscriptions | every open row has `product_key = sign` and `unpinned = 0` |
| Q5 plan versions | one PUBLISHED v1 per plan |
| Q6 A9 guard | 5 triggers, all `A` |
| Q7 guard union | `union_blocks = 28` (22 at the gate + CCP-C4 2, CCP-C4-R 2, CCP-ACC-1 2) |
| Q8 APPLYING backstops | 6 triggers (`…_billing_adjustment_applying_commit`, `…_conversion_applying_commit`, `…_no_applying_commit`, `_a7`, `_a8`, `_b5r`) |
| Q9 operational tables | 0 change requests, 0 commands, 0 inbox rows, 0 alerts, 0 roll-up runs, 0 attestations, 0 billing adjustments, 0 self-service requests; 1 audit event (the A2 seed row for v1) |
| Q10 entitlement provenance | every row has an explicit `granted_source` (`MIGRATION` for pre-existing rows) |
| Q11 unions | `command_guard_blocks = 3` (2 CCP-C7 markers, 1 CCP-C4 marker; C7 alone gives 2, C4 alone 1); `alert_types = 11` |

Then:
- P5 again: the same four results as before the apply.
- P6 again: the Astre row is byte-for-byte the same (`source`, `status`, `plan_key`, `period_anchor`, `started_at`, `ended_at` null, `provider_linked` false; entitlements unchanged).
- P3 again: schema stage `CCP-A7 (present 6, absent 0)`; (3) Astre `plan_version=v1 PUBLISHED`; (7) `PUBLISHED 5`; (9) `0`.
- The A11 backfill **dry run is local only** (`npm run ccp:astre-backfill -- --dry-run`). It refuses every
  non-local URL (`DATABASE_URL_NOT_LOCAL`) and `--execute` (`EXECUTE_NOT_AUTHORIZED`). Run it against a restored
  copy of the production backup on a non-production host, never against the box.

## 6. Compensation order

A failed apply is first recovered from the P1 backup (`RELEASE-box.md` "Rollback": the backup is the floor).
A compensating SQL is used only with its own PO authorization, and only in this order: **newest first**,
27 → 1. A compensation for migration N runs only after every migration after N has been compensated.

| Step | Compensate | Form | Refused while |
|---|---|---|---|
| 1 | 27 alert-type union | file | an APPLY_DEADLINE_NEARING / APPLY_DEADLINE_PASSED alert row exists |
| 2 | 26 command-guard union | file | a CCP-C4 provider command is not CONFIRMED |
| 3 | 25 A1-A1 (identity) | file | a role other than the 3 grantees holds `platform:billing:amount:read` |
| 4 | 24 R3 alert | file | an ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION alert row exists |
| 5 | 23 C7 | file | a self-service billing request or a self-service-origin command exists |
| 6 | 22 C4 | file | a CREDIT, DISCOUNT or REFUND request, a billing-adjustment command or an adjustment record exists |
| 7 | 21 B5-R | file | a POLICY_ACTIVATE request is APPROVED, APPLYING or APPLY_FAILED |
| 8 | 20 constraint union | file | an ENTITLEMENT_REVOKE or SUPPORT_EXTENSION application row exists |
| 9 | 19 guard union | file | a request of a type whose branch the C2 body lacks is in an apply state, or any request is APPLY_EXPIRED |
| 10 | 18 D3 | file | an OPEN operational alert exists |
| 11 | 17 C2 | file | conversion state exists |
| 12 | 16 A6-R | file | an APPLY_EXPIRED request exists |
| 13 | 15 B4 | file | contract records exist |
| 14 | 14 C1 | file | an unconfirmed command or an unprocessed inbox event exists |
| 15 | 13 A8 | file | A8 state exists |
| 16 | 12, then 11 A7 | file | governed revokes exist; then revoked or commercially sourced entitlement rows exist |
| 17 | 10 D1 | file | nothing (the roll-ups are derived; the change log and run log are dropped with it) |
| 18 | 9 B2-backend | file | catalog apply state exists |
| 19 | 8 A6 | file | A6 state exists |
| 20 | 7, then 6 A9 | file | a change request is APPLYING or APPLIED; the identity half while the role-change apply path is installed |
| 21 | 5 A5 | file | a plan version other than the migration v1, a pinned provider price, re-pin history, or a row not on its plan's v1 exists |
| 22 | 4 A4 | file | a non-`sign` or non-BASE row exists, or a tenant has more than one open subscription |
| 23 | 3 A3 | file | any change request exists |
| 24 | 2 A2 | file | any audit row other than the v1 seed row exists |
| 25 | 1 A1 | file | a membership holds a CCP commercial role, or a non-CCP role holds a CCP scope |

Every compensation is executable SQL. The full chain is proven on a fresh Postgres 17: each step is refused
while its dependent data exists (nothing changed), then applies with 0 errors and restores the schema
fingerprint taken just before its migration; then all 27 migrations re-apply with 0 errors
(`ccp-full-compensation-chain.integration.spec.ts`, 30 / 30). Production recovery still starts from the P1
backup; a compensation is the reviewed alternative for one step, authorized on its own.

**The ledger.** `deploy/migrate-prod.sh` never re-runs a migration recorded in `public._local_migrations`.
A compensation therefore removes its migration's ledger row **in the same transaction**, so the next migrate
run re-applies it:

```bash
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q -f - \
  -c "DELETE FROM public._local_migrations WHERE name = '\''libs/subscription/prisma/migrations/20261027000200_ccp_b5r_policy_activate_apply/'\''"' \
  < libs/subscription/src/tests/fixtures/ccp-b5r-compensating.sql
```

Repeat with the file and ledger name of each step. Re-applying is a normal bounded migrate run (§4). Each
compensation is refused (RAISE, nothing changed) while dependent data exists (table above); it is never
forced.

## 7. Evidence to record

The PO authorization reference; the box HEAD; P1 size and marker count; P2 pending list; P3, P4, P5 and P6
outputs; the full migrate output; the §5 outputs and the P3/P5/P6 comparisons. Store them in the release
evidence folder (`OneDrive/Aramo/documents/…`), never in `Aramo/locked`.
