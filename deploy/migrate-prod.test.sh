#!/usr/bin/env bash
# Unit-check the migration GATE parse (no docker, no DB). Sources
# migrate-prod.sh — whose main() is guarded behind BASH_SOURCE==$0, so sourcing
# reaches gate_passes() without running anything — and exercises gate_passes()
# on sample db:sync:local --status strings: N==M must PASS (proceed), anything
# else (N<M partial apply, no fraction, error text, empty) must FAIL (abort).
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

# --- the deploy-safe case: zero pending → gate PASSES (0) -----------------
check "in-sync 56/56 → proceed" 0 \
  "db:sync:local status — 56/56 migrations recorded as applied"
check "fresh provision 0/0 → proceed" 0 \
  "db:sync:local status — 0/0 migrations recorded as applied"
check "extra noise around the fraction → proceed" 0 \
  "noise 12/12 migrations recorded as applied noise"

# --- the incident cases: pending remain → gate FAILS (1), deploy aborts ---
check "one pending (apply failed at last) 55/56 → abort" 1 \
  "db:sync:local status — 55/56 migrations recorded as applied"
check "many pending (apply never ran) 40/56 → abort" 1 \
  "db:sync:local status — 40/56 migrations recorded as applied"
# Hardening over the directive's illustrative backreference grep '([0-9]+)/\1':
# that regex FALSE-PASSES "10/100" (it matches the "10/10" prefix). Numeric
# -eq comparison (10 != 100) correctly ABORTS.
check "10/100 (substring trap) → abort" 1 \
  "db:sync:local status — 10/100 migrations recorded as applied"

# --- malformed / error output → gate FAILS (1), never a false-proceed -----
check "empty output → abort" 1 ""
check "connection error, no fraction → abort" 1 \
  "psql: error: connection to server failed"
check "single number, no fraction → abort" 1 \
  "db:sync:local status — 56 migrations"

echo ""
echo "gate parse: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
