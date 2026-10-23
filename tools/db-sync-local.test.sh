#!/usr/bin/env bash
# Unit-check the PENDING-count computation in db-sync-local.sh (no docker, no DB).
# Sources db-sync-local.sh — whose executable body is guarded behind
# BASH_SOURCE==$0, so sourcing reaches the pure mig_list()/compute_pending()
# without running psql or DDL — and exercises compute_pending() on sample
# (on-disk, recorded-ledger) inputs.
#
# THE regression this locks (race-free pending count): the prior implementation
# probed ledger membership per-item with `printf "$recorded" | grep -qxF -- "$d"`
# under `set -o pipefail`. When grep matched it exited immediately and closed the
# pipe; printf, still writing, took SIGPIPE (exit 141); pipefail then reported the
# whole pipeline as failed, so the `|| pending++` fired and a migration that WAS
# recorded got mis-counted as pending. Whether printf finished before grep closed
# the pipe was a scheduling race → non-deterministic false "pending" (and, just as
# dangerously, a false "0 pending"). compute_pending uses `comm`, which reads BOTH
# streams to EOF (no early close), so the count is deterministic.
#
# Also locks the --until (bounded apply) pure helpers: parse_args(),
# until_resolve() and compute_pending_split() — the stop point is resolved
# against the ORDERED manifest by exact directory name, a prefix or a duplicate
# never matches, --baseline + --until is refused, and the before/after split is
# by manifest position. The real-PostgreSQL behaviour (apply, ledger, abort) is
# proven by tools/db-sync-local.pg-integration.sh.
#
# Run:  bash tools/db-sync-local.test.sh   (exit 0 = all cases correct)

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tools/db-sync-local.sh disable=SC1091
source "$DIR/db-sync-local.sh"

pass=0
fail=0

# check <desc> <expected-count> <on-disk-list> <recorded-ledger-list>
check() {
  local desc="$1" expected="$2" on_disk="$3" recorded="$4" got
  got="$(compute_pending "$on_disk" "$recorded")"
  if [ "$got" = "$expected" ]; then
    echo "  ok    ${desc}"
    pass=$((pass + 1))
  else
    echo "  FAIL  ${desc} (expected ${expected}, got ${got})"
    fail=$((fail + 1))
  fi
}

A='libs/a/prisma/migrations/20260101000000_a/'
B='libs/b/prisma/migrations/20260102000000_b/'
C='libs/c/prisma/migrations/20260103000000_c/'
D='libs/d/prisma/migrations/20260104000000_d/'

# --- correctness of the pending set (on-disk NOT in ledger) ---------------
check "in-sync → 0 pending"                 0 "$A"$'\n'"$B"$'\n'"$C"        "$A"$'\n'"$B"$'\n'"$C"
check "one unapplied → 1 pending"           1 "$A"$'\n'"$B"$'\n'"$C"        "$A"$'\n'"$B"
check "none recorded → all pending"         3 "$A"$'\n'"$B"$'\n'"$C"        ""
check "orphan ledger row (recorded>disk)→0" 0 "$A"$'\n'"$B"                 "$A"$'\n'"$B"$'\n'"$C"
check "unordered inputs → correct set"      1 "$C"$'\n'"$A"$'\n'"$B"        "$A"$'\n'"$C"
check "blank lines ignored"                 0 "$A"$'\n'$'\n'"$B"            "$B"$'\n'"$A"$'\n'

# --- SIGPIPE regression (the defect this fix closes) ----------------------
# recorded ledger far exceeds one pipe buffer (>64KB) with the ONLY on-disk
# migration recorded FIRST → the old `printf|grep -qxF` idiom SIGPIPEd and
# mis-counted it as pending (=1). compute_pending must return 0, deterministically,
# every trial.
big_recorded="$(printf '%s\n' "$A"; seq 1 40000 | sed 's#^#libs/x/prisma/migrations/filler#; s#$#/#')"
for i in 1 2 3 4 5 6 7 8; do
  got="$(compute_pending "$A" "$big_recorded")"
  if [ "$got" = "0" ]; then
    echo "  ok    SIGPIPE regression trial ${i} → 0 pending"
    pass=$((pass + 1))
  else
    echo "  FAIL  SIGPIPE regression trial ${i} → got ${got} (expected 0)"
    fail=$((fail + 1))
  fi
done

# --- --until (bounded apply): the pure helpers ----------------------------
ok()  { echo "  ok    $1"; pass=$((pass + 1)); }
bad() { echo "  FAIL  $1"; fail=$((fail + 1)); }
LIST="$A"$'\n'"$B"$'\n'"$C"$'\n'"$D"

# U1 parse_args accepts --status --until <name> and lands both values.
if parse_args --status --until 20260102000000_b 2>/dev/null \
   && [ "$PARSED_MODE" = "--status" ] && [ "$PARSED_UNTIL" = "20260102000000_b" ] \
   && parse_args --until=20260102000000_b 2>/dev/null && [ "$PARSED_MODE" = "apply" ] && [ "$PARSED_UNTIL" = "20260102000000_b" ] \
   && parse_args 2>/dev/null && [ "$PARSED_MODE" = "apply" ] && [ "$PARSED_UNTIL" = "" ]; then
  ok "U1 parse_args: --status --until <name> / --until=<name> / no args → mode + stop point land"
else
  bad "U1 parse_args: --status --until <name> / --until=<name> / no args"
fi

# U2 parse_args refuses --baseline+--until, a missing --until value, an unknown flag (rc 2 each).
r1=0; parse_args --baseline --until 20260102000000_b >/dev/null 2>&1 || r1=$?
r2=0; parse_args --until >/dev/null 2>&1 || r2=$?
r3=0; parse_args --bogus >/dev/null 2>&1 || r3=$?
if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ]; then
  ok "U2 parse_args: --baseline+--until, missing --until value, unknown flag → each refused (rc 2)"
