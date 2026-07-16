#!/usr/bin/env bash
# CI-Velocity PR-2 — the integration runner for the CI lanes.
#
#   CI_AFFECTED=1 (PR lane): run only the integration roots whose Nx project is
#     affected vs NX_BASE..NX_HEAD (set by nrwl/nx-set-shas).
#   CI_AFFECTED unset/0 (merge_group / push / schedule): run ALL roots (full).
#
# Every run is SERIAL (--no-file-parallelism) — harness hardening (CI-Velocity
# PR-1): one Postgres container starts at a time, killing the saturation flake.
# The roots list is the authoritative CI integration set (16); keep it in sync
# with any new ARAMO_RUN_INTEGRATION root the same slice it is added.
set -euo pipefail

ROOTS=(
  libs/consent
  libs/examination
  libs/job-domain
  libs/matching
  libs/talent-evidence
  libs/evidence
  libs/submittal
  apps/api
  libs/engagement
  libs/ai-draft
  libs/identity-index
  libs/ingestion
  libs/talent-trust
  libs/canonicalization
  apps/platform-admin
  apps/auth-service
)

export ARAMO_RUN_INTEGRATION=1

TO_RUN=()
if [ "${CI_AFFECTED:-0}" = "1" ]; then
  AFFECTED=$(npx nx show projects --affected --base="${NX_BASE:?NX_BASE unset}" --head="${NX_HEAD:?NX_HEAD unset}" --json)
  for r in "${ROOTS[@]}"; do
    name=$(jq -r '.name' "$r/project.json")
    if echo "$AFFECTED" | jq -e --arg n "$name" 'index($n) != null' >/dev/null; then
      TO_RUN+=("$r")
    fi
  done
  echo "::notice::PR lane — affected integration roots: ${TO_RUN[*]:-(none)}"
else
  TO_RUN=("${ROOTS[@]}")
  echo "::notice::Full lane — all ${#ROOTS[@]} integration roots (serial)"
fi

if [ "${#TO_RUN[@]}" -eq 0 ]; then
  echo "No affected integration roots — nothing to run."
  exit 0
fi

for r in "${TO_RUN[@]}"; do
  echo "▶ integration: $r"
  npx vitest run --no-file-parallelism --root "$r"
done
