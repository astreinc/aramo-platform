# Runbook — Core-Talent migration-ledger reconciliation (one-time, next deploy)

**Status:** REQUIRED once, coordinated with the FIRST prod deploy that ships the
`chore/retire-core-talent-tombstone` change (the `libs/talent` package + its two
migrations were deleted). After it runs once, this runbook is spent.

## Why

`deploy/migrate-prod.sh` (via `tools/db-sync-local.sh`) discovers migrations by
scanning `libs/*/prisma/migrations/*/`, applies each, and records the applied
relative dir-path in `public._local_migrations`. On deploy it **GATES**: the
build/recreate step only proceeds when `recorded-count == discovered-count`.

Prod (`dbce8742`) already applied and recorded the two now-deleted migrations:

- `libs/talent/prisma/migrations/20260516085014_init_talent_model/`
- `libs/talent/prisma/migrations/20260704160000_drop_core_talent/`

Both are **net-zero** (they created the `talent` schema, then dropped it +
`DROP SCHEMA "talent"`), so the prod database is already clean — **no schema
DROP/ALTER or data remediation is required.** But once the repo no longer ships
those two dirs, the scan discovers two fewer migrations than are recorded, so
`recorded (N) > discovered (N-2)` → the gate fails → **the next deploy aborts**
unless the two orphan ledger rows are removed first.

Per PO/Architect ruling: do **not** change the migrate gate to tolerate orphan
rows, and do **not** retain a migration-only `libs/talent` tombstone. Reconcile
the ledger instead. Target end-state: `recorded == discovered`.

## Step — run ONCE, immediately before the migrate step of the next deploy

On the box, against the prod database (same `DATABASE_URL` the deploy uses):

```sql
DELETE FROM public._local_migrations
 WHERE path LIKE '%libs/talent/prisma/migrations%';
-- expect: DELETE 2
```

Then continue the normal deploy flow (`singlebox-ops.md` → "Update / redeploy the
stack"): `git pull --ff-only` → `deploy/migrate-prod.sh` → build/recreate. The
migrate gate now sees `recorded == discovered` and passes.

## Verify

- `SELECT count(*) FROM public._local_migrations WHERE path LIKE '%libs/talent%';`
  → `0`.
- `deploy/migrate-prod.sh` status line shows `rec == tot` and exits 0 (gate pass).
- Sanity (already-true; the schema was dropped long ago):
  `SELECT to_regnamespace('talent');` → `NULL` (no `talent` schema).

## Notes

- Fresh environments need no action — they never create the `talent` schema, and
  the scan simply omits the deleted dirs (`recorded == discovered` from zero).
- This is a ledger-bookkeeping reconciliation only; it touches no application
  table and no talent data.