else
  bad "U2 parse_args refusals (got rc ${r1}/${r2}/${r3}, expected 2/2/2)"
fi

# U3 until_resolve: an exact, unique name resolves to its MANIFEST POSITION + dir.
got="$(until_resolve "$LIST" 20260103000000_c 2>/dev/null)"
if [ "$got" = "3"$'\t'"$C" ]; then
  ok "U3 until_resolve: exact unique name → position 3 + dir (ordered manifest)"
else
  bad "U3 until_resolve exact match (got '${got}')"
fi

# U4 until_resolve: no such name → rc 2, prints nothing.
r=0; got="$(until_resolve "$LIST" 20260199000000_zz 2>/dev/null)" || r=$?
if [ "$r" = 2 ] && [ -z "$got" ]; then
  ok "U4 until_resolve: unknown name → refused (rc 2), nothing printed"
else
  bad "U4 until_resolve unknown name (rc ${r}, out '${got}')"
fi

# U5 until_resolve: a PREFIX never matches; a name duplicated across libs is AMBIGUOUS.
r1=0; until_resolve "$LIST" 20260103000000 >/dev/null 2>&1 || r1=$?
r2=0; until_resolve "$LIST" c >/dev/null 2>&1 || r2=$?
DUP="$LIST"$'\n''libs/z/prisma/migrations/20260103000000_c/'
r3=0; until_resolve "$DUP" 20260103000000_c >/dev/null 2>&1 || r3=$?
if [ "$r1" = 2 ] && [ "$r2" = 2 ] && [ "$r3" = 2 ]; then
  ok "U5 until_resolve: timestamp prefix / bare suffix / duplicated name → each refused (rc 2)"
else
  bad "U5 until_resolve prefix+ambiguity (got rc ${r1}/${r2}/${r3}, expected 2/2/2)"
fi

# U6 compute_pending_split splits by MANIFEST POSITION: pending at-or-before vs after the stop.
if [ "$(compute_pending_split "$LIST" "" 2)" = "2 2" ] \
   && [ "$(compute_pending_split "$LIST" "$A" 2)" = "1 2" ] \
   && [ "$(compute_pending_split "$LIST" "$A"$'\n'"$B"$'\n'"$C" 2)" = "0 1" ] \
   && [ "$(compute_pending_split "$LIST" "$D" 4)" = "3 0" ] \
   && [ "$(compute_pending_split "$LIST" "$LIST" 2)" = "0 0" ]; then
  ok "U6 compute_pending_split: before/after counts follow manifest position, not the ledger"
else
  bad "U6 compute_pending_split (got '$(compute_pending_split "$LIST" "" 2)' '$(compute_pending_split "$LIST" "$A" 2)' '$(compute_pending_split "$LIST" "$A"$'\n'"$B"$'\n'"$C" 2)' '$(compute_pending_split "$LIST" "$D" 4)')"
fi

# U7 locale-independence: inputs are sorted under LC_ALL=C, so comm must compare
# under LC_ALL=C too. Under a non-C locale (the box's postgres:17 container), GNU
# comm otherwise warns "input is not in sorted order" and may mis-count. Mixed-case
# names order differently in C vs en_US collation. Expect the exact count, no stderr.
MIXED_DISK="$(printf '%s\n' x/20261015000001_b/ x/20261015000002_k/ x/2026_B/ x/2026_a/ x/2026_c/ | LC_ALL=C sort -u)"
MIXED_REC="$(printf '%s\n' x/2026_B/ x/2026_c/ | LC_ALL=C sort -u)"
err="$(LANG=en_US.UTF-8 LC_ALL= LC_COLLATE=en_US.UTF-8 bash -c 'source "$1"; compute_pending "$2" "$3"' _ "$DIR/db-sync-local.sh" "$MIXED_DISK" "$MIXED_REC" 2>&1 >/dev/null)"
got="$(LANG=en_US.UTF-8 LC_ALL= LC_COLLATE=en_US.UTF-8 bash -c 'source "$1"; compute_pending "$2" "$3"' _ "$DIR/db-sync-local.sh" "$MIXED_DISK" "$MIXED_REC" 2>/dev/null)"
if [ "$got" = "3" ] && [ -z "$err" ]; then
  ok "U7 compute_pending under a non-C locale: exact count (3), no comm order warning"
else
  bad "U7 locale-independence (got '${got}', stderr '${err}')"
fi

# U8 (ATI-SEP-1 T0) — mig_list never offers a separate-database library's
# migrations (libs/intelligence-core → aramo_intelligence) to the shared-DB runner.
U8_ROOT="$(mktemp -d)"
mkdir -p "$U8_ROOT/libs/a/prisma/migrations/20260101000000_a" \
         "$U8_ROOT/libs/intelligence-core/prisma/migrations/20260102000000_ti" \
         "$U8_ROOT/libs/intelligence-core-x/prisma/migrations/20260103000000_x"
got="$(cd "$U8_ROOT" && mig_list | tr '\n' ' ' | sed 's/ $//')"
rm -rf "$U8_ROOT"
if [ "$got" = "libs/a/prisma/migrations/20260101000000_a/ libs/intelligence-core-x/prisma/migrations/20260103000000_x/" ]; then
  ok "U8 mig_list excludes libs/intelligence-core (exact lib name only)"
else
  bad "U8 mig_list separate-DB exclusion (got '${got}')"
fi

echo "db-sync-local.test — ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
