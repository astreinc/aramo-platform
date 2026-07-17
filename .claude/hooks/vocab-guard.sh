#!/usr/bin/env bash
#
# .claude/hooks/vocab-guard.sh — PostToolUse hook (DX-1 §6.3 as amended §A2).
#
# Matcher (registered in settings.json): Edit|Write|MultiEdit|NotebookEdit.
# On each such tool call, scans the just-touched file for banned Tier-2 trust
# vocabulary using the runtime-extracted term list (vocab-lib.sh, R-DX1-10).
#
# PostToolUse cannot block or revert — the tool already ran (A.4 grounding, §A1
# #3). Exit 2 SURFACES the violation to the session via stderr so the file gets
# corrected; the edit itself stays on disk. That fire -> message -> correction
# sequence is the passing evidence (§A4).
#
# Fail-closed: if extraction fails, exit 2 (never a silent pass).

set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=vocab-lib.sh
. "$DIR/vocab-lib.sh"

HOOK_INPUT="$(cat)"

vocab_init || { echo "vocab-guard: vocabulary pattern extraction failed — see scripts/verify-vocabulary.sh" >&2; exit 2; }

file="$(hook_json_field '.tool_input.file_path')"

# Skip: no file path on this tool (e.g. Bash), or the file is gone (deleted).
[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0

# Skip: non-text / binary / empty.
vocab_is_text "$file" || exit 0

# Relative path (for exemption matching against the extracted arrays).
rel="$file"
case "$file" in
  "${CLAUDE_PROJECT_DIR:-}"/*) rel="${file#"${CLAUDE_PROJECT_DIR}"/}" ;;
esac

# Skip: file sits on an extracted exemption (scratch / design-reference / the
# 126 Tier-2 carve-outs / common globs).
vocab_path_excluded "$rel" && exit 0

term="$(vocab_scan_file "$file" "$rel")"
if [ $? -eq 1 ]; then
  echo "banned trust-vocabulary token '$term' in $rel — see scripts/verify-vocabulary.sh Tier-2" >&2
  exit 2
fi

exit 0
