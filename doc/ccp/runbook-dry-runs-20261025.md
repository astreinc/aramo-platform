# CCP-D5 runbook dry runs — 2026-10-25

| | |
|---|---|
| **Slice** | CCP-D5 runbooks (Program Build Directive §5.4 row D5: "Runbook dry-runs on non-production"; evidence "Dry-run records") |
| **Worktree / branch** | `.claude/worktrees/ccp-d5`, `wip/ccp-d5`, base `41a0e3b5` (not committed, not pushed) |
| **Environment** | Local only. Docker container `ccp-d5-dryrun-pg`, image `pgvector/pgvector:pg17` (PostgreSQL 17.11), port 55417, on a local network `ccpd5dry_default` with alias `postgres`. Databases `aramo` (prod-shaped), `aramo_recovery` (recovery fixtures), `aramo_intelligence` (created by `deploy/migrate-prod.sh`), `restore_drill` (dropped after use). |
| **Production** | **Never connected.** No production host, credential or URL was used. Every "PO authorization reference" below is the literal dry-run marker `D5-DRY-RUN-NOT-PRODUCTION`. |
| **Authority** | `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` §5.4 D5; A0-C15 (design approval is not production migration authority) |

Every count below is exact and was read from that run's own output. The outputs are pasted as captured; only
the local scratch directory path is replaced by `<scratch>` and the worktree path by `<worktree>`, and single output lines longer than 600 characters
are cut (the cut is marked).

## 0. Summary

| Runbook | Steps run | Result | Defects found |
|---|---|---|---|
| `RUNBOOK-ccp-migration-validation.md` | 9 pre-check steps, 2 apply runs, 8 post-check steps, 3 compensations + 3 re-applies, 1 restore drill | 21 / 21 CCP migrations applied, 0 errors; every pre- and post-check as expected; the compensation cycle reversed and re-applied cleanly; the backup restores to the pre-CCP ledger (310 / 310, 0 CCP) | D5-DEF-1 (`deploy/migrate-prod.sh` exits 1 when `INTELLIGENCE_DB_USER` is absent); D5-OBS-1 (`RELEASE-box.md` STEP 2 `tail -1` marker check vs `pg_dump` 17) |
| `RUNBOOK-ccp-recovery.md` | 9 scenarios, 29 recorded steps, 2 alert scans | every scenario detected by its query and resolved through the product path; scan 1 raised 7 alerts, scan 2 resolved 7, 0 open | D5-DEF-2 (no governed editor path for `apply_expiry_hours`); gaps TD-C1-7, TD-C1-13, TD-D3-9, TD-C2-11 confirmed |
| `RUNBOOK-ccp-break-glass.md` | Part A 6 steps, Part B 7 steps | Part A: 4 refusals, 1 authorized end with its audit row, 2 untouched rows; Part B: guard refuses without break-glass, one-transaction window works, a failure or a missing re-arm commits nothing, replay re-arms | — |
| `RUNBOOK-ccp-platform-owner-bootstrap.md` | 22 steps + 5 (inert check) | the shipped command refuses every invocation; the bootstrap logic grants once, no-ops once, refuses 3 malformed invocations and is inert afterwards | **D5-DEF-3** (bootstrap CLI argv offset: the command cannot run) |
| `RUNBOOK-ccp-dark-state-verification.md` | 4 steps | the dark configuration classifies 7 / 7 rows as expected; a deliberately lit configuration is caught on 6 / 6 switch rows; 0 key-material leaks; the data check passes | — |
| Rendered-text re-check | 16 read-only SQL blocks extracted from the published runbooks | 16 / 16 ran (exit 0, ROLLBACK) | — |
| Supporting targeted specs | 6 spec files | 73 / 73 (libs/subscription, 5 files) + 4 / 4 (libs/identity, 1 file) | — |

## 1. Migration validation

### 1.0 Building a prod-shaped pre-CCP database

1. `tools/db-sync-local.sh` from a scratch copy of the tree **without the 21 CCP migration directories**
   (310 directories): `db:sync:local — 310 applied, 0 already present`, 0 errors. This is the drafting baseline
   `78dbd6d3` migration set (the CCP diff against it adds exactly the 21 directories).
2. The **pre-CCP** identity seeds (`seed.ts`, `seed-astre.ts`, `seed-platform-owner.ts` as at `78dbd6d3`, run from a
   temporary copy that was deleted): Astre tenant + owner, the platform sentinel tenant + `purush@aramo.ai` super_admin.
   Catalog: **19 / 190 / 939** (the seed shape; production was 19 / 194 / 973 at A1 pre-execution, TD-A1-1).
   A first attempt ran the current `seed-platform-owner.ts`, which imports the CCP-era `seed.ts` and wrote the CCP
   catalog (25 / 205 / 984); the database was dropped, restored from the empty-catalog backup and re-seeded with the
   pre-CCP files.
3. Fixture (prod-shaped, from `RELEASE-sign-standalone-billing.md` D8): Astre's MANUAL ACTIVE `aramo-sign-included-v1`
   row, period anchor 2026-10-01, no provider link; entitlements `core`, `ats`, `sign`.

### 1.1 Pre-checks P1–P6 (`RUNBOOK-ccp-migration-validation.md` §3)

````text
### P1 backup
$ docker exec ccp-d5-dryrun-pg sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > <scratch>/dry/pre-ccp-migration-backup.sql && ls -l <scratch>/dry/pre-ccp-migration-backup.sql | awk '{print $5}' && grep -c 'PostgreSQL database dump complete' <scratch>/dry/pre-ccp-migration-backup.sql
977068
1
[exit 0]

### P2a ledger status
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo bash tools/db-sync-local.sh --status --until 20261027000200_ccp_b5r_policy_activate_apply
db:sync:local status — 310/331 migrations recorded as applied
db:sync:local pending — 21 on-disk migration(s) not yet applied
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 21 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
[exit 0]

### P2b pending set
$ ls -d libs/*/prisma/migrations/*/ | grep -v '^libs/intelligence-core/' | sort > <scratch>/dry/ondisk.txt; docker exec ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "SELECT name FROM public._local_migrations"' | sort > <scratch>/dry/ledger.txt; comm -23 <scratch>/dry/ondisk.txt <scratch>/dry/ledger.txt | awk -F/ '{print $(NF-1)"	"$0}' | sort | cut -f2 > <scratch>/dry/pending.txt; cat <scratch>/dry/pending.txt; echo "pending=$(wc -l < <scratch>/dry/pending.txt) ccp=$(grep -c _ccp_ <scratch>/dry/pending.txt) non_ccp=$(grep -vc _ccp_ <scratch>/dry/pending.txt)"
libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/
libs/subscription/prisma/migrations/20261024180000_ccp_a2_commercial_audit_policy/
libs/subscription/prisma/migrations/20261025120000_ccp_a3_change_request_approval/
libs/subscription/prisma/migrations/20261025140000_ccp_a4_product_dimension/
libs/subscription/prisma/migrations/20261025160000_ccp_a5_plan_version/
libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/
libs/subscription/prisma/migrations/20261025180100_ccp_a9_role_change_apply_bootstrap/
libs/subscription/prisma/migrations/20261025200000_ccp_a6_transactional_apply/
libs/subscription/prisma/migrations/20261025220000_ccp_b2_catalog_apply/
libs/subscription/prisma/migrations/20261025240000_ccp_d1_usage_rollups/
libs/entitlement/prisma/migrations/20261026000000_ccp_a7_entitlement_revoke_provenance/
libs/subscription/prisma/migrations/20261026000100_ccp_a7_entitlement_revoke_apply/
libs/subscription/prisma/migrations/20261026010000_ccp_a8_support_extension_overlay/
libs/subscription/prisma/migrations/20261026020000_ccp_c1_stripe_command_inbox/
libs/subscription/prisma/migrations/20261026030000_ccp_b4_enterprise_contracts/
libs/subscription/prisma/migrations/20261026050000_ccp_a6r_apply_deadline/
libs/subscription/prisma/migrations/20261026060000_ccp_c2_conversion/
libs/subscription/prisma/migrations/20261026090000_ccp_d3_operational_alerts/
libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/
libs/subscription/prisma/migrations/20261027000100_ccp_constraint_union/
libs/subscription/prisma/migrations/20261027000200_ccp_b5r_policy_activate_apply/
pending=      21 ccp=21 non_ccp=0
[exit 0]

### P3a fact-check refusal (non-local URL, no ref)
$ npm run -s ccp:astre-fact-check -- --database-url postgresql://ro@db.example.invalid:5432/aramo
[ccp-fact-check] REFUSED (DATABASE_URL_NOT_LOCAL): refused: a non-local database is a production read; it needs a separate PO authorization (--po-authorization-ref <ref>). Nothing was connected.
[exit 2]

### P3b fact-check (local URL, ref given)
$ npm run -s ccp:astre-fact-check -- --database-url postgresql://aramo:dryrun@localhost:55417/aramo --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION
[ccp-fact-check] PO authorization reference: D5-DRY-RUN-NOT-PRODUCTION
[ccp-fact-check] session: BEGIN TRANSACTION READ ONLY (rolled back; nothing written; counts and states only)
[ccp-fact-check] schema stage: pre-CCP (present 0, absent 6)
[ccp-fact-check]   absent: A2 subscription.CommercialAuditEvent.event_type
[ccp-fact-check]   absent: A3 subscription.CommercialChangeRequest.kind
[ccp-fact-check]   absent: A4 subscription.TenantSubscription.product_key
[ccp-fact-check]   absent: A5 subscription.TenantSubscription.plan_version_id
[ccp-fact-check]   absent: A6 subscription.CommercialChangeApplication.subscription_id
[ccp-fact-check]   absent: A7 entitlement.TenantEntitlement.granted_source
[ccp-fact-check] (1) open subscriptions by product / source / status: 1 groups
[ccp-fact-check]   (pre-A4) MANUAL ACTIVE: 1
[ccp-fact-check] (2) subscriptions by source (open / total): 1 sources
[ccp-fact-check]   MANUAL: 1 / 1
[ccp-fact-check] (3) tenants with an open MANUAL row: 1
[ccp-fact-check]   tenant=019000a0-0000-7000-8000-000000000001 open_subscriptions=1 plan=aramo-sign-included-v1 status=ACTIVE started_on=2026-10-25 period_anchor_on=2026-10-01 billing_link=absent plan_version=n/a (pre-A5) entitlements=ats,core,sign
[ccp-fact-check] (4) checkout intents: 0
[ccp-fact-check] (5) entitlement rows by capability / source: 4 groups
[ccp-fact-check]   ats (pre-A7): 2
[ccp-fact-check]   core (pre-A7): 2
[ccp-fact-check]   portal (pre-A7): 1
[ccp-fact-check]   sign (pre-A7): 1
[ccp-fact-check] (6) identity catalog roles / scopes / role-scopes: 19 / 190 / 939
[ccp-fact-check] (7) plans: 5; plan versions: n/a (pre-A5)
[ccp-fact-check] (8) COMMERCIAL_PRE_CCP_GRANT_RECORDED records: n/a (pre-A2)
[ccp-fact-check] (9) change requests by kind: n/a (pre-A3)
[exit 0]

### P4 TD-A1-1 catalog pre-check
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/td-a1-1-precheck.sql
BEGIN
 roles | scopes | role_scopes 
-------+--------+-------------
    19 |    190 |         939
(1 row)

 a1_ids_or_keys_already_present 
--------------------------------
                              0
(1 row)

 tenant_read_scope 
-------------------
                 1
(1 row)

ROLLBACK
[exit 0]

### P5 C-16 pre-cutover check
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/c16-precheck.sql
BEGIN
 tenant_id | id | key | created_at | has_session 
-----------+----+-----+------------+-------------
(0 rows)

 source | status | n 
--------+--------+---
 MANUAL | ACTIVE | 1
(1 row)

 reason | n 
--------+---
(0 rows)

              tenant_id               |        plan_key        |     period_anchor      | status 
--------------------------------------+------------------------+------------------------+--------
 019000a0-0000-7000-8000-000000000001 | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | ACTIVE
(1 row)

ROLLBACK
[exit 0]

### P6 Astre snapshot (before)
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/astre-snapshot.sql
BEGIN
 slug  | source | status |        plan_key        |     period_anchor      |          started_at           | ended_at | provider_linked 
-------+--------+--------+------------------------+------------------------+-------------------------------+----------+-----------------
 astre | MANUAL | ACTIVE | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | 2026-10-25 19:48:26.466816+00 |          | f
(1 row)

 entitlements  
---------------
 ats,core,sign
(1 row)

ROLLBACK
[exit 0]

### P3c fact-check in the box form (node container on the compose network; host 'postgres' is non-local)
$ docker run --rm --network ccpd5dry_default -v $PWD:/repo -w /repo -e DATABASE_URL=postgresql://aramo:***@postgres:5432/aramo node:22-bookworm npm run -s ccp:astre-fact-check -- 
[ccp-fact-check] REFUSED (DATABASE_URL_NOT_LOCAL): refused: a non-local database is a production read; it needs a separate PO authorization (--po-authorization-ref <ref>). Nothing was connected.
[exit 2]
(the earlier second attempt passed the reference as one shell word, a dry-run quoting slip; re-run with two words)
$ docker run --rm --network ccpd5dry_default -v $PWD:/repo -w /repo -e DATABASE_URL=postgresql://aramo:***@postgres:5432/aramo node:22-bookworm npm run -s ccp:astre-fact-check -- --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION
[ccp-fact-check] PO authorization reference: D5-DRY-RUN-NOT-PRODUCTION
[ccp-fact-check] session: BEGIN TRANSACTION READ ONLY (rolled back; nothing written; counts and states only)
[ccp-fact-check] schema stage: CCP-A7 (present 6, absent 0)
[ccp-fact-check] (1) open subscriptions by product / source / status: 1 groups
[ccp-fact-check]   sign MANUAL ACTIVE: 3
[ccp-fact-check] (2) subscriptions by source (open / total): 1 sources
[ccp-fact-check]   MANUAL: 3 / 4
[ccp-fact-check] (3) tenants with an open MANUAL row: 3
[ccp-fact-check]   tenant=019000a0-0000-7000-8000-000000000001 open_subscriptions=1 plan=aramo-sign-included-v1 status=ACTIVE started_on=2026-10-25 period_anchor_on=2026-10-01 billing_link=absent plan_version=v1 PUBLISHED entitlements=ats:MIGRATION,core:MIGRATION,sign:MIGRATION
[ccp-fact-check]   tenant=0190d5b6-0000-7000-8000-0000000000b2 open_subscriptions=1 plan=aramo-sign-included-v1 status=ACTIVE started_on=2026-10-25 period_anchor_on=2026-10-01 billing_link=present plan_version=v1 PUBLISHED entitlements=
[ccp-fact-check]   tenant=0190d5b6-0000-7000-8000-0000000000b3 open_subscriptions=1 plan=aramo-sign-included-v1 status=ACTIVE started_on=2026-10-25 period_anchor_on=2026-10-01 billing_link=absent plan_version=v1 PUBLISHED entitlements=
[ccp-fact-check] (4) checkout intents: 0
[ccp-fact-check] (5) entitlement rows by capability / source: 4 groups
[ccp-fact-check]   ats MIGRATION: 2
[ccp-fact-check]   core MIGRATION: 2
[ccp-fact-check]   portal MIGRATION: 1
[ccp-fact-check]   sign MIGRATION: 1
[ccp-fact-check] (6) identity catalog roles / scopes / role-scopes: 25 / 205 / 984
[ccp-fact-check] (7) plans: 5; plan versions: PUBLISHED 5
[ccp-fact-check] (8) COMMERCIAL_PRE_CCP_GRANT_RECORDED records: 0
[ccp-fact-check] (9) change requests by kind: 0
[exit 0]
````

