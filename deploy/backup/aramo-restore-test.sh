#!/usr/bin/env bash
# Aramo — mandatory restore test for an encrypted backup run (M-A8 §1.3.1).
#
# Runs on the OPERATOR MAC (or another offline-key host), never on the box:
# it needs the age IDENTITY (private key), which by design never exists on the
# box. Steps:
#   1. fetch the run (local dir, or s3://<bucket>/<class>/<run_id> with the
#      restore-reader credential) into a private 0700 temp dir — encrypted
#      files only;
#   2. verify every artifact's size + sha256 against manifest.tsv;
#   3. start a THROWAWAY `pgvector/pgvector:pg17` container with `--rm`
#      `--network none` (no network at all; data enters over `docker exec -i`);
#   4. pre-create the cluster roles the dumps reference: every role named by a
#      CREATE ROLE in the run's encrypted globals artifact, or (historic runs,
#      no globals) every owner/grantee in its plain-SQL dumps; plus RESTORE_ROLES;
#   5. for each database artifact: `age -d | pg_restore --exit-on-error`
#      (or `psql -v ON_ERROR_STOP=1` for an encrypted plain .sql) — the
#      decrypted stream is never written to disk;
#   6. compare base-table count and migration-ledger row count with the
#      manifest's recorded values (when recorded), print a counts-only report;
#   7. remove the container WITH its anonymous volumes (the image declares a data
#      volume that would otherwise keep the restored database; recon defect 7),
#      then the temp dir (trap); PASS => exit 0;
#   8. upload the counts-only PASS/FAIL report to
#      s3://<bucket>/restore-checks/<UTCts>-<run_id>.<PASS|FAIL>.txt (SSE-KMS by
#      BACKUP_KMS_KEY_ID, metadata result=PASS|FAIL) with the restorer credential.
#      Default for s3:// sources; --report-s3 s3://<bucket> for a local run dir;
#      --no-report-upload to skip. A run that dies early still uploads a FAIL report.
#
# Usage:
#   AGE_IDENTITY_FILE=~/aramo-backup-identity.txt \
#     deploy/backup/aramo-restore-test.sh s3://aramo-prod-db-backups-use1/routine/<run_id>
#   AGE_IDENTITY_FILE=… deploy/backup/aramo-restore-test.sh /path/to/<run_id>
#   … --expect-tables aramo=N --expect-ledger aramo=M   # explicit expectations
#                                                       # (historic runs record none)
#   … --report <file>                                   # write the counts-only report
#   … --report-s3 s3://<bucket> | --no-report-upload    # restore-checks/ upload
#
# Env:
#   AGE_IDENTITY_FILE    age identity file (REQUIRED; keep it offline)
#   RESTORE_IMAGE        default pgvector/pgvector:pg17 (the production image)
#   RESTORE_ROLES        extra roles to pre-create (default none; the globals artifact names the rest)
#   RESTORE_SUPERUSER    default aramo (the production POSTGRES_USER; owns most objects)
#   AWS_PROFILE / AWS_REGION / … for s3:// sources (the restorer principal)
#   BACKUP_KMS_KEY_ID    the bucket's KMS key ARN (required for the report upload)
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-restore-test"

RESTORE_IMAGE="${RESTORE_IMAGE:-pgvector/pgvector:pg17}"
RESTORE_ROLES="${RESTORE_ROLES:-}"
RESTORE_SUPERUSER="${RESTORE_SUPERUSER:-aramo}"

TABLE_COUNT_SQL="SELECT count(*) FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')"

CONTAINER=""
WORK=""
REPORT_BUCKET=""
REPORT_UPLOADED=0
RUN_ID="unknown"
RUN_CLASS="unknown"

# upload_report <file> <PASS|FAIL>: restore-checks/<UTCts>-<run_id>.<result>.txt
upload_report() {
  local file="$1" result="$2" key
  [ -n "$REPORT_BUCKET" ] || return 0
  [[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$ ]] || RUN_ID="unknown"
  key="restore-checks/$(bk_now_compact)-${RUN_ID}.${result}.txt"
  bk_s3_put "$file" "$REPORT_BUCKET" "$key" "result=${result},run-id=${RUN_ID},class=${RUN_CLASS}" >/dev/null
  REPORT_UPLOADED=1
  bk_log "report uploaded: s3://${REPORT_BUCKET}/${key}"
}

