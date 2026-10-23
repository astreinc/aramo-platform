#!/usr/bin/env bash
# Unit-check the PURE helpers of tools/db-sync-intelligence.sh and
# tools/ensure-intelligence-db.sh (no docker, no DB). Both scripts guard their
# side-effecting main() behind BASH_SOURCE==$0, so sourcing is inert.
# The real-PostgreSQL behaviour is proven by tools/db-sync-intelligence.pg-integration.sh.
#
# Run:  bash tools/db-sync-intelligence.test.sh   (exit 0 = all cases correct)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/db-sync-intelligence.sh disable=SC1091
source "$DIR/db-sync-intelligence.sh"
# shellcheck source=tools/ensure-intelligence-db.sh disable=SC1091
source "$DIR/ensure-intelligence-db.sh"

pass=0; fail=0
ok()  { echo "  ok    $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }

# T1 pending = on-disk minus recorded (orphans ignored).
[ "$(ti_compute_pending "$(printf 'a\nb\nc')" "$(printf 'a\nz')")" = "2" ] && ok "T1 pending counts only unrecorded on-disk names" || bad "T1 pending"
[ "$(ti_compute_pending "$(printf 'a\nb')" "$(printf 'a\nb')")" = "0" ] && ok "T2 fully recorded → 0 pending" || bad "T2 pending zero"
[ "$(ti_compute_pending "" "")" = "0" ] && ok "T3 empty manifest → 0 pending" || bad "T3 empty"

# T4 drift = recorded name whose checksum differs from disk; unrecorded and orphan rows never drift.
DISK="$(printf 'a\tsum-a\nb\tsum-b\nc\tsum-c')"
REC="$(printf 'a\tsum-a\nb\tCHANGED\nz\tsum-z')"
[ "$(ti_compute_drift "$DISK" "$REC")" = "b" ] && ok "T4 drift names exactly the changed recorded migration" || bad "T4 drift (got '$(ti_compute_drift "$DISK" "$REC")')"
[ -z "$(ti_compute_drift "$DISK" "$(printf 'a\tsum-a')")" ] && ok "T5 no drift when checksums match" || bad "T5 drift empty"

# T6 checksum is the sha256 of the file bytes.
TMPF="$(mktemp)"; printf 'CREATE SCHEMA x;\n' > "$TMPF"
[ "$(ti_checksum "$TMPF")" = "$(printf 'CREATE SCHEMA x;\n' | (sha256sum 2>/dev/null || shasum -a 256) | cut -d' ' -f1)" ] && ok "T6 checksum = sha256(file)" || bad "T6 checksum"
rm -f "$TMPF"

# T7 manifest order + only dirs with migration.sql, from the real tree.
got="$(cd "$DIR/.." && ti_mig_list | head -1)"
[ "$got" = "20261023120000_init_intelligence_schema" ] && ok "T7 the real manifest starts at the T0 migration" || bad "T7 manifest (got '$got')"

# T8 args.
ti_parse_args --status && [ "$TI_MODE" = "--status" ] && ok "T8 --status parsed" || bad "T8 --status"
ti_parse_args 2>/dev/null && [ "$TI_MODE" = "apply" ] && ok "T9 no args → apply" || bad "T9 apply"
if ti_parse_args --baseline 2>/dev/null; then bad "T10 unknown argument accepted"; else ok "T10 unknown argument refused"; fi

# T11 identifier + password validators (ensure-intelligence-db.sh).
ti_valid_identifier aramo_intelligence && ok "T11 valid identifier accepted" || bad "T11 identifier"
if ti_valid_identifier 'Aramo"x' || ti_valid_identifier '1abc' || ti_valid_identifier ''; then bad "T12 bad identifier accepted"; else ok "T12 bad identifiers refused"; fi
ti_valid_password 'abcDEF0123456789-_.~' && ok "T13 URL-safe password accepted" || bad "T13 password"
if ti_valid_password 'short' || ti_valid_password 'has@at-sign-0123456789' || ti_valid_password 'has space 0123456789'; then bad "T14 unsafe password accepted"; else ok "T14 short / URL-unsafe passwords refused"; fi

echo "db-sync-intelligence.test — ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