### 1.2 Apply (§4)

**Run 1** (env file without `INTELLIGENCE_DB_USER`, as in `.env.prod.example:69`):

````text
$ ARAMO_DIR=$PWD ARAMO_ENV_FILE=<scratch>/env.dry ARAMO_MIGRATE_NETWORK=ccpd5dry_default bash deploy/migrate-prod.sh --until 20261027000200_ccp_b5r_policy_activate_apply
[migrate] network=ccpd5dry_default repo=<worktree> image=postgres:17
[migrate] BOUNDED apply — stop point: 20261027000200_ccp_b5r_policy_activate_apply
[migrate] Migrations after the stop point are DEFERRED on purpose (expand-before-restrict);
[migrate] they remain pending and are the next release's gate.
[migrate] pre-apply status:
db:sync:local status — 310/331 migrations recorded as applied
db:sync:local pending — 21 on-disk migration(s) not yet applied
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 21 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
[migrate] applying pending migrations…
NOTICE:  relation "_local_migrations" already exists, skipping
  applied  20261024120000_ccp_a1_commercial_role_catalog
  applied  20261024180000_ccp_a2_commercial_audit_policy
  applied  20261025120000_ccp_a3_change_request_approval
  applied  20261025140000_ccp_a4_product_dimension
  applied  20261025160000_ccp_a5_plan_version
  applied  20261025180000_ccp_a9_platform_last_owner_invariant
  applied  20261025180100_ccp_a9_role_change_apply_bootstrap
  applied  20261025200000_ccp_a6_transactional_apply
  applied  20261025220000_ccp_b2_catalog_apply
  applied  20261025240000_ccp_d1_usage_rollups
  applied  20261026000000_ccp_a7_entitlement_revoke_provenance
  applied  20261026000100_ccp_a7_entitlement_revoke_apply
  applied  20261026010000_ccp_a8_support_extension_overlay
  applied  20261026020000_ccp_c1_stripe_command_inbox
  applied  20261026030000_ccp_b4_enterprise_contracts
  applied  20261026050000_ccp_a6r_apply_deadline
  applied  20261026060000_ccp_c2_conversion
  applied  20261026090000_ccp_d3_operational_alerts
  applied  20261027000000_ccp_guard_union
  applied  20261027000100_ccp_constraint_union
  applied  20261027000200_ccp_b5r_policy_activate_apply
db:sync:local — 21 applied, 310 already present
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
db:sync:local verified — no migration beyond the stop point was applied by this run
[migrate] post-apply status: db:sync:local status — 331/331 migrations recorded as applied
db:sync:local pending — 0 on-disk migration(s) not yet applied
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
[migrate] OK — zero pending on-disk migrations at-or-before the stop point '20261027000200_ccp_b5r_policy_activate_apply'.
[migrate] Deferred migrations after the stop point stay pending (see status above).
[migrate] ── Talent Intelligence database (aramo_intelligence) — ATI-SEP-1 / ADR-0036 ──
[migrate] deploy step exited 1 — STOP: containers were NOT recreated.
[migrate] The DB schema is not confirmed in sync with the pulled code.
[migrate] Fix the migration apply (see output above) before retrying.
[exit 1]
````

The shared database is fully migrated (21 applied, gate OK), then the script exits 1 with no specific message.
Tracing it (`bash -x`) shows `TI_USER="$(read_env INTELLIGENCE_DB_USER)"` failing under `set -euo pipefail`
because `grep` finds no line. This is **D5-DEF-1** (§9). The runbook's §4 pre-check was added because of it.

**Run 2** (the env file carries `INTELLIGENCE_DB_USER=aramo_intelligence`):

````text
$ (env file now carries INTELLIGENCE_DB_USER=aramo_intelligence) ARAMO_DIR=$PWD ARAMO_ENV_FILE=<scratch>/env.dry ARAMO_MIGRATE_NETWORK=ccpd5dry_default bash deploy/migrate-prod.sh --until 20261027000200_ccp_b5r_policy_activate_apply
[migrate] network=ccpd5dry_default repo=<worktree> image=postgres:17
[migrate] BOUNDED apply — stop point: 20261027000200_ccp_b5r_policy_activate_apply
[migrate] Migrations after the stop point are DEFERRED on purpose (expand-before-restrict);
[migrate] they remain pending and are the next release's gate.
[migrate] pre-apply status:
db:sync:local status — 331/331 migrations recorded as applied
db:sync:local pending — 0 on-disk migration(s) not yet applied
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
[migrate] applying pending migrations…
NOTICE:  relation "_local_migrations" already exists, skipping
db:sync:local — 0 applied, 331 already present
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
db:sync:local verified — no migration beyond the stop point was applied by this run
[migrate] post-apply status: db:sync:local status — 331/331 migrations recorded as applied
db:sync:local pending — 0 on-disk migration(s) not yet applied
db:sync:local stop — 20261027000200_ccp_b5r_policy_activate_apply at manifest position 331/331
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
[migrate] OK — zero pending on-disk migrations at-or-before the stop point '20261027000200_ccp_b5r_policy_activate_apply'.
[migrate] Deferred migrations after the stop point stay pending (see status above).
[migrate] ── Talent Intelligence database (aramo_intelligence) — ATI-SEP-1 / ADR-0036 ──
[migrate] TI: ensuring role aramo_intelligence + database aramo_intelligence (idempotent; nothing dropped)…
ensure-intelligence-db — role aramo_intelligence and database aramo_intelligence ensured (owner aramo_intelligence; PUBLIC connect revoked)
[migrate] TI pre-apply status:
db:sync:intelligence database — aramo_intelligence
db:sync:intelligence status — 0/4 migrations recorded as applied
db:sync:intelligence pending — 4 on-disk migration(s) not yet applied
db:sync:intelligence drift — 0 recorded migration(s) whose checksum changed
[migrate] TI: applying pending migrations…
  applied  20261023120000_init_intelligence_schema
  applied  20261023130000_t1_golden_model
  applied  20261023140000_t4_t7_verification_trust_access
  applied  20261023150000_t10_evidence_lifecycle
db:sync:intelligence — 4 applied, 0 already present (database aramo_intelligence)
[migrate] TI post-apply status: db:sync:intelligence database — aramo_intelligence
db:sync:intelligence status — 4/4 migrations recorded as applied
db:sync:intelligence pending — 0 on-disk migration(s) not yet applied
db:sync:intelligence drift — 0 recorded migration(s) whose checksum changed
[migrate] OK — Talent Intelligence database: zero pending, zero drift.
[migrate] Safe to build + recreate containers.
[exit 0]
````

### 1.3 Post-checks (§5)

````text
### Q post-check SQL
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/ccp-postcheck.sql
BEGIN
 roles | scopes | role_scopes | ccp_roles 
-------+--------+-------------+-----------
    25 |    205 |         984 |         6
(1 row)

 commercial_role_grants 
------------------------
                      0
(1 row)

 version_number | status |                         content_checksum                         
----------------+--------+------------------------------------------------------------------
              1 | ACTIVE | bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5
(1 row)

 product_key | source | status | n | unpinned 
-------------+--------+--------+---+----------
 sign        | MANUAL | ACTIVE | 1 |        0
(1 row)

                 key                 | version_number |  status   
-------------------------------------+----------------+-----------
 aramo-sign-enterprise-v1            |              1 | PUBLISHED
 aramo-sign-free-personal-v1         |              1 | PUBLISHED
 aramo-sign-included-v1              |              1 | PUBLISHED
 aramo-sign-standard-business-v1     |              1 | PUBLISHED
 aramo-sign-standard-professional-v1 |              1 | PUBLISHED
(5 rows)

                    tgname                    | tgenabled 
----------------------------------------------+-----------
 ccp_a9_platform_last_owner_membership_delete | A
 ccp_a9_platform_last_owner_membership_update | A
 ccp_a9_platform_last_owner_role_delete       | A
 ccp_a9_platform_last_owner_role_update       | A
 ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 union_blocks 
--------------
           22
(1 row)

                        tgname                        
------------------------------------------------------
 commercial_change_request_conversion_applying_commit
 commercial_change_request_no_applying_commit
 commercial_change_request_no_applying_commit_a7
 commercial_change_request_no_applying_commit_a8
 commercial_change_request_no_applying_commit_b5r
(5 rows)

 change_requests | provider_commands | inbox_rows | alerts | rollup_runs | attestations | audit_events 
-----------------+-------------------+------------+--------+-------------+--------------+--------------
               0 |                 0 |          0 |      0 |           0 |            0 |            1
(1 row)

 capability | granted_source | n 
------------+----------------+---
 ats        | MIGRATION      | 2
 core       | MIGRATION      | 2
 portal     | MIGRATION      | 1
 sign       | MIGRATION      | 1
(4 rows)

ROLLBACK
[exit 0]

### C-16 again (post)
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/c16-precheck.sql
BEGIN
 tenant_id | id | key | created_at | has_session 
-----------+----+-----+------------+-------------
(0 rows)

 source | status | n 
--------+--------+---
 MANUAL | ACTIVE | 1
(1 row)

 reason | n 
--------+---
(0 rows)

              tenant_id               |        plan_key        |     period_anchor      | status 
--------------------------------------+------------------------+------------------------+--------
 019000a0-0000-7000-8000-000000000001 | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | ACTIVE
(1 row)

ROLLBACK
[exit 0]

### Astre snapshot (after)
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/astre-snapshot.sql
BEGIN
 slug  | source | status |        plan_key        |     period_anchor      |          started_at           | ended_at | provider_linked 
-------+--------+--------+------------------------+------------------------+-------------------------------+----------+-----------------
 astre | MANUAL | ACTIVE | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | 2026-10-25 19:48:26.466816+00 |          | f
(1 row)

 entitlements  
---------------
 ats,core,sign
(1 row)

ROLLBACK
[exit 0]

### fact-check (post)
$ npm run -s ccp:astre-fact-check -- --database-url postgresql://aramo:dryrun@localhost:55417/aramo --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION
[ccp-fact-check] PO authorization reference: D5-DRY-RUN-NOT-PRODUCTION
[ccp-fact-check] session: BEGIN TRANSACTION READ ONLY (rolled back; nothing written; counts and states only)
[ccp-fact-check] schema stage: CCP-A7 (present 6, absent 0)
[ccp-fact-check] (1) open subscriptions by product / source / status: 1 groups
[ccp-fact-check]   sign MANUAL ACTIVE: 1
[ccp-fact-check] (2) subscriptions by source (open / total): 1 sources
[ccp-fact-check]   MANUAL: 1 / 1
[ccp-fact-check] (3) tenants with an open MANUAL row: 1
[ccp-fact-check]   tenant=019000a0-0000-7000-8000-000000000001 open_subscriptions=1 plan=aramo-sign-included-v1 status=ACTIVE started_on=2026-10-25 period_anchor_on=2026-10-01 billing_link=absent plan_version=v1 PUBLISHED entitlements=ats:MIGRATION,core:MIGRATION,sign:MIGRATION
[ccp-fact-check] (4) checkout intents: 0
[ccp-fact-check] (5) entitlement rows by capability / source: 4 groups
[ccp-fact-check]   ats MIGRATION: 2
[ccp-fact-check]   core MIGRATION: 2
[ccp-fact-check]   portal MIGRATION: 1
[ccp-fact-check]   sign MIGRATION: 1
[ccp-fact-check] (6) identity catalog roles / scopes / role-scopes: 25 / 205 / 984
[ccp-fact-check] (7) plans: 5; plan versions: PUBLISHED 5
[ccp-fact-check] (8) COMMERCIAL_PRE_CCP_GRANT_RECORDED records: 0
[ccp-fact-check] (9) change requests by kind: 0
[exit 0]

### A11 backfill dry-run (local only)
$ npm run -s ccp:astre-backfill -- --dry-run --database-url postgresql://aramo:dryrun@localhost:55417/aramo
[ccp-a11] DRY RUN: session BEGIN TRANSACTION READ ONLY (rolled back; nothing written)
[ccp-a11] counts:
[ccp-a11]   subscriptions_total: 1
[ccp-a11]   subscriptions_open: 1
[ccp-a11]   open_manual: 1
[ccp-a11]   open_manual_governed_by_change_request: 0
[ccp-a11]   open_manual_already_recorded: 0
[ccp-a11]   open_manual_withdrawn: 0
[ccp-a11]   open_manual_to_record: 1
[ccp-a11]   open_self_service_not_in_scope: 0
[ccp-a11]   open_free_not_in_scope: 0
[ccp-a11]   open_development: 0
[ccp-a11]   open_pinned_checksum_ok: 1
[ccp-a11]   open_pinned_v1: 1
[ccp-a11]   open_product_sign_base: 1
[ccp-a11]   entitlement_rows: 6
[ccp-a11]   entitlement_rows_active: 6
[ccp-a11]   entitlement_rows_revoked: 0
[ccp-a11]   checkout_intents: 0
[ccp-a11]   checkout_intents_created_for_manual: 0
[ccp-a11]   pre_ccp_records_existing: 0
[ccp-a11]   exceptions_halt: 0
[ccp-a11]   exceptions_review: 0
[ccp-a11] open subscriptions by product / source / status: 1 groups
[ccp-a11]   sign MANUAL ACTIVE: 1
[ccp-a11] entitlement rows by granted_source: 1 sources
[ccp-a11]   MIGRATION: active 6, revoked 0
[ccp-a11] planned writes (if ever executed under separate PO authorization):
[ccp-a11]   subscription."CommercialAuditEvent": 1
[ccp-a11]   subscription."TenantSubscription": 0
[ccp-a11]   subscription."CommercialChangeRequest": 0
[ccp-a11]   subscription."SubscriptionVersionPinEvent": 0
[ccp-a11]   subscription."AllowanceUsage": 0
[ccp-a11]   subscription."CapacityUsage": 0
[ccp-a11]   entitlement."TenantEntitlement": 0
[ccp-a11]   entitlement."TenantEntitlementEvent": 0
[ccp-a11] planned records: 1
[ccp-a11]   COMMERCIAL_PRE_CCP_GRANT_RECORDED id=e226f3a0-14a3-7344-89f1-4a2d4b4ae7fa tenant=019000a0-0000-7000-8000-000000000001 subscription=019a0000-d500-7000-8000-000000000001 product=sign plan=aramo-sign-included-v1 v1 status=ACTIVE capabilities=ats:MIGRATION,core:MIGRATION,sign:MIGRATION state_checksum=9f2bc5d51de05c0b8759f21b89b6bc831da6890818ce32a8d6c2f320f9811ff4
[ccp-a11] exceptions: 0 (HALT 0, REVIEW 0)
[ccp-a11] OK: no HALT exception. Effective-service writes planned: 0.
[exit 0]

