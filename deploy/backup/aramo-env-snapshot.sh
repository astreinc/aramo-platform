#!/usr/bin/env bash
# Aramo single-box — encrypted .env snapshot before an environment change (M-A8 §1.2.4).
#
# Replaces the plaintext `cp .env /opt/aramo-backups/env-pre-<x>-<ts>` habit. It
#   - age-encrypts the env file straight from its source to the PUBLIC recipients
#     (no plaintext copy is ever written):
#       $BACKUP_DIR/env/env-<label>.age   (0600, in a 0700 directory)
#   - uploads it to s3://<bucket>/historic/env/env-<label>.age with SSE-KMS by the
#     bucket's key (checksum-verified), when BACKUP_S3_URI is set;
#   - keeps at most the 3 most recent snapshots locally (older local .age files are
#     removed; the S3 copies follow the 30-day historic/ lifecycle).
#
# Usage (on the box, before editing /opt/aramo/.env):
#   sudo deploy/backup/aramo-env-snapshot.sh --label pre-<sha|change-name>
#   … --env-file <path>      (default /opt/aramo/.env)
#   … --no-upload            (local encrypted copy only)
# Restore (Mac, with an identity): age -d -i <identity> env-<label>.age > .env
#
# Config: BACKUP_DIR, BACKUP_RECIPIENTS_FILE, BACKUP_S3_URI, BACKUP_KMS_KEY_ID, AWS_*
# (as aramo-backup.sh; `sudo -E` or `set -a; . /etc/aramo/backup.conf; set +a`).
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-env-snapshot"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aramo-r15}"
BACKUP_RECIPIENTS_FILE="${BACKUP_RECIPIENTS_FILE:-/etc/aramo/backup-recipients.txt}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"
ENV_SNAPSHOT_KEEP="${ENV_SNAPSHOT_KEEP:-3}"

main() {
  local label="" env_file="/opt/aramo/.env" upload=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) label="${2:-}"; shift 2 ;;
      --env-file) env_file="${2:-}"; shift 2 ;;
      --no-upload) upload=0; shift ;;
      -h | --help) sed -n '2,23p' "$0"; exit 0 ;;
      *) bk_die "unknown argument: $1" 2 ;;
    esac
  done
  bk_check_label "$label"
  bk_need age awk
  [ -f "$env_file" ] && [ -r "$env_file" ] || bk_die "env file not readable: ${env_file}"
  [ -s "$env_file" ] || bk_die "env file is empty: ${env_file}"
  [ -n "$BACKUP_S3_URI" ] || upload=0
  local bucket=""
  if [ "$upload" = "1" ]; then
    bucket="$(bk_s3_bucket "$BACKUP_S3_URI")"
    bk_require_kms_key
  fi

  bk_check_recipients "$BACKUP_RECIPIENTS_FILE"
  bk_private_dir "$BACKUP_DIR"
  bk_private_dir "$BACKUP_DIR/env"
  local name="env-${label}.age" out
  out="$BACKUP_DIR/env/$name"
  [ ! -e "$out" ] || bk_die "snapshot already exists: ${out} (labels are single-use)"
  age -R "$BACKUP_RECIPIENTS_FILE" -o "${out}.partial" "$env_file" || {
    rm -f "${out}.partial"
    bk_die "age failed for ${env_file}"
  }
  mv "${out}.partial" "$out"
  chmod 600 "$out"
  bk_log "encrypted ${env_file} → ${out} ($(bk_size "$out") bytes)"

  if [ "$upload" = "1" ]; then
    bk_s3_put "$out" "$bucket" "historic/env/${name}" "label=${label}" >/dev/null
    bk_log "uploaded historic/env/${name} (SSE-KMS, checksum verified)"
  else
    bk_log "upload skipped (--no-upload or BACKUP_S3_URI unset) — local encrypted copy only"
  fi

  # Keep the newest ENV_SNAPSHOT_KEEP local snapshots (by mtime). They are encrypted;
  # removal is ordinary rm.
  local f n=0 removed=0
  while IFS= read -r f; do
    n=$((n + 1))
    if [ "$n" -gt "$ENV_SNAPSHOT_KEEP" ]; then
      rm -f -- "$f"
      removed=$((removed + 1))
    fi
  done < <(ls -1t "$BACKUP_DIR"/env/env-*.age 2>/dev/null)
  bk_log "local snapshots kept=$((n - removed)) removed=${removed} (keep ${ENV_SNAPSHOT_KEEP})"
  printf '%s\n' "$out"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
