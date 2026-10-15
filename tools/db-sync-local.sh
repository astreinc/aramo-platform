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
#   Bounded apply (stop point):  tools/db-sync-local.sh --until <migration-dir-name>
#                                tools/db-sync-local.sh --status --until <migration-dir-name>
#
# --until <migration-dir-name> (IC-1 expand-before-restrict, Lead Architect ruling
# 2026-10-14): a BOUNDED apply that stops AFTER the named migration. The stop point
# is resolved against the ORDERED manifest (mig_list), not a bare directory-exists
# check: exactly one on-disk migration whose directory name equals the argument, at
# a known manifest position; the apply loop walks the manifest in order and stops
# after that position. Nothing before the stop point can be skipped; nothing after
# it is applied, and the run VERIFIES that against the ledger before exiting 0. A
# later run WITHOUT --until applies the deferred remainder — that remainder IS the
# next release's zero-pending gate. --until never changes what a plain run does.
#
# DATABASE_URL is read from the environment or .env (the ?schema= suffix is
# stripped — psql rejects it).
#
# STRUCTURE (testability): the pure helpers mig_list(), compute_pending(),
# parse_args(), until_resolve() and compute_pending_split() are defined at top
# level and have NO side effects on definition, so a unit test can `source` this
# file and exercise them WITHOUT running any psql/DDL. Everything with side effects
# lives in main(), guarded behind BASH_SOURCE==$0. See tools/db-sync-local.test.sh
# (pure) and tools/db-sync-local.pg-integration.sh (real PostgreSQL).
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

# parse_args "$@" → sets PARSED_MODE (apply | --status | --baseline) and
# PARSED_UNTIL (migration dir name, or empty). Returns 2 (message on stderr) on an
# unknown argument, a missing --until value, or --baseline combined with --until:
# stamping a PREFIX of the manifest as applied is a different operation and is
# deliberately not offered (it would hide unapplied migrations from the gate).
# Pure: no side effects beyond the two PARSED_* variables.
parse_args() {
  PARSED_MODE="apply"
  PARSED_UNTIL=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --status|--baseline) PARSED_MODE="$1" ;;
      --until)
        if [ -z "${2:-}" ]; then
          echo "db:sync:local: --until needs a migration directory name (nothing applied)" >&2
          return 2
        fi
        PARSED_UNTIL="$2"
        shift ;;
      --until=*) PARSED_UNTIL="${1#--until=}" ;;
      *)
        echo "db:sync:local: unknown argument '$1' (nothing applied)" >&2
        return 2 ;;
    esac
    shift
  done
  if [ "$PARSED_MODE" = "--baseline" ] && [ -n "$PARSED_UNTIL" ]; then
    echo "db:sync:local: --until cannot be combined with --baseline (refused; nothing stamped)" >&2
    return 2
  fi
  return 0
}

# until_resolve <ordered-on-disk-list> <name> → prints "<position>\t<dir>" for the
# UNIQUE migration whose directory name equals <name> EXACTLY; position is the
# 1-based index in the ordered manifest. A prefix, a substring or a path never
# matches. Returns 2 (message on stderr) when 0 or more than 1 entries match, so a
# typo can never widen the run and a duplicated name across libs is refused.
until_resolve() {
  local on_disk="${1:-}" name="${2:-}" hits n
  if [ -z "$name" ]; then
    echo "db:sync:local: --until requires a migration directory name" >&2
    return 2
  fi
  hits="$(printf '%s\n' "$on_disk" | sed '/^[[:space:]]*$/d' \
    | awk -F/ -v want="$name" '{ if ($(NF-1) == want) print NR "\t" $0 }')"
  n="$(printf '%s' "$hits" | grep -c . || true)"
  case "$n" in
    1) printf '%s\n' "$hits"; return 0 ;;
    0) echo "db:sync:local: --until '${name}' matches NO on-disk migration (exact directory name required; nothing applied)" >&2
       return 2 ;;
    *) echo "db:sync:local: --until '${name}' is AMBIGUOUS (${n} on-disk migrations carry that name; nothing applied)" >&2
       return 2 ;;
  esac
}

# compute_pending_split <ordered-on-disk-list> <recorded> <stop-position> → echoes
# "<pending at-or-before stop> <pending after stop>". The split is by MANIFEST
# POSITION (the order the apply loop walks), so "before" is exactly what a bounded
# run may apply and "after" is exactly what it must leave alone.
compute_pending_split() {
  local on_disk="${1:-}" recorded="${2:-}" stop="${3:-0}" clean before after
  clean="$(printf '%s\n' "$on_disk" | sed '/^[[:space:]]*$/d')"
  before="$(printf '%s\n' "$clean" | awk -v s="$stop" 'NR<=s')"
  after="$(printf '%s\n' "$clean" | awk -v s="$stop" 'NR>s')"
  printf '%s %s' "$(compute_pending "$before" "$recorded")" "$(compute_pending "$after" "$recorded")"
}