### A11 backfill refuses a non-local URL
$ npm run -s ccp:astre-backfill -- --dry-run --database-url postgresql://ro@db.example.invalid:5432/aramo
[ccp-a11] REFUSED (DATABASE_URL_NOT_LOCAL): refused: the database URL is not localhost or a testcontainer. Production is not authorized (PBD §7.5); nothing was connected.
[exit 2]

### A11 backfill refuses --execute
$ npm run -s ccp:astre-backfill -- --execute --database-url postgresql://aramo:dryrun@localhost:55417/aramo
[ccp-a11] REFUSED (EXECUTE_NOT_AUTHORIZED): refused: CCP-A11 has no execute path. Executing the backfill needs separate PO authorization and a separately authorized slice (PBD §7.5, A0-C15).
[exit 2]

### D1 reconcile-only (post)
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo npm run -s usage:rollup -- --reconcile-only
{"timestamp":"2026-10-25T19:54:03.187Z","level":"log","context":"PrismaService (subscription)","event":"prisma_service_connected","surface":"subscription"}
{
  "product_key": "sign",
  "status": "NOT_RUN",
  "checked_at": "2026-10-25T19:54:03.193Z",
  "metrics": [
    {
      "metric_key": "sign.envelopes",
      "product_key": "sign",
      "status": "NOT_RUN",
      "watermark": null,
      "last_run_id": null,
      "buckets": {
        "source": 0,
        "rollup": 0,
        "pending": 0,
        "compared": 0,
        "mismatched": 0
      },
      "compared_totals": {
        "allowance_usage": {
          "consumed": 0,
          "consumed_send": 0,
          "consumed_historical": 0,
          "reserved": 0
        },
        "rollup": {
          "consumed": 0,
          "consumed_send": 0,
          "consumed_historical": 0,
          "reserved": 0
        }
      },
      "usage_event": {
        "event_type": "sign.envelope.sent",
        "tenants": 0,
        "mismatched_tenants": 0,
        "allowance_usage_consumed_send": 0,
        "usage_event_quantity": 0
      },
      "mismatch_count": 0,
      "mismatches": []
    }
  ]
}
[usage-rollup] NOT_RUN
[exit 1]
````

Notes: Q9 `audit_events = 1` is the A2 seed row for the v1 activation (TD-A2-5). Q10 shows 6 entitlement rows: the 3
Astre fixture rows plus 3 rows (`core`, `ats`, `portal`) for tenant `01900000-0000-7000-8000-000000000001` that the
baseline chain already held. The production expectation for Q1 is 25 / 209 / 1018 (from 19 / 194 / 973);
locally it is 25 / 205 / 984 (from 19 / 190 / 939): +6 / +15 / +45 in both cases.

### 1.4 Compensation order (§6), top of the stack

The three file-backed integrator compensations (21 B5-R, 20 constraint union, 19 guard union), newest first, each with
its ledger row in the same transaction; then a normal bounded migrate run re-applies them.

````text
### compensate libs/subscription/prisma/migrations/20261027000200_ccp_b5r_policy_activate_apply/
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q -f - -c "DELETE FROM public._local_migrations WHERE name = '\''libs/subscription/prisma/migrations/20261027000200_ccp_b5r_policy_activate_apply/'\''"' < libs/subscription/src/tests/fixtures/ccp-b5r-compensating.sql
[exit 0]

### compensate libs/subscription/prisma/migrations/20261027000100_ccp_constraint_union/
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q -f - -c "DELETE FROM public._local_migrations WHERE name = '\''libs/subscription/prisma/migrations/20261027000100_ccp_constraint_union/'\''"' < libs/subscription/src/tests/fixtures/ccp-constraint-union-compensating.sql
[exit 0]

### compensate libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q -f - -c "DELETE FROM public._local_migrations WHERE name = '\''libs/subscription/prisma/migrations/20261027000000_ccp_guard_union/'\''"' < libs/subscription/src/tests/fixtures/ccp-guard-union-compensating.sql
[exit 0]

### state after compensation
$ docker exec ccp-d5-dryrun-pg psql -U aramo -d aramo -tA -c "SELECT 'union_blocks=' || (SELECT count(*) FROM regexp_matches(pg_get_functiondef('subscription.guard_commercial_change_request()'::regprocedure), '\[union block', 'g')) || ' b5r_trigger=' || (SELECT count(*) FROM pg_trigger WHERE tgname='commercial_change_request_no_applying_commit_b5r') || ' ledger=' || (SELECT count(*) FROM public._local_migrations)"
union_blocks=0 b5r_trigger=0 ledger=328
[exit 0]

### status after compensation
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo bash tools/db-sync-local.sh --status
db:sync:local status — 328/331 migrations recorded as applied
db:sync:local pending — 3 on-disk migration(s) not yet applied
[exit 0]

### re-apply
$ ARAMO_DIR=<worktree> ARAMO_ENV_FILE=<scratch>/dry/env.dry ARAMO_MIGRATE_NETWORK=ccpd5dry_default bash deploy/migrate-prod.sh --until 20261027000200_ccp_b5r_policy_activate_apply 2>&1 | grep -E 'applied |OK|FATAL|STOP|pending-before-stop'
db:sync:local pending-before-stop — 3 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
  applied  20261027000000_ccp_guard_union
  applied  20261027000100_ccp_constraint_union
  applied  20261027000200_ccp_b5r_policy_activate_apply
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
db:sync:local verified — no migration beyond the stop point was applied by this run
db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied
db:sync:local deferred — 0 on-disk migration(s) after the stop point (not applied by a bounded run)
[migrate] OK — zero pending on-disk migrations at-or-before the stop point '20261027000200_ccp_b5r_policy_activate_apply'.
[migrate] OK — Talent Intelligence database: zero pending, zero drift.
[exit 0]

### state after re-apply
$ docker exec ccp-d5-dryrun-pg psql -U aramo -d aramo -tA -c "SELECT 'union_blocks=' || (SELECT count(*) FROM regexp_matches(pg_get_functiondef('subscription.guard_commercial_change_request()'::regprocedure), '\[union block', 'g')) || ' b5r_trigger=' || (SELECT count(*) FROM pg_trigger WHERE tgname='commercial_change_request_no_applying_commit_b5r') || ' ledger=' || (SELECT count(*) FROM public._local_migrations)"
union_blocks=22 b5r_trigger=1 ledger=331
[exit 0]
````

The refusal-with-dependent-data behaviour of these compensations (and A1's) is proven by
`libs/subscription/src/tests/ccp-merge-train-compensation.integration.spec.ts`: **4 / 4** passed in this session (§6).

### 1.5 Restore drill (the backup is the recovery floor)

````text
$ createdb restore_drill; psql -d restore_drill -v ON_ERROR_STOP=1 < pre-ccp-migration-backup.sql; ledger + stage check
[restore exit 0]
ledger=310 ccp_in_ledger=0 audit_table=absent roles=19
[drill db dropped]
````

## 2. Recovery

### 2.0 Environment

Database `aramo_recovery`, built by the repo's shared helper `applyCcpA6Schema` (identity + entitlement + metering +
every subscription migration, whole files, then the CCP roster catalog). A temporary driver spec (not committed;
deleted after the run) used the real services on one Prisma client — change request, apply, policy apply, governance,
conversion, lifecycle, command, inbox, allowance and alert services — with the repo's fake Stripe (`FakeStripe`, no
network, no key), exactly as the C1/C2 integration specs do. Five operators: two commercial_ops, two finance_admin, one
platform_owner, each D9-attested. Every runbook query was run through `docker exec … psql` from the same SQL text that
is published in the runbook; the D1 steps ran the real `npm run usage:rollup` CLI.

Fixture writes (outside the product path, each logged): a raising trigger on `entitlement."TenantEntitlement"` for
one tenant (to cause a real APPLY_FAILED; dropped before the retry); a raw `CheckoutIntent` that predates the governed
row (the C2 spec's held-activation fixture); `rawSubscription` SELF_SERVICE rows; one `UPDATE` of a derived
`UsageRollupPeriod` row (simulated roll-up corruption); one `UPDATE` of the v2 policy **DRAFT** content (see D5-DEF-2).

````text
# CCP-D5 recovery dry run — local database aramo_recovery on ccp-d5-dryrun-pg (Postgres 17), started 2026-10-25T20:01:19.382Z
schema: applyCcpA6Schema (identity + entitlement + metering + every subscription migration, whole files; roster catalog)

### S0 setup — activate policy v2 (v1 + apply_expiry_hours=1) through a governed POLICY_ACTIVATE
updateDraft (governed editor) with apply_expiry_hours: "CommercialChangeRequestError:INVALID_INPUT:policy_key_not_editable these policy settings cannot be edited"
(fixture, DEF: no governed editor path for apply_expiry_hours) UPDATE the v2 DRAFT content to v1 + apply_expiry_hours=1, checksum recomputed
apply v2 activation (requester FA): "APPLIED"
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r9-policy.sql
BEGIN
                  id                  | version_number | status  |                         content_checksum                         |         activated_at          |         retired_at         
--------------------------------------+----------------+---------+------------------------------------------------------------------+-------------------------------+----------------------------
 019a0000-0000-7000-8000-0000000cc201 |              1 | RETIRED | bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5 | 2026-10-25 20:01:17.740222+00 | 2026-10-25 20:01:19.263+00
 01a174a7-3d88-7098-b88d-e23d97e83094 |              2 | ACTIVE  | cad2efae1659b3592b8cd2f68d84da919c7d38df3a958281f0ba56ea4e3e6c95 | 2026-10-25 20:01:19.263+00    | 
(2 rows)

                  id                  |  state  |             requested_by             |                target                | apply_attempts |         applied_at         
--------------------------------------+---------+--------------------------------------+--------------------------------------+----------------+----------------------------
 01a174a7-3ea0-710d-a06d-f758e8c636b5 | APPLIED | e7fc1357-eb45-4b50-8038-a555d8377268 | 01a174a7-3d88-7098-b88d-e23d97e83094 |              1 | 2026-10-25 20:01:19.263+00
(1 row)

ROLLBACK

### S1 seed — held activation (Conv. C-7): governed MANUAL row + a paid provider subscription from an old checkout
webhook outcome: {"outcome":"IGNORED","detail":"governed_subscription_open: held for reconciliation (an open governed subscription is never ended by a checkout)","tenant_id":"251ba384-72e8-4aab-8302-51580db0d683"}
tenant-facing state: {"state":"PENDING","message":"Subscription activation pending — contact support"}

### S2 seed — CONVERSION TO_GOVERNED waiting on the provider (the only APPLYING that commits)
conversion apply: {"status":"PENDING_PROVIDER","request":"APPLYING"}

### S2b — a non-CONVERSION request can never commit in APPLYING (raw attempt, rolled back by the DB)
raw APPLYING commit: "CommercialChangeRequest 01a174a7-54d1-741b-9bc4-0048a89ca728 cannot commit in APPLYING (the apply is one transaction)"
request after the refused commit: {"state":"APPROVED","apply_attempts":0}

### S3 seed — APPLY_FAILED: a real database fault on the entitlement write
apply (requester OPS): "CommercialApplyFailedError:UNEXPECTED apply failed (UNEXPECTED); the request is APPLY_FAILED"
request: {"state":"APPLY_FAILED","apply_attempts":1}

### S4 seed — expired approval window: submitted 80 h ago, never approved
submit (80 h ago): "OK"

### S5 seed — apply deadline passed: approved 2 h ago under v2 (apply_expiry_hours = 1)
request (raw, before any touch): {"state":"APPROVED","apply_attempts":0}

### S6 seed — Stripe command FAILED (provider refusal) for a self-service cancel
command: {"state":"FAILED","attempts":1,"last_error_code":"PROVIDER_REFUSED"}

### S7 seed — webhook inbox FAILED (the provider re-fetch failed)
delivery: "BillingProviderUnavailableError: billing provider unavailable: no such subscription"

### S8 seed — usage: three consumed sends for a governed tenant, a clean roll-up run, then a tampered roll-up row
reserve 1: true
consume 1: "CONSUMED"
reserve 2: true
consume 2: "CONSUMED"
reserve 3: true
consume 3: "CONSUMED"
$ npm run -s usage:rollup
{"timestamp":"2026-10-25T20:01:39.689Z","level":"log","context":"PrismaService (subscription)","event":"prisma_service_connected","surface":"subscription"}
[usage-rollup] run COMPLETED: [{"metric_key":"sign.envelopes","run_id":"01a174a7-8f1c-71e0-a7cf-88b1fb9577b0","mode":"FULL","from_xid":null,"to_xid":"8449","buckets_recomputed":1,"rows_scanned":3,"reconciliation":"RECONCILED","mismatch_count":0,"pending_bucket_count":0}]
{
  "product_key": "sign",
  "status": "RECONCILED",
  "checked_at": "2026-10-25T20:01:41.719Z",
  "metrics": [
    {
      "metric_key": "sign.envelopes",
      "product_key": "sign",
      "status": "RECONCILED",
      "watermark": "8449",
      "last_run_id": "01a174a7-8f1c-71e0-a7cf-88b1fb9577b0",
      "buckets": {
        "source": 1,
        "rollup": 1,
        "pending": 0,
        "compared": 1,
        "mismatched": 0
      },
      "compared_totals": {
        "allowance_usage": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        },
        "rollup": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        }
      },
      "usage_event": {
        "event_type": "sign.envelope.sent",
        "tenants": 1,
        "mismatched_tenants": 0,
        "allowance_usage_consumed_send": 3,
        "usage_event_quantity": 3
      },
      "mismatch_count": 0,
      "mismatches": []
    }
  ]
}
[usage-rollup] RECONCILED
[exit 0]
(fixture) UPDATE subscription."UsageRollupPeriod" SET consumed_count = consumed_count + 1 … for the tenant (simulated roll-up corruption)
$ npm run -s usage:rollup
{"timestamp":"2026-10-25T20:01:49.690Z","level":"log","context":"PrismaService (subscription)","event":"prisma_service_connected","surface":"subscription"}
[usage-rollup] run COMPLETED: [{"metric_key":"sign.envelopes","run_id":"01a174a7-b3a4-77b4-81f1-d9c7e095b299","mode":"INCREMENTAL","from_xid":"8449","to_xid":"8451","buckets_recomputed":0,"rows_scanned":0,"reconciliation":"NOT_RECONCILED","mismatch_count":3,"pending_bucket_count":0}]
{
  "product_key": "sign",
  "status": "NOT_RECONCILED",
  "checked_at": "2026-10-25T20:01:50.307Z",
  "metrics": [
    {
      "metric_key": "sign.envelopes",
      "product_key": "sign",
      "status": "NOT_RECONCILED",
      "watermark": "8451",
      "last_run_id": "01a174a7-b3a4-77b4-81f1-d9c7e095b299",
      "buckets": {
        "source": 1,
        "rollup": 1,
        "pending": 0,
        "compared": 1,
        "mismatched": 1
      },
      "compared_totals": {
        "allowance_usage": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        },
        "rollup": {
          "consumed": 4,
          "consumed_send": 4,
          "consumed_historical": 0,
          "reserved": 0
        }
      },
      "usage_event": {
        "event_type": "sign.envelope.sent",
        "tenants": 1,
        "mismatched_tenants": 1,
        "allowance_usage_consumed_send": 3,
        "usage_event_quantity": 3
      },
      "mismatch_count": 3,
      "mismatches": [
        {
          "kind": "PERIOD",
          "tenant_id": "b605fc31-bc03-432e-9e2c-f557a724190f",
          "period_start": "2026-10-25T20:01:29.242Z",
          "expected": {
            "consumed": 3,
            "consumed_send": 3,
            "consumed_historical": 0,
            "reserved": 0
          },
          "actual": {
            "consumed": 4,
            "consumed_send": 4,
            "consumed_historical": 0,
            "reserved": 0
          }
        },
        {
          "kind": "DAILY",
          "tenant_id": "b605fc31-bc03-432e-9e2c-f557a724190f",
          "period_start": "2026-10-25T20:01:29.242Z",
          "expected": {
            "consumed": 3,
            "consumed_send": 3,
            "consumed_historical": 0,
            "reserved": 0
          },
          "actual": {
            "consumed": 3,
            "consumed_send": 3,
            "consumed_historical": 0,
            "reserved": 0
          }
        },
        {
          "kind": "ROLLUP_USAGE_EVENT",
          "tenant_id": "b605fc31-bc03-432e-9e2c-f557a724190f",
          "period_start": null,
          "expected": 3,
          "actual": 4
        }
      ]
    }
  ]
}
[usage-rollup] NOT_RECONCILED
[exit 1]

