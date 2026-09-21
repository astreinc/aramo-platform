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

echo "db-sync-local.test — ${pass} passed, ${fail} failed"
[ "$fail" = 0 ]
