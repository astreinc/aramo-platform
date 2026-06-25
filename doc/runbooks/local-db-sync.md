# Runbook — `db:sync:local` (apply migrations to the local dev DB)

**The durable fix for the local-migration-apply gap.** The local dev DB is built
by raw-SQL apply (the integration-spec path) and does **not** carry Prisma's
`_prisma_migrations` tracking, so a newly-authored migration is not picked up by
`prisma migrate` and previously had to be hand-applied. `npm run db:sync:local`
replaces that hand-apply with a repeatable command.

## The rule (do this after any schema change)

When you add a Prisma migration (a new `libs/<lib>/prisma/migrations/<ts>_*/`):

1. Add the migration file to the **integration-spec curated apply-lists** (the
   CI-500 footgun — the per-spec hardcoded lists CI uses). *(unchanged)*
2. Run **`npm run db:sync:local`** — it applies that new migration to your local
   dev DB.

That's the whole loop: *add to the apply-list + `db:sync:local`* fully syncs
local. No more ad-hoc SQL.

## How it works

- The `migration.sql` files are the source of truth (the same files the
  integration specs reference). They are **auto-discovered** across
  `libs/*/prisma/migrations/*/` and applied in **timestamp order**.
- Idempotency is via a tracking table, `public._local_migrations`: an applied
  migration is recorded and **never re-run**. That makes both additive and
  destructive (`DROP`) migrations safe to leave in the set, and makes
  `db:sync:local` safe to run any number of times.
- `DATABASE_URL` is read from the environment or `.env` (the `?schema=` suffix is
  stripped — `psql` rejects it). Requires `psql` on PATH (or homebrew `libpq`).

## Commands

```bash
npm run db:sync:local              # apply any NOT-yet-recorded migrations, in order
npm run db:sync:local -- --status  # show recorded/total
npm run db:sync:local -- --baseline# stamp the current DB state as already-applied (see below)
```

## First-time setup per environment

- **Fresh / empty dev DB:** just run `npm run db:sync:local`. With nothing
  recorded, it applies all migrations in order (every `CREATE` succeeds).
- **An existing, already-working dev DB** (it already has the schema, just no
  tracking — e.g. a DB built before this tool existed): run
  `npm run db:sync:local -- --baseline` **once** to stamp the current 63
  migrations as already-applied, then use plain `db:sync:local` thereafter so it
  applies only genuinely-new migrations. (Baseline assumes the DB is in sync — it
  is, if the app runs against it.)

## Where it fits

Part of the local run story (`tools/local-run-link.sh`):
`nx build` → `tools/local-run-link.sh` (runtime links) → **`db:sync:local`**
(migrations) → `source .env` → `node dist/apps/api/src/main.js`.

## On the box (prod): the same runner, wrapped + gated

The single-box deploy applies these same migrations via
**`deploy/migrate-prod.sh`** (a mandatory deploy step, after `git pull`, before
container recreate). It runs `db:sync:local` inside a `postgres:17` container on
the compose network (the box host has no `psql`) and then GATES on zero-pending —
a failed/partial apply aborts the deploy rather than recreating containers against
a stale schema. See `doc/runbooks/singlebox-ops.md` → "Update / redeploy the
stack". `db:sync:local` itself is unchanged — the box just wraps it.
