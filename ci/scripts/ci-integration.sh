#!/usr/bin/env bash
# CI-Velocity PR-2 — the integration runner for the CI lanes.
#
#   CI_AFFECTED=1 (PR lane): run only the integration roots whose Nx project is
#     affected vs NX_BASE..NX_HEAD (set by nrwl/nx-set-shas).
#   CI_AFFECTED unset/0 (merge_group / push / schedule): run ALL roots (full).
#
# Every run is SERIAL (--no-file-parallelism) — harness hardening (CI-Velocity
# PR-1): one Postgres container starts at a time, killing the saturation flake.
#
# The roots are NOT listed here. This is a thin, jq-free wrapper over the single
# serial executor ci/scripts/run-integration.ts, which reads the sole canonical
# registry ci/integration-roots.json. The default-deny guard
# (ci/scripts/check-integration-roots.ts) proves the registry covers every
# integration-bearing project and that no runner embeds a divergent root list.
set -euo pipefail

exec node --import jiti/register ci/scripts/run-integration.ts
