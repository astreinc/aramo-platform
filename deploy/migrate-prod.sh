#!/usr/bin/env bash
# Aramo single-box — apply pending DB migrations on deploy, then GATE on
# zero-pending before containers are (re)built/recreated.
#
# THE incident this closes: the box deploy rebuilds + recreates containers but
# never applied pending migrations, so a migration-bearing change (Invite-S2:
# identity.Invitation + invite_status) shipped code that read a column the DB
# did not have → "Internal error" on the Users list until db:sync:local was run
# by hand. This wires that manual recipe into the deploy as a mandatory,
# fail-loud step.
#
# POSITION in the deploy flow (singlebox-ops.md "Update / redeploy the stack"):
#   1. git pull --ff-only           # new code + new migration files
#   2. >>> deploy/migrate-prod.sh <<<   # apply + GATE  (THIS script)
#   3. docker build … (api [+ nginx])   # only reached if the gate passed
#   4. systemctl restart aramo-singlebox.service  (compose up -d --force-recreate)
#   5. health checks
# Runs AFTER pull (so the new migration.sql files are present) and BEFORE
# build/recreate (so containers never start against a schema missing columns).
# If the gate fails the deploy STOPS here — the old containers keep serving the
# old image against the old-but-consistent schema (no broken half-state).
#
# HOW it applies: the idempotent runner tools/db-sync-local.sh needs psql (absent
# on the box host) + the 'postgres' service hostname (only resolves ON the
# compose network) + the repo mounted (to read libs/*/prisma/migrations/). So it
# runs inside a postgres:17 container joined to the compose network. db:sync:local
# records each applied migration in public._local_migrations and NEVER re-runs one
# — safe to run on every deploy (an in-sync DB is a no-op).
#
# DATABASE_URL is constructed from the .env PARTS (POSTGRES_USER/PASSWORD/DB) —
# the box .env carries the parts, not DATABASE_URL (compose builds it for the
# api/auth containers from the same parts). The parts are read WITHOUT shell-
# sourcing the .env, so a '$' in the password survives verbatim (the gotcha that
# bit the manual recipe: a sourced or double-quoted password loses its '$').
#
# Talent Intelligence (ATI-SEP-1 T0, ADR-0036): AFTER the shared-DB gate passes,
# migrate_intelligence() ensures the aramo_intelligence role + database
# (tools/ensure-intelligence-db.sh) and applies + gates libs/intelligence-core
# migrations with tools/db-sync-intelligence.sh (own ledger in the TI database).
# Requires INTELLIGENCE_DB_PASSWORD in the .env (fails closed without it).
#
# Provable LOCALLY (against a running prod-style stack) with overrides:
#   ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/migrate-prod.sh
# The gate parse is unit-checked (no docker/DB) by deploy/migrate-prod.test.sh.
#
# BOUNDED apply — `deploy/migrate-prod.sh --until <migration-dir-name>` (IC-1
# expand-before-restrict, Lead Architect ruling 2026-10-14). Passed through to
# tools/db-sync-local.sh, which resolves the name against the ORDERED manifest
# (exactly one match or it refuses with nothing applied), applies every pending
# migration at-or-before that position, and verifies against the ledger that
# nothing beyond it was applied. The GATE for a bounded run reads the
# `pending-before-stop — K` line (K must be 0); the `deferred — N` migrations
# stay pending on purpose and are the NEXT release's gate. Without --until this
# script's behaviour is unchanged.

set -euo pipefail

# Uniform failure reassurance: on ANY non-zero exit (a mid-apply SQL error that
# set -e propagates, or the gate's explicit abort) tell the operator the deploy
# must stop here and containers were NOT recreated. Suppressed on success.
# Installed inside main() (not at top level) so `source`-ing for tests does not
# inherit the trap.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[migrate] deploy step exited ${rc} — STOP: containers were NOT recreated." >&2
    echo "[migrate] The DB schema is not confirmed in sync with the pulled code." >&2
    echo "[migrate] Fix the migration apply (see output above) before retrying." >&2
  fi
}

