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

echo ""
echo "gate parse: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
