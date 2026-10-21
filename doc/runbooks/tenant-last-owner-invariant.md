# Runbook — Tenant last-owner invariant (ROLES-1 PR-1)

**Status:** operator procedure. **Owner:** platform on-call.
**Governing text:** `Aramo-ROLES-1-Organization-and-Product-Role-Model-Implementation-Directive-v1_0-LOCKED` §4 (safeguards 2 and S-1), under `Aramo-ADR-0035-Organization-and-Product-Role-Model-v1_0-LOCKED`.
**Migration:** `libs/identity/prisma/migrations/20261021120000_roles1_last_owner_invariant/migration.sql`.

## What it enforces

A tenant whose `identity."Tenant".status` is `ACTIVE` or `PROVISIONED` must keep **at least one
active `tenant_owner`**. An active owner is a `UserTenantMembershipRole` row for the role whose
key is `tenant_owner`, on an **active** `UserTenantMembership` of that tenant, held by an
**active** `User`.

The database refuses any write that would remove the last active owner. The check runs only
when the write removes an owner who counted, so a tenant that already has no owner (for example
the platform sentinel tenant `01900000-0000-7000-8000-000000000100`) is not blocked by unrelated
writes.

| Table | Trigger (AFTER ROW, `ENABLE ALWAYS`) | Fires on |
|---|---|---|
| `identity."UserTenantMembershipRole"` | `roles1_last_owner_role_delete` | DELETE |
| `identity."UserTenantMembershipRole"` | `roles1_last_owner_role_update` | UPDATE of `role_id` / `membership_id` |
| `identity."UserTenantMembership"` | `roles1_last_owner_membership_delete` | DELETE |
| `identity."UserTenantMembership"` | `roles1_last_owner_membership_update` | `is_active` true→false, or a `tenant_id` / `user_id` re-point |
| `identity."User"` | `roles1_last_owner_user_update` | `is_active` true→false (every tenant where the user is an owner) |

Every check takes `pg_advisory_xact_lock(hashtext('identity:owner:' || tenant_id))` and counts
owners **after** the lock, locking the counted rows `FOR SHARE`. Two concurrent removals therefore
serialize: the second one waits, recounts, and is refused. Under `REPEATABLE READ` or
`SERIALIZABLE`, it may fail with a serialization error instead. In both cases the
transaction rolls back.

**Refusal:** SQLSTATE `23000` (`integrity_constraint_violation`) with the message
`tenant_last_owner: tenant <id> must keep at least one active tenant_owner`. The identity
repository maps it to HTTP **409 `TENANT_LAST_OWNER`** (`details.reason = last_owner`). The
whole transaction is rolled back, so the write has no effect.

**There is no bypass (safeguard S-1).** The trigger functions read no GUC and no session
setting, and have no skip flag. The triggers are `ENABLE ALWAYS`, so they still fire when
`session_replication_role = replica` is set. Production runs the application as a Postgres
superuser, so any session-level switch would be available to ordinary application sessions.
That is why none exists.

### Legitimate ways to remove the last owner
1. **Grant another owner first,** then remove the original. This is the normal hand-over.
2. **Move the tenant out of `ACTIVE`/`PROVISIONED` first.** Use the governed lifecycle transition
   to `SUSPENDED` or `CLOSED`. Tenants in those states are not checked.

Use the break-glass below only when neither of these is possible.

## Capture (before changing anything)

```bash
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA' <<'SQL'
SELECT c.relname, tg.tgname, tg.tgenabled FROM pg_trigger tg
  JOIN pg_class c ON c.oid = tg.tgrelid
 WHERE tg.tgname LIKE 'roles1_last_owner_%' AND NOT tg.tgisinternal ORDER BY 2;
SQL
```

`A` means enabled ALWAYS, the armed state. Expect **5** rows, all `A`. Also record the tenant
ID, the owner memberships, and the exact operation that is being refused.

## Break-glass: disable the guard (superuser only, PO-authorized)

Use this only with explicit PO authorization, for a specific recorded operation. While the guard
is disabled, nothing stops a tenant from losing its last owner, so keep the window as short as
possible and run only the authorized operation inside it.

```bash
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
ALTER TABLE "identity"."UserTenantMembershipRole" DISABLE TRIGGER "roles1_last_owner_role_delete";
ALTER TABLE "identity"."UserTenantMembershipRole" DISABLE TRIGGER "roles1_last_owner_role_update";
ALTER TABLE "identity"."UserTenantMembership" DISABLE TRIGGER "roles1_last_owner_membership_delete";
ALTER TABLE "identity"."UserTenantMembership" DISABLE TRIGGER "roles1_last_owner_membership_update";
ALTER TABLE "identity"."User" DISABLE TRIGGER "roles1_last_owner_user_update";
SQL
```

Verify that the capture query reports all 5 as `D` (disabled). Then perform the authorized operation.

> ⚠ An image rollback does **not** remove these triggers. They live in the database, as with
> the S2 guards in `talent-rtbf-erasure.md`.

## Re-enable (immediately after the operation)

Re-apply the migration. It is idempotent (`CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`
+ `CREATE TRIGGER`, then `ENABLE ALWAYS`), so it restores the functions and all five triggers in
the armed state:

```bash
cd /opt/aramo
sudo docker exec -i aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction -q' \
  < libs/identity/prisma/migrations/20261021120000_roles1_last_owner_invariant/migration.sql
```

Do **not** re-arm with a plain `ALTER TABLE … ENABLE TRIGGER`. That restores the default
(origin-only) mode, which `session_replication_role = replica` silences. If you re-arm by hand,
use `ENABLE ALWAYS TRIGGER` for each of the five triggers.

Verify that the capture query reports **5** rows, all `A`.

## Audit note

Every break-glass use must be recorded in the release/incident evidence folder
(`OneDrive/Aramo/documents/…`). Record:
- the PO authorization (who, when, and for which operation);
- the capture output before and after;
- the exact SQL run while the guard was disabled, the tenant IDs it touched, and the resulting
  owner count per affected tenant;
- the disable and re-enable timestamps.

Production is attributed through CloudTrail and box access (see the key-custody
evidence). The database itself writes no audit row for `ALTER TABLE … DISABLE TRIGGER`.
