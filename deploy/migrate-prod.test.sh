#!/usr/bin/env bash
# Unit-check the migration GATE parse (no docker, no DB). Sources
# migrate-prod.sh — whose main() is guarded behind BASH_SOURCE==$0, so sourcing
# reaches gate_passes() without running anything — and exercises gate_passes()
# on sample db:sync:local --status strings. The gate is PENDING-SET based: it
# reads the 'pending — K on-disk migration(s) not yet applied' line and PASSES
# iff K == 0. Orphan ledger rows (recorded > on-disk) must NOT false-fail; only
# a genuinely unapplied on-disk migration (K>0), or a missing/garbage pending
# line, must FAIL (abort, fail-closed).
#
# A BOUNDED run (gate_passes "$status" 1, the --until path) reads ONLY the
# 'pending-before-stop — K' line: K must be 0, the total 'pending' line is the
# deferred remainder and is ignored, and a bounded run with no before-stop line
# fails closed. The legacy verdict (no second argument) never reads the
# before-stop line, so a plain run is unaffected by the new output.
#
# Run:  bash deploy/migrate-prod.test.sh   (exit 0 = all cases correct)

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/migrate-prod.sh disable=SC1091
source "$DIR/migrate-prod.sh"

pass=0
fail=0

# check <desc> <expected: 0=pass-gate|1=fail-gate> <status-string>
check() {
  local desc="$1" expected="$2" status="$3" got
  if gate_passes "$status"; then got=0; else got=1; fi
  if [ "$got" = "$expected" ]; then
    echo "  ok    ${desc}"
    pass=$((pass + 1))
  else
    echo "  FAIL  ${desc} (expected gate=${expected}, got ${got})"
    fail=$((fail + 1))
  fi
}

# checkb <desc> <expected: 0=pass-gate|1=fail-gate> <status-string> — the BOUNDED gate
checkb() {
  local desc="$1" expected="$2" status="$3" got
  if gate_passes "$status" 1; then got=0; else got=1; fi
  if [ "$got" = "$expected" ]; then
    echo "  ok    ${desc}"
    pass=$((pass + 1))
  else
    echo "  FAIL  ${desc} (expected bounded gate=${expected}, got ${got})"
    fail=$((fail + 1))
  fi
}

# --- deploy-safe: zero pending → gate PASSES (0) --------------------------
check "in-sync, zero pending → proceed" 0 \
  $'db:sync:local status — 56/56 migrations recorded as applied\ndb:sync:local pending — 0 on-disk migration(s) not yet applied'
check "fresh provision, zero pending → proceed" 0 \
  $'db:sync:local status — 0/0 migrations recorded as applied\ndb:sync:local pending — 0 on-disk migration(s) not yet applied'
# THE regression this fix closes: orphan ledger rows (recorded > on-disk, from a
# migration deleted-from-disk but still recorded) but ZERO pending must PROCEED.
# The old count gate (N==M) false-FATALed this exact case — 197 != 195 — even
# though nothing was actually unapplied.
check "orphan drift 197/195 but 0 pending → proceed" 0 \
  $'db:sync:local status — 197/195 migrations recorded as applied\ndb:sync:local pending — 0 on-disk migration(s) not yet applied'

# --- incident cases: pending remain → gate FAILS (1), deploy aborts -------
check "one pending (apply failed at last) → abort" 1 \
  $'db:sync:local status — 55/56 migrations recorded as applied\ndb:sync:local pending — 1 on-disk migration(s) not yet applied'
check "many pending (apply never ran) → abort" 1 \
  $'db:sync:local status — 40/56 migrations recorded as applied\ndb:sync:local pending — 16 on-disk migration(s) not yet applied'

# --- malformed / missing pending line → gate FAILS (1), never false-proceed
check "empty output → abort" 1 ""
check "connection error, no pending line → abort" 1 \
  "psql: error: connection to server failed"
# A stale db:sync:local that emits only the old N/M line (no pending line) must
# FAIL CLOSED — never infer "in sync" from the count alone.
check "old status line only, no pending line → abort" 1 \
  "db:sync:local status — 56/56 migrations recorded as applied"