main() {
  cd "$ROOT"
  parse_args "$@" || exit 2
  local MODE="$PARSED_MODE" UNTIL="$PARSED_UNTIL"

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

  # The ordered manifest, read ONCE: the stop point is resolved against it BEFORE
  # any DB access, so a bad --until fails with nothing touched (exit 2).
  local on_disk_all tot STOP_POS=0 STOP_DIR="" resolved
  on_disk_all="$(mig_list)"
  tot="$(printf '%s\n' "$on_disk_all" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')"
  if [ -n "$UNTIL" ]; then
    resolved="$(until_resolve "$on_disk_all" "$UNTIL")" || exit 2
    STOP_POS="$(printf '%s' "$resolved" | cut -f1)"
    STOP_DIR="$(printf '%s' "$resolved" | cut -f2)"
  fi

  # --status is READ-ONLY (R-STATUS-READONLY): report the ledger count with NO DDL. If the
  # ledger table is absent, report 0 — never CREATE it in status mode, so a read-only recon
  # is safe to run against any environment (including production).
  if [ "$MODE" = "--status" ]; then
    local rec recorded_names pending split
    if [ "$(q -c "SELECT to_regclass('public._local_migrations') IS NOT NULL;")" = "t" ]; then
      rec="$(q -c "SELECT count(*) FROM public._local_migrations;")"
      recorded_names="$(q -c "SELECT name FROM public._local_migrations;")"
    else
      rec=0
      recorded_names=""
    fi
    # Membership is an exact match on the relative dir path (the ledger key), read-only.
    pending="$(compute_pending "$on_disk_all" "$recorded_names")"
    echo "db:sync:local status — ${rec}/${tot} migrations recorded as applied"
    echo "db:sync:local pending — ${pending} on-disk migration(s) not yet applied"
    if [ -n "$UNTIL" ]; then
      split="$(compute_pending_split "$on_disk_all" "$recorded_names" "$STOP_POS")"
      echo "db:sync:local stop — ${UNTIL} at manifest position ${STOP_POS}/${tot}"
      echo "db:sync:local pending-before-stop — ${split%% *} on-disk migration(s) not yet applied"
      echo "db:sync:local deferred — ${split##* } on-disk migration(s) after the stop point (not applied by a bounded run)"
    fi
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

  # Ledger snapshot BEFORE the walk: the bounded run's post-verification compares
  # against it to prove nothing beyond the stop point was recorded by this run.
  local recorded_before=""
  [ -n "$UNTIL" ] && recorded_before="$(q -c "SELECT name FROM public._local_migrations;")"

  local applied=0 baselined=0 skipped=0 pos=0 d f name err
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    pos=$((pos + 1))
    # The bounded walk ends AFTER the stop position; positions are manifest
    # positions (every entry counts, migration.sql present or not), the same
    # numbering until_resolve reported.
    if [ "$STOP_POS" -gt 0 ] && [ "$pos" -gt "$STOP_POS" ]; then
      break
    fi
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
  done < <(printf '%s\n' "$on_disk_all")

  if [ "$MODE" = "--baseline" ]; then
    echo "db:sync:local --baseline — stamped ${baselined} migrations as already-applied (${skipped} already recorded)"
    exit 0
  fi

  if [ -z "$UNTIL" ]; then
    echo "db:sync:local — ${applied} applied, ${skipped} already present"
    exit 0
  fi

  # Bounded run: VERIFY against the ledger before claiming success.
  #   (1) every manifest entry at-or-before the stop point is now recorded;
  #   (2) NO entry after the stop point was recorded by THIS run (newly recorded
  #       set ∩ after-stop set must be empty). Either failing is exit 1 — the
  #       deploy gate must never read a bounded run as "safe" on a false premise.
  local recorded_after split before after after_list newly newly_after
  recorded_after="$(q -c "SELECT name FROM public._local_migrations;")"
  split="$(compute_pending_split "$on_disk_all" "$recorded_after" "$STOP_POS")"
  before="${split%% *}"
  after="${split##* }"
  after_list="$(printf '%s\n' "$on_disk_all" | sed '/^[[:space:]]*$/d' | awk -v s="$STOP_POS" 'NR>s')"
  newly="$(comm -13 \
    <(printf '%s\n' "$recorded_before" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u) \
    <(printf '%s\n' "$recorded_after"  | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u))"
  newly_after="$(comm -12 \
    <(printf '%s\n' "$after_list" | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u) \
    <(printf '%s\n' "$newly"      | sed '/^[[:space:]]*$/d' | LC_ALL=C sort -u))"
  if [ -n "$newly_after" ]; then
    echo "db:sync:local: FATAL — bounded run recorded migration(s) BEYOND the stop point:" >&2
    printf '%s\n' "$newly_after" | sed 's/^/    /' >&2
    exit 1
  fi
  if [ "$before" != "0" ]; then
    echo "db:sync:local: FATAL — ${before} migration(s) at-or-before the stop point remain unapplied" >&2
    exit 1
  fi
  echo "db:sync:local — ${applied} applied, ${skipped} already present"
  echo "db:sync:local stop — ${UNTIL} at manifest position ${STOP_POS}/${tot}"
  echo "db:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied"
  echo "db:sync:local deferred — ${after} on-disk migration(s) after the stop point (not applied by a bounded run)"
  echo "db:sync:local verified — no migration beyond the stop point was applied by this run"
}

# Run only when executed directly; a `source` (the unit test) reaches the pure
# helpers without running any psql/DDL.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
