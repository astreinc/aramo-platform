#!/usr/bin/env bash
# Aramo — encrypt + upload EXISTING plaintext files (M-A8 §1.4 D1 "Migrated").
#
# The migration path for the historic plaintext dumps and .env copies on the box
# (/opt/aramo-backups, /opt/aramo, /var/backups/aramo, /home/…). Normally driven by
# aramo-historic-disposition.sh (migrate), which checks every source against the
# verified inventory first. For each source file it:
#   - records the PLAINTEXT source's sha256, size and mtime (so the D3 retirement
#     can prove it deletes exactly what was preserved);
#   - encrypts it with age to the public recipients into
#     $BACKUP_DIR/historic/<run_id>/<name>.age (0600, 0700 dirs);
#   - writes manifest.tsv; when BACKUP_S3_URI is set uploads every file with SSE-KMS
#     by BACKUP_KMS_KEY_ID (checksum-verified, single PUT) to
#       historic/<run_id>/            (--kind dump)
#       historic/env/<run_id>/        (--kind env)
#     and records uploads.tsv: file, key, VersionId, sha256, size, verified.
#
# It NEVER deletes, moves, chmods or otherwise modifies a source file.
#
# Legal hold (M-A8 §1.4): the box writer cannot write legal-hold/ and no principal
# but the writer/restorer may use the bucket key, so a held file is uploaded here
# like any other (--hold-ref records the hold reference in the manifest) and the
# PO then places an Object Lock LEGAL HOLD on the exact uploaded VersionId from the
# Mac with the administrator credential (RUNBOOK-backups.md §9). A held version
# survives the 30-day lifecycle until the hold is lifted.
#
# Usage:
#   sudo deploy/backup/aramo-backup-encrypt-existing.sh --label opt-aramo-backups \
#        /opt/aramo-backups/pre-*.sql
#   … --kind env --label env-opt-aramo-backups /opt/aramo-backups/env-pre-*
#   … --hold-ref <ref> …        # documented hold; the PO places the S3 legal hold
#   … --no-upload               # local encrypted copy only
#
# Kinds: dump (default; *.sql → plain-sql+age, *.dump → pg_dump-custom+age, the
# database inferred from the name: *intelligence* → aramo_intelligence, else aramo)
# | env (any file → env+age, database "-"). A pg_dump of selected schemas keeps its
# source name in the manifest and must be classified by a human.
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
  local class="historic" label="" upload=1 kind="dump" hold_ref="-"
  local -a files=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --class) class="${2:-}"; shift 2 ;;
      --kind) kind="${2:-}"; shift 2 ;;
      --label) label="${2:-}"; shift 2 ;;
      --hold-ref) hold_ref="${2:-}"; shift 2 ;;
      --no-upload) upload=0; shift ;;
      -h | --help) sed -n '2,40p' "$0"; exit 0 ;;
      -*) bk_die "unknown argument: $1" 2 ;;
      *) files+=("$1"); shift ;;
    esac
  done
  case "$class" in
    historic) ;;
    legal-hold) bk_die "--class legal-hold is retired: upload with --hold-ref <ref>; the PO places the Object Lock legal hold on the uploaded version (RUNBOOK-backups.md §9)" 2 ;;
    *) bk_die "--class must be historic" 2 ;;
  esac
  case "$kind" in dump | env) ;; *) bk_die "--kind must be dump or env" 2 ;; esac
  bk_check_label "$label"
  if [ "$hold_ref" != "-" ]; then bk_check_label "$hold_ref"; fi
  [ -n "$BACKUP_S3_URI" ] || upload=0
  local bucket=""
  if [ "$upload" = "1" ]; then
    bucket="$(bk_s3_bucket "$BACKUP_S3_URI")"
    bk_require_kms_key
  fi
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
    if [ "$kind" = "env" ]; then
      format="env+age"
      db="-"
    else
      case "$name" in
        *.sql) format="plain-sql+age" ;;
        *.dump) format="pg_dump-custom+age" ;;
        *) bk_die "unsupported dump type (expect .sql or .dump; use --kind env for env copies): ${name}" ;;
      esac
      case "$name" in
        *intelligence*) db="aramo_intelligence" ;;
        *) db="aramo" ;;
      esac
    fi
    base="${name#.}.age"
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
    bk_manifest_kv kind "$kind"
    bk_manifest_kv hold_ref "$hold_ref"
    bk_manifest_kv git_sha "-"
    bk_manifest_kv host "$(hostname)"
    bk_manifest_kv encryption "age-x25519"
    bk_manifest_kv recipients_sha256 "$(bk_sha256 "$BACKUP_RECIPIENTS_FILE")"
    cat "$body"
  } >"$run_dir/manifest.tsv"
  rm -f "$body"
  chmod 600 "$run_dir/manifest.tsv"

  if [ "$upload" = "1" ]; then
    local prefix="historic/${run_id}" g key version up="$run_dir/uploads.tsv"
    [ "$kind" = "env" ] && prefix="historic/env/${run_id}"
    printf '#file\tkey\tversion_id\tsha256\tsize\tverified\n' >"$up"
    for g in "$run_dir"/*.age "$run_dir/manifest.tsv"; do
      key="${prefix}/$(basename "$g")"
      version="$(bk_s3_put "$g" "$bucket" "$key" "run-id=${run_id},hold-ref=${hold_ref}")"
      printf '%s\t%s\t%s\t%s\t%s\tyes\n' "$(basename "$g")" "$key" "$version" "$(bk_sha256 "$g")" "$(bk_size "$g")" >>"$up"
    done
    chmod 600 "$up"
    bk_log "uploaded ${prefix}/ ($(($(wc -l <"$up") - 1)) objects, SSE-KMS, checksum verified)"
    if [ "$hold_ref" != "-" ]; then
      bk_log "HOLD ${hold_ref}: the PO places an Object Lock legal hold on each VersionId in ${up} (RUNBOOK-backups.md §9)"
    fi
  else
    bk_log "upload skipped — local encrypted copy only"
  fi
  bk_log "OK ${class} run ${run_id}: ${#files[@]} file(s); sources UNCHANGED (D3 retirement is a separate, approved step)"
  printf '%s\n' "$run_dir"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