### R-ALERT scan 1 (CommercialAlertService.scan, as the CCP_ALERTS_ENABLED worker tick does)
scan: {"at":"2026-10-25T20:01:50.927Z","raised":7,"refreshed":0,"resolved":0,"open":7,"sources":{"COMMAND_PENDING_PROVIDER_STUCK":"read","COMMAND_FAILED":"read","HELD_ACTIVATION":"read","WEBHOOK_INBOX_FAILED":"read","USAGE_NOT_RECONCILED":"read","APPLY_FAILED":"read","APPROVAL_NEARING_EXPIRY":"read","APPROVAL_PAST_EXPIRY":"read"},"thresholds":{"pending_provider_stuck_minutes":1440,"approval_expiry_lead_minutes":720},"raised_alerts":[{"id":"01a174a7-b7de-7038-89aa-c67e6515f01f","alert_type":"COMMAND_FAILED","family":"BILLING","subject_kind":"billing_command","subject_id":"01a174a7-6524-7548-a44 … [line cut: 5873 characters]

### R7 alert triage — open alerts
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r7-alerts.sql
BEGIN
  family  |      alert_type      | status | n 
----------+----------------------+--------+---
 APPROVAL | APPLY_FAILED         | OPEN   | 1
 APPROVAL | APPROVAL_PAST_EXPIRY | OPEN   | 1
 BILLING  | COMMAND_FAILED       | OPEN   | 1
 BILLING  | HELD_ACTIVATION      | OPEN   | 2
 BILLING  | USAGE_NOT_RECONCILED | OPEN   | 1
 BILLING  | WEBHOOK_INBOX_FAILED | OPEN   | 1
(6 rows)

      alert_type      |    subject_kind     |              subject_id              |              tenant_id               | detection_count |     first_detected_at      |                                               detail                                                
----------------------+---------------------+--------------------------------------+--------------------------------------+-----------------+----------------------------+-----------------------------------------------------------------------------------------------------
 COMMAND_FAILED       | billing_command     | 01a174a7-6524-7548-a44a-f60862c10896 | bdc577f9-1f08-4c00-bb46-f5ddc6e238b5 |               1 | 2026-10-25 20:01:50.927+00 | SUBSCRIPTION_CANCEL FAILED PROVIDER_REFUSED after 1 attempt(s)
 HELD_ACTIVATION      | reconciliation_flag | 01a174a7-473f-77e5-b89c-682963a0b62d | 251ba384-72e8-4aab-8302-51580db0d683 |               1 | 2026-10-25 20:01:50.927+00 | self-service activation held: a governed subscription is open (flag open 0 min)
 HELD_ACTIVATION      | reconciliation_flag | 01a174a7-4e23-733e-90f0-070bab9f65e1 | f9b26fbc-5044-4c4d-bf92-77cf7ef53901 |               1 | 2026-10-25 20:01:50.927+00 | self-service activation held: a governed subscription is open (flag open 0 min)
 WEBHOOK_INBOX_FAILED | webhook_inbox       | 01a174a7-66b4-7773-b04d-e94d4689e0f6 |                                      |               1 | 2026-10-25 20:01:50.927+00 | provider event subscription.updated failed processing after 1 attempt(s)
 USAGE_NOT_RECONCILED | usage_metric        | sign.envelopes                       |                                      |               1 | 2026-10-25 20:01:50.927+00 | latest usage roll-up run (INCREMENTAL) did not reconcile: 3 mismatch(es)
 APPLY_FAILED         | change_request      | 01a174a7-5a1a-776d-a98d-c10e5099a5bd | 35aadb17-8e7f-40e0-be49-84074de5495b |               1 | 2026-10-25 20:01:50.927+00 | SUBSCRIPTION_OPEN apply failed after 1 attempt(s); retryable
 APPROVAL_PAST_EXPIRY | change_request      | 01a174a7-5f40-77aa-a37e-119d4bd78484 | e5ccc16e-e2ad-4e89-a140-615891dfb387 |               1 | 2026-10-25 20:01:50.927+00 | SUBSCRIPTION_OPEN still PENDING_APPROVAL 480 min after its expiry (no further approval is accepted)
(7 rows)

ROLLBACK

### R1 stuck APPLYING — detection
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r1-applying.sql
BEGIN
                  id                  | action_type |              tenant_id               | apply_attempts |         updated_at         |              command_id              |    command_kind     |          step          |  command_state   | command_attempts | last_error_code 
--------------------------------------+-------------+--------------------------------------+----------------+----------------------------+--------------------------------------+---------------------+------------------------+------------------+------------------+-----------------
 01a174a7-4efa-72cf-8ec5-2ce7d85d7756 | CONVERSION  | f9b26fbc-5044-4c4d-bf92-77cf7ef53901 |              1 | 2026-10-25 20:01:19.263+00 | 01a174a7-531e-7785-af4f-c27501e80348 | SUBSCRIPTION_CANCEL | cancel_held_activation | PENDING_PROVIDER |                1 | 
(1 row)

 applying_not_conversion 
-------------------------
                       0
(1 row)

ROLLBACK

### R2 APPLY_FAILED — detection
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r2-apply-failed.sql
BEGIN
                  id                  |    action_type    |              tenant_id               | product_key |             requested_by             | apply_attempts |        approved_at         | last_failure 
--------------------------------------+-------------------+--------------------------------------+-------------+--------------------------------------+----------------+----------------------------+--------------
 01a174a7-5a1a-776d-a98d-c10e5099a5bd | SUBSCRIPTION_OPEN | 35aadb17-8e7f-40e0-be49-84074de5495b | sign        | ca66810d-13bd-4b7e-8b79-f536e32622f2 |              1 | 2026-10-25 20:01:19.263+00 | UNEXPECTED
(1 row)

ROLLBACK

### R3 expiry — detection
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r3-expiry.sql
BEGIN
                  id                  |    action_type    |              tenant_id               | product_key |             requested_by             |        submitted_at        |         expires_at         
--------------------------------------+-------------------+--------------------------------------+-------------+--------------------------------------+----------------------------+----------------------------
 01a174a7-5f40-77aa-a37e-119d4bd78484 | SUBSCRIPTION_OPEN | e5ccc16e-e2ad-4e89-a140-615891dfb387 | sign        | ca66810d-13bd-4b7e-8b79-f536e32622f2 | 2026-10-22 12:01:28.338+00 | 2026-10-25 12:01:28.338+00
(1 row)

                  id                  |    action_type    |  state   |        approved_at         | apply_expiry_hours |       apply_deadline       
--------------------------------------+-------------------+----------+----------------------------+--------------------+----------------------------
 01a174a7-6031-7760-93bc-b51683a7b4e5 | SUBSCRIPTION_OPEN | APPROVED | 2026-10-25 18:01:28.598+00 |                  1 | 2026-10-25 19:01:28.598+00
(1 row)

 state | n 
-------+---
(0 rows)

ROLLBACK

### R4 Stripe commands — detection
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r4-commands.sql
BEGIN
      state       | n 
------------------+---
 FAILED           | 1
 PENDING_PROVIDER | 1
(2 rows)

                  id                  |          change_request_id           |          step          |    command_kind     |              tenant_id               |                target_ref                |      state       | attempts | last_error_code  | next_attempt_at | lease_until |    provider_accepted_at    |         failed_at          |         updated_at         | lease_expired 
--------------------------------------+--------------------------------------+------------------------+---------------------+--------------------------------------+------------------------------------------+------------------+----------+------------------+-----------------+-------------+----------------------------+----------------------------+----------------------------+---------------
 01a174a7-531e-7785-af4f-c27501e80348 | 01a174a7-4efa-72cf-8ec5-2ce7d85d7756 | cancel_held_activation | SUBSCRIPTION_CANCEL | f9b26fbc-5044-4c4d-bf92-77cf7ef53901 | sub_1f7d8205-031a-4cd3-820c-4bd6a81919b2 | PENDING_PROVIDER |        1 |                  |                 |             | 2026-10-25 20:01:29.242+00 |                            | 2026-10-25 20:01:29.242+00 | f
 01a174a7-6524-7548-a44a-f60862c10896 | 01a174a7-630e-700e-9852-55f5568be1f7 | end_self_service       | SUBSCRIPTION_CANCEL | bdc577f9-1f08-4c00-bb46-f5ddc6e238b5 | sub_bd96ce4a-6c68-45a8-ba72-f3fb57a02445 | FAILED           |        1 | PROVIDER_REFUSED |                 |             |                            | 2026-10-25 20:01:29.242+00 | 2026-10-25 20:01:29.242+00 | f
(2 rows)

ROLLBACK

### R5 webhook inbox — detection
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r5-inbox.sql
BEGIN
  status   | n 
-----------+---
 FAILED    | 1
 PROCESSED | 2
(2 rows)

 provider_event_id |      event_type      | product_key | status | attempts |      next_attempt_at       | lease_until |                     last_error                     |        received_at         | needs_provider_redelivery 
-------------------+----------------------+-------------+--------+----------+----------------------------+-------------+----------------------------------------------------+----------------------------+---------------------------
 evt_d5_3          | subscription.updated | sign        | FAILED |        1 | 2026-10-25 20:02:29.242+00 |             | billing provider unavailable: no such subscription | 2026-10-25 20:01:29.242+00 | f
(1 row)

ROLLBACK

### R6 usage — detection
$ npm run -s usage:rollup -- --reconcile-only
{"timestamp":"2026-10-25T20:02:01.035Z","level":"log","context":"PrismaService (subscription)","event":"prisma_service_connected","surface":"subscription"}
{
  "product_key": "sign",
  "status": "NOT_RECONCILED",
  "checked_at": "2026-10-25T20:02:01.041Z",
  "metrics": [
    {
      "metric_key": "sign.envelopes",
      "product_key": "sign",
      "status": "NOT_RECONCILED",
      "watermark": "8451",
      "last_run_id": "01a174a7-b3a4-77b4-81f1-d9c7e095b299",
      "buckets": {
        "source": 1,
        "rollup": 1,
        "pending": 0,
        "compared": 1,
        "mismatched": 1
      },
      "compared_totals": {
        "allowance_usage": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        },
        "rollup": {
          "consumed": 4,
          "consumed_send": 4,
          "consumed_historical": 0,
          "reserved": 0
        }
      },
      "usage_event": {
        "event_type": "sign.envelope.sent",
        "tenants": 1,
        "mismatched_tenants": 1,
        "allowance_usage_consumed_send": 3,
        "usage_event_quantity": 3
      },
      "mismatch_count": 3,
      "mismatches": [
        {
          "kind": "PERIOD",
          "tenant_id": "b605fc31-bc03-432e-9e2c-f557a724190f",
          "period_start": "2026-10-25T20:01:29.242Z",
          "expected": {
            "consumed": 3,
            "consumed_send": 3,
            "consumed_historical": 0,
            "reserved": 0
          },
          "actual": {
            "consumed": 4,
            "consumed_send": 4,
            "consumed_historical": 0,
            "reserved": 0
          }
        },
        {
          "kind": "DAILY",
          "tenant_id": "b605fc31-bc03-432e-9e2c-f557a724190f",
          "period_start": "2026-10-25T20:01:29.242Z",
          "expected": {
            "consumed": 3,
            "consumed_send": 3,
            "consumed_historical": 0,
            "reserved": 0
          },
          "actual": {
            "consumed": 3,
            "consumed_send": 3,
            "consumed_historical": 0,
            "reserved": 0
          }
        },
        {
          "kind": "ROLLUP_USAGE_EVENT",
          "tenant_id": "b605fc31-bc03-432e-9e2c-f557a724190f",
          "period_start": null,
          "expected": 3,
          "actual": 4
        }
      ]
    }
  ]
}
[usage-rollup] NOT_RECONCILED
[exit 1]
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r6-usage-runs.sql
BEGIN
   metric_key   |    mode     | reconciliation | mismatch_count | pending_bucket_count |         started_at         |        finished_at         
----------------+-------------+----------------+----------------+----------------------+----------------------------+----------------------------
 sign.envelopes | INCREMENTAL | NOT_RECONCILED |              3 |                    0 | 2026-10-25 20:01:49.988+00 | 2026-10-25 20:01:50.219+00
(1 row)

ROLLBACK

### R8 held activation — detection
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r8-held.sql
BEGIN
              tenant_id               |             subscription_ref             |              intent_id               |          detected_at          |   open_rows   | intent_status | open_conversions 
--------------------------------------+------------------------------------------+--------------------------------------+-------------------------------+---------------+---------------+------------------
 251ba384-72e8-4aab-8302-51580db0d683 | sub_caaa4113-a5c4-4c7e-94db-9f09189b8fe6 | caaa4113-a5c4-4c7e-94db-9f09189b8fe6 | 2026-10-25 20:01:22.119178+00 | MANUAL:ACTIVE | CREATED       |                0
 f9b26fbc-5044-4c4d-bf92-77cf7ef53901 | sub_1f7d8205-031a-4cd3-820c-4bd6a81919b2 | 1f7d8205-031a-4cd3-820c-4bd6a81919b2 | 2026-10-25 20:01:23.750566+00 | MANUAL:ACTIVE | CREATED       |                1
(2 rows)

ROLLBACK

### R1 action — CONVERSION waiting on the provider: dispatch, then the webhook-confirmed end
dispatchDue: {"skipped":null,"claimed":0,"accepted":0,"retry_wait":0,"failed":0,"lost_fence":0}
confirming webhook: "IGNORED"
conversion request: {"state":"APPLIED","apply_attempts":1}
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r1-applying.sql
BEGIN
 id | action_type | tenant_id | apply_attempts | updated_at | command_id | command_kind | step | command_state | command_attempts | last_error_code 
----+-------------+-----------+----------------+------------+------------+--------------+------+---------------+------------------+-----------------
(0 rows)

 applying_not_conversion 
-------------------------
                       0
(1 row)

ROLLBACK

### R2 action — retry by the requester only
get() as requester OPS: apply_actionable: true
get() as approver FA: apply_actionable: false
apply as OPS2 (not the requester): "CommercialChangeRequestError:NOT_REQUESTER:not_requester Only the person who requested this change can apply it."
(fixture) fault removed (the cause of the failure is fixed)
apply as OPS (requester), retry: "OK"
request: {"state":"APPLIED","apply_attempts":2}
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r2-apply-failed.sql
BEGIN
 id | action_type | tenant_id | product_key | requested_by | apply_attempts | approved_at | last_failure 
----+-------------+-----------+-------------+--------------+----------------+-------------+--------------
(0 rows)

ROLLBACK

### R3a action — expired approval window: the next touch expires it; a fresh request takes the slot
approve the stale request as FA: "CommercialApprovalRefusedError:EXPIRED approval refused (EXPIRED)"
stale request: {"state":"EXPIRED","apply_attempts":0}
fresh request: "DRAFT"

### R3b action — apply deadline passed: a read expires it; apply refuses; a fresh request is the recovery
get() state / apply_actionable: {"state":"APPLY_EXPIRED","apply_actionable":false}
apply as requester: "CommercialChangeRequestError:APPLY_EXPIRED The apply authority of this approved request has expired (apply deadline passed); raise a new request for fresh approvals."
fresh request for the same tenant x product: "OK"
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r3-expiry.sql
BEGIN
 id | action_type | tenant_id | product_key | requested_by | submitted_at | expires_at 
----+-------------+-----------+-------------+--------------+--------------+------------
(0 rows)

 id | action_type | state | approved_at | apply_expiry_hours | apply_deadline 
----+-------------+-------+-------------+--------------------+----------------
(0 rows)

     state     | n 
---------------+---
 APPLY_EXPIRED | 1
 EXPIRED       | 1
(2 rows)

ROLLBACK

### R4 action — FAILED command: the worker re-fetch first, then (engineering, PO-authorized) retryFailed
reconcilePending (provider still active): {"checked":1,"confirmed":0,"failed":0,"results":[{"outcome":"APPLIED","detail":"ACTIVE -> ACTIVE","tenant_id":"bdc577f9-1f08-4c00-bb46-f5ddc6e238b5","subscription_id":"f1bd635c-703b-4e13-9503-3341959dea05"}]}
command: {"state":"FAILED","attempts":1,"last_error_code":"PROVIDER_REFUSED"}
audit rows before retry: {"n":4}
retryFailed: "PENDING"
dispatchDue: {"skipped":null,"claimed":1,"accepted":1,"retry_wait":0,"failed":0,"lost_fence":0}
reconcilePending (provider now canceled): {"checked":1,"confirmed":1,"failed":0,"results":[{"outcome":"APPLIED","detail":"ACTIVE -> CANCELED","tenant_id":"bdc577f9-1f08-4c00-bb46-f5ddc6e238b5","subscription_id":"f1bd635c-703b-4e13-9503-3341959dea05"}]}
command: {"state":"CONFIRMED","attempts":2,"confirmation_source":"REFETCH"}
audit rows after retry (TD-C1-7: retryFailed writes none): {"n":4}
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r4-commands.sql
BEGIN
   state   | n 
-----------+---
 CONFIRMED | 2
(1 row)

 id | change_request_id | step | command_kind | tenant_id | target_ref | state | attempts | last_error_code | next_attempt_at | lease_until | provider_accepted_at | failed_at | updated_at | lease_expired 
----+-------------------+------+--------------+-----------+------------+-------+----------+-----------------+-----------------+-------------+----------------------+-----------+------------+---------------
(0 rows)

ROLLBACK

### R5 action — inbox FAILED: the worker drain after the backoff
drain now (before backoff): {"claimed":0,"processed":0,"failed":0,"results":[]}
drain at +2 min: {"claimed":1,"processed":1,"failed":0,"results":[{"outcome":"APPLIED","detail":"ACTIVE -> ACTIVE","tenant_id":"ff3689d7-b958-448b-923d-0b49654ead30","subscription_id":"07af5001-5abc-45bb-af24-a1a9819b6854"}]}
provider redelivery afterwards: "DUPLICATE"
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r5-inbox.sql
BEGIN
  status   | n 
-----------+---
 PROCESSED | 4
(1 row)

 provider_event_id | event_type | product_key | status | attempts | next_attempt_at | lease_until | last_error | received_at | needs_provider_redelivery 
-------------------+------------+-------------+--------+----------+-----------------+-------------+------------+-------------+---------------------------
(0 rows)

ROLLBACK

### R6 action — rebuild the derived roll-ups
$ npm run -s usage:rollup -- --rebuild
{"timestamp":"2026-10-25T20:02:14.599Z","level":"log","context":"PrismaService (subscription)","event":"prisma_service_connected","surface":"subscription"}
[usage-rollup] run COMPLETED: [{"metric_key":"sign.envelopes","run_id":"01a174a8-1407-7439-b191-0a71dcefcb86","mode":"REBUILD","from_xid":null,"to_xid":"8487","buckets_recomputed":1,"rows_scanned":3,"reconciliation":"RECONCILED","mismatch_count":0,"pending_bucket_count":0}]
{
  "product_key": "sign",
  "status": "RECONCILED",
  "checked_at": "2026-10-25T20:02:14.835Z",
  "metrics": [
    {
      "metric_key": "sign.envelopes",
      "product_key": "sign",
      "status": "RECONCILED",
      "watermark": "8487",
      "last_run_id": "01a174a8-1407-7439-b191-0a71dcefcb86",
      "buckets": {
        "source": 1,
        "rollup": 1,
        "pending": 0,
        "compared": 1,
        "mismatched": 0
      },
      "compared_totals": {
        "allowance_usage": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        },
        "rollup": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        }
      },
      "usage_event": {
        "event_type": "sign.envelope.sent",
        "tenants": 1,
        "mismatched_tenants": 0,
        "allowance_usage_consumed_send": 3,
        "usage_event_quantity": 3
      },
      "mismatch_count": 0,
      "mismatches": []
    }
  ]
}
[usage-rollup] RECONCILED
[exit 0]
$ npm run -s usage:rollup -- --reconcile-only
{"timestamp":"2026-10-25T20:02:17.056Z","level":"log","context":"PrismaService (subscription)","event":"prisma_service_connected","surface":"subscription"}
{
  "product_key": "sign",
  "status": "RECONCILED",
  "checked_at": "2026-10-25T20:02:17.059Z",
  "metrics": [
    {
      "metric_key": "sign.envelopes",
      "product_key": "sign",
      "status": "RECONCILED",
      "watermark": "8487",
      "last_run_id": "01a174a8-1407-7439-b191-0a71dcefcb86",
      "buckets": {
        "source": 1,
        "rollup": 1,
        "pending": 0,
        "compared": 1,
        "mismatched": 0
      },
      "compared_totals": {
        "allowance_usage": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        },
        "rollup": {
          "consumed": 3,
          "consumed_send": 3,
          "consumed_historical": 0,
          "reserved": 0
        }
      },
      "usage_event": {
        "event_type": "sign.envelope.sent",
        "tenants": 1,
        "mismatched_tenants": 0,
        "allowance_usage_consumed_send": 3,
        "usage_event_quantity": 3
      },
      "mismatch_count": 0,
      "mismatches": []
    }
  ]
}
[usage-rollup] RECONCILED
[exit 0]
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r6-usage-runs.sql
BEGIN
   metric_key   |  mode   | reconciliation | mismatch_count | pending_bucket_count |         started_at         |        finished_at         
