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
#
# STRUCTURE (testability): the pure helpers mig_list() and compute_pending() are
# defined at top level and have NO side effects on definition, so a unit test can
# `source` this file and exercise them WITHOUT running any psql/DDL. Everything
# with side effects lives in main(), guarded behind BASH_SOURCE==$0. See
# tools/db-sync-local.test.sh.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Ordered relative migration-dir paths (timestamp dir-name is the sort key).
mig_list() {
  ls -d libs/*/prisma/migrations/*/ 2>/dev/null \
    | awk -F/ '{print $(NF-1)"\t"$0}' | sort | cut -f2
}

# PENDING = on-disk migration dirs NOT recorded in the ledger. This — NOT
# rec-vs-tot — is the real "safe to build/recreate" signal. Orphan ledger rows
# (recorded but no longer on disk — e.g. a retired net-zero migration deleted
# from code) are harmless and must never block a deploy; only an on-disk
# migration missing from the ledger is a genuine unapplied migration.
#
# RACE-FREE by construction: the pending set is the relative complement
# (on-disk MINUS recorded), computed with `comm`, which reads BOTH input streams
# to EOF. The prior implementation probed membership per on-disk item with
# `printf "$recorded" | grep -qxF -- "$d"` under `set -o pipefail`; when grep
# matched it closed the pipe early, printf took SIGPIPE (exit 141), and pipefail
# reported the matched (RECORDED) migration as pending — a scheduling-dependent
# false count in BOTH directions (false "pending" AND, just as dangerous, false
# "0 pending"). `comm` has no early-close, so the count is deterministic.
#
# Args: $1 = newline-separated on-disk dir paths; $2 = newline-separated recorded
# ledger names. Echoes the integer pending count. LC_ALL=C gives a byte-stable
# sort on both sides (comm requires identically-sorted inputs).
compute_pending() {
  local on_disk="${1:-}" recorded="${2:-}" out
  out="$(comm -23 \
    <(printf '%s\n' "$on_disk"  | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u) \
    <(printf '%s\n' "$recorded" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u))"
  if [ -z "$out" ]; then
    printf '0'
    return 0
  fi
  printf '%s\n' "$out" | wc -l | tr -d ' '
}

main() {
  cd "$ROOT"
  local MODE="${1:-apply}"

  # Locate psql (homebrew libpq is keg-only and often off PATH).
  local PSQL_BIN
  PSQL_BIN="$(command -v psql || true)"
  [ -z "$PSQL_BIN" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
  [ -z "$PSQL_BIN" ] && { echo "db:sync:local: psql not found (install libpq / postgresql-client)"; exit 2; }

  local DBURL="${DATABASE_URL:-}"
  [ -z "$DBURL" ] && DBURL="$(grep -E '^DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  [ -z "$DBURL" ] && { echo "db:sync:local: DATABASE_URL not set (env or .env)"; exit 2; }
  local URL
  URL="$(printf '%s' "$DBURL" | sed -E 's/\?.*$//')"

  q() { "$PSQL_BIN" "$URL" -v ON_ERROR_STOP=1 -q -t -A "$@"; }

  # --status is READ-ONLY (R-STATUS-READONLY): report the ledger count with NO DDL. If the
  # ledger table is absent, report 0 — never CREATE it in status mode, so a read-only recon
  # is safe to run against any environment (including production).
  if [ "$MODE" = "--status" ]; then
    local rec recorded_names tot on_disk pending
    if [ "$(q -c "SELECT to_regclass('public._local_migrations') IS NOT NULL;")" = "t" ]; then
      rec="$(q -c "SELECT count(*) FROM public._local_migrations;")"
      recorded_names="$(q -c "SELECT name FROM public._local_migrations;")"
    else
      rec=0
      recorded_names=""
    fi
    on_disk="$(mig_list)"
    tot="$(printf '%s\n' "$on_disk" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
    # Membership is an exact match on the relative dir path (the ledger key), read-only.
    pending="$(compute_pending "$on_disk" "$recorded_names")"
    echo "db:sync:local status — ${rec}/${tot} migrations recorded as applied"
    echo "db:sync:local pending — ${pending} on-disk migration(s) not yet applied"
    exit 0
  fi

  # apply mode — the tracking table, keyed on the relative migration-dir path (unique).
  q -c "CREATE TABLE IF NOT EXISTS public._local_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null

  # T2-P3B pre-GA Selection rebaseline guard: RETIRED (Track-2 Engagement-Residue
  # Forward-Cleanup, R-GUARD-RETIRE). Read-only prod recon 2026-08-18 established prod is
  # Selection-native — the ledger records only init_selection_model, zero superseded
  # engagement-era paths, so the guard was 0-armed and its job is complete. The forward
  # `20260823120000_drop_empty_engagement_schema` migration removes the last residual (the
  # empty engagement schema shell). Removing the guard leaves no obsolete engagement-path
  # reference in the tooling.

  local applied=0 baselined=0 skipped=0 d f name err
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
}

# Run only when executed directly; a `source` (the unit test) reaches the pure
# mig_list()/compute_pending() helpers without running any psql/DDL.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
