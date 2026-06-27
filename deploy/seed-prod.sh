#!/usr/bin/env bash
# Aramo single-box — on deploy, REGENERATE the host-side Prisma client and run
# the Astre seed, then GATE on a known seeded row before the deploy proceeds.
#
# THE two gaps this closes (proven during the Domain-Enforcement P1 deploy):
#   (1) STALE CLIENT — when a migration adds a column, the repo's committed
#       Prisma client is still the pre-column build, so host-side tools (the
#       seed) fail "Unknown argument <field>" until a manual `prisma generate`.
#       The api/auth IMAGES regenerate on build (apps/api/Dockerfile), so the
#       running app is fine — this fixes only the HOST-SIDE repo client.
#   (2) HAND-TYPED SEED — the seed only ran via a hand-typed
#       `docker run --network … -v … node …` because the box host has no
#       node-DB-reachability (the 'postgres' service hostname resolves only on
#       the compose network). This wires that recipe into the deploy.
#
# SIBLING to deploy/migrate-prod.sh — it reuses that script's scaffolding
# verbatim (read_env / build_dburl / on_exit trap / overridable config /
# numeric gate / source-guard). The ONLY differences are the images (node for
# generate+seed, postgres:17 for the psql assertion — not postgres:17 for the
# work) and the two stages below.
#
# POSITION in the deploy flow (singlebox-ops.md "Update / redeploy the stack"):
#   1. git pull --ff-only                # new code + new migration + new schema
#   2. deploy/migrate-prod.sh            # apply migrations + GATE on zero-pending
#   3. >>> deploy/seed-prod.sh <<<       # regen client + seed + ASSERT  (THIS)
#   4. docker build … (api [+ caddy])    # only reached if both gates passed
#   5. systemctl restart aramo-singlebox.service  (compose up -d --force-recreate)
#   6. health checks
# Runs AFTER migrate-prod.sh: generate reads only the schema files (no DB), and
# the seed needs the migrated schema present (it writes the new columns). If the
# assertion fails the deploy STOPS here — containers are NOT recreated.
#
# Provable LOCALLY (against a running prod-style stack) with overrides:
#   ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/seed-prod.sh
# The assertion gate is unit-checked (no docker/DB) by deploy/seed-prod.test.sh.

set -euo pipefail

# Uniform failure reassurance: on ANY non-zero exit (a generate/seed error that
# set -e propagates, or the assertion's explicit abort) tell the operator the
# deploy must stop here and containers were NOT recreated. Suppressed on success.
# Installed inside main() (not at top level) so `source`-ing for tests does not
# inherit the trap.
on_exit() {
  local rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[seed] seed step exited ${rc} — STOP: schema regen/seed not confirmed; containers were NOT recreated." >&2
    echo "[seed] The host-side Prisma client and/or the Astre seed are not confirmed in sync with the pulled code." >&2
    echo "[seed] Fix the regen/seed (see output above) before retrying." >&2
  fi
}

# --- config (overridable for local proof / tests) -------------------------
ARAMO_DIR="${ARAMO_DIR:-/opt/aramo}"
ENV_FILE="${ARAMO_ENV_FILE:-${ARAMO_DIR}/.env}"
# The compose project (deploy/systemd/singlebox-compose.sh) is 'aramo-singlebox';
# its default docker network is '<project>_default'. Keep these in lockstep.
COMPOSE_PROJECT="${ARAMO_COMPOSE_PROJECT:-aramo-singlebox}"
NETWORK="${ARAMO_SEED_NETWORK:-${COMPOSE_PROJECT}_default}"
# node-22 matches the box host (v22.23.0). NON-SLIM on purpose: slim omits
# openssl, which Prisma's generator probes (apps/api/Dockerfile apt-gets openssl
# for the same reason). Do NOT switch to node:22-slim.
NODE_IMAGE="${ARAMO_SEED_NODE_IMAGE:-node:22-bookworm}"
# psql lives in postgres:17 (not the node image) — used only for the assertion.
ASSERT_IMAGE="${ARAMO_SEED_ASSERT_IMAGE:-postgres:17}"

# The Astre tenant identity the seed provisions (seed-astre.ts:33 / :50). The
# post-seed assertion confirms this exact row exists with the backfilled domain
# AND subdomain slug (Subdomain-Identity Directive A — the slug is what makes
# astre.aramo.ai resolve through the on-demand cert path).
ASTRE_TENANT_ID="${ARAMO_ASTRE_TENANT_ID:-019000a0-0000-7000-8000-000000000001}"
ASTRE_ALLOWED_DOMAIN="${ARAMO_ASTRE_ALLOWED_DOMAIN:-astreinc.com}"
ASTRE_SLUG="${ARAMO_ASTRE_SLUG:-astre}"

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
# seed target cannot drift from what the app containers talk to.
build_dburl() {
  local user pass db
  user="$(read_env POSTGRES_USER)"; user="${user:-aramo}"
  pass="$(read_env POSTGRES_PASSWORD)"
  db="$(read_env POSTGRES_DB)"; db="${db:-aramo}"
  printf 'postgresql://%s:%s@postgres:5432/%s?schema=public' "$user" "$pass" "$db"
}

