#!/usr/bin/env bash
# Aramo — deletion reconciliation after a restore (M-A8 §1.3.2).
#
# When a backup taken at T_backup (manifest.tsv `created_at`) is restored to serve
# production, every privacy DELETION executed after T_backup must be re-applied to
# the restored database BEFORE it serves traffic. Otherwise a restore would bring
# back data Aramo told a person it had deleted.
#
# Source of truth: the identity privacy-request ledger of the CURRENT database (or its
# newest surviving copy), never the restored one:
#   identity."PrivacyRequest"       (request_type, subject, status)
#   identity."PrivacyRequestEvent"  (append-only history)
# (libs/identity/prisma/migrations/20261030030000_privacy_requests). An EXECUTED
# deletion is a DELETION request with an event that moved it EXECUTING → COMPLETED
# (event_type STATUS_CHANGED, as written by the execution service), or an event of
# type EXECUTED, whose created_at is later than T_backup.
#
# Re-application uses the SAME idempotent execution service, not SQL written here:
#   plan   (default) select the executed deletions; print counts; write the plan
#          (request ids only) to --plan <file>. Empty → exit 0 ("empty replay").
#          Non-empty → exit 4: the restored database must not serve yet.
#   --stage  put each planned request into the RESTORED database in status
#          EXECUTING (copying the request row when the backup predates it), with a
#          REPLAY_STAGED event, in one transaction. Then run the sign-service
#          privacy execution worker against the restored database with
#          SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1, before it serves traffic.
#          Exit 4 (replay pending).
#   --verify every planned request is COMPLETED in the restored database → exit 0;
#          otherwise exit 4.
# While account-deletion execution is not activated (M-A8 §3, §4.4) no request is
# ever executed: the ledger holds no executed deletion, the replay is empty and the
# script says so. A ledger that does not exist yet (tables absent) is also empty.
#
# Safety: it REFUSES to stage into or verify against the live container — by name
# (BACKUP_LIVE_CONTAINER, default aramo-prod-postgres), when the target is the
# ledger's own container, or when the target is a docker compose service container
# (the restored database runs standalone). The ledger source is only ever READ.
#
# Usage:
#   aramo-deletion-replay.sh --backup-created-at 2026-10-28T03:30:05Z \
#     --source-container aramo-prod-postgres [--source-db aramo] \
#     --db-container <restored> [--db-name aramo] [--plan <file>] [--stage | --verify]
#
# Output is counts-only on stdout/stderr (no personal data); the plan file holds
# request ids, never names or addresses. Exit codes: 0 = nothing (left) to replay,
# 2 = usage/refusal, 3 = ledger error, 4 = replay required / pending.
set -euo pipefail
umask 077

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-deletion-replay"

BACKUP_LIVE_CONTAINER="${BACKUP_LIVE_CONTAINER:-aramo-prod-postgres}"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# q <container> <db> <sql>: psql as the container's own superuser.
q() {
  docker exec "$1" sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "$2"' _ "$2" "$3"
}

ledger_present() {
  [ "$(q "$1" "$2" "SELECT to_regclass('identity.\"PrivacyRequestEvent\"') IS NOT NULL AND to_regclass('identity.\"PrivacyRequest\"') IS NOT NULL")" = "t" ]
}

# Executed deletions after T_backup: one row per request (first execution event).
select_sql() {
  cat <<SQL
SELECT r.id, min(e.created_at) AS executed_at
FROM identity."PrivacyRequestEvent" e
JOIN identity."PrivacyRequest" r ON r.id = e.request_id
WHERE r.request_type = 'DELETION'
  AND e.created_at > '$1'::timestamptz
  AND ((e.event_type = 'STATUS_CHANGED' AND e.from_status = 'EXECUTING' AND e.to_status = 'COMPLETED')
       OR e.event_type = 'EXECUTED')
GROUP BY r.id
ORDER BY executed_at, r.id
SQL
}

