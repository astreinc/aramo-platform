#!/usr/bin/env bash
# Aramo single-box — compose bring-up / tear-down launcher.
#
# Single-Box Directive 3 §A. The systemd unit (aramo-singlebox.service) calls
# this on boot/stop so the full docker-compose.prod.yml stack returns
# automatically after a reboot or power-cycle (it pairs with the
# `restart: unless-stopped` already on every service — that keeps containers up
# while dockerd runs; this brings the project up when the box boots).
#
# Why a launcher and not a raw `docker compose` in ExecStart: the real .env
# carries multi-line PEM keys (AUTH_PRIVATE_KEY / AUTH_PUBLIC_KEY) that
# compose's env_file parser cannot read. The proven pattern (D1) is to SOURCE
# the env into the shell and let compose pass the bare-name vars through, with
# `--env-file /dev/null` so compose does not try to parse .env for ${}
# interpolation. That needs a shell — hence this script.
#
# This logic is provable LOCALLY (no systemd needed):
#   ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/systemd/singlebox-compose.sh up
#   ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/systemd/singlebox-compose.sh status
#   ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/systemd/singlebox-compose.sh down
set -euo pipefail

# Deploy dir on the box (the repo checkout / artifact dir). Override via the
# unit's Environment= for a different layout.
ARAMO_DIR="${ARAMO_DIR:-/opt/aramo}"
ARAMO_ENV_FILE="${ARAMO_ENV_FILE:-${ARAMO_DIR}/.env}"
COMPOSE_FILE="${ARAMO_COMPOSE_FILE:-docker-compose.prod.yml}"
# Explicit, ISOLATED project name. The default compose project is the dir
# basename — which collides with the dev docker-compose.yml when both live in
# the same checkout (running prod `up` would otherwise recreate the dev
# `postgres` container). A distinct name keeps the prod stack's containers /
# network / volumes wholly separate. Harmless on the box (no dev compose there).
COMPOSE_PROJECT="${ARAMO_COMPOSE_PROJECT:-aramo-singlebox}"

cd "$ARAMO_DIR"

# `docker compose` (v2 plugin) preferred; fall back to legacy `docker-compose`.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -p "$COMPOSE_PROJECT" --env-file /dev/null -f "$COMPOSE_FILE" "$@"
  else
    docker-compose -p "$COMPOSE_PROJECT" --env-file /dev/null -f "$COMPOSE_FILE" "$@"
  fi
}

action="${1:-up}"
case "$action" in
  up)
    [ -f "$ARAMO_ENV_FILE" ] || { echo "singlebox-compose: env file not found: $ARAMO_ENV_FILE" >&2; exit 2; }
    # Source the shell-form .env (multi-line-PEM-safe), then bring the stack up.
    set -a
    # shellcheck disable=SC1090
    . "$ARAMO_ENV_FILE"
    set +a
    compose up -d
    ;;
  down)
    compose down
    ;;
  status)
    compose ps
    ;;
  *)
    echo "usage: $0 {up|down|status}" >&2
    exit 2
    ;;
esac
