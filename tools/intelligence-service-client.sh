#!/usr/bin/env bash
# intelligence-service-client — provision (create or rotate) a Talent
# Intelligence ServiceClient row (ATI-SEP-1 T4, ADR-0036 §3 "Service auth (E-2)").
#
# Usage:
#   tools/intelligence-service-client.sh --client-id aramo-ats \
#     --scopes intelligence:ingest,intelligence:read,intelligence:entitlements \
#     [--source-system ARAMO_ATS] [--inactive]
#
# Secret: export INTELLIGENCE_CLIENT_SECRET (>= 32 chars) to set it; leave it
# unset to have a random secret generated and printed ONCE in the JSON result.
# Only the scrypt hash (hashClientSecret) is stored — never the secret.
# Scopes: intelligence:ingest | intelligence:read | intelligence:verify | intelligence:entitlements.
#
# Needs INTELLIGENCE_DATABASE_URL (environment or .env). Runs the compiled entry
# dist/apps/talent-intelligence-service/src/provision-service-client.js, building
# it first when absent (or always with ARAMO_TI_REBUILD=1). Inside the TI
# container the compiled entry already exists:
#   docker compose exec talent-intelligence-service node dist/apps/talent-intelligence-service/src/provision-service-client.js ...
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/dist/apps/talent-intelligence-service/src/provision-service-client.js"

if [ -z "${INTELLIGENCE_DATABASE_URL:-}" ] && [ -f "$ROOT/.env" ]; then
  INTELLIGENCE_DATABASE_URL="$(grep -E '^INTELLIGENCE_DATABASE_URL=' "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
  export INTELLIGENCE_DATABASE_URL
fi
if [ -z "${INTELLIGENCE_DATABASE_URL:-}" ]; then
  echo "intelligence-service-client: INTELLIGENCE_DATABASE_URL is not set" >&2
  exit 2
fi

if [ ! -f "$ENTRY" ] || [ "${ARAMO_TI_REBUILD:-0}" = "1" ]; then
  (cd "$ROOT" && npx nx run talent-intelligence-service:build --skip-nx-cache >/dev/null)
fi

exec node "$ENTRY" "$@"
