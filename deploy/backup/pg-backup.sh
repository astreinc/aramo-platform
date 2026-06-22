#!/usr/bin/env bash
# Aramo single-box — Postgres backup → S3 (Single-Box Directive 3 §B).
#
# Dumps the box Postgres (the docker-compose.prod.yml `postgres` container) with
# `pg_dump -Fc` (custom format — compressed, restored by pg-restore.sh), stages
# the dump locally, and uploads it to S3. Driven by a systemd timer
# (aramo-pg-backup.timer) on the box; runnable by hand for the restore drill.
#
# THE ONLY legitimate AWS credential on the box. Scope its IAM user to ONLY
# `s3:PutObject` on the backup prefix (deploy/backup/s3-backup-iam-policy.json) —
# nothing broader. S3-side retention (expiring old dumps) is a BUCKET LIFECYCLE
# rule (deploy/backup/s3-backup-lifecycle.json), NOT a script delete, so the box
# credential never needs ListBucket/DeleteObject. This script only PUTs.
#
# Config (env, or /etc/aramo/backup.conf via the systemd unit's EnvironmentFile):
#   PG_CONTAINER        postgres container name   (default aramo-prod-postgres)
#   POSTGRES_USER       db user                   (default aramo)
#   POSTGRES_DB         db name                   (default aramo)
#   BACKUP_DIR          local staging dir         (default /var/backups/aramo)
#   BACKUP_S3_URI       s3://bucket/prefix         (UNSET => local-only; the drill)
#   BACKUP_LOCAL_KEEP   local dumps to retain      (default 7)
#   AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  (the narrow S3 user)
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-aramo-prod-postgres}"
POSTGRES_USER="${POSTGRES_USER:-aramo}"
POSTGRES_DB="${POSTGRES_DB:-aramo}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aramo}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"
BACKUP_LOCAL_KEEP="${BACKUP_LOCAL_KEEP:-7}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
file="aramo-pg-${ts}.dump"
mkdir -p "$BACKUP_DIR"
dest="${BACKUP_DIR}/${file}"

echo "pg-backup: dumping ${POSTGRES_DB} from ${PG_CONTAINER} → ${dest}"
# -Fc custom format captures ALL schemas (identity, company, … schema-per-
# module) in one dump; restore is pg-restore.sh. Fail loud on a partial dump.
if ! docker exec "$PG_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$dest"; then
  echo "pg-backup: pg_dump FAILED — removing partial file" >&2
  rm -f "$dest"
  exit 1
fi
size="$(wc -c < "$dest" | tr -d ' ')"
[ "$size" -gt 0 ] || { echo "pg-backup: dump is empty — aborting" >&2; rm -f "$dest"; exit 1; }
echo "pg-backup: wrote ${size} bytes"

if [ -n "$BACKUP_S3_URI" ]; then
  echo "pg-backup: uploading → ${BACKUP_S3_URI%/}/${file}"
  aws s3 cp "$dest" "${BACKUP_S3_URI%/}/${file}"
  echo "pg-backup: uploaded (s3 retention is the bucket lifecycle rule, not this script)"
else
  echo "pg-backup: BACKUP_S3_URI unset — local-only (restore-drill mode)"
fi

# Local staging retention (the box keeps only a small working set; the durable
# copies live in S3). Only prunes the LOCAL dir — no S3 delete (PutObject-only).
# Portable (no `mapfile` — the box may run an older bash).
old_dumps="$(ls -1t "${BACKUP_DIR}"/aramo-pg-*.dump 2>/dev/null | tail -n +"$((BACKUP_LOCAL_KEEP + 1))")"
if [ -n "$old_dumps" ]; then
  n="$(printf '%s\n' "$old_dumps" | wc -l | tr -d ' ')"
  echo "pg-backup: pruning ${n} local dump(s) beyond the last ${BACKUP_LOCAL_KEEP}"
  printf '%s\n' "$old_dumps" | xargs rm -f
fi

echo "pg-backup: done (${dest})"
