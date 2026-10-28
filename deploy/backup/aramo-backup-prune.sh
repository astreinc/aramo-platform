#!/usr/bin/env bash
# Aramo single-box — local routine-backup retention (M-A8 §1.2.2).
#
# Keeps 7 days of LOCAL encrypted copies on the box (S3 lifecycle keeps 30):
# removes $BACKUP_DIR/routine/<run_id>/ run directories older than
# BACKUP_RETENTION_DAYS (default 7). Age is taken from the run's manifest
# mtime (a run without a manifest is an aborted run; its directory mtime is used).
# Local heartbeat files ($BACKUP_DIR/heartbeat/*.json) older than the same window
# are removed too. Encrypted .env snapshots ($BACKUP_DIR/env/) are kept to the 3
# newest by aramo-env-snapshot.sh, not here.
#
# What it NEVER touches:
#   - $BACKUP_DIR/legal-hold/ and $BACKUP_DIR/historic/ (exceptional
#     preservation and the PO-gated historic set; M-A7 §2);
#   - anything outside $BACKUP_DIR/routine/ and $BACKUP_DIR/heartbeat/ — and it
#     refuses to run at all if BACKUP_DIR points at the historic plaintext
#     locations (/opt/aramo-backups, /opt/aramo, /var/backups/aramo): those are
#     retired only by aramo-historic-disposition.sh at the M-A8 §4.3 checkpoint;
#   - S3. S3 expiry is the bucket lifecycle rule (infrastructure-backups/bucket.tf:
#     routine/ and historic/ expire after 30 days, noncurrent versions after 1 day).
#     The box credential has no s3:DeleteObject.
#
# Usage:
#   sudo deploy/backup/aramo-backup-prune.sh            # prune
#   sudo deploy/backup/aramo-backup-prune.sh --dry-run  # list only
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-backup-prune"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aramo-r15}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# run_id = <UTC compact timestamp>-<label>, as written by aramo-backup.sh.
RUN_ID_RE='^[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'

main() {
  local dry=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) dry=1; shift ;;
      -h | --help) sed -n '2,25p' "$0"; exit 0 ;;
      *) bk_die "unknown argument: $1" 2 ;;
    esac
  done
  if ! [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || [ "$BACKUP_RETENTION_DAYS" -lt 1 ]; then
    bk_die "BACKUP_RETENTION_DAYS must be a positive integer" 2
  fi

  local root
  root="$(cd "$BACKUP_DIR" 2>/dev/null && pwd -P)" || bk_die "BACKUP_DIR not found: ${BACKUP_DIR}"
  case "$root" in
    /opt/aramo-backups* | /opt/aramo | /opt/aramo/* | /var/backups/aramo)
      bk_die "refusing to prune ${root}: historic plaintext backups are retired only at the M-A8 §4.3 checkpoint, not by routine prune" 3
      ;;
  esac
  bk_private_dir "$root"
  [ -d "$root/routine" ] || bk_log "no routine/ directory under ${root}"

  local run name ref removed=0 kept=0
  for run in "$root"/routine/*; do
    [ -d "$run" ] || continue
    name="$(basename "$run")"
    if ! [[ "$name" =~ $RUN_ID_RE ]]; then
      bk_log "skip (not a run directory): ${name}"
      continue
    fi
    ref="$run/manifest.tsv"
    [ -f "$ref" ] || ref="$run"
    if [ -n "$(find "$ref" -maxdepth 0 -mtime +"$BACKUP_RETENTION_DAYS" -print)" ]; then
      if [ "$dry" = "1" ]; then
        bk_log "would remove ${name} (older than ${BACKUP_RETENTION_DAYS} days)"
      else
        rm -rf -- "${root:?}/routine/${name:?}"
        bk_log "removed ${name} (older than ${BACKUP_RETENTION_DAYS} days)"
      fi
      removed=$((removed + 1))
    else
      kept=$((kept + 1))
    fi
  done
  local hb hb_removed=0
  if [ -d "$root/heartbeat" ]; then
    while IFS= read -r hb; do
      [ -n "$hb" ] || continue
      if [ "$dry" = "1" ]; then
        bk_log "would remove heartbeat $(basename "$hb")"
      else
        rm -f -- "$hb"
      fi
      hb_removed=$((hb_removed + 1))
    done < <(find "$root/heartbeat" -maxdepth 1 -type f -name '*.json' -mtime +"$BACKUP_RETENTION_DAYS" -print)
  fi
  bk_log "done: $([ "$dry" = "1" ] && echo would-remove || echo removed)=${removed} kept=${kept} heartbeats=${hb_removed} retention_days=${BACKUP_RETENTION_DAYS}"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
