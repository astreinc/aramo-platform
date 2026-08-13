#!/usr/bin/env bash
# db:sync:local — replay every Prisma migration against the LOCAL dev DB so a
# schema change is fully synced with NO ad-hoc SQL. THE durable fix for the
# local-migration-apply gap: the local dev DB is built by raw-SQL apply (the
# integration-spec path) without Prisma's _prisma_migrations tracking, so a new
# migration would otherwise need hand-applied SQL.
#
# The migration.sql files ARE the source of truth (the same files the
# integration specs' curated apply-lists reference). They are auto-discovered
# across libs/*/prisma/migrations and applied in TIMESTAMP order. Idempotent
# via a tracking table (public._local_migrations): an applied migration is
# recorded and NEVER re-run, so additive AND destructive (DROP) migrations are
# both safe to keep in the set.
#
# Workflows:
#   Fresh / empty dev DB:        tools/db-sync-local.sh             # applies all, in order
#   Existing already-synced DB:  tools/db-sync-local.sh --baseline  # stamp current state ONCE
#                                tools/db-sync-local.sh             # then applies only NEW migrations
#   Status:                      tools/db-sync-local.sh --status
#
# DATABASE_URL is read from the environment or .env (the ?schema= suffix is
# stripped — psql rejects it).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="${1:-apply}"

# Locate psql (homebrew libpq is keg-only and often off PATH).
PSQL_BIN="$(command -v psql || true)"
[ -z "$PSQL_BIN" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
[ -z "$PSQL_BIN" ] && { echo "db:sync:local: psql not found (install libpq / postgresql-client)"; exit 2; }

DBURL="${DATABASE_URL:-}"
[ -z "$DBURL" ] && DBURL="$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
[ -z "$DBURL" ] && { echo "db:sync:local: DATABASE_URL not set (env or .env)"; exit 2; }
URL="$(printf '%s' "$DBURL" | sed -E 's/\?.*$//')"

q() { "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 -q -t -A "$@"; }

# Ordered relative migration-dir paths (timestamp dir-name is the sort key).
mig_list() {
  ls -d libs/*/prisma/migrations/*/ 2>/dev/null \
    | awk -F/ '{print $(NF-1)"\t"$0}' | sort | cut -f2
}

# The tracking table — keyed on the relative migration-dir path (unique).
q -c "CREATE TABLE IF NOT EXISTS public._local_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null

if [ "$MODE" = "--status" ]; then
  rec="$(q -c "SELECT count(*) FROM public._local_migrations;")"
  tot="$(mig_list | wc -l | tr -d ' ')"
  echo "db:sync:local status — ${rec}/${tot} migrations recorded as applied"
  exit 0
fi

# ── T2-P3B pre-GA Selection migration rebaseline guard (fail-closed) ─────────
# The Selection workflow migration chain was rebaselined pre-GA: the six
# engagement-first migrations were replaced by a single Selection-native
# init_selection_model. If a target ledger still records the superseded
# engagement-era Selection migration paths, applying the rebaselined chain
# would create a divergent SECOND schema (uncontrolled DDL). Detect that state
# and FAIL CLOSED — a governed pre-GA ledger reconciliation is required first.
# READ-ONLY: this guard never mutates the ledger and never repairs the schema.
if [ -d "libs/selection/prisma/migrations/20260525120000_init_selection_model" ]; then
  # The three engagement-NAMED Selection migration paths are unambiguous
  # markers of the superseded engagement-era ledger (production recorded all of
  # them). Any one present alongside the Selection-native baseline = rebaseline
  # divergence. (Kept engagement-named only, so this guard carries no Tier-2
  # vocabulary; the full superseded set is documented in the reconciliation runbook.)
  stale="$(q -c "SELECT count(*) FROM public._local_migrations WHERE name IN (
    'libs/selection/prisma/migrations/20260525120000_init_engagement_model/',
    'libs/selection/prisma/migrations/20260525150000_add_engagement_event_log/',
    'libs/selection/prisma/migrations/20260813120000_t2p2_relocate_engagement_to_selection/'
  );")"
  if [ -n "$stale" ] && [ "$stale" != "0" ]; then
    echo "db:sync:local: HALT — pre-GA Selection migration rebaseline detected." >&2
    echo "  The target ledger (public._local_migrations) records ${stale} superseded" >&2
    echo "  engagement-era Selection migration path(s), but this repository ships the" >&2
    echo "  Selection-native baseline (20260525120000_init_selection_model)." >&2
    echo "  Applying now would create a divergent second schema. A governed pre-GA" >&2
    echo "  ledger reconciliation is REQUIRED before this environment can migrate" >&2
    echo "  (see doc/runbooks/t2p3b-selection-rebaseline-prod-reconciliation.md)." >&2
    echo "  This tool will NOT auto-repair production." >&2
    exit 3
  fi
fi

applied=0; baselined=0; skipped=0
while IFS= read -r d; do
  [ -n "$d" ] || continue
  f="${d}migration.sql"
  [ -f "$f" ] || continue
  name="$(basename "$d")"

  if [ "$(q -c "SELECT 1 FROM public._local_migrations WHERE name='${d}';")" = "1" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  if [ "$MODE" = "--baseline" ]; then
    q -c "INSERT INTO public._local_migrations(name) VALUES ('${d}') ON CONFLICT DO NOTHING;" >/dev/null
    baselined=$((baselined + 1))
    continue
  fi

  # Apply in a single transaction; FAIL LOUD on any error (tracking — not
  # error-swallowing — provides idempotency, so an error here is a real bug).
  if err="$("$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 --single-transaction -q -f "$f" 2>&1)"; then
    q -c "INSERT INTO public._local_migrations(name) VALUES ('${d}') ON CONFLICT DO NOTHING;" >/dev/null
    echo "  applied  ${name}"
    applied=$((applied + 1))
  else
    echo "  FAILED   ${name}"
    printf '%s\n' "$err" | sed 's/^/    /'
    echo "db:sync:local: aborted on ${name} (nothing further applied)"
    exit 1
  fi
done < <(mig_list)

if [ "$MODE" = "--baseline" ]; then
  echo "db:sync:local --baseline — stamped ${baselined} migrations as already-applied (${skipped} already recorded)"
else
  echo "db:sync:local — ${applied} applied, ${skipped} already present"
fi
