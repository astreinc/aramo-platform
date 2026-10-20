#!/usr/bin/env bash
# tools/db-sync-local.pg-integration.sh — REAL-PostgreSQL proof of the bounded
# (--until) apply in tools/db-sync-local.sh.
#
# NOT a *.test.sh on purpose: the pure suites run under scripts/run-script-tests.sh
# (the static-governance job, no docker); this one needs docker + psql and belongs
# to the integration leg (the same pgvector/pgvector:pg17 image every Postgres-
# backed integration spec starts, pre-warmed there).
#
# Run:  bash tools/db-sync-local.pg-integration.sh      (exit 0 = all five cases pass)
#   ARAMO_PG_IMAGE  (default pgvector/pgvector:pg17)   ARAMO_PG_PORT (default 55432)
#
# Cases:
#   P1 a bounded apply applies exactly the manifest prefix; ledger == applied; status
#      reports pending-before-stop 0 and the deferred count; nothing after the stop exists
#   P2 re-running the same --until applies 0 and exits 0 (idempotent)
#   P3 a plain apply afterwards applies ONLY the deferred remainder; final pending 0
#   P4 a failing file INSIDE the window aborts (exit 1); nothing after it is applied or
#      recorded; the ledger holds only what succeeded before it
#   P5 IC-1 on the REAL manifest (fresh DB, full replay): a User without a membership makes
#      the backfill post-condition abort at --until <backfill>; the cardinality file is never
#      reached (User.tenant_id still nullable); removing the orphan lets the same bounded run
#      complete, and the restrict files are still deferred.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${ARAMO_PG_IMAGE:-pgvector/pgvector:pg17}"
PORT="${ARAMO_PG_PORT:-55432}"
CNAME="aramo-dbsync-pg-$$"

