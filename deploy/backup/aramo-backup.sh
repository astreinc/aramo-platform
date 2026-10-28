#!/usr/bin/env bash
# Aramo single-box — encrypted database backup (M-A7 §2 / R-15).
#
# Replaces the raw `pg_dump … > /opt/aramo/*.sql` deploy step (RELEASE-box.md
# STEP 2) and the daily timer job. For each database it streams
#
#   docker exec <pg> pg_dump -Fc  ──►  age -R <recipients>  ──►  <db>.dump.age (0600)
#
# so NO plaintext dump ever touches the disk. Output lands in a 0700 directory
# owned by the running user (root on the box):
#
#   $BACKUP_DIR/routine/<run_id>/<db>.dump.age
#   $BACKUP_DIR/routine/<run_id>/globals.sql.age      (roles only, NO password hashes)
#   $BACKUP_DIR/routine/<run_id>/manifest.tsv         (sha256/size/db/time/git SHA/counts)
#
# and, when BACKUP_S3_URI is set, is uploaded to <BACKUP_S3_URI>/routine/<run_id>/
# (SSE-KMS bucket, 30-day lifecycle; infrastructure-lightsail/r15-backups.tf).
# The manifest is uploaded LAST, so a manifest object means a complete set.
#
# Encryption: age (X25519 + ChaCha20-Poly1305) to PUBLIC recipients only. The
# matching identities (private keys) stay offline with the PO; the box can
# write backups but can never read one back. Rationale + custody:
# doc/runbooks/RUNBOOK-backups-r15.md.
#
# Usage:
#   sudo deploy/backup/aramo-backup.sh --label pre-<sha>      # deploy STEP 2
#   sudo deploy/backup/aramo-backup.sh --label scheduled      # systemd timer
#   … --no-upload                                             # local only (drill)
#
# Config (env, or /etc/aramo/backup.conf via the systemd unit):
#   PG_CONTAINER            postgres container            (default aramo-prod-postgres)
#   BACKUP_DATABASES        space-separated db names      (default "aramo aramo_intelligence")
#   BACKUP_DIR              0700 output root              (default /var/backups/aramo-r15)
#   BACKUP_RECIPIENTS_FILE  age1… public recipients       (default /etc/aramo/backup-recipients.txt)
#   BACKUP_S3_URI           s3://<bucket>                 (unset => local only)
#   ARAMO_DIR               repo checkout for git SHA     (default /opt/aramo)
#   BACKUP_GIT_SHA          explicit SHA override         (default: git -C $ARAMO_DIR rev-parse HEAD)
#   AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY  the put-only backup writer
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-backup"

PG_CONTAINER="${PG_CONTAINER:-aramo-prod-postgres}"
BACKUP_DATABASES="${BACKUP_DATABASES:-aramo aramo_intelligence}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/aramo-r15}"
BACKUP_RECIPIENTS_FILE="${BACKUP_RECIPIENTS_FILE:-/etc/aramo/backup-recipients.txt}"
BACKUP_S3_URI="${BACKUP_S3_URI:-}"
ARAMO_DIR="${ARAMO_DIR:-/opt/aramo}"

# psql inside the postgres container as the container's own superuser.
# $POSTGRES_USER is expanded INSIDE the container (it is in that env, not ours).
pg_q() {
  local db="$1" sql="$2"
  docker exec "$PG_CONTAINER" sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "$2"' _ "$db" "$sql"
}

# Base tables outside the system schemas: the restore test compares this.
TABLE_COUNT_SQL="SELECT count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')"

# The migration ledger of each database (tools/db-sync-local.sh,
# tools/db-sync-intelligence.sh). First one present wins; "-" if none.
LEDGER_TABLES="public._local_migrations public._intelligence_migrations"

ledger_of() {
  local db="$1" t
  for t in $LEDGER_TABLES; do
    if [ "$(pg_q "$db" "SELECT to_regclass('${t}') IS NOT NULL")" = "t" ]; then
      printf '%s\t%s\n' "$t" "$(pg_q "$db" "SELECT count(*) FROM ${t}")"
      return 0
    fi
  done
  printf -- '-\t-\n'
}