refuse_live_target() {
  local target="$1" source="$2" labels
  [ "$target" != "$BACKUP_LIVE_CONTAINER" ] ||
    bk_die "refusing the live container '${target}': replay runs only on the RESTORED database" 2
  [ "$target" != "$source" ] ||
    bk_die "refusing: target '${target}' is the ledger's own container (the live database)" 2
  labels="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$target" 2>/dev/null)" ||
    bk_die "target container not found: ${target}" 2
  [ -z "$labels" ] || [ "$labels" = "<no value>" ] ||
    bk_die "refusing: '${target}' is a docker compose service container (${labels}); the restored database runs standalone" 2
}

id_list() { # quoted, comma-separated ids from the plan file
  awk -F'\t' '{printf "%s'"'"'%s'"'"'", (NR>1?",":""), $1}' "$1"
}

stage() {
  local target="$1" db="$2" source="$3" sdb="$4" plan="$5" created_at="$6" ids
  ids="$(id_list "$plan")"
  ledger_present "$target" "$db" || bk_die "the restored database has no identity privacy-request tables" 3
  {
    cat <<SQL
\\set ON_ERROR_STOP 1
BEGIN;
CREATE TEMP TABLE replay_src (LIKE identity."PrivacyRequest" INCLUDING DEFAULTS) ON COMMIT DROP;
COPY replay_src FROM STDIN;
SQL
    # Request rows from the ledger (read-only COPY OUT; streamed, never on disk).
    docker exec "$source" sh -c 'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -c "$2"' _ "$sdb" \
      "COPY (SELECT * FROM identity.\"PrivacyRequest\" WHERE id IN (${ids})) TO STDOUT"
    cat <<SQL
\\.
CREATE TEMP TABLE replay_prior ON COMMIT DROP AS
  SELECT s.id, p.status AS prior_status FROM replay_src s LEFT JOIN identity."PrivacyRequest" p ON p.id = s.id;
DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM replay_prior WHERE prior_status IN ('DENIED_WITH_REASON','CANCELLED')) THEN
    RAISE EXCEPTION 'a planned request is DENIED/CANCELLED in the restored database; resolve by hand';
  END IF;
END \$\$;
-- A request the backup predates is inserted already in EXECUTING (the guard trigger
-- forbids leaving a terminal status, so it is never inserted as COMPLETED).
UPDATE replay_src SET status = 'EXECUTING', completed_at = NULL, completion_evidence = NULL,
       outcome_code = NULL, outcome_text = NULL, updated_at = now();
INSERT INTO identity."PrivacyRequest" SELECT * FROM replay_src ON CONFLICT (id) DO NOTHING;
UPDATE identity."PrivacyRequest" p
   SET status = 'EXECUTING', updated_at = now()
  FROM replay_prior r
 WHERE p.id = r.id AND r.prior_status IS NOT NULL AND r.prior_status <> 'COMPLETED';
INSERT INTO identity."PrivacyRequestEvent" (id, request_id, event_type, from_status, to_status, actor_type, actor_id, payload, created_at)
  SELECT gen_random_uuid(), r.id, 'REPLAY_STAGED', r.prior_status, 'EXECUTING', 'SYSTEM', NULL,
         jsonb_build_object('backup_created_at', '${created_at}'), now()
    FROM replay_prior r WHERE r.prior_status IS DISTINCT FROM 'COMPLETED';
SELECT 'staged=' || count(*) FILTER (WHERE prior_status IS DISTINCT FROM 'COMPLETED')
       || ' inserted=' || count(*) FILTER (WHERE prior_status IS NULL)
       || ' already_completed=' || count(*) FILTER (WHERE prior_status = 'COMPLETED')
  FROM replay_prior;
COMMIT;
SQL
  } | docker exec -i "$target" sh -c 'psql -X -At -q -U "$POSTGRES_USER" -d "$1"' _ "$db"
}