PSQL="$(command -v psql || true)"
[ -z "$PSQL" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
[ -n "$PSQL" ] || { echo "pg-integration: psql not found (install libpq / postgresql-client)"; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "pg-integration: docker not found"; exit 2; }

TMP="$(mktemp -d)"
cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { echo "  ok    $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

echo "pg-integration: starting ${IMAGE} on 127.0.0.1:${PORT} (${CNAME})"
docker run -d --rm --name "$CNAME" -e POSTGRES_PASSWORD=pg -e POSTGRES_USER=pg -e POSTGRES_DB=postgres \
  -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
ADMIN="postgresql://pg:pg@127.0.0.1:${PORT}/postgres"
for i in $(seq 1 60); do "$PSQL" "$ADMIN" -tAc "select 1" >/dev/null 2>&1 && break; sleep 1; done
"$PSQL" "$ADMIN" -tAc "select 1" >/dev/null 2>&1 || { echo "pg-integration: postgres did not come up"; exit 2; }

mkdb()   { "$PSQL" "$ADMIN" -qc "CREATE DATABASE $1;" >/dev/null; printf 'postgresql://pg:pg@127.0.0.1:%s/%s' "$PORT" "$1"; }
ledger() { "$PSQL" "$1" -tAc "SELECT name FROM public._local_migrations ORDER BY name;" 2>/dev/null | awk -F/ '{print $(NF-1)}' | tr '\n' ' ' | sed 's/ $//'; }
lcount() { "$PSQL" "$1" -tAc "SELECT count(*) FROM public._local_migrations;" 2>/dev/null; }
absent() { [ "$("$PSQL" "$1" -tAc "SELECT to_regclass('$2') IS NULL;")" = "t" ]; }

# A synthetic manifest under a throwaway ROOT: the runner derives ROOT from its own
# path, so a COPY of it under $root/tools discovers $root/libs/*/prisma/migrations.
stage() { # $1 = root dir, $2 = "c-fails" makes migration c a failing file
  mkdir -p "$1/tools"; cp "$ROOT/tools/db-sync-local.sh" "$1/tools/"; cp -R "$ROOT/tools/sign-naming" "$1/tools/"
  local m
  for m in 20260101000000_a 20260102000000_b 20260103000000_c 20260104000000_d 20260105000000_e; do
    mkdir -p "$1/libs/t/prisma/migrations/$m"
    echo "CREATE TABLE public.t_${m##*_}(id int);" > "$1/libs/t/prisma/migrations/$m/migration.sql"
  done
  if [ "${2:-}" = "c-fails" ]; then
    echo "SELECT 1/0;" > "$1/libs/t/prisma/migrations/20260103000000_c/migration.sql"
  fi
  return 0
}
run() { # $1 = root, $2 = db url, rest = runner args; echoes output, returns the runner's rc
  local root="$1" url="$2"; shift 2
  (cd "$root" && DATABASE_URL="$url" bash tools/db-sync-local.sh "$@" 2>&1)
}

# --- P1 ---------------------------------------------------------------------
R1="$TMP/r1"; stage "$R1"; U1="$(mkdb p1)"
out="$(run "$R1" "$U1" --until 20260103000000_c)"; rc=$?
st="$(run "$R1" "$U1" --status --until 20260103000000_c)"
if [ "$rc" = 0 ] \
   && [ "$(ledger "$U1")" = "20260101000000_a 20260102000000_b 20260103000000_c" ] \
   && printf '%s' "$out" | grep -q "3 applied, 0 already present" \
   && printf '%s' "$out" | grep -q "deferred — 2 on-disk" \
   && printf '%s' "$out" | grep -q "verified — no migration beyond the stop point" \
   && printf '%s' "$st"  | grep -q "pending-before-stop — 0 on-disk" \
   && printf '%s' "$st"  | grep -q "deferred — 2 on-disk" \
   && printf '%s' "$st"  | grep -q "pending — 2 on-disk" \
   && absent "$U1" public.t_d && absent "$U1" public.t_e; then
  ok "P1 --until c: applied a,b,c exactly; ledger = a b c; status before-stop 0 / deferred 2; d,e absent"
else
  bad "P1 bounded apply (rc ${rc}; ledger '$(ledger "$U1")')"; printf '%s\n%s\n' "$out" "$st" | sed 's/^/        /'
fi

# --- P2 ---------------------------------------------------------------------
out="$(run "$R1" "$U1" --until 20260103000000_c)"; rc=$?
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "0 applied, 3 already present" \
   && [ "$(ledger "$U1")" = "20260101000000_a 20260102000000_b 20260103000000_c" ]; then
  ok "P2 re-run of the same --until: 0 applied, 3 already present, exit 0, ledger unchanged"
else
  bad "P2 idempotent re-run (rc ${rc})"; printf '%s\n' "$out" | sed 's/^/        /'
fi

# --- P3 ---------------------------------------------------------------------
out="$(run "$R1" "$U1")"; rc=$?
st="$(run "$R1" "$U1" --status)"
if [ "$rc" = 0 ] && printf '%s' "$out" | grep -q "2 applied, 3 already present" \
   && printf '%s' "$st" | grep -q "pending — 0 on-disk" \
   && [ "$(lcount "$U1")" = 5 ] && ! absent "$U1" public.t_e; then
  ok "P3 plain apply afterwards: only the deferred d,e applied; ledger 5; pending 0"
else
  bad "P3 deferred remainder (rc ${rc})"; printf '%s\n%s\n' "$out" "$st" | sed 's/^/        /'
fi

# --- P4 ---------------------------------------------------------------------
R2="$TMP/r2"; stage "$R2" c-fails; U4="$(mkdb p4)"
out="$(run "$R2" "$U4" --until 20260104000000_d)"; rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q "FAILED   20260103000000_c" \
   && [ "$(ledger "$U4")" = "20260101000000_a 20260102000000_b" ] \
   && absent "$U4" public.t_c && absent "$U4" public.t_d; then
  ok "P4 failing file inside the window: exit 1 at c; ledger = a b only; c,d not applied"
else
  bad "P4 abort inside window (rc ${rc}; ledger '$(ledger "$U4")')"; printf '%s\n' "$out" | sed 's/^/        /'
fi

# --- P5 (real manifest) -----------------------------------------------------
EXPAND=20261015000000_ic1_user_tenant_owner_expand
BACKFILL=20261015000001_ic1_user_tenant_owner_backfill
U5="$(mkdb p5)"
nullable() { "$PSQL" "$1" -tAc "SELECT is_nullable FROM information_schema.columns WHERE table_schema='identity' AND table_name='User' AND column_name='tenant_id';"; }
echo "  (P5: full replay of the real manifest up to ${EXPAND} — this takes a while)"
out="$(run "$ROOT" "$U5" --until "$EXPAND")"; rc=$?
pos="$(printf '%s' "$out" | sed -nE 's/^db:sync:local stop — .* at manifest position ([0-9]+)\/[0-9]+$/\1/p')"
# Manifest length, so the deferred tail after the backfill stop is DERIVED (every
# migration after the stop must stay unapplied) instead of a fixed count that any
# later migration would break.
total="$(printf '%s' "$out" | sed -nE 's/^db:sync:local stop — .* at manifest position [0-9]+\/([0-9]+)$/\1/p')"
if [ "$rc" = 0 ] && [ -n "$pos" ] && [ "$(lcount "$U5")" = "$pos" ] && [ "$(nullable "$U5")" = "YES" ]; then
  ok "P5a real manifest --until expand: exit 0; ledger rows = manifest position ${pos}; User.tenant_id present and nullable"
else
  bad "P5a real replay to expand (rc ${rc}; ledger $(lcount "$U5"); pos '${pos}'; nullable '$(nullable "$U5")')"
  printf '%s\n' "$out" | tail -15 | sed 's/^/        /'
fi
"$PSQL" "$U5" -qc "INSERT INTO identity.\"User\"(id,email,display_name,is_active,created_at,updated_at) VALUES (gen_random_uuid(),'orphan-no-membership@example.test','Orphan',true,now(),now());"
out="$(run "$ROOT" "$U5" --until "$BACKFILL")"; rc=$?
if [ "$rc" = 1 ] && printf '%s' "$out" | grep -q "ic1 backfill incomplete: 1 User rows without tenant_id" \
   && [ "$(lcount "$U5")" = "$pos" ] && [ "$(nullable "$U5")" = "YES" ]; then
  ok "P5b orphan User present, --until backfill: backfill post-condition aborts (exit 1); ledger unchanged; cardinality never reached (still nullable)"
else
  bad "P5b backfill abort (rc ${rc}; ledger $(lcount "$U5"); nullable '$(nullable "$U5")')"; printf '%s\n' "$out" | tail -8 | sed 's/^/        /'
fi
"$PSQL" "$U5" -qc "DELETE FROM identity.\"User\" WHERE email='orphan-no-membership@example.test';"
out="$(run "$ROOT" "$U5" --until "$BACKFILL")"; rc=$?
st="$(run "$ROOT" "$U5" --status)"
if [ "$rc" = 0 ] && [ "$(lcount "$U5")" = $((pos + 1)) ] && [ "$(nullable "$U5")" = "YES" ] \
   && printf '%s' "$out" | grep -q "deferred — $((total - pos - 1)) on-disk" \
   && printf '%s' "$st" | grep -q "pending — $((total - pos - 1)) on-disk"; then
  ok "P5c orphan removed, same --until backfill completes: ledger +1; every later file deferred ($((total - pos - 1)) pending, incl. the restrict files); still nullable"
else
  bad "P5c resume after fix (rc ${rc}; ledger $(lcount "$U5"); nullable '$(nullable "$U5")')"; printf '%s\n%s\n' "$out" "$st" | tail -8 | sed 's/^/        /'
fi

echo "db-sync-local.pg-integration — ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