----------------+---------+----------------+----------------+----------------------+----------------------------+----------------------------
 sign.envelopes | REBUILD | RECONCILED     |              0 |                    0 | 2026-10-25 20:02:14.663+00 | 2026-10-25 20:02:14.796+00
(1 row)

ROLLBACK

### R8 action — held activation resolved through C2 (governed -> self-service adopting the held provider subscription)
conversion apply: {"status":"CONVERTED","request":"APPLIED","release":"CONVERTED"}
tenant-facing state after: null
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r8-held.sql
BEGIN
 tenant_id | subscription_ref | intent_id | detected_at | open_rows | intent_status | open_conversions 
-----------+------------------+-----------+-------------+-----------+---------------+------------------
(0 rows)

ROLLBACK

### R9 action — policy rollback: re-activate v1 (RETIRED) through POLICY_ACTIVATE (Finance -> Owner, requester applies)
approver FA2 tries to apply: "CommercialChangeRequestError:NOT_REQUESTER:not_requester Only the person who requested this change can apply it."
requester FA applies: "APPLIED"
activation audit: {"rollback":"true","replaces_v2":true}
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r9-policy.sql
BEGIN
                  id                  | version_number | status  |                         content_checksum                         |        activated_at        |         retired_at         
--------------------------------------+----------------+---------+------------------------------------------------------------------+----------------------------+----------------------------
 019a0000-0000-7000-8000-0000000cc201 |              1 | ACTIVE  | bdc36ef2f1cde82945139efffdac03c999d98a026113b4dde6e13f0ce05752f5 | 2026-10-25 20:01:29.242+00 | 
 01a174a7-3d88-7098-b88d-e23d97e83094 |              2 | RETIRED | cad2efae1659b3592b8cd2f68d84da919c7d38df3a958281f0ba56ea4e3e6c95 | 2026-10-25 20:01:19.263+00 | 2026-10-25 20:01:29.242+00
(2 rows)

                  id                  |  state  |             requested_by             |                target                | apply_attempts |         applied_at         
--------------------------------------+---------+--------------------------------------+--------------------------------------+----------------+----------------------------
 01a174a7-3ea0-710d-a06d-f758e8c636b5 | APPLIED | e7fc1357-eb45-4b50-8038-a555d8377268 | 01a174a7-3d88-7098-b88d-e23d97e83094 |              1 | 2026-10-25 20:01:19.263+00
 01a174a8-252b-76b7-97b1-a04df3b5dec2 | APPLIED | e7fc1357-eb45-4b50-8038-a555d8377268 | 019a0000-0000-7000-8000-0000000cc201 |              1 | 2026-10-25 20:01:29.242+00
(2 rows)

ROLLBACK

