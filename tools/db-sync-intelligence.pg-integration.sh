#!/usr/bin/env bash
# tools/db-sync-intelligence.pg-integration.sh — REAL-PostgreSQL proof of the
# Talent Intelligence database provisioning + migration runner (ATI-SEP-1 T0).
#
# NOT a *.test.sh on purpose (needs docker + psql); runs in the CI
# migration-runner:pg job next to tools/db-sync-local.pg-integration.sh.
#
# Run:  bash tools/db-sync-intelligence.pg-integration.sh   (exit 0 = all cases pass)
#   ARAMO_PG_IMAGE (default pgvector/pgvector:pg17)   ARAMO_PG_PORT (default 55433)
#
# Cases (against a server that ALREADY holds a non-TI database — the PROD shape):
#   I1 ensure-intelligence-db creates role + database owned by the role; PUBLIC loses CONNECT
#   I2 ensure-intelligence-db is idempotent (second run exits 0, nothing duplicated)
#   I3 ensure-intelligence-db refuses a missing / URL-unsafe password (exit 2, nothing created)
#   I4 the runner applies the real TI manifest as the TI role; ledger rows carry checksums
#   I5 a second run applies 0 (idempotent); --status reports pending 0 / drift 0
#   I6 --status is read-only on a database without a ledger (no table created)
#   I7 a changed applied migration is DRIFT: apply refuses (exit 3), status reports it
#   I8 a failing migration rolls back atomically — no schema change, no ledger row
#   I9 the shared-DB runner (tools/db-sync-local.sh) never lists the TI migrations
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${ARAMO_PG_IMAGE:-pgvector/pgvector:pg17}"
PORT="${ARAMO_PG_PORT:-55433}"
CNAME="aramo-ti-dbsync-pg-$$"

