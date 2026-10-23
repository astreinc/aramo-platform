#!/usr/bin/env bash
# db:sync:intelligence — apply the Talent Intelligence migrations to the TI
# database (ATI-SEP-1 T0, ADR-0036 Decision 2).
#
# TI has its OWN database (aramo_intelligence, role aramo_intelligence) and its
# OWN ledger. This runner applies libs/intelligence-core/prisma/migrations/* in
# timestamp order against INTELLIGENCE_DATABASE_URL and records each one in
# public._intelligence_migrations IN THE TI DATABASE. It never touches the shared
# Aramo DB, and tools/db-sync-local.sh never applies these migrations
# (SEPARATE_DB_MIGRATION_LIBS there).
#
# Semantics (mirrors tools/db-sync-local.sh, plus checksums):
#   - idempotent: a recorded migration is never re-run;
#   - each migration and its ledger row commit in ONE transaction (psql -1), so a
#     failed file leaves neither schema changes nor a ledger row;
#   - checksummed: the ledger stores the sha256 of migration.sql. A recorded
#     migration whose file changed on disk is DRIFT — apply mode refuses to run
#     (exit 3, nothing applied) because applied migrations are immutable;
#   - fail loud: the first failing file aborts the run (exit 1).
#
# Usage:
#   tools/db-sync-intelligence.sh            # apply pending migrations
#   tools/db-sync-intelligence.sh --status   # READ-ONLY: counts, pending, drift (no DDL)
#
# Status lines (the deploy gate in deploy/migrate-prod.sh parses these):
#   db:sync:intelligence status — R/T migrations recorded as applied
#   db:sync:intelligence pending — K on-disk migration(s) not yet applied
#   db:sync:intelligence drift — D recorded migration(s) whose checksum changed
#
# INTELLIGENCE_DATABASE_URL is read from the environment or .env (any ?query
# suffix is stripped — psql rejects ?schema=). A URL without a password uses
# PGPASSWORD, which keeps special characters out of the URL.
#
# STRUCTURE (testability): the pure helpers below have no side effects on
# definition; main() runs only when executed directly (BASH_SOURCE==$0). See
# tools/db-sync-intelligence.test.sh (pure) and
# tools/db-sync-intelligence.pg-integration.sh (real PostgreSQL).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TI_MIGRATIONS_DIR="libs/intelligence-core/prisma/migrations"
TI_LEDGER="public._intelligence_migrations"

