#!/usr/bin/env bash
#
# ci/scripts/frontdoor-boot-smoke.sh
#
# D-FRONTDOOR-CUTOVER-1 Ruling 3 — the nginx front-door BOOT smoke. A new Gate-5
# lane class: the 2026-07-26 cutover rolled back on runtime defects that every
# static check (nginx -t, conf-check) passed. This lane boots the ALREADY-BUILT
# image the way production boots it and proves it actually serves — catching E18
# (entrypoint bypass) and E19 (unset-var literal) at the desk, before a window.
#
# It BUILDS NOTHING. It takes aramo/nginx:local (arg 1, default), runs it, proves
# it, and always cleans up. Exit 0 = boots + serves; non-zero (+ log tail) = defect.
#
# Wiring: (a) Gate-5 mandatory for any PR touching deploy/nginx/** or the compose
# nginx service; (b) CI — a step appended INSIDE the existing docker-build(nginx)
# matrix leg, after its build (no new job; runs exactly when the image builds).

set -euo pipefail

IMAGE="${1:-aramo/nginx:local}"
CONTAINER="aramo-frontdoor-smoke-$$"
CERTDIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$CERTDIR" || true
}
trap cleanup EXIT

fail() {
  echo "FRONTDOOR BOOT SMOKE — FAIL: $*" >&2
  echo "---- container log tail ----" >&2
  docker logs "$CONTAINER" 2>&1 | tail -40 >&2 || true
  exit 1
}

# --- Throwaway self-signed cert in the DEFAULT layout ------------------------
# Laid out as live/aramo.ai/{fullchain,privkey}.pem and mounted at /etc/letsencrypt,
# so it satisfies the image's DEFAULT NGINX_CERT_DIR (/etc/letsencrypt/live/aramo.ai).
# The container is run with ZERO NGINX_* env — proving the image-level defaults
# (deploy/nginx/Dockerfile, Ruling A) end-to-end. If the defaults regressed, envsubst
# would leave a literal ${NGINX_*} and nginx would crash here (E19).
mkdir -p "$CERTDIR/live/aramo.ai"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=localhost' \
  -keyout "$CERTDIR/live/aramo.ai/privkey.pem" \
  -out    "$CERTDIR/live/aramo.ai/fullchain.pem" >/dev/null 2>&1

# --- The FIXED compose wrapper command, VERBATIM (Ruling C, E18 coverage) -----
# This is the docker-compose.prod.yml nginx `command:` after compose un-escapes
# `$${!}`→`${!}` — i.e. exactly what the box runs. The outer entrypoint sees
# $1=/bin/sh and SKIPS its render scripts; the inner `exec /docker-entrypoint.sh
# nginx` re-enters the entrypoint with $1=nginx, which renders envsubst → conf.d
# and execs nginx. That inner-exec chain is the E18 fix, and it is exactly what
# the box ran after Saturday's hot-fix. conf-check assertion (i) pins the compose
# side to this shape; this smoke proves the shape boots — together, E18 end-to-end.
NGINX_CMD='trap exit TERM
while :; do sleep 6h & wait ${!}; nginx -s reload; done &
exec /docker-entrypoint.sh nginx -g '\''daemon off;'\'''

# --- Run: NO NGINX_* env; loopback host-aliases for the known upstreams -------
# Ruling B — the runtime analogue of the Option C build-time loopback rewrite:
# nginx resolves literal-hostname upstreams at config-load, and a standalone
# container has no compose network, so api/auth-service/platform-admin would be
# "host not found in upstream". These THREE aliases (the exact upstreams the
# template proxies) point them at a dead loopback so nginx starts; the smoke
# exercises /healthz + static HTTPS, never the proxied backends. Forced
# consciousness: a FOURTH upstream added to the template fails this smoke until
# it is added here (same property as the Option C name list).
docker run -d --name "$CONTAINER" \
  -p 127.0.0.1::80 -p 127.0.0.1::443 \
  --add-host api:127.0.0.1 \
  --add-host auth-service:127.0.0.1 \
  --add-host platform-admin:127.0.0.1 \
  -v "$CERTDIR:/etc/letsencrypt:ro" \
  "$IMAGE" /bin/sh -c "$NGINX_CMD" >/dev/null 2>&1 \
  || fail "docker run failed to start the container"

HTTP_PORT="$(docker port "$CONTAINER" 80/tcp | head -1 | sed 's/.*://')"
HTTPS_PORT="$(docker port "$CONTAINER" 443/tcp | head -1 | sed 's/.*://')"
[ -n "$HTTP_PORT" ] && [ -n "$HTTPS_PORT" ] || fail "could not resolve mapped host ports"

# --- Poll /healthz → 200 (the nginx-served health endpoint, not proxied) ------
code=""
for _ in $(seq 1 30); do
  if ! docker ps --filter "name=$CONTAINER" --filter status=running --format '{{.Names}}' \
       | grep -q "$CONTAINER"; then
    fail "container exited during boot (E18/E19 class — see log)"
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HTTP_PORT}/healthz" 2>/dev/null || true)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "$code" = "200" ] || fail "/healthz did not return 200 (got '${code:-<none>}')"
echo "  ✓ /healthz → 200"

# --- conf.d/aramo.conf exists and is NON-EMPTY in-container (E18/E19) ----------
# The defect signature was an empty conf.d (E18) or an unrendered literal (E19).
docker exec "$CONTAINER" test -s /etc/nginx/conf.d/aramo.conf \
  || fail "/etc/nginx/conf.d/aramo.conf missing or empty in-container (E18 render skip)"
# And it must carry NO unrendered ${NGINX_<VAR>} literal in a FUNCTIONAL position
# (E19 signature). The pattern requires an uppercase letter right after `NGINX_`,
# so it matches the real placeholders (${NGINX_CERT_DIR} …) but NOT the template's
# descriptive `${NGINX_*}` header comment (the `*` is not [A-Z]).
if docker exec "$CONTAINER" grep -q '${NGINX_[A-Z]' /etc/nginx/conf.d/aramo.conf 2>/dev/null; then
  fail 'conf.d/aramo.conf still contains an unrendered ${NGINX_<VAR>} literal (E19)'
fi
echo "  ✓ conf.d/aramo.conf rendered, non-empty, no unrendered \${NGINX_<VAR>} literal"

# --- One curl -k HTTPS handshake against the tenant server block --------------
https_code="$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:${HTTPS_PORT}/" 2>/dev/null || true)"
[ "$https_code" = "200" ] || fail "tenant HTTPS handshake did not return 200 (got '${https_code:-<none>}')"
echo "  ✓ tenant-block HTTPS (curl -k) → 200"

echo "FRONTDOOR BOOT SMOKE — PASS ($IMAGE): defaults applied with zero NGINX_* env, entrypoint chain rendered conf, TLS served."
