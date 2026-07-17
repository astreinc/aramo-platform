#!/usr/bin/env bash
#
# .claude/hooks/stop-gate.sh — Stop hook (DX-1 §6.4 as amended §A2).
#
# Pre-push tripwire, check-and-block only (never commits/pushes/installs). One
# changed-file union (committed delta vs origin/main merge-base + unstaged +
# staged + untracked) is computed ONCE and feeds both passes:
#   1. Vocabulary — banned Tier-2 tokens in changed text files (vocab-lib.sh).
#   2. Boundary  — the nx module-boundary wall over the SAME union, via --files.
#
# R-DX1-6: honor stop_hook_active FIRST — if this hook already fired for the
# current stop, exit permissive so it cannot loop.
#
# R-DX1-9 (v1.2): the boundary pass runs
#   npx nx affected --target=lint --files=<union> --skip-nx-cache
# so working-tree changes (tracked-modified and untracked) are seen pre-commit
# (v1.0's --head=HEAD was commit-to-commit only — proven vacuous at Gate 5).
# Rules: (b) empty union -> skipped-permissive; (c) union or nx invocation
# failure -> exit 2 fail-closed; (d) lint_status != 0 -> exit 2; --skip-nx-cache
# retained (cold-graph rationale stands; a wall that can false-green is no wall).
#
# Green -> exit permissive and emit the manual pre-push law as a reminder (this
# hook never runs the integration suite itself).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=vocab-lib.sh
. "$DIR/vocab-lib.sh"

HOOK_INPUT="$(cat)"

# --- R-DX1-6 loop guard (first) ---------------------------------------------
active="$(hook_json_field '.stop_hook_active')"
case "$active" in
  [Tt]rue) exit 0 ;;
esac

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$DIR/../.." && pwd)}"
cd "$ROOT" || { echo "stop-gate: cannot enter project root" >&2; exit 2; }

vocab_init || { echo "stop-gate: vocabulary pattern extraction failed — see scripts/verify-vocabulary.sh" >&2; exit 2; }

# --- changed files vs origin/main merge-base --------------------------------
base="$(git merge-base origin/main HEAD 2>/dev/null || true)"
if [ -z "$base" ]; then
  echo "stop-gate: cannot compute merge-base with origin/main (fail-closed)" >&2
  exit 2
fi

red=0
summary=""

# --- changed-file union: ONE computation, both passes consume it (R-DX1-9 v1.2)
# Committed delta vs merge-base + unstaged + staged + untracked. Deleted paths
# may remain — nx --files maps path->project only, it does not stat the file.
union_raw="$( { git diff --name-only "$base"...HEAD &&
                git diff --name-only &&
                git diff --name-only --cached &&
                git ls-files --others --exclude-standard; } | sort -u )"
if [ $? -ne 0 ]; then
  echo "stop-gate: changed-file union computation failed (fail-closed, R-DX1-9 v1.2 c)" >&2
  exit 2
fi

union=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  union[${#union[@]}]="$f"
done <<EOF
$union_raw
EOF

# --- pass 1: vocabulary over changed text files -----------------------------
vocab_findings=""
for f in "${union[@]}"; do
  [ -f "$f" ] || continue
  vocab_is_text "$f" || continue
  t="$(vocab_scan_file "$f" "$f")"
  if [ $? -eq 1 ]; then
    vocab_findings="${vocab_findings}  ${f}: '${t}'
"
  fi
done

if [ -n "$vocab_findings" ]; then
  red=1
  summary="${summary}Vocabulary (Tier-2) violations in changed files — see scripts/verify-vocabulary.sh:
${vocab_findings}"
fi

# --- pass 2: nx boundary wall over the changed-file union (R-DX1-9 v1.2) ------
boundary_skipped=0
if [ "${#union[@]}" -eq 0 ]; then
  # (b) empty union -> boundary pass skipped-permissive.
  boundary_skipped=1
else
  files_csv="$(printf '%s,' "${union[@]}")"; files_csv="${files_csv%,}"
  lint_out="$(npx nx affected --target=lint --files="$files_csv" --skip-nx-cache 2>&1)"
  lint_status=$?
  if [ "$lint_status" -ne 0 ]; then
    # (c) nx invocation failure and (d) lint findings both fail-closed at exit 2.
    red=1
    summary="${summary}Boundary/lint wall failed (nx affected lint over changed-file union; lint findings or tooling error — fail-closed per R-DX1-9 v1.2):
${lint_out}
"
  fi
fi

# --- verdict ----------------------------------------------------------------
if [ "$red" -eq 1 ]; then
  printf '%s\n' "$summary" >&2
  echo "stop-gate: blocking — resolve the above before stopping." >&2
  exit 2
fi

if [ "$boundary_skipped" -eq 1 ]; then
  echo "stop-gate: empty changed-file union — boundary pass skipped-permissive." >&2
fi
echo "Pre-push law: ARAMO_RUN_INTEGRATION=1 nx run api locally before push." >&2
exit 0