# Ordered migration directory NAMES (the ledger key), from the cwd.
ti_mig_list() {
  local d
  for d in "$TI_MIGRATIONS_DIR"/*/; do
    [ -d "$d" ] || continue
    [ -f "${d}migration.sql" ] || continue
    basename "$d"
  done | LC_ALL=C sort
}

# sha256 (hex) of a file — sha256sum (Linux / the postgres image) or shasum (macOS).
ti_checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# "name<TAB>checksum" lines for every on-disk migration, in order.
ti_disk_manifest() {
  local n
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    printf '%s\t%s\n' "$n" "$(ti_checksum "$TI_MIGRATIONS_DIR/$n/migration.sql")"
  done < <(ti_mig_list)
}

# Pending = on-disk names NOT in the ledger (relative complement via comm, which
# reads both streams to EOF — the race-free form tools/db-sync-local.sh uses).
# $1 = newline-separated on-disk names; $2 = newline-separated recorded names.
ti_compute_pending() {
  local out
  out="$(LC_ALL=C comm -23 \
    <(printf '%s\n' "${1:-}" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u) \
    <(printf '%s\n' "${2:-}" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u))"
  if [ -z "$out" ]; then printf '0'; return 0; fi
  printf '%s\n' "$out" | wc -l | tr -d ' '
}

# Drift = names recorded with a checksum different from the on-disk file.
# $1 = on-disk "name<TAB>sum" lines; $2 = recorded "name<TAB>sum" lines.
# Echoes the drifting names, one per line (empty when none).
ti_compute_drift() {
  awk -F'\t' 'NR == FNR { if ($1 != "") disk[$1] = $2; next }
              ($1 in disk) && disk[$1] != $2 { print $1 }' \
    <(printf '%s\n' "${1:-}") <(printf '%s\n' "${2:-}")
}

# parse_args → TI_MODE (apply | --status). Returns 2 on anything else.
ti_parse_args() {
  TI_MODE="apply"
  while [ $# -gt 0 ]; do
    case "$1" in
      --status) TI_MODE="--status" ;;
      *) echo "db:sync:intelligence: unknown argument '$1' (accepted: --status)" >&2; return 2 ;;
    esac
    shift
  done
  return 0
}

main() {
  cd "$ROOT"
  ti_parse_args "$@" || exit 2

  local PSQL_BIN
  PSQL_BIN="$(command -v psql || true)"
  [ -z "$PSQL_BIN" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL_BIN=/opt/homebrew/opt/libpq/bin/psql
  [ -z "$PSQL_BIN" ] && { echo "db:sync:intelligence: psql not found (install libpq / postgresql-client)"; exit 2; }

  local DBURL="${INTELLIGENCE_DATABASE_URL:-}"
  [ -z "$DBURL" ] && DBURL="$(grep -E '^INTELLIGENCE_DATABASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  [ -z "$DBURL" ] && { echo "db:sync:intelligence: INTELLIGENCE_DATABASE_URL not set (env or .env)"; exit 2; }
  local URL
  URL="$(printf '%s' "$DBURL" | sed -E 's/\?.*$//')"

  q() { "$PSQL_BIN" "$URL" -X -v ON_ERROR_STOP=1 -q -t -A "$@"; }

  local disk names tot
  disk="$(ti_disk_manifest)"
  names="$(printf '%s\n' "$disk" | cut -f1 | sed '/^[[:space:]]*$/d')"
  tot="$(printf '%s\n' "$names" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"

  local db
  db="$(q -c "SELECT current_database();")" || { echo "db:sync:intelligence: cannot connect to the TI database"; exit 2; }

  local has_ledger recorded="" rec=0
  has_ledger="$(q -c "SELECT to_regclass('${TI_LEDGER}') IS NOT NULL;")"
  if [ "$has_ledger" = "t" ]; then
    recorded="$(q -F $'\t' -c "SELECT name, checksum FROM ${TI_LEDGER} ORDER BY name;")"
    rec="$(printf '%s\n' "$recorded" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  fi
  local recorded_names drift drift_n pending
  recorded_names="$(printf '%s\n' "$recorded" | cut -f1)"
  drift="$(ti_compute_drift "$disk" "$recorded")"
  drift_n="$(printf '%s\n' "$drift" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  pending="$(ti_compute_pending "$names" "$recorded_names")"

  # --status is READ-ONLY: never creates the ledger, never runs DDL.
  if [ "$TI_MODE" = "--status" ]; then
    echo "db:sync:intelligence database — ${db}"
    echo "db:sync:intelligence status — ${rec}/${tot} migrations recorded as applied"
    echo "db:sync:intelligence pending — ${pending} on-disk migration(s) not yet applied"
    echo "db:sync:intelligence drift — ${drift_n} recorded migration(s) whose checksum changed"
    [ "$drift_n" != "0" ] && printf '%s\n' "$drift" | sed '/^[[:space:]]*$/d; s/^/    drift  /'
    exit 0
  fi

  if [ "$drift_n" != "0" ]; then
    echo "db:sync:intelligence: FATAL — ${drift_n} applied migration(s) changed on disk (migrations are immutable):" >&2
    printf '%s\n' "$drift" | sed '/^[[:space:]]*$/d; s/^/    /' >&2
    echo "db:sync:intelligence: aborted — nothing applied" >&2
    exit 3
  fi

  q -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS ${TI_LEDGER} (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());" >/dev/null || exit 1

  local applied=0 skipped=0 name sum f err
  while IFS=$'\t' read -r name sum; do
    [ -n "$name" ] || continue
    # Here-string, not a pipe: no SIGPIPE/pipefail false negative (db-sync-local.sh #831).
    if grep -qxF -- "$name" <<<"$recorded_names"; then
      skipped=$((skipped + 1))
      continue
    fi
    f="$TI_MIGRATIONS_DIR/$name/migration.sql"
    # ONE transaction: the migration file + its ledger row (a duplicate concurrent
    # apply fails on the ledger primary key and rolls its DDL back).
    if err="$("$PSQL_BIN" "$URL" -X -v ON_ERROR_STOP=1 -q -1 -f "$f" \
        -c "INSERT INTO ${TI_LEDGER}(name, checksum) VALUES ('${name}', '${sum}');" 2>&1)"; then
      echo "  applied  ${name}"
      applied=$((applied + 1))
    else
      echo "  FAILED   ${name}"
      printf '%s\n' "$err" | sed 's/^/    /'
      echo "db:sync:intelligence: aborted on ${name} (nothing further applied)"
      exit 1
    fi
  done < <(printf '%s\n' "$disk")

  echo "db:sync:intelligence — ${applied} applied, ${skipped} already present (database ${db})"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