# --- bounded run (--until): the before-stop line is the verdict -----------
BOUNDED_OK=$'db:sync:local status — 260/263 migrations recorded as applied\ndb:sync:local pending — 3 on-disk migration(s) not yet applied\ndb:sync:local stop — 20261015000001_ic1_user_tenant_owner_backfill at manifest position 260/263\ndb:sync:local pending-before-stop — 0 on-disk migration(s) not yet applied\ndb:sync:local deferred — 3 on-disk migration(s) after the stop point (not applied by a bounded run)'
BOUNDED_SHORT=$'db:sync:local status — 259/263 migrations recorded as applied\ndb:sync:local pending — 4 on-disk migration(s) not yet applied\ndb:sync:local stop — 20261015000001_ic1_user_tenant_owner_backfill at manifest position 260/263\ndb:sync:local pending-before-stop — 1 on-disk migration(s) not yet applied\ndb:sync:local deferred — 3 on-disk migration(s) after the stop point (not applied by a bounded run)'
PLAIN_ZERO=$'db:sync:local status — 263/263 migrations recorded as applied\ndb:sync:local pending — 0 on-disk migration(s) not yet applied'

# G1 the Release-A shape: before-stop 0, deferred 3 (total pending 3) → PROCEED.
checkb "G1 bounded: before-stop 0, deferred 3 (total pending 3) → proceed" 0 "$BOUNDED_OK"
# G2 a file inside the window did not land → before-stop 1 → ABORT.
checkb "G2 bounded: before-stop 1 → abort" 1 "$BOUNDED_SHORT"
# G3 a bounded run was requested but the runner printed no before-stop line → ABORT (fail closed).
checkb "G3 bounded run, runner output has no before-stop line → abort (fail closed)" 1 "$PLAIN_ZERO"
# G4 the legacy verdict is untouched by the new lines: total pending 3 → abort, even with before-stop 0.
check  "G4 legacy verdict on bounded output: total pending 3 → abort (before-stop line ignored)" 1 "$BOUNDED_OK"
# G5 the legacy verdict on a plain run is byte-for-byte as before.
check  "G5 legacy verdict, plain run, zero pending → proceed" 0 "$PLAIN_ZERO"

# ATI-SEP-1 T0 — Talent Intelligence gate (pending 0 AND drift 0; missing line fails closed).
checkti() {
  local desc="$1" expected="$2" status="$3" got
  if intelligence_gate_passes "$status"; then got=0; else got=1; fi
  if [ "$got" = "$expected" ]; then echo "  ok    ${desc}"; pass=$((pass + 1)); else echo "  FAIL  ${desc} (expected ${expected}, got ${got})"; fail=$((fail + 1)); fi
}
TI_OK="$(printf '%s\n' 'db:sync:intelligence status — 1/1 migrations recorded as applied' 'db:sync:intelligence pending — 0 on-disk migration(s) not yet applied' 'db:sync:intelligence drift — 0 recorded migration(s) whose checksum changed')"
checkti "TI1 pending 0 + drift 0 → proceed" 0 "$TI_OK"
checkti "TI2 pending 1 → abort" 1 "$(printf '%s' "$TI_OK" | sed 's/pending — 0/pending — 1/')"
checkti "TI3 drift 1 → abort" 1 "$(printf '%s' "$TI_OK" | sed 's/drift — 0/drift — 1/')"
checkti "TI4 no drift line → abort (fail closed)" 1 "$(printf '%s' "$TI_OK" | grep -v drift)"
checkti "TI5 shared-DB status lines are not a TI verdict → abort" 1 "db:sync:local pending — 0 on-disk migration(s) not yet applied"
ENV_FILE="$(mktemp)"; printf 'INTELLIGENCE_DB_USER=aramo_intelligence\n' > "$ENV_FILE"
if [ "$(build_intelligence_dburl)" = "postgresql://aramo_intelligence@postgres:5432/aramo_intelligence" ]; then
  echo "  ok    TI6 TI runner URL: postgres service host, aramo_intelligence db, no password in the URL"; pass=$((pass + 1))
else
  echo "  FAIL  TI6 TI runner URL ($(build_intelligence_dburl))"; fail=$((fail + 1))
fi
rm -f "$ENV_FILE"

