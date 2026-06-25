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
#   3. docker build … (api [+ caddy])   # only reached if the gate passed
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
# Provable LOCALLY (against a running prod-style stack) with overrides:
#   ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/migrate-prod.sh
# The gate parse is unit-checked (no docker/DB) by deploy/migrate-prod.test.sh.

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
# from the already-resolved shell variable, so its '$' is NOT re-expanded.
run_runner() {
  docker run --rm \
    --network "$NETWORK" \
    -v "$ARAMO_DIR":/repo -w /repo \
    -e DATABASE_URL="$DBURL" \
    "$MIGRATE_IMAGE" \
    bash tools/db-sync-local.sh ${1:-}
}

# THE GATE. db:sync:local --status prints:
#   'db:sync:local status — N/M migrations recorded as applied'
# Returns 0 iff exactly-one N/M pair is found AND N == M (zero pending).
# Anything else (no fraction, partial apply N<M, garbage/error text) → 1.
gate_passes() {
  local status="$1" frac n m
  frac="$(printf '%s' "$status" | grep -oE '[0-9]+/[0-9]+' | head -n1)" || true
  [ -n "$frac" ] || return 1
  n="${frac%/*}"
  m="${frac#*/}"
  [ "$n" -eq "$m" ] 2>/dev/null
}

# --- main -----------------------------------------------------------------

main() {
  trap on_exit EXIT
  command -v docker >/dev/null 2>&1 || {
    echo "[migrate] FATAL: docker not found on this host." >&2; exit 2; }
  [ -f "$ENV_FILE" ] || {
    echo "[migrate] FATAL: env file not found: $ENV_FILE" >&2; exit 2; }

  DBURL="$(build_dburl)"

  echo "[migrate] network=${NETWORK} repo=${ARAMO_DIR} image=${MIGRATE_IMAGE}"
  echo "[migrate] pre-apply status:"
  run_runner --status

  echo "[migrate] applying pending migrations…"
  run_runner

  # GATE: re-read status; N must equal M or the deploy ABORTS (containers are
  # NOT recreated — exit non-zero stops the deploy sequence at this step).
  local status
  status="$(run_runner --status)"
  echo "[migrate] post-apply status: ${status}"

  if gate_passes "$status"; then
    echo "[migrate] OK — schema in sync (N==M). Safe to build + recreate containers."
  else
    echo "[migrate] FATAL: pending migrations remain after apply (status not N/N)." >&2
    # The on_exit trap prints the "containers NOT recreated" reassurance.
    exit 1
  fi
}

# Allow `source`-ing this file (e.g. from deploy/migrate-prod.test.sh) to reach
# the helper functions WITHOUT executing main / touching docker.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