main() {
  local label="manual" upload=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --label) label="${2:-}"; shift 2 ;;
      --no-upload) upload=0; shift ;;
      -h | --help) sed -n '2,45p' "$0"; exit 0 ;;
      *) bk_die "unknown argument: $1" 2 ;;
    esac
  done
  bk_check_label "$label"
  bk_need docker age awk

  bk_check_recipients "$BACKUP_RECIPIENTS_FILE"
  bk_private_dir "$BACKUP_DIR"
  bk_private_dir "$BACKUP_DIR/routine"

  local git_sha="${BACKUP_GIT_SHA:-}"
  if [ -z "$git_sha" ]; then
    git_sha="$(git -C "$ARAMO_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  fi

  local run_id run_dir created_at server_version recipients_sha
  run_id="$(bk_now_compact)-${label}"
  run_dir="$BACKUP_DIR/routine/$run_id"
  [ ! -e "$run_dir" ] || bk_die "run directory already exists: ${run_dir}"
  bk_private_dir "$run_dir"
  created_at="$(bk_now_iso)"
  server_version="$(pg_q postgres 'SHOW server_version')" || bk_die "cannot reach postgres in container ${PG_CONTAINER}"
  recipients_sha="$(bk_sha256 "$BACKUP_RECIPIENTS_FILE")"

  local manifest="$run_dir/manifest.tsv" body="$run_dir/.manifest.body"
  : >"$body"

  local db out tables ledger ledger_table ledger_count size sha
  for db in $BACKUP_DATABASES; do
    [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || bk_die "invalid database name: ${db}"
    [ "$(pg_q postgres "SELECT count(*) FROM pg_database WHERE datname='${db}'")" = "1" ] ||
      bk_die "database ${db} not found in ${PG_CONTAINER} (BACKUP_DATABASES=${BACKUP_DATABASES})"
    tables="$(pg_q "$db" "$TABLE_COUNT_SQL")"
    ledger="$(ledger_of "$db")"
    ledger_table="${ledger%%$'\t'*}"
    ledger_count="${ledger##*$'\t'}"

    out="$run_dir/${db}.dump.age"
    bk_log "dumping ${db} (tables=${tables} ledger=${ledger_table}:${ledger_count}) → ${out}"
    # pipefail: a pg_dump failure fails the pipeline even though age exits 0.
    if ! docker exec "$PG_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$1" -Fc' _ "$db" |
      age -R "$BACKUP_RECIPIENTS_FILE" -o "${out}.partial"; then
      rm -f "${out}.partial"
      bk_die "pg_dump | age FAILED for ${db} — partial output removed; NO backup for this run"
    fi
    mv "${out}.partial" "$out"
    chmod 600 "$out"
    size="$(bk_size "$out")"
    # An age header alone is ~200 bytes; a real -Fc dump of any Aramo DB is far larger.
    [ "$size" -gt 1024 ] || bk_die "encrypted dump for ${db} is only ${size} bytes — refusing to call it a backup"
    sha="$(bk_sha256 "$out")"
    bk_manifest_artifact "${db}.dump.age" "$db" "pg_dump-custom+age" "$size" "$sha" \
      "$tables" "$ledger_table" "$ledger_count" "-" "-" >>"$body"
  done

  # Roles (attributes + memberships) WITHOUT password hashes: needed to restore
  # ownership/grants (aramo_erasure_definer, aramo_erasure_operator, …).
  out="$run_dir/globals.sql.age"
  if ! docker exec "$PG_CONTAINER" sh -c 'pg_dumpall -U "$POSTGRES_USER" --roles-only --no-role-passwords' |
    age -R "$BACKUP_RECIPIENTS_FILE" -o "${out}.partial"; then
    rm -f "${out}.partial"
    bk_die "pg_dumpall --roles-only | age FAILED"
  fi
  mv "${out}.partial" "$out"
  chmod 600 "$out"
  bk_manifest_artifact "globals.sql.age" "_globals" "pg_dumpall-roles+age" "$(bk_size "$out")" \
    "$(bk_sha256 "$out")" "-" "-" "-" "-" "-" >>"$body"

  {
    bk_manifest_header
    bk_manifest_kv run_id "$run_id"
    bk_manifest_kv class routine
    bk_manifest_kv created_at "$created_at"
    bk_manifest_kv label "$label"
    bk_manifest_kv git_sha "$git_sha"
    bk_manifest_kv host "$(hostname)"
    bk_manifest_kv pg_container "$PG_CONTAINER"
    bk_manifest_kv pg_server_version "$server_version"
    bk_manifest_kv encryption "age-x25519"
    bk_manifest_kv recipients_sha256 "$recipients_sha"
    cat "$body"
  } >"$manifest"
  rm -f "$body"
  chmod 600 "$manifest"

  if [ "$upload" = "1" ] && [ -n "$BACKUP_S3_URI" ]; then
    [[ "$BACKUP_S3_URI" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] ||
      bk_die "BACKUP_S3_URI must be s3://<bucket> (prefixes are fixed by this script)"
    local dest="${BACKUP_S3_URI}/routine/${run_id}" f
    export BK_AWS_MOUNT="$run_dir"
    for f in "$run_dir"/*.age "$manifest"; do
      bk_log "uploading $(basename "$f") → ${dest}/"
      bk_aws s3 cp --only-show-errors "$f" "${dest}/$(basename "$f")"
    done
    bk_log "uploaded run ${run_id} (bucket lifecycle owns S3 expiry; this credential cannot delete)"
  else
    bk_log "upload skipped (--no-upload or BACKUP_S3_URI unset) — local copy only"
  fi

  bk_log "OK run_id=${run_id} dir=${run_dir}"
  awk -F'\t' '$1=="artifact" {printf "  %-28s db=%-20s bytes=%s tables=%s ledger=%s\n", $2, $3, $5, $7, $9}' "$manifest" >&2
  printf '%s\n' "$run_dir"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
