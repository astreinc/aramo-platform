#!/usr/bin/env bash
# T2-F1-H2 — unit-check the governed build guard deploy/build-images.sh WITHOUT
# building anything: `docker` is stubbed, and the guard runs inside a throwaway
# temp git repo so HEAD / clean-tree logic is deterministic and isolated from the
# working tree it ships in.
#
# Proves: exit 2 (bad SHA), exit 3 (HEAD mismatch), exit 4 (dirty tree),
# exit 0 + all 4 image builds reached (authorized SHA + clean tree).
#
# Run:  bash deploy/build-images.test.sh   (exit 0 = all cases correct)

set -uo pipefail
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_SRC="$SRC_DIR/build-images.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Throwaway repo with the guard at <repo>/deploy/build-images.sh so its
# ROOT_DIR (../ from the script) resolves to <repo>.
mkdir -p "$TMP/repo/deploy" "$TMP/bin"
cp "$GUARD_SRC" "$TMP/repo/deploy/build-images.sh"
chmod +x "$TMP/repo/deploy/build-images.sh"
( cd "$TMP/repo"
  git init -q
  git config user.email t@t; git config user.name t
  echo seed > seed.txt
  git add -A && git commit -qm init )
HEAD="$(cd "$TMP/repo" && git rev-parse HEAD)"
NOTHEAD="0000000000000000000000000000000000000000"

# Stub docker: record each `build` invocation; everything exits 0.
cat >"$TMP/bin/docker" <<STUB
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in build) echo build >> "$TMP/builds" ;; esac; done
exit 0
STUB
chmod +x "$TMP/bin/docker"

pass=0; fail=0
run() { # desc  arg  expect_exit  expect_builds(-1=don't care)
  local desc="$1" arg="$2" ex="$3" eb="$4"
  : > "$TMP/builds"
  ( cd "$TMP/repo" && PATH="$TMP/bin:$PATH" bash deploy/build-images.sh "$arg" ) >/dev/null 2>&1
  local rc=$? builds; builds=$(wc -l < "$TMP/builds" | tr -d ' ')
  local ok=1
  [ "$rc" = "$ex" ] || ok=0
  [ "$eb" = "-1" ] || [ "$builds" = "$eb" ] || ok=0
  if [ "$ok" = 1 ]; then echo "  ok    $desc (rc=$rc builds=$builds)"; pass=$((pass+1));
  else echo "  FAIL  $desc (rc=$rc builds=$builds; want rc=$ex builds=$eb)"; fail=$((fail+1)); fi
}

echo "T2-F1-H2 build guard:"
run "CASE A non-hex SHA        → exit 2, no build"  "not-a-sha"  2  0
run "CASE B valid SHA != HEAD  → exit 3, no build"  "$NOTHEAD"   3  0
# CASE C dirty tree: introduce an uncommitted change, then run with correct HEAD.
( cd "$TMP/repo" && echo dirty > dirty.txt )
run "CASE C dirty tree         → exit 4, no build"  "$HEAD"      4  0
( cd "$TMP/repo" && rm -f dirty.txt )   # restore clean
run "CASE D HEAD + clean tree  → exit 0, 4 builds"  "$HEAD"      0  4

echo "build-images.test: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
