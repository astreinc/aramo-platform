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
for S in api auth-service platform-admin; do
  echo "[build] building aramo/${S}:local"
  docker build --no-cache -f "${ROOT_DIR}/apps/${S}/Dockerfile" \
    --build-arg GIT_REVISION="${AUTHORIZED_SHA}" -t "aramo/${S}:local" "${ROOT_DIR}"
done
echo "[build] building aramo/nginx:local"
docker build --no-cache -f "${ROOT_DIR}/deploy/nginx/Dockerfile" \
  --build-arg GIT_REVISION="${AUTHORIZED_SHA}" -t "aramo/nginx:local" "${ROOT_DIR}"

echo "[build] OK — 4 images stamped ${AUTHORIZED_SHA} from ${ROOT_DIR}"
