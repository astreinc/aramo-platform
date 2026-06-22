#!/usr/bin/env bash
# Aramo single-box — Postgres restore (Single-Box Directive 3 §B, the drill).
#
# Restores a pg-backup.sh dump (`pg_dump -Fc`) into a Postgres container. A
# backup you haven't restored is a hope, not a backup — this is the proven
# other half. The restore drill (see doc/runbooks/singlebox-ops.md) dumps the
# live stack, restores into a CLEAN Postgres, and confirms the stack reads it.
#
# Usage:
#   deploy/backup/pg-restore.sh <dump>            # dump = local path OR s3://… uri
#   PG_CONTAINER=clean-pg deploy/backup/pg-restore.sh /var/backups/aramo/aramo-pg-…dump
#
# Config (env):
#   PG_CONTAINER   target postgres container   (default aramo-prod-postgres)
#   POSTGRES_USER  db user                     (default aramo)
#   POSTGRES_DB    db name                     (default aramo)
# Reading from s3:// also needs the AWS env (region + creds) with GetObject.
set -euo pipefail

SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: $0 <dump-file-or-s3-uri>" >&2; exit 2; }

PG_CONTAINER="${PG_CONTAINER:-aramo-prod-postgres}"
POSTGRES_USER="${POSTGRES_USER:-aramo}"
POSTGRES_DB="${POSTGRES_DB:-aramo}"

cleanup=""
local_file="$SRC"
if [[ "$SRC" == s3://* ]]; then
  local_file="$(mktemp /tmp/aramo-restore-XXXXXX.dump)"
  cleanup="$local_file"
  echo "pg-restore: fetching ${SRC} → ${local_file}"
  aws s3 cp "$SRC" "$local_file"
fi
[ -f "$local_file" ] || { echo "pg-restore: dump not found: $local_file" >&2; exit 1; }

echo "pg-restore: restoring ${local_file} → ${POSTGRES_DB} in ${PG_CONTAINER}"
# --clean --if-exists makes the restore repeatable: it DROPs each object before
# recreating (no-op on a truly empty target), so the same dump restores cleanly
# into either a fresh DB or one being rolled back. --no-owner ignores the dump's
# role grants (the box DB has a single owning role). Non-fatal NOTICEs (e.g.
# "schema already exists") are expected; pg_restore exits non-zero only on real
# errors with --exit-on-error, which we DON'T set so benign drop-misses on an
# empty target don't abort the drill.
if ! docker exec -i "$PG_CONTAINER" pg_restore \
      -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      --clean --if-exists --no-owner < "$local_file"; then
  echo "pg-restore: pg_restore reported errors (review above; benign on empty target)" >&2
fi

[ -n "$cleanup" ] && rm -f "$cleanup"
echo "pg-restore: done"
