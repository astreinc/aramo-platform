#!/usr/bin/env bash
# §5 Auth-Hardening D5 (3.6) Part A — one-command local stack.
#
# Ends the hand-run `node dist/...` story: brings up the FULL local stack —
# Postgres + Redis (docker compose) + auth-service (:3001) + api (:3000) + FE
# ats-web (:4201) — from a single command, reproducibly. See the runbook:
# doc/runbooks/local-run.md.
#
#   tools/local-stack.sh up        # infra + db sync + seed + build + link + start all 3 apps
#   tools/local-stack.sh down      # stop the 3 apps + `docker compose down`
#   tools/local-stack.sh status    # what's running (apps + infra)
#   tools/local-stack.sh logs      # tail the app logs
#
# Options (env):
#   SKIP_BUILD=1   reuse the existing dist/ (skip the nx build — faster restarts)
#   SKIP_SEED=1    skip ALL seeds (identity catalog + tenant provisioning +
#                  policy-lifecycle + entitlements)
#
# The apps run as plain background processes (the established build+link pattern,
# NOT containers); pids + logs live under .local-stack/ (gitignored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUN_DIR=".local-stack"
mkdir -p "$RUN_DIR"

log()  { printf '\033[36m[local-stack]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[local-stack] %s\033[0m\n' "$*" >&2; exit 1; }

load_env() {
  [ -f .env ] || die "no .env — copy .env.example to .env and fill it (doc/runbooks/local-run.md)"
  set -a; . ./.env; set +a
}

compose() { docker compose "$@"; }

wait_for_pg() {
  log "waiting for Postgres…"
  for _ in $(seq 1 40); do
    if compose exec -T postgres pg_isready -U aramo -d aramo >/dev/null 2>&1; then
      log "Postgres ready"; return 0
    fi
    sleep 1
  done
  die "Postgres did not become ready in time"
}

start_app() { # name  command...
  local name="$1"; shift
  if [ -f "$RUN_DIR/$name.pid" ] && kill -0 "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null; then
    log "$name already running (pid $(cat "$RUN_DIR/$name.pid"))"; return 0
  fi
  "$@" > "$RUN_DIR/$name.log" 2>&1 &
  echo $! > "$RUN_DIR/$name.pid"
  log "$name started (pid $!) → $RUN_DIR/$name.log"
}

stop_app() { # name
  local name="$1" pidf="$RUN_DIR/$1.pid"
  [ -f "$pidf" ] || return 0
  local pid; pid="$(cat "$pidf")"
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; log "$name stopped (pid $pid)"; fi
  rm -f "$pidf"
}

cmd_up() {
  command -v docker >/dev/null || die "docker not found (needed for Postgres + Redis)"
  load_env
  # The canonical local tenant (mirrors deploy/seed-prod.sh:82). Overridable.
  ASTRE_TENANT_ID="${ARAMO_ASTRE_TENANT_ID:-019000a0-0000-7000-8000-000000000001}"

  log "1/7 infra: docker compose up -d (postgres + redis)"
  compose up -d
  wait_for_pg

  log "2/7 db: apply migrations (tools/db-sync-local.sh)"
  bash tools/db-sync-local.sh

  # Host-jiti seeds (identity + tenant provisioning). These graphs transform
  # cleanly under jiti; the POLICY seed does NOT (see step 5/7) — it must run
  # from the compiled dist, so it is deferred until AFTER the build.
  if [ "${SKIP_SEED:-0}" = "1" ]; then
    log "3/7 seed: skipped (SKIP_SEED=1)"
  else
    log "3/7 seed (host): identity catalog + Astre tenant + platform owner + auth storage"
    node --import jiti/register libs/identity/prisma/seed.ts
    npm run prisma:seed-astre
    npm run prisma:seed-platform-owner
    npm run prisma:seed-auth-storage
  fi

  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    log "4/7 build: skipped (SKIP_BUILD=1) — reusing dist/"
  else
    log "4/7 build: nx build api auth-service"
    npx nx run-many -t build -p api auth-service
  fi

  # Policy-lifecycle + entitlements seed — AFTER the build (mirrors
  # deploy/seed-prod.sh Stage C/D; BUILD precedes policy SEED). The policy seed
  # MUST run from the COMPILED dist, never host-jiti: its import graph pulls the
  # NestJS + class-validator surface, which jiti cannot transform (the repo uses
  # legacy experimentalDecorators), so `npm run prisma:seed-policy-lifecycle`
  # fails on a fresh env. Skipping it leaves policy_store EMPTY and the engine
  # fails closed (NO_POLICY_PUBLISHED) — every governed requisition transition
  # (Submit for approval, Close, …) and client-policy publish then 403s.
  if [ "${SKIP_SEED:-0}" = "1" ]; then
    log "5/7 policy+entitlements seed: skipped (SKIP_SEED=1)"
  elif [ ! -f dist/apps/api/src/policy/seed-lifecycle.js ]; then
    log "5/7 policy+entitlements seed: SKIPPED — compiled seed missing at dist/apps/api (build first; do NOT SKIP_BUILD on a fresh env)"
  else
    log "5/7 seed (compiled): policy-lifecycle + tenant entitlements"
    node dist/apps/api/src/policy/seed-lifecycle.js
    ARAMO_ENTITLEMENT_TENANT_ID="$ASTRE_TENANT_ID" npm run prisma:seed-entitlements
  fi

  log "6/7 link: runtime deps for node dist/ (tools/local-run-link.sh)"
  bash tools/local-run-link.sh

  log "7/7 start: auth-service :3001, api :3000, ats-web :4201"
  start_app auth-service env PORT=3001 node dist/apps/auth-service/src/main.js
  start_app api          env PORT=3000 node dist/apps/api/src/main.js
  start_app ats-web      npx nx serve aramo-ats-web

  log "stack up:"
  log "  FE   → http://localhost:4201"
  log "  api  → http://localhost:3000   auth → http://localhost:3001"
  log "  logs → $RUN_DIR/{auth-service,api,ats-web}.log   (tools/local-stack.sh down to stop)"
}

cmd_down() {
  stop_app ats-web; stop_app api; stop_app auth-service
  if command -v docker >/dev/null; then log "infra: docker compose down"; compose down; fi
}

cmd_status() {
  for name in auth-service api ats-web; do
    local pidf="$RUN_DIR/$name.pid"
    if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
      printf '  %-13s UP   (pid %s)\n' "$name" "$(cat "$pidf")"
    else
      printf '  %-13s down\n' "$name"
    fi
  done
  command -v docker >/dev/null && compose ps 2>/dev/null || true
}

cmd_logs() { tail -n 40 -F "$RUN_DIR"/*.log; }

case "${1:-up}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) die "usage: tools/local-stack.sh [up|down|status|logs]" ;;
esac
