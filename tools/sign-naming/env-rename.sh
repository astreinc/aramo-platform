#!/usr/bin/env bash
# Sign naming unification — secrets-preserving .env key rename.
# Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED §3.7 (N-7).
#
#   tools/sign-naming/env-rename.sh <env-file>            # dry run: lists the planned key renames
#   tools/sign-naming/env-rename.sh <env-file> --apply    # backup, rename, verify
#
# - Renames KEYS only, per tools/sign-naming/env-map.tsv; every value is carried
#   over byte for byte (the line's text after the first '=' is never touched).
# - Never prints a value. Verification compares the SHA-256 of each value before
#   and after; only key names, counts and digests are reported.
# - Writes a timestamped backup beside the file before changing it (mode preserved).
# - Refuses (exit 3, file unchanged) if a target key already exists, or if a source
#   key appears more than once (ambiguous).
# - Idempotent: when no source key is present it reports nothing to do.
set -euo pipefail
ENV_FILE="${1:?usage: env-rename.sh <env-file> [--apply]}"
MODE="${2:-dry-run}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAP="$HERE/env-map.tsv"
[ -f "$ENV_FILE" ] || { echo "env-rename: $ENV_FILE not found" >&2; exit 2; }

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }
value_digest() { # $1 file, $2 key → digest of the value (first occurrence), or empty
  awk -v k="$2" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }' "$1" | sha
}
count_key() { grep -c "^$2=" "$1" || true; }

planned=0
while IFS=$'\t' read -r old new; do
  [ -n "$old" ] && [ "${old#\#}" = "$old" ] || continue
  n_old="$(count_key "$ENV_FILE" "$old")"; n_new="$(count_key "$ENV_FILE" "$new")"
  [ "$n_old" = "0" ] && continue
  if [ "$n_old" != "1" ]; then echo "env-rename: REFUSED — $old appears $n_old times (ambiguous). Nothing changed." >&2; exit 3; fi
  if [ "$n_new" != "0" ]; then echo "env-rename: REFUSED — target $new already exists. Nothing changed." >&2; exit 3; fi
  echo "  $old -> $new"
  planned=$((planned + 1))
done < "$MAP"

if [ "$planned" = "0" ]; then echo "env-rename: nothing to do (no legacy keys present)"; exit 0; fi
if [ "$MODE" != "--apply" ]; then echo "env-rename: dry run — ${planned} key(s) would be renamed (re-run with --apply)"; exit 0; fi

BK="${ENV_FILE}.pre-sign-naming-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV_FILE" "$BK"
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
chmod --reference="$ENV_FILE" "$TMP" 2>/dev/null || chmod "$(stat -f '%Lp' "$ENV_FILE")" "$TMP"
awk -F'\t' 'NR == FNR { if ($1 !~ /^#/ && $1 != "") map[$1] = $2; next }
  { eq = index($0, "=")
    if (eq > 1) { k = substr($0, 1, eq - 1); if (k in map) { print map[k] substr($0, eq); next } }
    print }' "$MAP" "$ENV_FILE" > "$TMP"

ok=0
while IFS=$'\t' read -r old new; do
  [ -n "$old" ] && [ "${old#\#}" = "$old" ] || continue
  [ "$(count_key "$BK" "$old")" = "1" ] || continue
  if [ "$(value_digest "$BK" "$old")" = "$(value_digest "$TMP" "$new")" ] && [ "$(count_key "$TMP" "$old")" = "0" ]; then
    ok=$((ok + 1))
  else
    rm -f "$TMP"; echo "env-rename: VERIFY FAILED for $old -> $new. Nothing changed (backup: $BK)." >&2; exit 3
  fi
done < "$MAP"
[ "$(wc -l < "$BK")" = "$(wc -l < "$TMP")" ] || { rm -f "$TMP"; echo "env-rename: line count changed. Nothing changed." >&2; exit 3; }
mv "$TMP" "$ENV_FILE"
echo "env-rename: renamed ${ok} key(s); every value verified by digest; backup $BK"
