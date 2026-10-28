#!/usr/bin/env bash
# Aramo — encrypt + upload EXISTING plaintext dumps (M-A7 §2 historic set).
#
# The migration path for the historic plaintext dumps on the box
# (/opt/aramo-backups, /opt/aramo, /var/backups/aramo) and the operator-Mac
# copies (~/.aramo-e1-backups). For each source file it:
#   - records the PLAINTEXT source's sha256, size and mtime (so a later,
#     PO-approved deletion can prove it deletes exactly what was preserved);
#   - encrypts it with age to the public recipients into
#     $BACKUP_DIR/<class>/<run_id>/<name>.age (0600, 0700 dirs);
#   - writes manifest.tsv; uploads to <BACKUP_S3_URI>/<class>/<run_id>/ when set.
#
# It NEVER deletes, moves, chmods or otherwise modifies a source file. Removing
# the plaintext originals is a separate step that requires (1) a passing
# aramo-restore-test.sh on the uploaded copy and (2) explicit PO approval
# (M-A7 §2, §8). See doc/runbooks/RUNBOOK-backups-r15.md §Historic migration.
#
# Usage:
#   sudo deploy/backup/aramo-backup-encrypt-existing.sh --class historic \
#        --label opt-aramo-backups /opt/aramo-backups/pre-*.sql
#   … --class legal-hold --label hold-<ref> <files…>     # documented hold only
#
# Classes: historic (lifecycle per PO decision) | legal-hold (no expiry).
# Format is inferred: *.sql → plain-sql+age, *.dump → pg_dump-custom+age.
# The database is inferred from the file name (*intelligence* →
# aramo_intelligence, else aramo); a pg_dump of selected schemas is flagged
# in the manifest via its source name and must be classified by a human.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-backup-encrypt-existing"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/aramo-r15}"
BACKUP_RECIPIENTS_FILE="${BACKUP_RECIPIENTS_FILE:-/etc/aramo/backup-recipients.txt}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"

main() {
  local class="" label="" upload=1
  local -a files=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --class) class="${2:-}"; shift 2 ;;
      --label) label="${2:-}"; shift 2 ;;
      --no-upload) upload=0; shift ;;
      -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
      -*) bk_die "unknown argument: $1" 2 ;;
      *) files+=("$1"); shift ;;
    esac
  done
  case "$class" in historic | legal-hold) ;; *) bk_die "--class must be historic or legal-hold" 2 ;; esac
  bk_check_label "$label"
  [ "${#files[@]}" -ge 1 ] || bk_die "no source files given" 2
  bk_need age awk

  bk_check_recipients "$BACKUP_RECIPIENTS_FILE"
  bk_private_dir "$BACKUP_DIR"
  bk_private_dir "$BACKUP_DIR/$class"
  local run_id run_dir
  run_id="$(bk_now_compact)-${label}"
  run_dir="$BACKUP_DIR/$class/$run_id"
  [ ! -e "$run_dir" ] || bk_die "run directory already exists: ${run_dir}"
  bk_private_dir "$run_dir"

  local body="$run_dir/.manifest.body" f name base db format out
  : >"$body"
  for f in "${files[@]}"; do
    if ! [ -f "$f" ] || ! [ -r "$f" ]; then bk_die "source not a readable file: ${f}"; fi
    name="$(basename "$f")"
    case "$name" in
      *.sql) format="plain-sql+age" ;;
      *.dump) format="pg_dump-custom+age" ;;
      *) bk_die "unsupported source type (expect .sql or .dump): ${name}" ;;
    esac
    case "$name" in
      *intelligence*) db="aramo_intelligence" ;;
      *) db="aramo" ;;
    esac
    base="${name}.age"
    out="$run_dir/$base"
    [ ! -e "$out" ] || bk_die "duplicate source basename in one run: ${name}"
    bk_log "encrypting ${f} → ${out}"
    age -R "$BACKUP_RECIPIENTS_FILE" -o "${out}.partial" "$f" || { rm -f "${out}.partial"; bk_die "age failed for ${f}"; }
    mv "${out}.partial" "$out"
    chmod 600 "$out"
    # source_name carries the original path + mtime for the disposition record.
    bk_manifest_artifact "$base" "$db" "$format" "$(bk_size "$out")" "$(bk_sha256 "$out")" \
      "-" "-" "-" "$(bk_sha256 "$f")" "${f}@$(bk_mtime_iso "$f")@$(bk_size "$f")" >>"$body"
  done

  {
    bk_manifest_header
    bk_manifest_kv run_id "$run_id"
    bk_manifest_kv class "$class"
    bk_manifest_kv created_at "$(bk_now_iso)"
    bk_manifest_kv label "$label"
    bk_manifest_kv git_sha "-"
    bk_manifest_kv host "$(hostname)"
    bk_manifest_kv encryption "age-x25519"
    bk_manifest_kv recipients_sha256 "$(bk_sha256 "$BACKUP_RECIPIENTS_FILE")"
    cat "$body"
  } >"$run_dir/manifest.tsv"
  rm -f "$body"
  chmod 600 "$run_dir/manifest.tsv"

  if [ "$upload" = "1" ] && [ -n "$BACKUP_S3_URI" ]; then
    [[ "$BACKUP_S3_URI" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
      bk_die "BACKUP_S3_URI must be s3://<bucket>"
    export BK_AWS_MOUNT="$run_dir"
    local dest="${BACKUP_S3_URI}/${class}/${run_id}" g
    for g in "$run_dir"/*.age "$run_dir/manifest.tsv"; do
      bk_aws s3 cp --only-show-errors "$g" "${dest}/$(basename "$g")"
    done
    bk_log "uploaded ${class}/${run_id}"
  else
    bk_log "upload skipped — local encrypted copy only"
  fi
  bk_log "OK ${class} run ${run_id}: ${#files[@]} file(s); sources UNCHANGED (deletion is PO-gated)"
  printf '%s\n' "$run_dir"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