# --- config (overridable for local proof / tests) -------------------------
ARAMO_DIR="${ARAMO_DIR:-/opt/aramo}"
ENV_FILE="${ARAMO_ENV_FILE:-${ARAMO_DIR}/.env}"
# The compose project (deploy/systemd/singlebox-compose.sh) is 'aramo-singlebox';
# its default docker network is '<project>_default'. Keep these in lockstep.
COMPOSE_PROJECT="${ARAMO_COMPOSE_PROJECT:-aramo-singlebox}"
NETWORK="${ARAMO_MIGRATE_NETWORK:-${COMPOSE_PROJECT}_default}"
MIGRATE_IMAGE="${ARAMO_MIGRATE_IMAGE:-postgres:17}"
# Stop point of a bounded run (empty = plain run). Set by main() from --until.
UNTIL=""

# --- helpers --------------------------------------------------------------

# Read a single value from the .env file WITHOUT shell-sourcing it, so a '$'
# (or other shell metachar) in the value is taken verbatim — never expanded.
# Strips one layer of surrounding single/double quotes. Last assignment wins.
read_env() {
  local key="$1"
  grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2- \
    | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

# Build DATABASE_URL exactly as docker-compose.prod.yml does for the api/auth
# containers (host pinned to the 'postgres' service name) — same parts, so the
# migration target cannot drift from what the app containers talk to.
build_dburl() {
  local user pass db
  user="$(read_env POSTGRES_USER)"; user="${user:-aramo}"
  pass="$(read_env POSTGRES_PASSWORD)"
  db="$(read_env POSTGRES_DB)"; db="${db:-aramo}"
  printf 'postgresql://%s:%s@postgres:5432/%s?schema=public' "$user" "$pass" "$db"
}

# Run the idempotent runner in a postgres:17 container on the compose network.
# $1 = mode: empty → apply; '--status' → read-only count. DATABASE_URL is passed
# from the already-resolved shell variable, so its '$' is NOT re-expanded. A
# bounded run appends `--until <name>` to BOTH the status reads and the apply, so
# the pre-status, the apply and the gate all see the same stop point.
run_runner() {
  local args=()
  [ -n "${1:-}" ] && args+=("$1")
  [ -n "${UNTIL:-}" ] && args+=(--until "$UNTIL")
  docker run --rm \
    --network "$NETWORK" \
    -v "$ARAMO_DIR":/repo -w /repo \
    -e DATABASE_URL="$DBURL" \
    "$MIGRATE_IMAGE" \
    bash tools/db-sync-local.sh ${args[@]+"${args[@]}"}
}

# THE GATE — PENDING-SET based (orphan-immune). db:sync:local --status prints:
#   'db:sync:local pending — K on-disk migration(s) not yet applied'
# Returns 0 iff K is found AND K == 0 (every on-disk migration is applied).
# It deliberately does NOT compare recorded-vs-on-disk counts: an orphan ledger
# row (a migration deleted from disk but still recorded — e.g. a retired
# net-zero pair) makes recorded > on-disk and would false-FATAL a count gate,
# even though nothing is actually pending. Only a genuinely unapplied on-disk
# migration (K > 0) must block. Missing/garbage 'pending' line → 1 (fail closed).
#
# $2 = 1 for a BOUNDED run: the verdict then comes ONLY from the
#   'db:sync:local pending-before-stop — K on-disk migration(s) not yet applied'
# line (K must be 0); the total 'pending' line is expected to be > 0 (the
# deferred remainder) and is ignored. A bounded run whose status carries no
# pending-before-stop line fails closed. $2 absent/0 = the legacy verdict, which
# reads the total 'pending' line only — a stray before-stop line never changes it.
gate_passes() {
  local status="$1" bounded="${2:-0}" pending before
  if [ "$bounded" = "1" ]; then
    before="$(printf '%s' "$status" | sed -nE 's/^db:sync:local pending-before-stop — ([0-9]+) on-disk.*/\1/p' | head -n1)"
    [ -n "$before" ] || return 1
    [ "$before" -eq 0 ] 2>/dev/null
    return
  fi
  pending="$(printf '%s' "$status" | sed -nE 's/^db:sync:local pending — ([0-9]+) on-disk.*/\1/p' | head -n1)"
  [ -n "$pending" ] || return 1
  [ "$pending" -eq 0 ] 2>/dev/null
}

# --- Talent Intelligence database (ATI-SEP-1 T0, ADR-0036 Decision 2) -------
# TI owns a SEPARATE database (aramo_intelligence, role aramo_intelligence) on the
# same postgres server, with its own migrations (libs/intelligence-core) and its
# own ledger (public._intelligence_migrations IN the TI database). The PROD volume
# is not fresh, so initdb scripts never run: tools/ensure-intelligence-db.sh
# creates/re-asserts the role + database idempotently (superuser URL = DBURL), then
# tools/db-sync-intelligence.sh applies + reports, and the TI gate requires
# pending 0 AND drift 0. Runs AFTER the shared-DB gate passed.
INTELLIGENCE_DB_NAME="aramo_intelligence"

# The TI runner URL — host pinned to the 'postgres' service, NO password in the URL
# (it travels as PGPASSWORD, so no URL-encoding concern). Mirrors the compose URL.
build_intelligence_dburl() {
  local user
  user="$(read_env INTELLIGENCE_DB_USER)"; user="${user:-aramo_intelligence}"
  printf 'postgresql://%s@postgres:5432/%s' "$user" "$INTELLIGENCE_DB_NAME"
}

# TI gate — 0 iff the status carries 'pending — 0' AND 'drift — 0' lines.
# A missing line (connection error, garbage) fails closed.
intelligence_gate_passes() {
  local status="$1" pending drift
  pending="$(printf '%s' "$status" | sed -nE 's/^db:sync:intelligence pending — ([0-9]+) on-disk.*/\1/p' | head -n1)"
  drift="$(printf '%s' "$status" | sed -nE 's/^db:sync:intelligence drift — ([0-9]+) recorded.*/\1/p' | head -n1)"
  [ -n "$pending" ] && [ -n "$drift" ] || return 1
  [ "$pending" -eq 0 ] 2>/dev/null && [ "$drift" -eq 0 ] 2>/dev/null
}

run_ti_container() { # script args...
  # The TI password reaches the container as a bare `-e NAME` passthrough from this
  # process's env — never on the docker argv.
  INTELLIGENCE_DB_PASSWORD="$TI_PASSWORD" PGPASSWORD="$TI_PASSWORD" docker run --rm \
    --network "$NETWORK" \
    -v "$ARAMO_DIR":/repo -w /repo \
    -e INTELLIGENCE_ADMIN_DATABASE_URL="$DBURL" \
    -e INTELLIGENCE_DATABASE_URL="$TI_DBURL" \
    -e INTELLIGENCE_DB_USER="$TI_USER" \
    -e INTELLIGENCE_DB_NAME="$INTELLIGENCE_DB_NAME" \
    -e INTELLIGENCE_DB_PASSWORD \
    -e PGPASSWORD \
    "$MIGRATE_IMAGE" \
    bash "$@"
}

migrate_intelligence() {
  echo "[migrate] ── Talent Intelligence database (${INTELLIGENCE_DB_NAME}) — ATI-SEP-1 / ADR-0036 ──"
  TI_USER="$(read_env INTELLIGENCE_DB_USER)"; TI_USER="${TI_USER:-aramo_intelligence}"
  TI_PASSWORD="$(read_env INTELLIGENCE_DB_PASSWORD)"
  TI_DBURL="$(build_intelligence_dburl)"
  if [ -z "$TI_PASSWORD" ]; then
    echo "[migrate] FATAL: INTELLIGENCE_DB_PASSWORD is not set in ${ENV_FILE} — the talent-intelligence-service" >&2
    echo "[migrate] container cannot start without it (docker-compose.prod.yml guards it). Set a 16+ char" >&2
    echo "[migrate] URL-safe value [A-Za-z0-9._~-] (see .env.prod.example) and re-run." >&2
    exit 2
  fi
  echo "[migrate] TI: ensuring role ${TI_USER} + database ${INTELLIGENCE_DB_NAME} (idempotent; nothing dropped)…"
  run_ti_container tools/ensure-intelligence-db.sh
  echo "[migrate] TI pre-apply status:"
  run_ti_container tools/db-sync-intelligence.sh --status
  echo "[migrate] TI: applying pending migrations…"
  run_ti_container tools/db-sync-intelligence.sh
  local status
  status="$(run_ti_container tools/db-sync-intelligence.sh --status)"
  echo "[migrate] TI post-apply status: ${status}"
  if intelligence_gate_passes "$status"; then
    echo "[migrate] OK — Talent Intelligence database: zero pending, zero drift."
  else
    echo "[migrate] FATAL: Talent Intelligence migrations pending or drifted after apply (see status above)." >&2
    exit 1
  fi
}

# --- main -----------------------------------------------------------------

main() {
  trap on_exit EXIT
  # Arguments: only `--until <migration-dir-name>` is accepted; anything else is
  # refused before docker is touched (fail closed — a typo must not become a
  # plain full apply by accident).
  while [ $# -gt 0 ]; do
    case "$1" in
      --until)
        [ -n "${2:-}" ] || { echo "[migrate] FATAL: --until needs a migration directory name." >&2; exit 2; }
        UNTIL="$2"; shift ;;
      --until=*) UNTIL="${1#--until=}" ;;
      *) echo "[migrate] FATAL: unknown argument '$1' (accepted: --until <migration-dir-name>)." >&2; exit 2 ;;
    esac
    shift
  done
  command -v docker >/dev/null 2>&1 || {
    echo "[migrate] FATAL: docker not found on this host." >&2; exit 2; }
  [ -f "$ENV_FILE" ] || {
    echo "[migrate] FATAL: env file not found: $ENV_FILE" >&2; exit 2; }

  DBURL="$(build_dburl)"

  echo "[migrate] network=${NETWORK} repo=${ARAMO_DIR} image=${MIGRATE_IMAGE}"
  if [ -n "$UNTIL" ]; then
    echo "[migrate] BOUNDED apply — stop point: ${UNTIL}"
    echo "[migrate] Migrations after the stop point are DEFERRED on purpose (expand-before-restrict);"
    echo "[migrate] they remain pending and are the next release's gate."
  fi
  echo "[migrate] pre-apply status:"
  run_runner --status

  echo "[migrate] applying pending migrations…"
  run_runner

  # GATE: re-read status; the deploy ABORTS unless the gate passes (containers
  # are NOT recreated — exit non-zero stops the deploy sequence at this step).
  local status
  status="$(run_runner --status)"
  echo "[migrate] post-apply status: ${status}"

  if [ -n "$UNTIL" ]; then
    if gate_passes "$status" 1; then
      echo "[migrate] OK — zero pending on-disk migrations at-or-before the stop point '${UNTIL}'."
      echo "[migrate] Deferred migrations after the stop point stay pending (see status above)."
      migrate_intelligence
      echo "[migrate] Safe to build + recreate containers."
    else
      echo "[migrate] FATAL: migrations at-or-before the stop point remain unapplied, or the runner reported no stop-point status (see above)." >&2
      exit 1
    fi
    return 0
  fi

  if gate_passes "$status"; then
    echo "[migrate] OK — zero pending on-disk migrations (shared Aramo DB)."
    migrate_intelligence
    echo "[migrate] Safe to build + recreate containers."
  else
    echo "[migrate] FATAL: pending on-disk migrations remain after apply (see status above)." >&2
    # The on_exit trap prints the "containers NOT recreated" reassurance.
    exit 1
  fi
}

# Allow `source`-ing this file (e.g. from deploy/migrate-prod.test.sh) to reach
# the helper functions WITHOUT executing main / touching docker.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
