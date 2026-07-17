#!/usr/bin/env bash
#
# .claude/hooks/vocab-lib.sh
#
# Runtime trust-vocabulary extraction engine (DX-1 R-DX1-10). Sourced by both
# vocab-guard.sh (PostToolUse) and stop-gate.sh (Stop) — one engine, two hooks,
# no duplicated extraction logic (§A2 one-shared-helper law).
#
# Why this file exists: the checked-in harness is itself scanned by the repo-wide
# gate (scripts/verify-vocabulary.sh). To keep parity with that gate WITHOUT
# writing any banned Tier-2 term as a literal in a harness file, this library
# reads the term list, the exemption arrays, the common globs, and the public-host
# strip out of scripts/verify-vocabulary.sh at execution time, by array-boundary
# markers (never by line number, never by re-declaring the terms here).
#
# Parity target: the source scans with `rg -i` — so does this library
# (case-insensitive; ripgrep is a hard repo dependency of the source gate).
#
# Fail-closed contract: if the source script is missing/moved, or extraction
# yields zero terms, vocab_init returns non-zero. Callers MUST treat that as a
# blocking condition (exit 2) — a silent pass on an extraction shortfall is the
# same false-green the gate exists to prevent.
#
# Bash 3.2 compatible (macOS default): no mapfile/readarray, no associative
# arrays, no ${var,,} lowercasing.
#
# This file mutates nothing.

# Resolve the source gate script from the project root.
vocab__source_script() {
  local root="${CLAUDE_PROJECT_DIR:-}"
  if [ -z "$root" ]; then
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
  fi
  printf '%s/scripts/verify-vocabulary.sh' "$root"
}