# --- CCP-FIX1 (D5-DEF-1): a missing .env key under the script's own `set -euo pipefail` ---
# Each case runs in a fresh `bash -c` with the script's shell options, sources the script, and
# reports its exit code (`|| rc=$?`: sourcing migrate-prod.sh turns on its `set -e` here too).
# Before the fix, read_env of an absent key exited 1 under pipefail.
SCRIPT="$DIR/migrate-prod.sh"
TMPD="$(mktemp -d)"
okcase() { echo "  ok    $1"; pass=$((pass + 1)); }
badcase() { echo "  FAIL  $1"; fail=$((fail + 1)); }
strict() { # strict <env-file> <commands…> → stdout+stderr; exit code of the commands
  ARAMO_ENV_FILE="$1" bash -c "set -euo pipefail; source '$SCRIPT'; $2" 2>&1
}
printf 'POSTGRES_PASSWORD=pw\nINTELLIGENCE_DB_PASSWORD=ti-secret-0123456789\n# INTELLIGENCE_DB_USER=aramo_intelligence\n' > "$TMPD/no-user.env"
printf 'POSTGRES_PASSWORD=pw\nINTELLIGENCE_DB_USER=\nINTELLIGENCE_DB_PASSWORD=ti-secret-0123456789\n' > "$TMPD/empty-user.env"
printf 'POSTGRES_PASSWORD=pw\nINTELLIGENCE_DB_USER=aramo_intelligence\n' > "$TMPD/no-password.env"
printf 'POSTGRES_PASSWORD=pw\nINTELLIGENCE_DB_USER=Bad-Name\nINTELLIGENCE_DB_PASSWORD=ti-secret-0123456789\n' > "$TMPD/bad-user.env"

rc=0; out="$(strict "$TMPD/no-user.env" 'v="$(read_env INTELLIGENCE_DB_USER)"; echo "rc=0 v=[$v]"')" || rc=$?
[ "$rc" = 0 ] && [ "$out" = "rc=0 v=[]" ] && okcase "DEF1-1 read_env of an absent key under set -euo pipefail → empty, exit 0" || badcase "DEF1-1 read_env absent key (rc=$rc out=$out)"
rc=0; out="$(strict "$TMPD/no-user.env" 'v="$(read_env POSTGRES_USER)"; echo "[$(build_dburl)]"')" || rc=$?
[ "$rc" = 0 ] && [ "$out" = "[postgresql://aramo:pw@postgres:5432/aramo?schema=public]" ] && okcase "DEF1-2 absent POSTGRES_USER / POSTGRES_DB → the documented 'aramo' defaults (unchanged), exit 0" || badcase "DEF1-2 build_dburl (rc=$rc out=$out)"
rc=0; out="$(strict "$TMPD/no-user.env" 'resolve_intelligence_env; echo "user=$TI_USER url=$TI_DBURL"')" || rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q "INTELLIGENCE_DB_USER is not set in .* using the documented default 'aramo_intelligence'" \
  && printf '%s' "$out" | grep -q "^user=aramo_intelligence url=postgresql://aramo_intelligence@postgres:5432/aramo_intelligence$" \
  && okcase "DEF1-3 INTELLIGENCE_DB_USER absent (commented out, as .env.prod.example ships it) → explicit default, exit 0" || badcase "DEF1-3 (rc=$rc out=$out)"
rc=0; out="$(strict "$TMPD/empty-user.env" 'resolve_intelligence_env; echo "user=$TI_USER"')" || rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q "INTELLIGENCE_DB_USER is empty" && printf '%s' "$out" | grep -q "^user=aramo_intelligence$" && okcase "DEF1-4 INTELLIGENCE_DB_USER= (empty) → explicit default, exit 0" || badcase "DEF1-4 (rc=$rc out=$out)"
rc=0; out="$(strict "$TMPD/no-password.env" 'resolve_intelligence_env; echo reached')" || rc=$?
[ "$rc" = 2 ] && printf '%s' "$out" | grep -q "FATAL: INTELLIGENCE_DB_PASSWORD is not set" && printf '%s' "$out" | grep -q "Nothing was applied" && ! printf '%s' "$out" | grep -q reached && okcase "DEF1-5 INTELLIGENCE_DB_PASSWORD absent → FATAL exit 2" || badcase "DEF1-5 (rc=$rc out=$out)"
rc=0; out="$(strict "$TMPD/bad-user.env" 'resolve_intelligence_env; echo reached')" || rc=$?
[ "$rc" = 2 ] && printf '%s' "$out" | grep -q "is not a valid role name" && okcase "DEF1-6 an invalid INTELLIGENCE_DB_USER → FATAL exit 2" || badcase "DEF1-6 (rc=$rc out=$out)"

