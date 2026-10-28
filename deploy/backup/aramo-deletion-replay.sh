#!/usr/bin/env bash
# Aramo — deletion replay after a restore (M-A7 §2 "Restores") — SKELETON.
#
# CONTRACT (normative; the implementation lands with the WS-4 privacy-request
# capability, M-A7 §3):
#
#   When a backup taken at T_backup is restored, every DELETION privacy request
#   whose execution COMPLETED after T_backup must be re-applied to the restored
#   database BEFORE that database serves any traffic. Otherwise a restore would
#   silently resurrect data Aramo told a person it had deleted.
#
#   Inputs
#     --db-container <name>   the container holding the RESTORED database
#                             (never the live production database);
#     --backup-created-at <ISO-8601 UTC>   manifest.tsv `created_at` of the run;
#     --source <path|ref>     the replay source: the privacy-request ledger's
#                             completed-deletion records (WS-4), exported from
#                             the CURRENT production database (or its newest
#                             surviving copy), never from the restored one.
#   Selection
#     request type DELETION, status COMPLETED, completed_at > backup_created_at,
#     ordered by completed_at ascending. Each record carries the request id,
#     subject kind, tenant scope and the execution plan the original run used.
#   Execution
#     re-run the SAME execution service the original request used (M-A7 §3.2
#     rules: tenant isolation, shared-identity guard, retention exceptions,
#     legal hold), in replay mode against the restored database, idempotently
#     (an already-absent object is a no-op, not an error).
#   Output
#     counts-only evidence per request id (no personal data), plus an overall
#     verdict. Exit 0 only when every selected request replayed cleanly.
#   Gate
#     A restored database is NOT returned to service while this hook exits
#     non-zero. A legal hold recorded after T_backup is honoured (the replay
#     must not delete held data).
#
# Until the WS-4 records exist this script FAILS CLOSED (exit 3): it validates
# its arguments and refuses, so a restore runbook that calls it cannot proceed
# by accident. It deliberately contains no stand-in deletion logic.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/backup/lib.sh disable=SC1091
source "$DIR/lib.sh"
BK_TAG="aramo-deletion-replay"

main() {
  local container="" created_at="" source_ref=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --db-container) container="${2:-}"; shift 2 ;;
      --backup-created-at) created_at="${2:-}"; shift 2 ;;
      --source) source_ref="${2:-}"; shift 2 ;;
      -h | --help) sed -n '2,45p' "$0"; exit 0 ;;
      *) bk_die "unknown argument: $1" 2 ;;
    esac
  done
  [ -n "$container" ] || bk_die "--db-container is required" 2
  [ "$container" != "aramo-prod-postgres" ] ||
    bk_die "refusing to target the live production container; replay runs on the RESTORED database" 2
  [[ "$created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    bk_die "--backup-created-at must be ISO-8601 UTC (manifest created_at)" 2

  # select_completed_deletions <source> <created_at>  — WS-4 (M-A7 §3.1)
  # replay_one <container> <request>                  — WS-4 execution service, replay mode
  # emit_counts_evidence                              — counts only
  bk_log "deletion-replay source not available yet: the privacy-request capability (M-A7 §3, WS-4) has not shipped${source_ref:+ (given --source ${source_ref})}."
  bk_log "FAIL CLOSED: the restored database in '${container}' (backup ${created_at}) MUST NOT be returned to service."
  bk_log "Until WS-4 lands, any production restore needs an explicit PO decision recording which completed deletions were re-applied by hand."
  exit 3
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
