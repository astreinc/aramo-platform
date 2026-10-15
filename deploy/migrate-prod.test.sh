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

echo ""
echo "gate parse: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