# STAGE A — regenerate the per-module Prisma clients into the mounted repo.
# NO --network, NO DATABASE_URL: `prisma generate` reads the schema files only
# (the datasource blocks carry no url=env()), so it needs no DB. Relies on the
# mounted repo's node_modules (jiti / .bin/prisma / @prisma/adapter-pg, present
# from the box npm ci) — no `npm ci` here.
run_regen() {
  docker run --rm \
    -v "$ARAMO_DIR":/repo -w /repo \
    "$NODE_IMAGE" \
    npm run prisma:generate
}

# STAGE B — run the Astre seed against the box DB. The seed WRITES, so it joins
# the compose network (so 'postgres' resolves) and gets the $-safe DATABASE_URL
# from the already-resolved shell variable (its '$' is NOT re-expanded). The
# seed reads plain process.env['DATABASE_URL'] and is fail-loud if unset. Always
# run: it is idempotent + post-login-safe (upserts update:{} except the tenant's
# allowed_domain; the owner's linked Cognito sub is untouched).
run_seed() {
  docker run --rm \
    --network "$NETWORK" \
    -v "$ARAMO_DIR":/repo -w /repo \
    -e DATABASE_URL="$DBURL" \
    "$NODE_IMAGE" \
    npm run prisma:seed-astre
}

# Read-only assertion query, run via psql in postgres:17 (the node image has no
# psql). Strips the ?schema= suffix psql rejects (as db-sync-local.sh does).
# Tables are PascalCase-quoted + schema-qualified (identity."Tenant").
run_assert_query() {
  docker run --rm \
    --network "$NETWORK" \
    -e DATABASE_URL="$DBURL" \
    "$ASSERT_IMAGE" \
    psql "${DBURL%%\?*}" -v ON_ERROR_STOP=1 -q -t -A -c \
    "SELECT count(*) FROM identity.\"Tenant\" WHERE id='${ASTRE_TENANT_ID}' AND allowed_domain='${ASTRE_ALLOWED_DOMAIN}' AND slug='${ASTRE_SLUG}';"
}

# THE GATE. The seed-presence query returns a single count. Returns 0 iff that
# count is exactly 1 (the Astre tenant exists with its backfilled domain).
# Numeric -eq — NOT a substring match — so stray whitespace, empty output, or a
# psql error string can never false-pass (the migrate-gate 10/100 lesson).
assert_passes() {
  local count
  count="$(printf '%s' "$1" | tr -d '[:space:]')"
  [ -n "$count" ] || return 1
  [ "$count" -eq 1 ] 2>/dev/null
}

# --- main -----------------------------------------------------------------

main() {
  trap on_exit EXIT
  command -v docker >/dev/null 2>&1 || {
    echo "[seed] FATAL: docker not found on this host." >&2; exit 2; }
  [ -f "$ENV_FILE" ] || {
    echo "[seed] FATAL: env file not found: $ENV_FILE" >&2; exit 2; }

  DBURL="$(build_dburl)"

  echo "[seed] network=${NETWORK} repo=${ARAMO_DIR} node=${NODE_IMAGE}"

  echo "[seed] STAGE A — regenerating host-side Prisma client (no DB)…"
  run_regen

  echo "[seed] STAGE B — running the Astre seed (idempotent, on-network)…"
  run_seed

  # GATE: confirm the seed actually landed the Astre tenant + backfilled domain.
  # A silently-failed seed (or a wrong DB) would NOT satisfy this, and the deploy
  # ABORTS (containers are NOT recreated — exit non-zero stops the sequence).
  local count
  count="$(run_assert_query)"
  echo "[seed] post-seed assertion: Astre tenant rows matching id+domain = '${count}'"

  if assert_passes "$count"; then
    echo "[seed] OK — Astre tenant present with allowed_domain. Safe to build + recreate containers."
  else
    echo "[seed] FATAL: post-seed assertion failed (expected exactly 1 Astre tenant row)." >&2
    # The on_exit trap prints the "containers NOT recreated" reassurance.
    exit 1
  fi
}

# Allow `source`-ing this file (e.g. from deploy/seed-prod.test.sh) to reach the
# helper functions WITHOUT executing main / touching docker.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
