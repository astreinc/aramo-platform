#!/usr/bin/env bash
# T2-F1-H2 — governed production image build.
#
# The governed runtime (NODE_ENV=production, ARAMO_ENV=prod) requires a valid
# 40-hex ARAMO_RELEASE_REVISION; apps/api boot-probes it BEFORE listen, so an
# unstamped image crash-loops. The documented on-box build commands omitted
# `--build-arg GIT_REVISION`, so this guard is the single build path: it resolves
# the repo root, validates an explicitly authorized SHA against a clean checkout,
# and stamps every governed image.
#
# Usage:  deploy/build-images.sh <AUTHORIZED_SHA>      (or AUTHORIZED_SHA=<sha> deploy/build-images.sh)
#
# Exit codes: 2 = bad SHA arg; 3 = HEAD != AUTHORIZED_SHA; 4 = dirty tree.
set -euo pipefail

# Resolve the repository root from THIS script's location and operate only there,
# so SHA validation and the Docker build context are the same canonical tree
# (never the caller's CWD).
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

AUTHORIZED_SHA="${1:-${AUTHORIZED_SHA:-}}"
if [[ ! "$AUTHORIZED_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "[build] FATAL: AUTHORIZED_SHA must be a 40-hex commit SHA (got: '${AUTHORIZED_SHA}')." >&2
  echo "[build] Usage: deploy/build-images.sh <AUTHORIZED_SHA>" >&2
  exit 2
fi

HEAD="$(git rev-parse HEAD)"
if [ "$HEAD" != "$AUTHORIZED_SHA" ]; then
  echo "[build] FATAL: checkout HEAD ${HEAD} != AUTHORIZED_SHA ${AUTHORIZED_SHA} (in ${ROOT_DIR})." >&2
  exit 3
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "[build] FATAL: working tree is not clean — the built image would not match ${AUTHORIZED_SHA}." >&2
  exit 4
fi

echo "[build] repo=${ROOT_DIR} revision=${AUTHORIZED_SHA}"
# sign-service IS built here: the nginx image's baked sign.aramo.ai block renders
# `proxy_pass http://sign-service:3003` and nginx resolves that upstream at
# config-load — so recreating nginx with sign-service absent crash-loops the
# front door (`[emerg] host not found in upstream "sign-service"`). The prod app
# topology is 5 containers (api, auth-service, platform-admin, sign-service,
# nginx); nginx must never be recreated without sign-service built + running.
# ATI-SEP-1 T0 (ADR-0036) adds talent-intelligence-service (:3004, container-
# internal; NO nginx upstream, so nginx never depends on it) → 6 images.
for S in api auth-service platform-admin sign-service talent-intelligence-service; do
  echo "[build] building aramo/${S}:local"
  docker build --no-cache -f "${ROOT_DIR}/apps/${S}/Dockerfile" \
    --build-arg GIT_REVISION="${AUTHORIZED_SHA}" -t "aramo/${S}:local" "${ROOT_DIR}"
done
# Sign Personal (Free) — the Cloudflare Turnstile SITE key is public and baked into
# the Sign bundle at build time (deploy/nginx/Dockerfile ARG VITE_SIGN_TURNSTILE_SITE_KEY).
# This script is the production build path, so it — not docker-compose's build args —
# must pass it. Source: an exported SIGN_TURNSTILE_SITE_KEY, else the box env file
# (ARAMO_ENV_FILE, default <repo>/.env). Unset/unreadable ⇒ built without the widget
# (the backend then refuses Personal signups: fail closed). Only the SITE key is
# read; the Turnstile SECRET never enters an image.
ENV_FILE="${ARAMO_ENV_FILE:-${ROOT_DIR}/.env}"
TURNSTILE_SITE_KEY="${SIGN_TURNSTILE_SITE_KEY:-}"
if [ -z "$TURNSTILE_SITE_KEY" ] && [ -r "$ENV_FILE" ]; then
  TURNSTILE_SITE_KEY="$(grep -E '^SIGN_TURNSTILE_SITE_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
fi
if [ -n "$TURNSTILE_SITE_KEY" ]; then
  echo "[build] Sign Turnstile site key: set (${TURNSTILE_SITE_KEY:0:6}…)"
else
  echo "[build] Sign Turnstile site key: NOT set — the Personal signup robot check will not render"
fi
echo "[build] building aramo/nginx:local"
docker build --no-cache -f "${ROOT_DIR}/deploy/nginx/Dockerfile" \
  --build-arg GIT_REVISION="${AUTHORIZED_SHA}" \
  --build-arg VITE_SIGN_TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY}" \
  -t "aramo/nginx:local" "${ROOT_DIR}"

echo "[build] OK — 6 images stamped ${AUTHORIZED_SHA} from ${ROOT_DIR}"
