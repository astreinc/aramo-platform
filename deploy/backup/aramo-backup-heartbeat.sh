#!/usr/bin/env bash
# Aramo — write one backup heartbeat (M-A8 §1.2.1–§1.2.2).
#
# Used by the systemd OnFailure= unit (aramo-pg-backup-failed.service): when the
# backup service fails for ANY reason (dump, upload, prune, missing config), this
# uploads heartbeat/<UTCts>-failed-<label>.json with status FAILED, so the daily
# freshness check alerts even if aramo-backup.sh never reached its own trap.
# Counts only; no data. aramo-backup.sh writes the OK heartbeat itself.
#
# Usage:
#   aramo-backup-heartbeat.sh --status FAILED --label scheduled [--source <unit>]
# Config: BACKUP_DIR, BACKUP_S3_URI, BACKUP_KMS_KEY_ID, AWS_* (as aramo-backup.sh).
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-backup-heartbeat"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aramo-r15}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"

main() {
  local status="" label="scheduled" source="manual"
  while [ $# -gt 0 ]; do
    case "$1" in
      --status) status="${2:-}"; shift 2 ;;
      --label) label="${2:-}"; shift 2 ;;
      --source) source="${2:-}"; shift 2 ;;
      -h | --help) sed -n '2,15p' "$0"; exit 0 ;;
      *) bk_die "unknown argument: $1" 2 ;;
    esac
  done
  bk_check_label "$label"
  local run_id
  case "$status" in
    FAILED) run_id="$(bk_now_compact)-failed-${label}" ;;
    OK) run_id="$(bk_now_compact)-${label}" ;;
    *) bk_die "--status must be OK or FAILED" 2 ;;
  esac
  if [ -n "$BACKUP_S3_URI" ]; then bk_s3_bucket "$BACKUP_S3_URI" >/dev/null; fi
  bk_heartbeat "$status" "$run_id" "$label" 0 0 0 "$source"
  printf '%s\n' "$run_id"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
