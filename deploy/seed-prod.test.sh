#!/usr/bin/env bash
# Unit-check the post-seed ASSERTION gate parse (no docker, no DB). Sources
# seed-prod.sh — whose main() is guarded behind BASH_SOURCE==$0, so sourcing
# reaches assert_passes() without running anything — and exercises assert_passes()
# on sample count strings (what `psql -t -A -c 'SELECT count(*)…'` would print):
# exactly 1 must PASS (proceed), anything else (0 = seed never landed, empty =
# psql error/no output, non-numeric = error text, >1 = unexpected dupes) must
# FAIL (abort). Whitespace around the count (psql -t can pad) must be tolerated.
#
# Run:  bash deploy/seed-prod.test.sh   (exit 0 = all cases correct)

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/seed-prod.sh disable=SC1091
source "$DIR/seed-prod.sh"

pass=0
fail=0

# check <desc> <expected: 0=pass-gate|1=fail-gate> <count-string>
check() {
  local desc="$1" expected="$2" count="$3" got
  if assert_passes "$count"; then got=0; else got=1; fi
  if [ "$got" = "$expected" ]; then
    echo "  ok    ${desc}"
    pass=$((pass + 1))
  else
    echo "  FAIL  ${desc} (expected gate=${expected}, got ${got})"
    fail=$((fail + 1))
  fi
}

# --- the deploy-safe case: Astre tenant present → gate PASSES (0) ----------
check "count=1 (seeded + domain backfilled) → proceed" 0 "1"
check "count='1 ' trailing whitespace (psql -t padding) → proceed" 0 "1 "
check "count=' 1' leading whitespace → proceed" 0 " 1"
check "count='1' with newline → proceed" 0 "1
"

# --- the failure cases: seed not confirmed → gate FAILS (1), deploy aborts -
check "count=0 (seed never landed / wrong DB) → abort" 1 "0"
check "count=2 (unexpected duplicate tenant rows) → abort" 1 "2"
check "empty output (psql error / no row) → abort" 1 ""
check "whitespace-only output → abort" 1 "   "
check "connection error, no number → abort" 1 \
  "psql: error: connection to server failed"
check "non-numeric noise → abort" 1 "FATAL"
# Substring trap (the migrate-gate 10/100 lesson, applied here): "11" must NOT
# pass just because it contains a '1' — numeric -eq rejects it.
check "count=11 (substring trap) → abort" 1 "11"

echo ""
echo "assertion parse: ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
