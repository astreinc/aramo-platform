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
#   SKIP_SEED=1    skip the identity catalog seed
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

  log "1/6 infra: docker compose up -d (postgres + redis)"
  compose up -d
  wait_for_pg

  log "2/6 db: apply migrations (tools/db-sync-local.sh)"
  bash tools/db-sync-local.sh

  if [ "${SKIP_SEED:-0}" = "1" ]; then
    log "3/6 seed: skipped (SKIP_SEED=1)"
  else
    log "3/6 seed: identity catalog"
    node --import jiti/register libs/identity/prisma/seed.ts
  fi

  if [ "${SKIP_BUILD:-0}" = "1" ]; then
    log "4/6 build: skipped (SKIP_BUILD=1) — reusing dist/"
  else
    log "4/6 build: nx build api auth-service"
    npx nx run-many -t build -p api auth-service
  fi

  log "5/6 link: runtime deps for node dist/ (tools/local-run-link.sh)"
  bash tools/local-run-link.sh

  log "6/6 start: auth-service :3001, api :3000, ats-web :4201"
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