# Populate module globals from the source script.
#   VOCAB_TERMS      indexed array of "term<TAB>regex" (regex normalised for rg)
#   VOCAB_EXCLUDES   indexed array of Tier-2 exemption paths/globs
#   VOCAB_GLOBS      indexed array of common exclusion patterns (the "!pat" tails)
#   VOCAB_HOST_STRIP regex of the public-host literal that is stripped pre-match
#   VOCAB_HOST_TERM  the single term the host-strip special-case applies to
# Returns 0 on success; 3 if source missing; 4 if zero terms extracted.
vocab_init() {
  local src raw body inner term regex line hostline
  src="$(vocab__source_script)"
  [ -f "$src" ] || return 3

  VOCAB_TERMS=()
  VOCAB_EXCLUDES=()
  VOCAB_GLOBS=()
  VOCAB_HOST_STRIP=""
  VOCAB_HOST_TERM=""

  # --- term list: TIER2_TERMS_REGEX ("term:regex" per line) --------------------
  while IFS= read -r raw; do
    inner="${raw#*\"}"       # drop indent + opening quote
    inner="${inner%\"*}"     # drop closing quote (+ any trailing)
    [ -z "$inner" ] && continue
    term="${inner%%:*}"
    regex="${inner#*:}"
    # The source authors the boundary anchor as an escaped backslash inside a
    # double-quoted bash string; bash collapses it to a single backslash before
    # handing it to rg. We read the file as raw text, so collapse it ourselves.
    regex="${regex//\\\\/\\}"
    VOCAB_TERMS[${#VOCAB_TERMS[@]}]="$term	$regex"
  done < <(sed -n '/^TIER2_TERMS_REGEX=(/,/^)/p' "$src" | grep -E '^  "')

  # --- Tier-2 exemption paths/globs: TIER2_EXCLUDES ---------------------------
  while IFS= read -r raw; do
    inner="${raw#*\"}"
    inner="${inner%%\"*}"    # first closing quote — trailing comments dropped
    [ -z "$inner" ] && continue
    VOCAB_EXCLUDES[${#VOCAB_EXCLUDES[@]}]="$inner"
  done < <(sed -n '/^TIER2_EXCLUDES=(/,/^)/p' "$src" | grep -E '^  "')

  # --- common exclusion globs: COMMON_GLOBS ("--glob '!pat'") -----------------
  while IFS= read -r raw; do
    line="${raw#*\'!}"       # drop up to and including the "'!"
    line="${line%\'*}"       # drop the trailing quote
    [ -z "$line" ] && continue
    VOCAB_GLOBS[${#VOCAB_GLOBS[@]}]="$line"
  done < <(sed -n '/^COMMON_GLOBS=(/,/^)/p' "$src" | grep -E "^  --glob")

  # --- public-host literal strip (the sed 's/<host>//g' special-case) ---------
  # The source strips a public-host literal from a line before re-checking one
  # term; the host literal itself embeds that term, so we extract both here.
  hostline="$(grep -E "sed 's/.*aramo.*//g'" "$src" | head -n1)"
  if [ -n "$hostline" ]; then
    VOCAB_HOST_STRIP="$(printf '%s' "$hostline" | sed -E "s/.*sed 's\/(.*)\/\/g'.*/\1/")"
    # The term is the leading run of letters before the first escaped dot.
    VOCAB_HOST_TERM="$(printf '%s' "$VOCAB_HOST_STRIP" | sed -E 's/^([A-Za-z]+)\\?\..*/\1/')"
  fi

  [ "${#VOCAB_TERMS[@]}" -gt 0 ] || return 4
  return 0
}

# vocab_path_excluded <relpath> — return 0 if the path sits on an extracted
# exemption (short-circuit permissive), 1 otherwise. Uses glob matching; in
# bash [[ == ]] an unquoted pattern's * spans '/', so "**/x/**" matches anywhere.
vocab_path_excluded() {
  local rel="$1" pat
  for pat in "${VOCAB_GLOBS[@]}" "${VOCAB_EXCLUDES[@]}"; do
    [ -z "$pat" ] && continue
    if [[ "$rel" == $pat ]];      then return 0; fi
    if [[ "$rel" == $pat/* ]];    then return 0; fi
    if [[ "$rel" == */$pat ]];    then return 0; fi
    if [[ "$rel" == */$pat/* ]];  then return 0; fi
  done
  return 1
}

# vocab_scan_file <file> <relpath> — scan one file for banned Tier-2 vocabulary.
# Echoes the first matched term and returns 1 on a violation; returns 0 (silent)
# when clean or when the path is on an extracted exemption. Honors the host-strip
# special-case for its one term (parity with the source gate).
vocab_scan_file() {
  local file="$1" rel="$2" entry term regex hit
  vocab_path_excluded "$rel" && return 0
  for entry in "${VOCAB_TERMS[@]}"; do
    term="${entry%%	*}"
    regex="${entry#*	}"
    if [ -n "$VOCAB_HOST_TERM" ] && [ "$term" = "$VOCAB_HOST_TERM" ] && [ -n "$VOCAB_HOST_STRIP" ]; then
      hit="$(sed "s/${VOCAB_HOST_STRIP}//g" "$file" 2>/dev/null | rg -i --no-heading --color=never "$regex" 2>/dev/null || true)"
    else
      hit="$(rg -i --no-heading --color=never "$regex" "$file" 2>/dev/null || true)"
    fi
    if [ -n "$hit" ]; then
      printf '%s' "$term"
      return 1
    fi
  done
  return 0
}

# vocab_is_text <file> — 0 if a regular, non-empty, non-binary text file.
vocab_is_text() {
  local f="$1"
  [ -f "$f" ] || return 1
  grep -Iq . "$f" 2>/dev/null
}

# hook_json_field <dotted.path> — read one scalar from the hook's stdin JSON
# (already captured into $HOOK_INPUT by the caller). Prefers jq, falls back to
# node (a hard dependency of this monorepo), then python3. Echoes empty on any
# absence or parse error.
hook_json_field() {
  local path="$1"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$HOOK_INPUT" | jq -r "$path // empty" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    printf '%s' "$HOOK_INPUT" | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { let o=JSON.parse(s);
          let v=o; for (const k of process.argv[1].split(".").filter(Boolean)) v=(v==null?undefined:v[k]);
          process.stdout.write(v==null?"":String(v));
        } catch(e){ process.stdout.write(""); }
      });' "${path#.}" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$HOOK_INPUT" | python3 -c '
import sys, json
try:
    o = json.load(sys.stdin)
    for k in sys.argv[1].strip(".").split("."):
        o = o.get(k) if isinstance(o, dict) else None
    sys.stdout.write("" if o is None else str(o))
except Exception:
    sys.stdout.write("")' "$path" 2>/dev/null
  fi
}
