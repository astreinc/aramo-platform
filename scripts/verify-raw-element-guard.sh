#!/usr/bin/env bash
# G1 / R2 (Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED) — NEGATIVE test for
# the fail-closed raw-element guard. Proves that a newly-introduced raw interactive
# element in application code (apps/**) is REJECTED by ESLint. CI-runnable; exits
# non-zero if the guard fails to reject any element (i.e. the invariant regressed).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TMP="apps/ats-web/src/__raw_element_guard_probe__.tsx"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT

fail=0
for el in button input select textarea; do
  cat > "$TMP" <<EOF
export function Probe() {
  return <$el />;
}
EOF
  out="$(npx eslint "$TMP" 2>&1 || true)"
  if printf '%s' "$out" | grep -q "Raw <$el> is banned"; then
    echo "  OK    raw <$el> is rejected by the guard"
  else
    echo "  FAIL  raw <$el> was NOT rejected — the R2 invariant has regressed"
    fail=1
  fi
done

if [ "$fail" = 0 ]; then
  echo "raw-element guard negative test: PASS"
else
  echo "raw-element guard negative test: FAIL"
  exit 1
fi