# remove the container and every anonymous volume it created
remove_container() {
  local c="$1" vols v
  vols="$(docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}' "$c" 2>/dev/null || true)"
  docker rm -f -v "$c" >/dev/null 2>&1 || true
  for v in $vols; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      docker volume rm -f "$v" >/dev/null 2>&1 || bk_log "WARNING: could not remove volume ${v}"
    fi
  done
}

cleanup() {
  local rc=$?
  if [ "$rc" != 0 ] && [ "$REPORT_UPLOADED" = 0 ] && [ -n "$REPORT_BUCKET" ] && [ -n "$WORK" ] && [ -d "$WORK" ]; then
    printf 'restore-test run_id=%s class=%s image=%s at=%s\nerror=%s\noverall=FAIL\n' \
      "$RUN_ID" "$RUN_CLASS" "$RESTORE_IMAGE" "$(bk_now_iso)" "${BK_LAST_ERROR:-exit ${rc}}" >"$WORK/fail-report.txt"
    (upload_report "$WORK/fail-report.txt" FAIL) || bk_log "WARNING: FAIL report upload failed"
  fi
  if [ -n "$CONTAINER" ]; then remove_container "$CONTAINER"; fi
  if [ -n "$WORK" ]; then rm -rf -- "$WORK"; fi
  return "$rc"
}
trap cleanup EXIT

rq() {
  local db="$1" sql="$2"
  docker exec "$CONTAINER" psql -X -At -v ON_ERROR_STOP=1 -U "$RESTORE_SUPERUSER" -d "$db" -c "$sql"
}

# expectation lookup in "db=N db2=M" lists
expect_of() {
  local list="$1" db="$2" kv
  for kv in $list; do
    if [ "${kv%%=*}" = "$db" ]; then
      printf '%s\n' "${kv#*=}"
      return 0
    fi
  done
  printf -- '-\n'
}