### R-ALERT scan 2 (after the actions)
scan: {"at":"2026-10-25T20:02:19.342Z","raised":0,"refreshed":0,"resolved":7,"open":0,"sources":{"COMMAND_PENDING_PROVIDER_STUCK":"read","COMMAND_FAILED":"read","HELD_ACTIVATION":"read","WEBHOOK_INBOX_FAILED":"read","USAGE_NOT_RECONCILED":"read","APPLY_FAILED":"read","APPROVAL_NEARING_EXPIRY":"read","APPROVAL_PAST_EXPIRY":"read"},"thresholds":{"pending_provider_stuck_minutes":1440,"approval_expiry_lead_minutes":720},"raised_alerts":[],"resolved_alerts":[{"id":"01a174a7-b800-754c-ba7e-5a9541569ee6","alert_type":"APPLY_FAILED","family":"APPROVAL","subject_kind":"change_request","subject_id":"01a … [line cut: 6285 characters]
$ docker exec -i <pg> psql -U aramo -d aramo_recovery -v ON_ERROR_STOP=1 < r7-alerts.sql
BEGIN
  family  |      alert_type      |  status  | n 
----------+----------------------+----------+---
 APPROVAL | APPLY_FAILED         | RESOLVED | 1
 APPROVAL | APPROVAL_PAST_EXPIRY | RESOLVED | 1
 BILLING  | COMMAND_FAILED       | RESOLVED | 1
 BILLING  | HELD_ACTIVATION      | RESOLVED | 2
 BILLING  | USAGE_NOT_RECONCILED | RESOLVED | 1
 BILLING  | WEBHOOK_INBOX_FAILED | RESOLVED | 1
(6 rows)

 alert_type | subject_kind | subject_id | tenant_id | detection_count | first_detected_at | detail 
------------+--------------+------------+-----------+-----------------+-------------------+--------
(0 rows)

ROLLBACK

finished 2026-10-25T20:02:19.531Z; platform tenant 01900000-0000-7000-8000-000000000100
````

### 2.1 Reading the recovery log

| Scenario | Detected by | Resolved by | Final state |
|---|---|---|---|
| Stuck APPLYING | `r1-applying.sql`: 1 CONVERSION row with its PENDING_PROVIDER command; `applying_not_conversion = 0`. A raw attempt to commit a SUBSCRIPTION_OPEN in APPLYING was refused by the deferred trigger and left the request APPROVED, `apply_attempts 0` | the confirming webhook | request APPLIED; 0 APPLYING rows |
| APPLY_FAILED | `r2-apply-failed.sql`: 1 row, `last_failure UNEXPECTED` | requester retry after the cause was removed; `apply_actionable` true for the requester, false for the approver; a second commercial_ops was refused `NOT_REQUESTER` | APPLIED, `apply_attempts 2`; 0 APPLY_FAILED rows |
| Approval window passed | `r3-expiry.sql` (a): 1 row; alert `APPROVAL_PAST_EXPIRY` | the next touch (an approval attempt, refused `EXPIRED`) expired it; a fresh request took the slot | EXPIRED 1 |
| Apply deadline passed | `r3-expiry.sql` (b): 1 row, `apply_expiry_hours 1` | a read expired it (`APPLY_EXPIRED`, `apply_actionable false`); the requester's apply was refused `APPLY_EXPIRED`; a fresh request was created | APPLY_EXPIRED 1 |
| Stripe command FAILED | `r4-commands.sql`: FAILED 1 (`PROVIDER_REFUSED`); alert `COMMAND_FAILED` | the worker re-fetch left it FAILED (provider still active); the engineering-only `retryFailed` + dispatch + re-fetch confirmed it; **0** audit rows added (4 before, 4 after: TD-C1-7) | CONFIRMED 2, `confirmation_source REFETCH` |
| Webhook inbox FAILED | `r5-inbox.sql`: 1 FAILED row, `attempts 1`; alert `WEBHOOK_INBOX_FAILED` | the drain after the backoff (not before it); a later redelivery was `DUPLICATE` | PROCESSED 4, 0 failed |
| Usage NOT_RECONCILED | CLI run exit 1 `NOT_RECONCILED`, 3 mismatches (PERIOD, DAILY, ROLLUP_USAGE_EVENT); `r6-usage-runs.sql`; alert `USAGE_NOT_RECONCILED` | `usage:rollup -- --rebuild` (exit 0, RECONCILED); `--reconcile-only` exit 0 | latest run REBUILD RECONCILED, 0 mismatches |
| Held activation | `r8-held.sql`: 2 held tenants; tenant state "Subscription activation pending — contact support"; 2 `HELD_ACTIVATION` alerts | one through C2 TO_SELF_SERVICE (CONVERTED), one through C2 TO_GOVERNED (the provider-confirmed cancel) | 0 open flags; tenant state no longer pending |
| Policy rollback | `r9-policy.sql`: v1 RETIRED, v2 ACTIVE | POLICY_ACTIVATE of v1: Finance → Owner; the approver's apply refused `NOT_REQUESTER`; the requester applied; audit `rollback: true`, `replaces` = v2 | v1 ACTIVE, v2 RETIRED; 2 POLICY_ACTIVATE requests APPLIED |
| Alert triage | scan 1: raised 7 (APPLY_FAILED 1, APPROVAL_PAST_EXPIRY 1, COMMAND_FAILED 1, HELD_ACTIVATION 2, USAGE_NOT_RECONCILED 1, WEBHOOK_INBOX_FAILED 1) | the actions above | scan 2: resolved 7, open 0 |

## 3. Break-glass

Part A ran on the migrated `aramo` database with three fixture tenants (`0190d5b6-…-b1` clean MANUAL, `…-b2` MANUAL with
a provider link, `…-b3` MANUAL with an open `governed_subscription_open` flag), each with an open MANUAL row pinned to the
included plan's PUBLISHED v1. Part B ran on the same database after the bootstrap (§4) had granted the one platform_owner.

````text
### BG-A1 refused: no evidence location
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v tenant_id=0190d5b6-0000-7000-8000-0000000000b1 -v subscription_id=0190d5b7-0000-7000-8000-0000000000b1 -v po_ref=D5-DRY-RUN-NOT-PRODUCTION -v operator=d5-dry-run@local -v evidence="" -v reason="d5 dry run"' < c15-break-glass-end.sql
BEGIN
              set_config              |              set_config              |        set_config         | set_config 
--------------------------------------+--------------------------------------+---------------------------+------------
 0190d5b6-0000-7000-8000-0000000000b1 | 0190d5b7-0000-7000-8000-0000000000b1 | D5-DRY-RUN-NOT-PRODUCTION | 
(1 row)

 pg_advisory_xact_lock 
-----------------------
 
(1 row)

ERROR:  break-glass refused: a PO authorization reference and an evidence location are required
CONTEXT:  PL/pgSQL function inline_code_block line 7 at RAISE
[exit 3]

### BG-A2 refused: provider-linked row
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v tenant_id=0190d5b6-0000-7000-8000-0000000000b2 -v subscription_id=0190d5b7-0000-7000-8000-0000000000b2 -v po_ref=D5-DRY-RUN-NOT-PRODUCTION -v operator=d5-dry-run@local -v evidence="documents/d5-dry-run" -v reason="d5 dry run"' < c15-break-glass-end.sql
BEGIN
              set_config              |              set_config              |        set_config         |      set_config      
--------------------------------------+--------------------------------------+---------------------------+----------------------
 0190d5b6-0000-7000-8000-0000000000b2 | 0190d5b7-0000-7000-8000-0000000000b2 | D5-DRY-RUN-NOT-PRODUCTION | documents/d5-dry-run
(1 row)

 pg_advisory_xact_lock 
-----------------------
 
(1 row)

ERROR:  break-glass refused: the row is provider-linked (Stripe-owned operations go through C1 commands only)
CONTEXT:  PL/pgSQL function inline_code_block line 15 at RAISE
[exit 3]

### BG-A3 refused: open reconciliation flag
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v tenant_id=0190d5b6-0000-7000-8000-0000000000b3 -v subscription_id=0190d5b7-0000-7000-8000-0000000000b3 -v po_ref=D5-DRY-RUN-NOT-PRODUCTION -v operator=d5-dry-run@local -v evidence="documents/d5-dry-run" -v reason="d5 dry run"' < c15-break-glass-end.sql
BEGIN
              set_config              |              set_config              |        set_config         |      set_config      
--------------------------------------+--------------------------------------+---------------------------+----------------------
 0190d5b6-0000-7000-8000-0000000000b3 | 0190d5b7-0000-7000-8000-0000000000b3 | D5-DRY-RUN-NOT-PRODUCTION | documents/d5-dry-run
(1 row)

 pg_advisory_xact_lock 
-----------------------
 
(1 row)

ERROR:  break-glass refused: an open reconciliation flag exists for the tenant (a provider subscription may be live); resolve it through C2
CONTEXT:  PL/pgSQL function inline_code_block line 21 at RAISE
[exit 3]

### BG-A4 the authorized break-glass end
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v tenant_id=0190d5b6-0000-7000-8000-0000000000b1 -v subscription_id=0190d5b7-0000-7000-8000-0000000000b1 -v po_ref=D5-DRY-RUN-NOT-PRODUCTION -v operator=d5-dry-run@local -v evidence="documents/d5-dry-run" -v reason="d5 dry run"' < c15-break-glass-end.sql
BEGIN
              set_config              |              set_config              |        set_config         |      set_config      
--------------------------------------+--------------------------------------+---------------------------+----------------------
 0190d5b6-0000-7000-8000-0000000000b1 | 0190d5b7-0000-7000-8000-0000000000b1 | D5-DRY-RUN-NOT-PRODUCTION | documents/d5-dry-run
(1 row)

 pg_advisory_xact_lock 
-----------------------
 
(1 row)

DO
                                                                                                                                                                                                                                                                                                                                                                                         before_image                                                                                                                                                                                                                    … [line cut: 767 characters]
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ … [line cut: 767 characters]
 {"id":"0190d5b7-0000-7000-8000-0000000000b1","tenant_id":"0190d5b6-0000-7000-8000-0000000000b1","plan_id":"019a0000-5150-7000-8000-000000000001","period_anchor":"2026-10-01T00:00:00+00:00","source":"MANUAL","started_at":"2026-10-25T20:06:59.896402+00:00","ended_at":null,"created_by":"d5-fixture","status":"ACTIVE","billing_provider":null,"billing_account_ref":null,"billing_subscription_ref":null,"current_period_end":null,"cancel_at_period_end":false,"grace_until":null,"provider_state_at":null,"activated_by":null,"commitment_start":null,"commitment_end":null,"cancel_requested_within_commitment" … [line cut: 766 characters]
(1 row)

UPDATE 1
INSERT 0 1
                                                                                                                                                                                                                                                                                                                                                                                                          after_image                                                                                                                                                                                                    … [line cut: 799 characters]
------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ … [line cut: 799 characters]
 {"id":"0190d5b7-0000-7000-8000-0000000000b1","tenant_id":"0190d5b6-0000-7000-8000-0000000000b1","plan_id":"019a0000-5150-7000-8000-000000000001","period_anchor":"2026-10-01T00:00:00+00:00","source":"MANUAL","started_at":"2026-10-25T20:06:59.896402+00:00","ended_at":"2026-10-25T20:07:17.574333+00:00","created_by":"d5-fixture","status":"CANCELED","billing_provider":null,"billing_account_ref":null,"billing_subscription_ref":null,"current_period_end":null,"cancel_at_period_end":false,"grace_until":null,"provider_state_at":null,"activated_by":null,"commitment_start":null,"commitment_end":null,"can … [line cut: 798 characters]
(1 row)

                event_type                 | is_exception |          po_ref           
-------------------------------------------+--------------+---------------------------
 COMMERCIAL_BREAK_GLASS_SUBSCRIPTION_ENDED | t            | D5-DRY-RUN-NOT-PRODUCTION
(1 row)

COMMIT
[exit 0]

### BG-A5 refused: re-run on the ended row
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v tenant_id=0190d5b6-0000-7000-8000-0000000000b1 -v subscription_id=0190d5b7-0000-7000-8000-0000000000b1 -v po_ref=D5-DRY-RUN-NOT-PRODUCTION -v operator=d5-dry-run@local -v evidence="documents/d5-dry-run" -v reason="d5 dry run"' < c15-break-glass-end.sql
BEGIN
              set_config              |              set_config              |        set_config         |      set_config      
--------------------------------------+--------------------------------------+---------------------------+----------------------
 0190d5b6-0000-7000-8000-0000000000b1 | 0190d5b7-0000-7000-8000-0000000000b1 | D5-DRY-RUN-NOT-PRODUCTION | documents/d5-dry-run
(1 row)

 pg_advisory_xact_lock 
-----------------------
 
(1 row)

ERROR:  break-glass refused: the row is already ended (an ended row is never reopened)
CONTEXT:  PL/pgSQL function inline_code_block line 12 at RAISE
[exit 3]

### BG-A6 unchanged rows (fixtures 2 and 3)
$ docker exec ccp-d5-dryrun-pg psql -U aramo -d aramo -c "SELECT id, source, status, ended_at IS NULL AS open FROM subscription.\"TenantSubscription\" WHERE tenant_id::text LIKE '0190d5b6%' ORDER BY id"
                  id                  | source |  status  | open 
--------------------------------------+--------+----------+------
 0190d5b7-0000-7000-8000-0000000000b1 | MANUAL | CANCELED | f
 0190d5b7-0000-7000-8000-0000000000b2 | MANUAL | ACTIVE   | t
 0190d5b7-0000-7000-8000-0000000000b3 | MANUAL | ACTIVE   | t
(3 rows)

[exit 0]

(dry-run fixture: the platform_owner assignment removed by the first Part B drill was re-inserted so the drill could be repeated with the hardened tail)

### BG-B1 capture before
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < a9-capture.sql
BEGIN
         relname          |                    tgname                    | tgenabled 
--------------------------+----------------------------------------------+-----------
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_delete | A
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_update | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_delete       | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_update       | A
 User                     | ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 effective_platform_owners 
---------------------------
                         1
(1 row)

ROLLBACK
[exit 0]

### BG-B2 the same operation WITHOUT break-glass is refused by the guard
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' < a9-dryrun-op.sql
ERROR:  platform_last_owner: the platform must keep at least one active platform_owner
CONTEXT:  PL/pgSQL function identity.ccp_a9_assert_platform_keeps_owner() line 1 at RAISE
SQL statement "SELECT "identity".ccp_a9_assert_platform_keeps_owner()"
PL/pgSQL function identity.ccp_a9_guard_platform_owner_role() line 1 at PERFORM
[exit 3]

### BG-B3 one-transaction window: disable, the authorized operation, re-arm ALWAYS, assert, commit
$ cat a9-window-head.sql a9-dryrun-op.sql a9-window-tail.sql | docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
BEGIN
SET
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
DELETE 1
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
DO
 armed | total 
-------+-------
     5 |     5
(1 row)

COMMIT
[exit 0]

### BG-B4 capture after
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < a9-capture.sql
BEGIN
         relname          |                    tgname                    | tgenabled 
--------------------------+----------------------------------------------+-----------
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_delete | A
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_update | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_delete       | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_update       | A
 User                     | ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 effective_platform_owners 
---------------------------
                         0
(1 row)

ROLLBACK
[exit 0]

### BG-B5 a failing operation inside the window rolls the disable back too
$ ( cat a9-window-head.sql; echo "SELECT 1/0;"; cat a9-window-tail.sql ) | docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < a9-capture.sql
BEGIN
SET
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ERROR:  division by zero
BEGIN
         relname          |                    tgname                    | tgenabled 
--------------------------+----------------------------------------------+-----------
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_delete | A
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_update | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_delete       | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_update       | A
 User                     | ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 effective_platform_owners 
---------------------------
                         0
(1 row)

ROLLBACK
[exit 0]

### BG-B5b the tail refuses to commit when a trigger is left disabled
$ ( cat a9-window-head.sql; echo 'SELECT 1;'; sed '/ccp_a9_platform_last_owner_user_update";$/d' a9-window-tail.sql ) | docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < a9-capture.sql
BEGIN
SET
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
 ?column? 
----------
        1
(1 row)

ALTER TABLE
ALTER TABLE
ALTER TABLE
ALTER TABLE
ERROR:  A9 break-glass: the guard is not fully re-armed; nothing is committed
CONTEXT:  PL/pgSQL function inline_code_block line 4 at RAISE
BEGIN
         relname          |                    tgname                    | tgenabled 
--------------------------+----------------------------------------------+-----------
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_delete | A
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_update | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_delete       | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_update       | A
 User                     | ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 effective_platform_owners 
---------------------------
                         0
(1 row)

ROLLBACK
[exit 0]

### BG-B6 re-arm by replaying the migration (idempotent)
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q' < <worktree>/libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql && docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < a9-capture.sql
BEGIN
         relname          |                    tgname                    | tgenabled 
--------------------------+----------------------------------------------+-----------
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_delete | A
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_update | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_delete       | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_update       | A
 User                     | ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 effective_platform_owners 
---------------------------
                         0
(1 row)

ROLLBACK
[exit 0]
````

## 4. Platform-owner bootstrap

On the migrated `aramo` database (the pre-CCP platform-owner seed's super_admin `purush@aramo.ai` in the sentinel tenant;
ACTIVE policy v1). B2–B4 are the shipped npm command; B6 is a direct `node --import jiti/register` attempt; B8 is a
temporary driver (deleted) that calls `parseBootstrapArgs` + `runPlatformOwnerBootstrap` exactly as the script does, with
the argv the script would see once D5-DEF-3 is fixed.

````text
### B1 pre-check
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/bootstrap-precheck.sql
BEGIN
 super_admin_holders | active_holders 
---------------------+----------------
                   1 |              1
(1 row)

 platform_owner_holders 
------------------------
                      0
(1 row)

 bootstrap_events | bootstrap_attestations 
------------------+------------------------
                0 |                      0
(1 row)

 active_policies 
-----------------
               1
(1 row)

                    tgname                    | tgenabled 
----------------------------------------------+-----------
 ccp_a9_platform_last_owner_membership_delete | A
 ccp_a9_platform_last_owner_membership_update | A
 ccp_a9_platform_last_owner_role_delete       | A
 ccp_a9_platform_last_owner_role_update       | A
 ccp_a9_platform_last_owner_user_update       | A
(5 rows)

ROLLBACK
[exit 0]

### B2a refusal: no arguments
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo npm run -s ccp:bootstrap-platform-owner
[ccp-bootstrap] REFUSED: INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts","accepted":["--po-authorization-ref","--human-ref-hash"]}
[exit 2]

### B2b refusal: an unknown argument (a target email)
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo npm run -s ccp:bootstrap-platform-owner -- --email someone@example.test --po-authorization-ref D5-DRY-RUN --human-ref-hash $(printf '%s' 'd5-dry-run-human' | shasum -a 256 | cut -d' ' -f1)
[ccp-bootstrap] REFUSED: INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts","accepted":["--po-authorization-ref","--human-ref-hash"]}
[exit 2]

### B2c refusal: a malformed human-ref hash
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo npm run -s ccp:bootstrap-platform-owner -- --po-authorization-ref D5-DRY-RUN --human-ref-hash NOT-A-HASH
[ccp-bootstrap] REFUSED: INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts","accepted":["--po-authorization-ref","--human-ref-hash"]}
[exit 2]

### B2d refusal: DATABASE_URL unset
$ env -u DATABASE_URL npm run -s ccp:bootstrap-platform-owner -- --po-authorization-ref D5-DRY-RUN --human-ref-hash $(printf '%s' 'd5-dry-run-human' | shasum -a 256 | cut -d' ' -f1)
[ccp-bootstrap] FATAL: DATABASE_URL is not set.
[exit 1]

### B3 the one-time grant
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo npm run -s ccp:bootstrap-platform-owner -- --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION --human-ref-hash $(printf '%s' 'd5-dry-run-human' | shasum -a 256 | cut -d' ' -f1)
[ccp-bootstrap] REFUSED: INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts","accepted":["--po-authorization-ref","--human-ref-hash"]}
[exit 2]

### B4 re-run is a no-op
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo npm run -s ccp:bootstrap-platform-owner -- --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION --human-ref-hash $(printf '%s' 'd5-dry-run-human' | shasum -a 256 | cut -d' ' -f1)
[ccp-bootstrap] REFUSED: INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts","accepted":["--po-authorization-ref","--human-ref-hash"]}
[exit 2]

### B5 post-check
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/bootstrap-precheck.sql
BEGIN
 super_admin_holders | active_holders 
---------------------+----------------
                   1 |              1
(1 row)

 platform_owner_holders 
------------------------
                      0
(1 row)

 bootstrap_events | bootstrap_attestations 
------------------+------------------------
                0 |                      0
(1 row)

 active_policies 
-----------------
               1
(1 row)

                    tgname                    | tgenabled 
----------------------------------------------+-----------
 ccp_a9_platform_last_owner_membership_delete | A
 ccp_a9_platform_last_owner_membership_update | A
 ccp_a9_platform_last_owner_role_delete       | A
 ccp_a9_platform_last_owner_role_update       | A
 ccp_a9_platform_last_owner_user_update       | A
(5 rows)

ROLLBACK
[exit 0]

### B5b audit row
$ docker exec ccp-d5-dryrun-pg psql -U aramo -d aramo -c "SELECT event_type, is_exception, actor_type, payload->>'exception_kind' AS kind, payload->>'po_authorization_ref' AS po_ref, payload->>'granted_source' AS source FROM subscription.\"CommercialAuditEvent\" WHERE event_type = 'COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED'"
 event_type | is_exception | actor_type | kind | po_ref | source 
------------+--------------+------------+------+--------+--------
(0 rows)

[exit 0]

### B6a direct invocation, malformed hash (refusal path)
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo node --import jiti/register libs/subscription/scripts/ccp-bootstrap-platform-owner.ts --po-authorization-ref D5-DRY-RUN --human-ref-hash NOT-A-HASH
node:internal/modules/cjs/loader:1369
  const err = new Error(message);
              ^

Error: Cannot find module '@aramo/common'
Require stack:
- <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts
    at Module._resolveFilename (node:internal/modules/cjs/loader:1369:15)
    at require.resolve (node:internal/modules/helpers:145:19)
    at jitiResolve (<worktree>/node_modules/jiti/dist/jiti.cjs:1:148703)
    at jitiRequire (<worktree>/node_modules/jiti/dist/jiti.cjs:1:150290)
    at import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158307)
    at <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts:3:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-policy.repository.ts:4:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts:5:35
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async _module (file://<worktree>/libs/subscription/scripts/ccp-bootstrap-platform-owner.ts:18:41)
    at async file://<worktree>/libs/subscription/scripts/ccp-bootstrap-platform-owner.ts:67:1 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '<worktree>/libs/subscription/src/lib/prisma/prisma.service.ts'
  ]
}

Node.js v24.4.1
[exit 1]

### B6b direct invocation, unknown argument
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo node --import jiti/register libs/subscription/scripts/ccp-bootstrap-platform-owner.ts --email someone@example.test --po-authorization-ref D5-DRY-RUN --human-ref-hash 5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13
node:internal/modules/cjs/loader:1369
  const err = new Error(message);
              ^

Error: Cannot find module '@aramo/common'
Require stack:
- <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts
    at Module._resolveFilename (node:internal/modules/cjs/loader:1369:15)
    at require.resolve (node:internal/modules/helpers:145:19)
    at jitiResolve (<worktree>/node_modules/jiti/dist/jiti.cjs:1:148703)
    at jitiRequire (<worktree>/node_modules/jiti/dist/jiti.cjs:1:150290)
    at import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158307)
    at <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts:3:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-policy.repository.ts:4:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts:5:35 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '<worktree>/libs/subscription/src/lib/prisma/prisma.service.ts'
  ]
}

