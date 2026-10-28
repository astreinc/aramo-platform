#!/usr/bin/env bash
# Aramo single-box — Postgres restore of ONE database dump (real restore / drill).
#
# For the routine proof that a backup restores, use aramo-restore-test.sh (a
# throwaway, network-isolated container). THIS script restores into a named
# target container — a real rollback — and so carries the M-A7 §2 gate:
# restoring a backup older than recorded deletions requires deletion replay
# (deploy/backup/aramo-deletion-replay.sh) BEFORE the database serves traffic.
#
# Usage:
#   deploy/backup/pg-restore.sh <dump>          # local path or s3://… uri
#     <dump> = *.dump.age  (aramo-backup.sh output; needs AGE_IDENTITY_FILE)
#            | *.dump      (legacy unencrypted pg_dump -Fc)
#
# Config (env):
#   PG_CONTAINER       target postgres container   (default aramo-prod-postgres)
#   POSTGRES_USER      db user                     (default aramo)
#   POSTGRES_DB        db name                     (default aramo)
#   AGE_IDENTITY_FILE  age identity for *.age input (kept OFFLINE; bring it only
#                      for the restore, never leave it on the box)
# Reading from s3:// also needs the AWS env of the restore-reader principal.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="pg-restore"

SRC="${1:-}"
[ -n "$SRC" ] || bk_die "usage: $0 <dump-file-or-s3-uri>" 2

PG_CONTAINER="${PG_CONTAINER:-aramo-prod-postgres}"
POSTGRES_USER="${POSTGRES_USER:-aramo}"
POSTGRES_DB="${POSTGRES_DB:-aramo}"

work=""
trap '[ -z "$work" ] || rm -rf -- "$work"' EXIT
local_file="$SRC"
if [[ "$SRC" == s3://* ]]; then
  work="$(mktemp -d "${TMPDIR:-/tmp}/aramo-restore.XXXXXX")"
  local_file="$work/$(basename "$SRC")"
  export BK_AWS_MOUNT="$work"
  bk_log "fetching ${SRC}"
  bk_aws s3 cp --only-show-errors "$SRC" "$local_file"
fi
[ -f "$local_file" ] || bk_die "dump not found: $local_file"

bk_log "restoring $(basename "$local_file") → ${POSTGRES_DB} in ${PG_CONTAINER}"
# --clean --if-exists makes the restore repeatable (fresh OR rollback target).
# --no-owner: the box DB has a single owning role. Benign drop-misses on an
# empty target are reported but do not abort (no --exit-on-error here; the
# throwaway restore test is the strict one).
restore() {
  docker exec -i "$PG_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --clean --if-exists --no-owner
}
rc=0
case "$local_file" in
  *.age)
    if [ -z "${AGE_IDENTITY_FILE:-}" ] || ! [ -r "$AGE_IDENTITY_FILE" ]; then
      bk_die "encrypted dump: set AGE_IDENTITY_FILE to the offline age identity" 2
    fi
    age -d -i "$AGE_IDENTITY_FILE" "$local_file" | restore || rc=$?
    ;;
  *) restore <"$local_file" || rc=$? ;;
esac
[ "$rc" = "0" ] || bk_log "pg_restore reported errors (rc=${rc}; review above; benign on an empty target)"

bk_log "done. GATE (M-A8 §1.3.2): before this database serves traffic, run"
bk_log "  deploy/backup/aramo-deletion-replay.sh --backup-created-at <manifest created_at> \\"
bk_log "    --source-container <current ledger container> --db-container ${PG_CONTAINER}"
bk_log "and do not return the database to service until it exits 0 (empty or verified replay)."