PSQL="$(command -v psql || true)"
[ -z "$PSQL" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
[ -n "$PSQL" ] || { echo "ti-pg-integration: psql not found (install libpq / postgresql-client)"; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "ti-pg-integration: docker not found"; exit 2; }

TMP="$(mktemp -d)"
cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ok    $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

echo "ti-pg-integration: starting ${IMAGE} on 127.0.0.1:${PORT} (${CNAME})"
docker run -d --rm --name "$CNAME" -e POSTGRES_PASSWORD=pg -e POSTGRES_USER=aramo -e POSTGRES_DB=aramo \
  -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
ADMIN="postgresql://aramo:pg@127.0.0.1:${PORT}/aramo"
for _ in $(seq 1 60); do "$PSQL" "$ADMIN" -tAc "select 1" >/dev/null 2>&1 && break; sleep 1; done
"$PSQL" "$ADMIN" -tAc "select 1" >/dev/null 2>&1 || { echo "ti-pg-integration: postgres did not come up"; exit 2; }
# The PROD shape: the server already has the shared Aramo DB with data in it.
"$PSQL" "$ADMIN" -qc "CREATE TABLE public.pre_existing(id int); INSERT INTO public.pre_existing VALUES (1);" >/dev/null

PW="ti-integration-password-0123456789"
TI_URL="postgresql://aramo_intelligence:${PW}@127.0.0.1:${PORT}/aramo_intelligence"
ensure() { INTELLIGENCE_ADMIN_DATABASE_URL="$ADMIN" INTELLIGENCE_DB_PASSWORD="${1-$PW}" bash "$ROOT/tools/ensure-intelligence-db.sh" 2>&1; }
runner() { # $1 = root, $2 = url, rest = args
  local root="$1" url="$2"; shift 2
  (cd "$root" && INTELLIGENCE_DATABASE_URL="$url" bash tools/db-sync-intelligence.sh "$@" 2>&1)
}
sql() { "$PSQL" "$1" -X -tAc "$2" 2>/dev/null; }

# --- I3 (first, so nothing exists yet) ----------------------------------------
o1="$(ensure "")"; r1=$?
o2="$(ensure "has@sign-but-long-enough-0123")"; r2=$?
if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$(sql "$ADMIN" "SELECT count(*) FROM pg_roles WHERE rolname='aramo_intelligence'")" = "0" ]; then
  ok "I3 missing / URL-unsafe password refused (exit 2), no role created"
else
  bad "I3 password refusal (rc ${r1}/${r2}): ${o1} ${o2}"
fi

# --- I1 -----------------------------------------------------------------------
out="$(ensure)"; rc=$?
owner="$(sql "$ADMIN" "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='aramo_intelligence'")"
super="$(sql "$ADMIN" "SELECT rolsuper FROM pg_roles WHERE rolname='aramo_intelligence'")"
pubconn="$(sql "$ADMIN" "SELECT has_database_privilege('public', 'aramo_intelligence', 'CONNECT')" || true)"
if [ "$rc" = 0 ] && [ "$owner" = "aramo_intelligence" ] && [ "$super" = "f" ] \
   && [ "$(sql "$TI_URL" "SELECT current_user")" = "aramo_intelligence" ] \
   && [ "$(sql "$ADMIN" "SELECT count(*) FROM public.pre_existing")" = "1" ]; then
  ok "I1 role + database created (owner aramo_intelligence, not superuser); existing DB untouched"
else
  bad "I1 ensure (rc ${rc}, owner '${owner}', super '${super}'): ${out}"
fi
acl="$(sql "$ADMIN" "SELECT datacl::text FROM pg_database WHERE datname='aramo_intelligence'")"
if printf '%s' "$acl" | grep -q 'aramo_intelligence=' && ! printf '%s' "$acl" | grep -Eq '(^|[{,])=[A-Za-z]*c'; then
  ok "I1b PUBLIC has no CONNECT on aramo_intelligence (acl ${acl}; has_database_privilege(public)=${pubconn})"
else
  bad "I1b database ACL (${acl})"
fi

# --- I2 -----------------------------------------------------------------------
out="$(ensure)"; rc=$?
if [ "$rc" = 0 ] && [ "$(sql "$ADMIN" "SELECT count(*) FROM pg_database WHERE datname='aramo_intelligence'")" = "1" ]; then
  ok "I2 ensure is idempotent (second run exit 0)"
else
  bad "I2 ensure re-run (rc ${rc}): ${out}"
fi

# --- I6 (before any apply: no ledger yet) -------------------------------------
st="$(runner "$ROOT" "$TI_URL" --status)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$st" | grep -q "pending — 1 on-disk" \
   && [ "$(sql "$TI_URL" "SELECT to_regclass('public._intelligence_migrations') IS NULL")" = "t" ]; then
  ok "I6 --status is read-only (no ledger table created)"
else
  bad "I6 status read-only (rc ${rc}): ${st}"
fi

# --- I4 -----------------------------------------------------------------------
out="$(runner "$ROOT" "$TI_URL")"; rc=$?
tot="$(cd "$ROOT" && ls -d libs/intelligence-core/prisma/migrations/*/ | wc -l | tr -d ' ')"
rows="$(sql "$TI_URL" "SELECT count(*) FROM public._intelligence_migrations WHERE length(checksum) = 64")"
if [ "$rc" = 0 ] && [ "$rows" = "$tot" ] && printf '%s' "$out" | grep -q "${tot} applied, 0 already present" \
   && [ "$(sql "$TI_URL" "SELECT value FROM intelligence.\"ServiceInfo\" WHERE key='schema_baseline'")" = "ATI-SEP-1-T0" ] \
   && [ "$(sql "$TI_URL" "SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='intelligence'")" = "aramo_intelligence" ] \
   && [ "$(sql "$ADMIN" "SELECT to_regnamespace('intelligence') IS NULL")" = "t" ]; then
  ok "I4 first run applied ${tot}/${tot} as the TI role (checksummed ledger; schema absent from the shared DB)"
else
  bad "I4 first apply (rc ${rc}, rows ${rows}/${tot}): ${out}"
fi

# --- I5 -----------------------------------------------------------------------
out="$(runner "$ROOT" "$TI_URL")"; rc=$?
st="$(runner "$ROOT" "$TI_URL" --status)"
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "0 applied, ${tot} already present" \
   && printf '%s' "$st" | grep -q "pending — 0 on-disk" && printf '%s' "$st" | grep -q "drift — 0 recorded"; then
  ok "I5 second run applied 0 (idempotent); status pending 0 / drift 0"
else
  bad "I5 idempotent re-run (rc ${rc}): ${out} / ${st}"
fi

# --- I7 / I8 on a staged copy (synthetic manifest) ----------------------------
stage() { # $1 = root
  mkdir -p "$1/tools" "$1/libs/intelligence-core/prisma/migrations/20260101000000_a"
  cp "$ROOT/tools/db-sync-intelligence.sh" "$1/tools/"
  echo "CREATE TABLE public.t_a(id int);" > "$1/libs/intelligence-core/prisma/migrations/20260101000000_a/migration.sql"
}
"$PSQL" "$ADMIN" -qc "CREATE DATABASE ti_drift OWNER aramo_intelligence;" >/dev/null
DRIFT_URL="postgresql://aramo_intelligence:${PW}@127.0.0.1:${PORT}/ti_drift"
S="$TMP/s"; stage "$S"
runner "$S" "$DRIFT_URL" >/dev/null
echo "CREATE TABLE public.t_a(id int, changed int);" > "$S/libs/intelligence-core/prisma/migrations/20260101000000_a/migration.sql"
mkdir -p "$S/libs/intelligence-core/prisma/migrations/20260102000000_b"
echo "CREATE TABLE public.t_b(id int);" > "$S/libs/intelligence-core/prisma/migrations/20260102000000_b/migration.sql"
out="$(runner "$S" "$DRIFT_URL")"; rc=$?
st="$(runner "$S" "$DRIFT_URL" --status)"
if [ "$rc" = 3 ] && printf '%s' "$st" | grep -q "drift — 1 recorded" \
   && [ "$(sql "$DRIFT_URL" "SELECT to_regclass('public.t_b') IS NULL")" = "t" ]; then
  ok "I7 checksum drift refused (exit 3) and nothing applied; status reports drift 1"
else
  bad "I7 drift (rc ${rc}): ${out} / ${st}"
fi

"$PSQL" "$ADMIN" -qc "CREATE DATABASE ti_fail OWNER aramo_intelligence;" >/dev/null
FAIL_URL="postgresql://aramo_intelligence:${PW}@127.0.0.1:${PORT}/ti_fail"
F="$TMP/f"; stage "$F"
mkdir -p "$F/libs/intelligence-core/prisma/migrations/20260102000000_b"
printf 'CREATE TABLE public.t_b(id int);\nSELECT 1/0;\n' > "$F/libs/intelligence-core/prisma/migrations/20260102000000_b/migration.sql"
out="$(runner "$F" "$FAIL_URL")"; rc=$?
if [ "$rc" = 1 ] && [ "$(sql "$FAIL_URL" "SELECT count(*) FROM public._intelligence_migrations")" = "1" ] \
   && [ "$(sql "$FAIL_URL" "SELECT to_regclass('public.t_b') IS NULL")" = "t" ]; then
  ok "I8 failing migration rolled back atomically (no table, no ledger row; exit 1)"
else
  bad "I8 atomic failure (rc ${rc}): ${out}"
fi

# --- I9 -----------------------------------------------------------------------
if (cd "$ROOT" && bash -c 'source tools/db-sync-local.sh && mig_list' | grep -q '^libs/intelligence-core/'); then
  bad "I9 tools/db-sync-local.sh lists TI migrations (they would hit the shared DB)"
else
  ok "I9 tools/db-sync-local.sh never lists libs/intelligence-core migrations"
fi

echo "db-sync-intelligence.pg-integration — ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
