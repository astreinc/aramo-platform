#!/usr/bin/env bash
# T2-F1-H4 — unit-check the production DB-credential preflight in
# deploy/systemd/singlebox-compose.sh. Proves that an absent / empty / known-weak
# POSTGRES_PASSWORD is REJECTED (non-zero exit) BEFORE `compose up` is reached,
# and that a strong password reaches compose up. NO real docker, NO DB, NO
# containers: `docker` is stubbed to a recorder that never starts anything.
#
# The password value is never echoed by the launcher (asserted below via the
# captured output). The passwords used here are throwaway TEST fixtures, not
# secrets.
#
# Run:  bash deploy/singlebox-compose.test.sh   (exit 0 = all cases correct)

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
LAUNCHER="$ROOT/deploy/systemd/singlebox-compose.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Stub `docker`: `docker compose version` → ok (so the launcher's compose()
# probe passes); any `up` records a marker file so the test can tell whether
# compose-up was actually reached. Nothing is ever started.
mkdir -p "$TMP/bin"
cat >"$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  case "$a" in
    version) exit 0 ;;
    up) : > "${COMPOSE_UP_MARKER}" ; exit 0 ;;
  esac
done
exit 0
STUB
chmod +x "$TMP/bin/docker"

DUMMY_STRONG_PW="S7rong-Prod-Pw-x9Q2"   # throwaway test fixture, not a secret

pass=0
fail=0

# run_case <desc> <pw|__UNSET__> <expect_reject:1|0>
run_case() {
  local desc="$1" pw="$2" expect_reject="$3"
  local envf="$TMP/.env"
  if [ "$pw" = "__UNSET__" ]; then
    : >"$envf"                                   # env file with no POSTGRES_PASSWORD
  else
    printf 'POSTGRES_PASSWORD=%s\n' "$pw" >"$envf"
  fi
  export COMPOSE_UP_MARKER="$TMP/up.marker"
  rm -f "$COMPOSE_UP_MARKER"
  local out rc reached=0 rejected=0
  out="$(PATH="$TMP/bin:$PATH" ARAMO_DIR="$TMP" ARAMO_ENV_FILE="$envf" \
        bash "$LAUNCHER" up 2>&1)"
  rc=$?
  [ -f "$COMPOSE_UP_MARKER" ] && reached=1
  # rejected == launcher exited non-zero AND compose-up was NOT reached
  if [ "$rc" -ne 0 ] && [ "$reached" -eq 0 ]; then rejected=1; fi
  # the launcher must NEVER print the password value
  if [ "$pw" != "__UNSET__" ] && [ -n "$pw" ] && printf '%s' "$out" | grep -qF "$pw"; then
    echo "  FAIL  ${desc}: launcher LEAKED the password value"
    fail=$((fail + 1)); return
  fi
  if [ "$rejected" = "$expect_reject" ]; then
    echo "  ok    ${desc} (rc=${rc} reached-compose-up=${reached})"
    pass=$((pass + 1))
  else
    echo "  FAIL  ${desc} (rc=${rc} reached=${reached}; expected reject=${expect_reject})"
    fail=$((fail + 1))
  fi
}

echo "T2-F1-H4 DB-credential preflight:"
run_case "CASE1 unset POSTGRES_PASSWORD          → rejected, compose up not reached" "__UNSET__"          1
run_case "CASE2 empty POSTGRES_PASSWORD          → rejected"                          ""                  1
run_case "CASE3 POSTGRES_PASSWORD=aramo          → rejected"                          "aramo"             1
run_case "CASE4 POSTGRES_PASSWORD=change_me_in_prod → rejected"                       "change_me_in_prod" 1
run_case "CASE5 strong POSTGRES_PASSWORD         → preflight passes, compose up reached" "$DUMMY_STRONG_PW" 0

echo "singlebox-compose.test: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