# main() end to end with a fake `docker` on PATH (no container, no DB): it logs each call and
# answers the status reads with an in-sync verdict. Proves the ordering: a missing TI password stops
# BEFORE any shared apply; a missing TI user runs both steps to completion with the default role.
mkdir -p "$TMPD/bin"
cat > "$TMPD/bin/docker" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *db-sync-local.sh*--status*) echo 'db:sync:local pending — 0 on-disk migration(s) not yet applied' ;;
  *db-sync-intelligence.sh*--status*) printf '%s\n' 'db:sync:intelligence pending — 0 on-disk migration(s) not yet applied' 'db:sync:intelligence drift — 0 recorded migration(s) whose checksum changed' ;;
esac
exit 0
FAKE
chmod +x "$TMPD/bin/docker"
runmain() { # runmain <env-file> <log-file>
  : > "$2"
  PATH="$TMPD/bin:$PATH" FAKE_DOCKER_LOG="$2" ARAMO_DIR="$TMPD" ARAMO_ENV_FILE="$1" bash "$SCRIPT" 2>&1
}
rc=0; out="$(runmain "$TMPD/no-password.env" "$TMPD/np.log")" || rc=$?
applies="$(grep -c 'db-sync-local.sh$' "$TMPD/np.log" || true)"; calls="$(wc -l < "$TMPD/np.log" | tr -d ' ')"
[ "$rc" = 2 ] && [ "$calls" = 0 ] && [ "$applies" = 0 ] && printf '%s' "$out" | grep -q "Nothing was applied" && okcase "DEF1-7 main(): missing TI password → exit 2 before ANY docker call (0 calls, 0 shared applies)" || badcase "DEF1-7 (rc=$rc calls=$calls applies=$applies out=$out)"
rc=0; out="$(runmain "$TMPD/no-user.env" "$TMPD/nu.log")" || rc=$?
[ "$rc" = 0 ] && printf '%s' "$out" | grep -q "OK — Talent Intelligence database: zero pending, zero drift." \
  && grep -q "INTELLIGENCE_DB_USER=aramo_intelligence" "$TMPD/nu.log" && grep -q "ensure-intelligence-db.sh" "$TMPD/nu.log" \
  && [ "$(grep -c 'db-sync-local.sh$' "$TMPD/nu.log")" = 1 ] && [ "$(grep -c 'db-sync-intelligence.sh$' "$TMPD/nu.log")" = 1 ] \
  && okcase "DEF1-8 main(): INTELLIGENCE_DB_USER absent → shared apply + gate, then the TI step runs to its gate with the default role (exit 0)" || badcase "DEF1-8 (rc=$rc out=$out)"
# CP-10 (LC-4): the per-domain grants are re-asserted exactly once, after the shared apply and gate
# and before the TI step, so a new table is granted before containers are recreated.
gate_line="$(grep -n 'db-sync-local.sh --status$' "$TMPD/nu.log" | tail -n1 | cut -d: -f1)"
roles_line="$(grep -n 'aramo-domain-roles.sql' "$TMPD/nu.log" | cut -d: -f1)"
ti_line="$(grep -n 'ensure-intelligence-db.sh' "$TMPD/nu.log" | head -n1 | cut -d: -f1)"
[ "$(grep -c 'aramo-domain-roles.sql' "$TMPD/nu.log")" = 1 ] && [ -n "$gate_line" ] && [ -n "$ti_line" ] \
  && [ "$roles_line" -gt "$gate_line" ] && [ "$roles_line" -lt "$ti_line" ] && grep 'aramo-domain-roles.sql' "$TMPD/nu.log" | grep -q 'ON_ERROR_STOP=1' \
  && printf '%s' "$out" | grep -q "per-domain role grants converged" \
  && okcase "LC4-1 main(): domain-role grants re-run once (ON_ERROR_STOP) after the shared gate, before the TI step" || badcase "LC4-1 (gate=$gate_line roles=$roles_line ti=$ti_line)"
rc=0; out="$(runmain "$TMPD/no-password.env" "$TMPD/np2.log")" || rc=$?
[ "$rc" = 2 ] && ! grep -q 'aramo-domain-roles.sql' "$TMPD/np2.log" \
  && okcase "LC4-2 main(): a refused precheck never reaches the grant step" || badcase "LC4-2 (rc=$rc)"
rm -rf "$TMPD"

echo ""
echo "gate parse: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
