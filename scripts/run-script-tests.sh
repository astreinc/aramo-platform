#!/usr/bin/env bash
# scripts:test — run every deploy/tools shell-script unit test (pure: no docker,
# no DB). These *.test.sh files source their target script (whose side-effecting
# body is guarded behind BASH_SOURCE==$0) and unit-check its PURE functions:
# migrate-prod gate parse, db-sync-local pending-count, image/compose/seed guards.
#
# WHY THIS RUNNER EXISTS: the deploy/*.test.sh suites predated any CI wiring — they
# existed but nothing invoked them, so they gated NOTHING (a regression in the
# deploy tooling could ship unnoticed; that is exactly how the db-sync-local
# pending-count SIGPIPE defect reached production). This runner is the CI wall that
# executes them. It is a named step of the `static-governance` job and is pinned in
# ci/scripts/verify-aggregate-gate.ts so it cannot silently stop gating.
#
# Auto-enrolling: every deploy/*.test.sh and tools/*.test.sh is discovered and run
# (no hand-maintained list to forget). Fail-closed: zero suites found, or any suite
# failing, fails the wall.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Portable collection (bash 3.2+ — macOS default has no `mapfile`).
suites=()
while IFS= read -r t; do
  [ -n "$t" ] && suites+=("$t")
done < <(ls deploy/*.test.sh tools/*.test.sh 2>/dev/null | sort)
if [ "${#suites[@]}" -eq 0 ]; then
  echo "scripts:test — FAIL: no *.test.sh suites found (expected deploy/tools shell tests)"
  exit 1
fi

fail=0
for t in "${suites[@]}"; do
  echo "── ${t}"
  if bash "$t"; then
    :
  else
    echo "  ✗ ${t} FAILED"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "scripts:test — all ${#suites[@]} suite(s) passed"
else
  echo "scripts:test — one or more suites FAILED"
fi
exit "$fail"