main() {
  local created_at="" source="" sdb="aramo" target="" db="aramo" plan="" mode="plan"
  while [ $# -gt 0 ]; do
    case "$1" in
      --backup-created-at) created_at="${2:-}"; shift 2 ;;
      --source-container) source="${2:-}"; shift 2 ;;
      --source-db) sdb="${2:-}"; shift 2 ;;
      --db-container) target="${2:-}"; shift 2 ;;
      --db-name) db="${2:-}"; shift 2 ;;
      --plan) plan="${2:-}"; shift 2 ;;
      --stage) mode="stage"; shift ;;
      --verify) mode="verify"; shift ;;
      -h | --help) sed -n '2,50p' "$0"; exit 0 ;;
      *) bk_die "unknown argument: $1" 2 ;;
    esac
  done
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    bk_die "--backup-created-at must be ISO-8601 UTC (manifest created_at)" 2
  [ -n "$target" ] || bk_die "--db-container (the RESTORED database) is required" 2
  [ -n "$source" ] || bk_die "--source-container (the current ledger, read-only) is required" 2
  local n
  for n in "$sdb" "$db"; do
    [[ "$n" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || bk_die "invalid database name: ${n}" 2
  done
  bk_need docker awk
  refuse_live_target "$target" "$source"

  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/aramo-replay.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf -- '$work'" EXIT
  [ -n "$plan" ] || plan="$work/plan.tsv"

  if ! ledger_present "$source" "$sdb"; then
    : >"$plan"
    bk_log "ledger: identity privacy-request tables absent in ${source}/${sdb}; empty replay (nothing was ever executed)"
  else
    q "$source" "$sdb" "$(select_sql "$created_at")" | tr '|' '\t' >"$plan" ||
      bk_die "reading the ledger failed" 3
  fi
  awk -F'\t' -v re="$UUID_RE" '$1 !~ re {bad=1} END{exit bad}' "$plan" || bk_die "ledger returned a malformed request id" 3
  local count
  count="$(awk 'END{print NR}' "$plan")"
  chmod 600 "$plan"

  if [ "$count" = 0 ]; then
    bk_log "EMPTY REPLAY: 0 executed privacy deletions after ${created_at}."
    bk_log "  (account-deletion execution is not activated, or nothing was executed since the backup)"
    bk_log "  deletion reconciliation is complete for the restored database in '${target}'."
    printf 'replay backup_created_at=%s executed_deletions=0 verdict=EMPTY\n' "$created_at"
    exit 0
  fi

  case "$mode" in
    plan)
      bk_log "REPLAY REQUIRED: ${count} executed privacy deletion(s) after ${created_at}; plan: ${plan}"
      bk_log "next: --stage, run the privacy execution worker against '${target}', then --verify"
      printf 'replay backup_created_at=%s executed_deletions=%s verdict=REQUIRED\n' "$created_at" "$count"
      exit 4
      ;;
    stage)
      local res
      res="$(stage "$target" "$db" "$source" "$sdb" "$plan" "$created_at")" || bk_die "staging into ${target} FAILED (rolled back)" 3
      bk_log "staged into ${target}/${db}: ${res}"
      bk_log "now run the sign-service privacy execution worker against '${target}' with SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1, then --verify"
      printf 'replay backup_created_at=%s executed_deletions=%s verdict=STAGED %s\n' "$created_at" "$count" "$res"
      exit 4
      ;;
    verify)
      local done_n
      done_n="$(q "$target" "$db" "SELECT count(*) FROM identity.\"PrivacyRequest\" WHERE status = 'COMPLETED' AND id IN ($(id_list "$plan"))")" ||
        bk_die "verify query failed" 3
      printf 'replay backup_created_at=%s executed_deletions=%s completed_in_restore=%s verdict=%s\n' \
        "$created_at" "$count" "$done_n" "$([ "$done_n" = "$count" ] && echo COMPLETE || echo PENDING)"
      if [ "$done_n" = "$count" ]; then
        bk_log "VERIFIED: all ${count} replayed deletions are COMPLETED in the restored database"
        exit 0
      fi
      bk_log "PENDING: ${done_n}/${count} completed; the restored database MUST NOT serve traffic yet"
      exit 4
      ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