main() {
  local src="" exp_tables="" exp_ledger="" report="" report_s3="" report_upload=auto
  while [ $# -gt 0 ]; do
    case "$1" in
      --expect-tables) exp_tables="${exp_tables} ${2:?}"; shift 2 ;;
      --expect-ledger) exp_ledger="${exp_ledger} ${2:?}"; shift 2 ;;
      --report) report="${2:?}"; shift 2 ;;
      --report-s3) report_s3="${2:?}"; shift 2 ;;
      --no-report-upload) report_upload=no; shift ;;
      -h | --help) sed -n '2,50p' "$0"; exit 0 ;;
      -*) bk_die "unknown argument: $1" 2 ;;
      *) [ -z "$src" ] || bk_die "one source only" 2; src="$1"; shift ;;
    esac
  done
  [ -n "$src" ] || bk_die "usage: $0 <run-dir | s3://bucket/<class>/<run_id>> [--expect-tables db=N] [--expect-ledger db=N] [--report file]" 2
  if [ -z "${AGE_IDENTITY_FILE:-}" ] || ! [ -r "$AGE_IDENTITY_FILE" ]; then
    bk_die "AGE_IDENTITY_FILE must point at the readable age identity (kept offline; never on the box)" 2
  fi
  bk_need docker age awk
  if [ "$report_upload" != "no" ]; then
    if [ -n "$report_s3" ]; then
      REPORT_BUCKET="$(bk_s3_bucket "$report_s3")"
    elif [[ "$src" == s3://* ]]; then
      local b="${src#s3://}"
      REPORT_BUCKET="${b%%/*}"
    fi
    if [ -n "$REPORT_BUCKET" ]; then bk_require_kms_key; fi
  fi

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/aramo-restore-test.XXXXXX")"
  chmod 700 "$WORK"
  local run="$WORK/run"
  mkdir -m 700 "$run"
  if [[ "$src" == s3://* ]]; then
    export BK_AWS_MOUNT="$WORK"
    bk_log "fetching ${src%/}/ (encrypted objects only)"
    bk_aws s3 cp --only-show-errors --recursive "${src%/}/" "$run/"
  else
    [ -f "$src/manifest.tsv" ] || bk_die "no manifest.tsv in ${src}"
    cp -p "$src"/manifest.tsv "$src"/*.age "$run/"
  fi
  local manifest="$run/manifest.tsv"
  bk_manifest_check "$manifest"
  local run_id class
  run_id="$(bk_manifest_get "$manifest" run_id)"
  class="$(bk_manifest_get "$manifest" class)"
  RUN_ID="$run_id"
  RUN_CLASS="$class"

  # 2. integrity against the manifest
  local file db format size sha tables ledger_table ledger_count n=0
  while IFS=$'\t' read -r _ file db format size sha tables ledger_table ledger_count _ _; do
    [ -f "$run/$file" ] || bk_die "artifact listed in manifest is missing: ${file}"
    [ "$(bk_size "$run/$file")" = "$size" ] || bk_die "size mismatch: ${file}"
    [ "$(bk_sha256 "$run/$file")" = "$sha" ] || bk_die "sha256 mismatch: ${file}"
    n=$((n + 1))
  done < <(awk -F'\t' '$1=="artifact"' "$manifest")
  [ "$n" -ge 1 ] || bk_die "manifest lists no artifacts"
  bk_log "integrity OK: ${n} artifact(s) match manifest (run ${run_id}, class ${class})"

  # 3. throwaway, network-isolated postgres
  local pw
  pw="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  CONTAINER="aramo-restore-test-$$-$(date +%s)"
  docker run -d --rm --name "$CONTAINER" --network none \
    -e POSTGRES_USER="$RESTORE_SUPERUSER" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=postgres \
    "$RESTORE_IMAGE" >/dev/null
  local i
  for i in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -q -U "$RESTORE_SUPERUSER" -d postgres 2>/dev/null &&
      rq postgres 'SELECT 1' >/dev/null 2>&1; then
      break
    fi
    [ "$i" -lt 60 ] || bk_die "throwaway postgres did not become ready"
    sleep 1
  done
  [ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER")" = "none" ] ||
    bk_die "restore container is not network-isolated"
  bk_log "throwaway ${RESTORE_IMAGE} up (network=none): $(rq postgres 'SHOW server_version')"

  # 4. cluster roles referenced by ownership / grants in the dumps: the role NAMES
  #    from the globals artifact (attributes and memberships are not needed to restore).
  local role roles="$RESTORE_ROLES" gfile
  gfile="$(awk -F'\t' '$3=="_globals"{print $2; exit}' "$run/manifest.tsv")"
  if [ -n "$gfile" ]; then
    roles="$roles $(age -d -i "$AGE_IDENTITY_FILE" "$run/$gfile" |
      sed -n 's/^CREATE ROLE \([a-z_][a-z0-9_]*\);$/\1/p' | { grep -vx "$RESTORE_SUPERUSER" || true; } | tr '\n' ' ')"
  else
    # A historic run has no globals artifact: take the roles its plain-SQL dumps
    # reference as owners or grantees.
    local pfile
    while IFS= read -r pfile; do
      roles="$roles $(age -d -i "$AGE_IDENTITY_FILE" "$run/$pfile" |
        sed -n -e 's/.* OWNER TO \([a-z_][a-z0-9_]*\);$/\1/p' -e 's/^GRANT .* TO \([a-z_][a-z0-9_]*\);$/\1/p' |
        { grep -vxE "$RESTORE_SUPERUSER|PUBLIC|public" || true; } | sort -u | tr '\n' ' ')"
    done < <(awk -F'\t' '$4=="plain-sql+age"{print $2}' "$run/manifest.tsv")
  fi
  for role in $roles; do
    [[ "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || bk_die "invalid role name: ${role}"
    rq postgres "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END \$\$" >/dev/null
  done
  bk_log "pre-created roles: $(echo $roles | wc -w | tr -d ' ')"

  # 5–6. restore + counts
  local fail=0 got_t got_l exp_t exp_l lt out
  out="$(
    printf 'restore-test run_id=%s class=%s image=%s at=%s\n' "$run_id" "$class" "$RESTORE_IMAGE" "$(bk_now_iso)"
    printf '%-20s %-22s %10s %10s %-32s %10s %10s %s\n' db format tables exp_tables ledger_table ledger exp_ledger verdict
  )"
  # fd 3: docker exec / age inside the loop must not consume the artifact list.
  while IFS=$'\t' read -r _ file db format size sha tables ledger_table ledger_count _ _ <&3; do
    [ "$db" != "_globals" ] || continue
    [[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || bk_die "invalid database name in manifest: ${db}"
    if [ "$db" != "postgres" ]; then
      rq postgres "CREATE DATABASE \"${db}\" OWNER \"${RESTORE_SUPERUSER}\"" >/dev/null
    fi
    bk_log "restoring ${file} → ${db}"
    case "$format" in
      pg_dump-custom+age)
        age -d -i "$AGE_IDENTITY_FILE" "$run/$file" |
          docker exec -i "$CONTAINER" pg_restore -U "$RESTORE_SUPERUSER" -d "$db" --exit-on-error ||
          bk_die "pg_restore FAILED for ${db}"
        ;;
      plain-sql+age)
        age -d -i "$AGE_IDENTITY_FILE" "$run/$file" |
          docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$RESTORE_SUPERUSER" -d "$db" >/dev/null ||
          bk_die "psql restore FAILED for ${db}"
        ;;
      *) bk_die "unsupported artifact format '${format}' for ${file}" ;;
    esac

    got_t="$(rq "$db" "$TABLE_COUNT_SQL")"
    lt="$ledger_table"
    if [ "$lt" = "-" ]; then
      for lt in public._local_migrations public._intelligence_migrations -; do
        [ "$lt" = "-" ] && break
        [ "$(rq "$db" "SELECT to_regclass('${lt}') IS NOT NULL")" = "t" ] && break
      done
    fi
    got_l="-"
    if [ "$lt" != "-" ]; then got_l="$(rq "$db" "SELECT count(*) FROM ${lt}")"; fi

    exp_t="$(expect_of "$exp_tables" "$db")"
    [ "$exp_t" != "-" ] || exp_t="$tables"
    exp_l="$(expect_of "$exp_ledger" "$db")"
    [ "$exp_l" != "-" ] || exp_l="$ledger_count"

    local verdict="PASS"
    if [ "$exp_t" != "-" ] && [ "$exp_t" != "$got_t" ]; then verdict="FAIL(tables)"; fi
    if [ "$exp_l" != "-" ] && [ "$exp_l" != "$got_l" ]; then verdict="FAIL(ledger)"; fi
    if [ "$got_t" = "0" ]; then verdict="FAIL(empty)"; fi
    if [ "$exp_t" = "-" ] && [ "$exp_l" = "-" ] && [ "$verdict" = "PASS" ]; then verdict="PASS(no-expectation-recorded)"; fi
    [[ "$verdict" == PASS* ]] || fail=1
    out="${out}"$'\n'"$(printf '%-20s %-22s %10s %10s %-32s %10s %10s %s' "$db" "$format" "$got_t" "$exp_t" "$lt" "$got_l" "$exp_l" "$verdict")"
  done 3< <(awk -F'\t' '$1=="artifact"' "$manifest")

  local overall="PASS"
  [ "$fail" = "0" ] || overall="FAIL"
  out="${out}"$'\n'"overall=${overall}"
  printf '%s\n' "$out"
  if [ -n "$report" ]; then printf '%s\n' "$out" >"$report"; fi
  printf '%s\n' "$out" >"$WORK/report.txt"
  # Remove the throwaway database (container + volumes) BEFORE reporting PASS.
  remove_container "$CONTAINER"
  CONTAINER=""
  upload_report "$WORK/report.txt" "$overall"
  [ "$fail" = "0" ] || exit 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