Node.js v24.4.1
[exit 1]

### B6c direct invocation: the one-time grant
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo node --import jiti/register libs/subscription/scripts/ccp-bootstrap-platform-owner.ts --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION --human-ref-hash 5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13
node:internal/modules/cjs/loader:1369
  const err = new Error(message);
              ^

Error: Cannot find module '@aramo/common'
Require stack:
- <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts
    at Module._resolveFilename (node:internal/modules/cjs/loader:1369:15)
    at require.resolve (node:internal/modules/helpers:145:19)
    at jitiResolve (<worktree>/node_modules/jiti/dist/jiti.cjs:1:148703)
    at jitiRequire (<worktree>/node_modules/jiti/dist/jiti.cjs:1:150290)
    at import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158307)
    at <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts:3:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-policy.repository.ts:4:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts:5:35 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '<worktree>/libs/subscription/src/lib/prisma/prisma.service.ts'
  ]
}

Node.js v24.4.1
[exit 1]

### B6d direct invocation: re-run is a no-op
$ DATABASE_URL=postgresql://aramo:dryrun@localhost:55417/aramo node --import jiti/register libs/subscription/scripts/ccp-bootstrap-platform-owner.ts --po-authorization-ref D5-DRY-RUN-NOT-PRODUCTION --human-ref-hash 5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13
node:internal/modules/cjs/loader:1369
  const err = new Error(message);
              ^

Error: Cannot find module '@aramo/common'
Require stack:
- <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts
    at Module._resolveFilename (node:internal/modules/cjs/loader:1369:15)
    at require.resolve (node:internal/modules/helpers:145:19)
    at jitiResolve (<worktree>/node_modules/jiti/dist/jiti.cjs:1:148703)
    at jitiRequire (<worktree>/node_modules/jiti/dist/jiti.cjs:1:150290)
    at import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158307)
    at <worktree>/libs/subscription/src/lib/prisma/prisma.service.ts:3:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-policy.repository.ts:4:22
    at async import (<worktree>/node_modules/jiti/dist/jiti.cjs:1:158301)
    at async <worktree>/libs/subscription/src/lib/commercial/commercial-platform-owner-bootstrap.ts:5:35 {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '<worktree>/libs/subscription/src/lib/prisma/prisma.service.ts'
  ]
}

Node.js v24.4.1
[exit 1]

### B7 post-check
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/bootstrap-precheck.sql
BEGIN
 super_admin_holders | active_holders 
---------------------+----------------
                   1 |              1
(1 row)

 platform_owner_holders 
------------------------
                      0
(1 row)

 bootstrap_events | bootstrap_attestations 
------------------+------------------------
                0 |                      0
(1 row)

 active_policies 
-----------------
               1
(1 row)

                    tgname                    | tgenabled 
----------------------------------------------+-----------
 ccp_a9_platform_last_owner_membership_delete | A
 ccp_a9_platform_last_owner_membership_update | A
 ccp_a9_platform_last_owner_role_delete       | A
 ccp_a9_platform_last_owner_role_update       | A
 ccp_a9_platform_last_owner_user_update       | A
(5 rows)

ROLLBACK
[exit 0]

### B7b audit row
$ docker exec ccp-d5-dryrun-pg psql -U aramo -d aramo -c "SELECT event_type, is_exception, actor_type, payload->>'exception_kind' AS kind, payload->>'po_authorization_ref' AS po_ref, payload->>'granted_source' AS source FROM subscription.\"CommercialAuditEvent\" WHERE event_type = 'COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED'"
 event_type | is_exception | actor_type | kind | po_ref | source 
------------+--------------+------------+------+--------+--------
(0 rows)

[exit 0]

