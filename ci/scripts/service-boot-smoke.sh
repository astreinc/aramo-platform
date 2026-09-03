#!/usr/bin/env bash
#
# ci/scripts/service-boot-smoke.sh
#
# Production-dependency BOOT smoke for the Node runtime services (api, auth-service,
# platform-admin). New Gate-5 lane class, motivated by the 2026-09-02 decimal.js
# incident: a runtime import left in devDependencies passed every CI check, was
# stripped by `npm prune --omit=dev` in the image, and would have crash-looped all
# three services at boot. CI installs ALL deps and never booted a pruned image, so it
# was blind to the whole class.
#
# It BUILDS NOTHING. It takes an ALREADY-BUILT service image (arg 1) + a service name
# (arg 2), runs the prod-pruned image with ci/scripts/boot-smoke-loader.cjs mounted in,
# and asserts the service's runtime entry module graph resolves with PRODUCTION
# dependencies only. Exit 0 = graph resolves; non-zero (+ container log tail) = a
# runtime import is missing from the production image.
#
# `--self-test` proves the guard is RED on a missing module and GREEN on a present one,
# with NO Docker — the committed RED-first proof of the guard itself.
#
# Wiring: a step appended INSIDE each Node leg of the docker-build matrix, after its
# build (mirrors the nginx frontdoor-boot-smoke.sh precedent — no new job; runs exactly
# when the image builds). A SKIPPED smoke on a Node leg is a finding.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOADER="$HERE/boot-smoke-loader.cjs"

# --self-test: prove RED (missing module) + GREEN (present module). No Docker, no deps.
if [ "${1:-}" = "--self-test" ]; then
  exec node "$LOADER" --self-test
fi

IMAGE="${1:?usage: service-boot-smoke.sh <image> <service> | --self-test}"
SERVICE="${2:?usage: service-boot-smoke.sh <image> <service> | --self-test}"

# Service -> the exact runtime entry the image's CMD boots (see each apps/*/Dockerfile).
case "$SERVICE" in
  api)            ENTRY="dist/apps/api/src/main.js" ;;
  auth-service)   ENTRY="dist/apps/auth-service/src/main.js" ;;
  platform-admin) ENTRY="dist/apps/platform-admin/src/main.js" ;;
  *) echo "service-boot-smoke: unknown service '$SERVICE' (expected api|auth-service|platform-admin)" >&2; exit 2 ;;
esac

echo "── prod-deps boot-smoke [$SERVICE] · image $IMAGE · entry $ENTRY ──"

# Run the prod-pruned image with the entrypoint overridden to the loader. The loader
# resolves the entry's static require graph and exits the instant it resolves — it does
# NOT boot the app, so a missing DB/env cannot mask or fake the result.
#   - WORKDIR in the image is /app, so ENTRY resolves to /app/dist/... and its requires
#     resolve against /app/node_modules (the prod-pruned tree).
#   - ARAMO_RELEASE_REVISION is set so the ReleaseIdentity governor does not fail-closed
#     before the graph resolves (belt — the image is already stamped at build).
if docker run --rm \
    -e NODE_ENV=production \
    -e ARAMO_RELEASE_REVISION="${ARAMO_RELEASE_REVISION:-boot-smoke}" \
    -v "$LOADER:/opt/boot-smoke-loader.cjs:ro" \
    --entrypoint node "$IMAGE" \
    /opt/boot-smoke-loader.cjs "$ENTRY" "$SERVICE"; then
  echo "SERVICE BOOT SMOKE — PASS [$SERVICE]"
else
  echo "SERVICE BOOT SMOKE — FAIL [$SERVICE]: a runtime import is missing from the production image." >&2
  exit 1
fi
