#!/usr/bin/env bash
#
# scripts/audit-check.sh
#
# M4 PR-10 — allow-list-aware wrapper around `npm audit`.
#
# Runs `npm audit --audit-level=high --omit=dev --json` against the
# production-only dependency tree (devDependencies excluded; workspace
# substrate is server + library code where dev deps are not shipped to
# runtime per ADR-0014 Decision 4). Parses the JSON output for HIGH /
# CRITICAL advisory IDs (GHSA-* identifiers extracted from advisory URLs)
# and compares against the allow-list at .github/npm-audit-allowlist.json.
#
# Exit semantics (per ADR-0014 Decision 6):
#   0 — every HIGH / CRITICAL advisory present is listed in
#       ALLOWLIST.advisories[].id (or zero HIGH / CRITICAL findings).
#   1 — at least one HIGH / CRITICAL advisory is NOT on the allow-list.
#   2 — environmental error (missing jq, missing allow-list file, npm
#       audit produced no JSON output, allow-list JSON malformed).
#
# MODERATE / LOW findings are informational and do not affect exit code.
#
# Runs in CI on every build (.github/workflows/ci.yml `npm:audit`).

set -euo pipefail

cd "$(dirname "$0")/.."

ALLOWLIST=".github/npm-audit-allowlist.json"

if [[ ! -f "$ALLOWLIST" ]]; then
  echo "ERROR: allow-list file $ALLOWLIST not found" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required for audit-check.sh" >&2
  exit 2
fi

# Validate allow-list JSON shape up-front so a malformed file fails fast.
if ! jq -e '.advisories | type == "array"' "$ALLOWLIST" >/dev/null 2>&1; then
  echo "ERROR: allow-list $ALLOWLIST malformed: .advisories must be an array" >&2
  exit 2
fi

# npm audit exits non-zero whenever findings exist at or above the audit
# level; that is expected, so capture output and rely on the JSON content
# for status determination rather than the exit code.
AUDIT_JSON="$(npm audit --audit-level=high --omit=dev --json 2>/dev/null || true)"

if [[ -z "$AUDIT_JSON" ]]; then
  echo "ERROR: npm audit produced no JSON output" >&2
  exit 2
fi

# Extract unique HIGH / CRITICAL advisory IDs (GHSA-* form, parsed from
# advisory URLs). Each `via` array entry may be a string (referencing
# another package) or an object (the actual advisory record); we keep
# only the object form and filter by severity.
FOUND_IDS="$(printf '%s' "$AUDIT_JSON" | jq -r '
  (.vulnerabilities // {})
  | to_entries
  | map(.value.via)
  | flatten
  | map(select(type == "object" and (.severity == "high" or .severity == "critical")))
  | map(.url | capture("(?<ghsa>GHSA-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+)").ghsa)
  | unique
  | .[]
' 2>/dev/null || true)"

ALLOWED_IDS="$(jq -r '.advisories[].id' "$ALLOWLIST")"

UNALLOWED=()
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  if ! printf '%s\n' "$ALLOWED_IDS" | grep -qx "$id"; then
    UNALLOWED+=("$id")
  fi
done <<< "$FOUND_IDS"

if [[ "${#UNALLOWED[@]}" -gt 0 ]]; then
  echo "ERROR: HIGH/CRITICAL advisory IDs found that are NOT on the allow-list:" >&2
  for id in "${UNALLOWED[@]}"; do
    echo "  - $id" >&2
  done
  echo "" >&2
  echo "Either upgrade the affected production dependency, or add the advisory" >&2
  echo "to $ALLOWLIST with id, package, severity, reason, expected_resolution" >&2
  echo "per ADR-0014 Decision 6. Allow-list entries are time-bounded to" >&2
  echo "M4-close hardening per ADR-0014 Decision 7." >&2
  exit 1
fi

if [[ -z "$FOUND_IDS" ]]; then
  echo "OK: no HIGH/CRITICAL advisories present in production deps."
else
  echo "OK: all HIGH/CRITICAL advisories present in production deps are allow-listed."
  echo "$FOUND_IDS" | sed 's/^/  - /'
fi

exit 0