### B8a refusal: a target email argument
argv: ["--email","someone@example.test","--po-authorization-ref","D5-DRY-RUN","--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
REFUSED: INVALID_ARGUMENT {"unknown_argument":"--email","accepted":["--po-authorization-ref","--human-ref-hash"]}
### B8b refusal: malformed human-ref hash
argv: ["--po-authorization-ref","D5-DRY-RUN","--human-ref-hash","NOT-A-HASH"]
REFUSED: INVALID_ARGUMENT {"argument":"human_ref_hash"}
### B8c refusal: missing --po-authorization-ref
argv: ["--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
REFUSED: INVALID_ARGUMENT {"missing_argument":"--po-authorization-ref"}
### B8d the one-time grant
argv: ["--po-authorization-ref","D5-DRY-RUN-NOT-PRODUCTION","--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
granted platform_owner to 019000b0-0000-7000-8000-000000000001; attestation 01a174ab-55fd-70b1-a62d-62c91b9ca1bf; audit event 01a174ab-560f-76cf-82e2-510818e45874.
### B8e re-run is a no-op
argv: ["--po-authorization-ref","D5-DRY-RUN-NOT-PRODUCTION","--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
no-op: 019000b0-0000-7000-8000-000000000001 already holds platform_owner (nothing written).
### B9 post-check
$ docker exec -i ccp-d5-dryrun-pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < <scratch>/sql/bootstrap-precheck.sql
BEGIN
 super_admin_holders | active_holders 
---------------------+----------------
                   1 |              1
(1 row)

 platform_owner_holders 
------------------------
                      1
(1 row)

 bootstrap_events | bootstrap_attestations 
------------------+------------------------
                1 |                      1
(1 row)

 active_policies 
-----------------
               1
(1 row)

                    tgname                    | tgenabled 
----------------------------------------------+-----------
 ccp_a9_platform_last_owner_membership_delete | A
 ccp_a9_platform_last_owner_membership_update | A
 ccp_a9_platform_last_owner_role_delete       | A
 ccp_a9_platform_last_owner_role_update       | A
 ccp_a9_platform_last_owner_user_update       | A
(5 rows)

ROLLBACK
[exit 0]

### B9b audit row
$ docker exec ccp-d5-dryrun-pg psql -U aramo -d aramo -c "SELECT event_type, is_exception, actor_type, payload->>'exception_kind' AS kind, payload->>'po_authorization_ref' AS po_ref, payload->>'granted_source' AS source FROM subscription.\"CommercialAuditEvent\" WHERE event_type = 'COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED'"
               event_type               | is_exception | actor_type |   kind    |          po_ref           |  source   
----------------------------------------+--------------+------------+-----------+---------------------------+-----------
 COMMERCIAL_PLATFORM_OWNER_BOOTSTRAPPED | t            | system     | BOOTSTRAP | D5-DRY-RUN-NOT-PRODUCTION | MIGRATION
(1 row)

[exit 0]
````

**Inert check** (after Part B of §3 removed the only platform_owner): the same driver, run again.

````text
### B8a refusal: a target email argument
argv: ["--email","someone@example.test","--po-authorization-ref","D5-DRY-RUN","--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
REFUSED: INVALID_ARGUMENT {"unknown_argument":"--email","accepted":["--po-authorization-ref","--human-ref-hash"]}
### B8b refusal: malformed human-ref hash
argv: ["--po-authorization-ref","D5-DRY-RUN","--human-ref-hash","NOT-A-HASH"]
REFUSED: INVALID_ARGUMENT {"argument":"human_ref_hash"}
### B8c refusal: missing --po-authorization-ref
argv: ["--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
REFUSED: INVALID_ARGUMENT {"missing_argument":"--po-authorization-ref"}
### B8d the one-time grant
argv: ["--po-authorization-ref","D5-DRY-RUN-NOT-PRODUCTION","--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
REFUSED: ALREADY_BOOTSTRAPPED {"prior_events":1}
### B8e re-run is a no-op
argv: ["--po-authorization-ref","D5-DRY-RUN-NOT-PRODUCTION","--human-ref-hash","5cd5ee586f4181b1f8acae775990ff190c76a0d69c6e13cf40d459469d071d13"]
REFUSED: ALREADY_BOOTSTRAPPED {"prior_events":1}
````

## 5. Dark-state verification

The box containers do not exist locally, so the published check script ran unchanged against stand-in containers
(`postgres:17` running `sleep`) that carry only the relevant environment, with the container names and the env-file path
passed as the script's overrides (`SUDO=`, `SIGN_C`, `PA_C`, `ENV_FILE`). `dark` is the expected configuration (a fake
`sk_test_` key, empty `STRIPE_PLAN_PRICES`); `lit` turns every switch on (a fake `sk_live_` key, a price map). The
platform-admin stand-in gets no Stripe variables, as `docker-compose.prod.yml` passes none to it. Both fake keys contain
the marker `d5dryrunNOTAREALKEY`; the last step counts it in the output. The data check ran on the migrated `aramo`
database (its `open_flags = 1` is the §3 break-glass fixture `…-b3`).

````text
### DS-dark: SUDO= SIGN_C=d5-dark-sign PA_C=d5-dark-pa ENV_FILE=<scratch>/dark.env bash dark-state-check.sh
CONTROL                            VARIABLE                     RUNNING  ENV_FILE 
public business signup             SIGN_PUBLIC_SIGNUP_ENABLED   UNSET    UNSET    expected UNSET
Personal (platform-admin)          SIGN_PERSONAL_SIGNUP_MODE    UNSET    UNSET    expected UNSET
Personal (sign)                    SIGN_PERSONAL_SIGNUP_MODE    UNSET    UNSET    expected UNSET
Stripe key (sign)                  STRIPE_SECRET_KEY            TEST     TEST     expected TEST or UNSET
Stripe key (platform-admin)        STRIPE_SECRET_KEY            UNSET    -        expected UNSET
checkout prices                    STRIPE_PLAN_PRICES           UNSET    UNSET    expected UNSET
Stripe command worker              SIGN_BILLING_COMMANDS_ENABLED UNSET    UNSET    expected UNSET
[exit 0]

### DS-lit: SUDO= SIGN_C=d5-lit-sign PA_C=d5-lit-pa ENV_FILE=<scratch>/lit.env bash dark-state-check.sh
CONTROL                            VARIABLE                     RUNNING  ENV_FILE 
public business signup             SIGN_PUBLIC_SIGNUP_ENABLED   SET      SET      expected UNSET
Personal (platform-admin)          SIGN_PERSONAL_SIGNUP_MODE    SET      SET      expected UNSET
Personal (sign)                    SIGN_PERSONAL_SIGNUP_MODE    SET      SET      expected UNSET
Stripe key (sign)                  STRIPE_SECRET_KEY            LIVE     LIVE     expected TEST or UNSET
Stripe key (platform-admin)        STRIPE_SECRET_KEY            UNSET    -        expected UNSET
checkout prices                    STRIPE_PLAN_PRICES           SET      SET      expected UNSET
Stripe command worker              SIGN_BILLING_COMMANDS_ENABLED SET      SET      expected UNSET
[exit 0]

### DS-secret-leak check: does the output contain any key material?
0
### DS-sql dark-state.sql on the migrated prod-shaped database
BEGIN
 pinned_provider_prices 
------------------------
                      0
(1 row)

 slug  | source | status |        plan_key        |     period_anchor      | provider_linked | product_key | pinned_version 
-------+--------+--------+------------------------+------------------------+-----------------+-------------+----------------
 astre | MANUAL | ACTIVE | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | f               | sign        |              1
(1 row)

 open_self_service | open_flags | open_checkout_intents 
-------------------+------------+-----------------------
                 0 |          1 |                     0
(1 row)

ROLLBACK
[exit 0]
````

## 6. Supporting targeted specs (this session, `ARAMO_RUN_INTEGRATION=1`, real Postgres 17 testcontainers)

| Spec | Result | Covers |
|---|---|---|
| `libs/subscription/src/tests/ccp-c1-command-inbox.integration.spec.ts` | 23 / 23 | lease reclaim (C1-LEASE-1), retry backoff, FAILED visibility, inbox failure and crash recovery |
| `libs/subscription/src/tests/ccp-c2-conversion.integration.spec.ts` | 21 / 21 | the held-activation resolutions C2-C8-1…3 |
| `libs/subscription/src/tests/ccp-a6r-apply-deadline.integration.spec.ts` | 8 / 8 | the apply deadline boundary, AD-2 (v1 never expires) |
| `libs/subscription/src/tests/ccp-a9-bootstrap-role-change.integration.spec.ts` | 17 / 17 | every bootstrap refusal, the inert rule, role changes |
| `libs/subscription/src/tests/ccp-merge-train-compensation.integration.spec.ts` | 4 / 4 | compensations refused with dependent data; reverse order; re-apply |
| `libs/identity/src/tests/ccp-a9-platform-last-owner.spec.ts` | 4 / 4 | the A9 trigger set (static) |
| **Total** | **77 / 77** | |

## 7. Rendered-text re-check

Every `BEGIN TRANSACTION READ ONLY` SQL block was extracted from the five published runbooks and run as written against
the dry-run databases (migration, dark-state, bootstrap and break-glass blocks on `aramo`; recovery blocks on
`aramo_recovery`): **16 / 16** exit 0 with `ROLLBACK`. The non-read-only blocks (the break-glass SQL, the A9 window, the
dark-state script, the ledger-row compensation command) are injected byte-for-byte from the files run in §1.4, §3 and §5.

````text
### RUNBOOK-ccp-migration-validation.md block 5 (db aramo) exit 0 OK
BEGIN
 roles | scopes | role_scopes 
-------+--------+-------------
    25 |    205 |         984
(1 row)

 a1_ids_or_keys_already_present 
--------------------------------
                             21
(1 row)

 tenant_read_scope 
-------------------
                 1
(1 row)

ROLLBACK

### RUNBOOK-ccp-migration-validation.md block 6 (db aramo) exit 0 OK
ason           | n 
----------------------------+---
 governed_subscription_open | 1
(1 row)

              tenant_id               |        plan_key        |     period_anchor      | status 
--------------------------------------+------------------------+------------------------+--------
 019000a0-0000-7000-8000-000000000001 | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | ACTIVE
 0190d5b6-0000-7000-8000-0000000000b2 | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | ACTIVE
 0190d5b6-0000-7000-8000-0000000000b3 | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | ACTIVE
(3 rows)

ROLLBACK

### RUNBOOK-ccp-migration-validation.md block 7 (db aramo) exit 0 OK
BEGIN
 slug  | source | status |        plan_key        |     period_anchor      |          started_at           | ended_at | provider_linked 
-------+--------+--------+------------------------+------------------------+-------------------------------+----------+-----------------
 astre | MANUAL | ACTIVE | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | 2026-10-25 19:48:26.466816+00 |          | f
(1 row)

 entitlements  
---------------
 ats,core,sign
(1 row)

ROLLBACK

### RUNBOOK-ccp-migration-validation.md block 10 (db aramo) exit 0 OK

 commercial_change_request_no_applying_commit_b5r
(5 rows)

 change_requests | provider_commands | inbox_rows | alerts | rollup_runs | attestations | audit_events 
-----------------+-------------------+------------+--------+-------------+--------------+--------------
               0 |                 0 |          0 |      0 |           0 |            1 |            3
(1 row)

 capability | granted_source | n 
------------+----------------+---
 ats        | MIGRATION      | 2
 core       | MIGRATION      | 2
 portal     | MIGRATION      | 1
 sign       | MIGRATION      | 1
(4 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 2 (db aramo_recovery) exit 0 OK
  alert_type      |  status  | n 
----------+----------------------+----------+---
 APPROVAL | APPLY_FAILED         | RESOLVED | 1
 APPROVAL | APPROVAL_PAST_EXPIRY | RESOLVED | 1
 BILLING  | COMMAND_FAILED       | RESOLVED | 1
 BILLING  | HELD_ACTIVATION      | RESOLVED | 2
 BILLING  | USAGE_NOT_RECONCILED | RESOLVED | 1
 BILLING  | WEBHOOK_INBOX_FAILED | RESOLVED | 1
(6 rows)

 alert_type | subject_kind | subject_id | tenant_id | detection_count | first_detected_at | detail 
------------+--------------+------------+-----------+-----------------+-------------------+--------
(0 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 3 (db aramo_recovery) exit 0 OK
BEGIN
 id | action_type | tenant_id | apply_attempts | updated_at | command_id | command_kind | step | command_state | command_attempts | last_error_code 
----+-------------+-----------+----------------+------------+------------+--------------+------+---------------+------------------+-----------------
(0 rows)

 applying_not_conversion 
-------------------------
                       0
(1 row)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 4 (db aramo_recovery) exit 0 OK
BEGIN
 id | action_type | tenant_id | product_key | requested_by | apply_attempts | approved_at | last_failure 
----+-------------+-----------+-------------+--------------+----------------+-------------+--------------
(0 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 5 (db aramo_recovery) exit 0 OK
BEGIN
 id | action_type | tenant_id | product_key | requested_by | submitted_at | expires_at 
----+-------------+-----------+-------------+--------------+--------------+------------
(0 rows)

 id | action_type | state | approved_at | apply_expiry_hours | apply_deadline 
----+-------------+-------+-------------+--------------------+----------------
(0 rows)

     state     | n 
---------------+---
 APPLY_EXPIRED | 1
 EXPIRED       | 1
(2 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 6 (db aramo_recovery) exit 0 OK
BEGIN
   state   | n 
-----------+---
 CONFIRMED | 2
(1 row)

 id | change_request_id | step | command_kind | tenant_id | target_ref | state | attempts | last_error_code | next_attempt_at | lease_until | provider_accepted_at | failed_at | updated_at | lease_expired 
----+-------------------+------+--------------+-----------+------------+-------+----------+-----------------+-----------------+-------------+----------------------+-----------+------------+---------------
(0 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 7 (db aramo_recovery) exit 0 OK
BEGIN
  status   | n 
-----------+---
 PROCESSED | 4
(1 row)

 provider_event_id | event_type | product_key | status | attempts | next_attempt_at | lease_until | last_error | received_at | needs_provider_redelivery 
-------------------+------------+-------------+--------+----------+-----------------+-------------+------------+-------------+---------------------------
(0 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 8 (db aramo_recovery) exit 0 OK
BEGIN
   metric_key   |  mode   | reconciliation | mismatch_count | pending_bucket_count |         started_at         |        finished_at         
----------------+---------+----------------+----------------+----------------------+----------------------------+----------------------------
 sign.envelopes | REBUILD | RECONCILED     |              0 |                    0 | 2026-10-25 20:02:14.663+00 | 2026-10-25 20:02:14.796+00
(1 row)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 10 (db aramo_recovery) exit 0 OK
BEGIN
 tenant_id | subscription_ref | intent_id | detected_at | open_rows | intent_status | open_conversions 
-----------+------------------+-----------+-------------+-----------+---------------+------------------
(0 rows)

ROLLBACK

### RUNBOOK-ccp-recovery.md block 11 (db aramo_recovery) exit 0 OK
t                | apply_attempts |         applied_at         
--------------------------------------+---------+--------------------------------------+--------------------------------------+----------------+----------------------------
 01a174a7-3ea0-710d-a06d-f758e8c636b5 | APPLIED | e7fc1357-eb45-4b50-8038-a555d8377268 | 01a174a7-3d88-7098-b88d-e23d97e83094 |              1 | 2026-10-25 20:01:19.263+00
 01a174a8-252b-76b7-97b1-a04df3b5dec2 | APPLIED | e7fc1357-eb45-4b50-8038-a555d8377268 | 019a0000-0000-7000-8000-0000000cc201 |              1 | 2026-10-25 20:01:29.242+00
(2 rows)

ROLLBACK

### RUNBOOK-ccp-dark-state-verification.md block 2 (db aramo) exit 0 OK
                  0
(1 row)

 slug  | source | status |        plan_key        |     period_anchor      | provider_linked | product_key | pinned_version 
-------+--------+--------+------------------------+------------------------+-----------------+-------------+----------------
 astre | MANUAL | ACTIVE | aramo-sign-included-v1 | 2026-10-01 00:00:00+00 | f               | sign        |              1
(1 row)

 open_self_service | open_flags | open_checkout_intents 
-------------------+------------+-----------------------
                 0 |          1 |                     0
(1 row)

ROLLBACK

### RUNBOOK-ccp-platform-owner-bootstrap.md block 1 (db aramo) exit 0 OK
0
(1 row)

 bootstrap_events | bootstrap_attestations 
------------------+------------------------
                1 |                      1
(1 row)

 active_policies 
-----------------
               1
(1 row)

                    tgname                    | tgenabled 
----------------------------------------------+-----------
 ccp_a9_platform_last_owner_membership_delete | A
 ccp_a9_platform_last_owner_membership_update | A
 ccp_a9_platform_last_owner_role_delete       | A
 ccp_a9_platform_last_owner_role_update       | A
 ccp_a9_platform_last_owner_user_update       | A
(5 rows)

ROLLBACK

### RUNBOOK-ccp-break-glass.md block 2 (db aramo) exit 0 OK
     | tgenabled 
--------------------------+----------------------------------------------+-----------
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_delete | A
 UserTenantMembership     | ccp_a9_platform_last_owner_membership_update | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_delete       | A
 UserTenantMembershipRole | ccp_a9_platform_last_owner_role_update       | A
 User                     | ccp_a9_platform_last_owner_user_update       | A
(5 rows)

 effective_platform_owners 
---------------------------
                         0
(1 row)

ROLLBACK


TOTAL 16 / 16
````

## 8. Fidelity: what the dry run did not reproduce

| Production element | Dry run | Effect |
|---|---|---|
| `aramo-prod-postgres` on the box, `sudo` | `ccp-d5-dryrun-pg`, no `sudo` | none on SQL behaviour |
| the production catalog 19 / 194 / 973 | the seed catalog 19 / 190 / 939 (TD-A1-1) | the +6 / +15 / +45 deltas are the same; the absolute numbers differ |
| `deploy/migrate-prod.sh` on the box | the same script with `ARAMO_DIR`, `ARAMO_ENV_FILE` and `ARAMO_MIGRATE_NETWORK` overrides (its documented local-proof mode) | none |
| the fact-check and roll-up CLIs in a `node:22-bookworm` container on the box | the fact-check also ran in that form on the local network (P3c); the other CLIs ran from the host | none observed |
| console / HTTP routes for recovery actions | the services the routes call, in one process | route-level authorization is not re-proven here (it is CCP-D4 and the route specs) |
| Stripe | the repo's `FakeStripe` | no provider behaviour beyond the fake's |
| the dark-state switches in the box containers | stand-in containers | the classification logic is proven; the box values are not (C-28) |
| the bootstrap CLI | its logic through a driver | the CLI path is broken (D5-DEF-3) |

## 9. Defects and observations

| ID | Kind | Finding | Where | Disposition |
|---|---|---|---|---|
| **D5-DEF-1** | production code (deploy script; pre-existing, ATI-SEP-1) | `deploy/migrate-prod.sh` exits 1 after the shared-database gate passes whenever the `.env` has no `INTELLIGENCE_DB_USER=` line: `read_env` (`grep … \| tail \| cut \| sed`) fails under `set -euo pipefail` inside `TI_USER="$(…)"`, before the `${TI_USER:-aramo_intelligence}` default applies. `.env.prod.example:69` ships the line commented out. The shared migrations are applied and recorded; the Talent Intelligence step never runs; the only message is the generic STOP banner. | `deploy/migrate-prod.sh:196` (also `:164`) | **Reported, not fixed.** Runbook pre-check added (`RUNBOOK-ccp-migration-validation.md` §4). |
| **D5-DEF-2** | production code (CCP-B5) | The policy draft editor accepts only `POLICY_EDITABLE_KEYS`, which omits `apply_expiry_hours`: `updateDraft` refuses it `policy_key_not_editable`. Charter Amendment A1 AD-1 requires the deadline to arrive as a v2 "whose content is v1 plus the key", activated through POLICY_ACTIVATE (B5). There is therefore no governed, no-SQL path to author that v2; CCP-A6-R's own tests use a fixture v2 (`CCP-A6-acceptance.md:349`). Bears on TD-ACC-1. | `libs/subscription/src/lib/commercial/commercial-policy-governance.service.ts:47-59`, `:197-199` | **Reported, not fixed.** |
| **D5-DEF-3** | production code (CCP-A9) | `npm run ccp:bootstrap-platform-owner` always refuses `INVALID_ARGUMENT {"unknown_argument":"libs/subscription/scripts/ccp-bootstrap-platform-owner.ts"}`: the script parses `process.argv.slice(2)`, but through `deploy/jiti-tsconfig-runner.mjs` `argv[2]` is the entry path. Fails closed (nothing written). A direct `node --import jiti/register` run cannot load (`Cannot find module '@aramo/common'`). The A11 scripts locate their own entry in `argv` and work. | `libs/subscription/scripts/ccp-bootstrap-platform-owner.ts:31` | **Reported, not fixed.** The bootstrap runbook HALTs on it (§1). |
| D5-OBS-1 | runbook (pre-existing) | `RELEASE-box.md` STEP 2 checks the backup with `tail -1 … # → completion marker present`; with `pg_dump` 17 the last line is `\unrestrict …`, so that check never shows the marker. `grep -c 'PostgreSQL database dump complete'` does. | `doc/runbooks/RELEASE-box.md:144` | The CCP runbook uses `grep -c`. `RELEASE-box.md` is not edited (outside D5). |
| D5-OBS-2 | gap (confirmed) | TD-C1-7: no operator retry for a FAILED command and no audit row for `retryFailed` (0 rows added in the dry run). TD-C1-13: past 10 attempts only a provider redelivery reprocesses an inbox row. TD-D3-9 / TD-C2-11: approval expiry and release expiry are lazy only. | as cited | Documented in `RUNBOOK-ccp-recovery.md` §4–§6, §8 as escalations. |
| D5-OBS-3 | observation | There is no DB guard on a direct `UPDATE` that ends a governed `TenantSubscription`; C-15's prohibition is procedural. The break-glass SQL therefore carries its own refusals (dry run BG-A1…A5). | `subscription."TenantSubscription"` (only the A5 pin trigger) | Recorded for the Lead. |
| D5-OBS-4 | observation | No D3 alert type covers an APPROVED request whose apply deadline has passed (`RUNBOOK-ccp-recovery.md` §4 (b) finds it by query). | `libs/subscription/src/lib/observability/commercial-alert.service.ts` | Recorded. |
| D5-OBS-5 | observation | `origin/main` (`ac24e234`) adds 5 migrations that will interleave with the CCP chain after the sync-forward (`auth-storage/20261025120000_native_device_sessions`; `sign/20261026100000…100300_sign_mobile_*`). | `RUNBOOK-ccp-migration-validation.md` §2 | Each needs its own authority or must already be applied; the P2 pending-set check catches it. |
