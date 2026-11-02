#!/usr/bin/env bash
# Aramo single box — health probe (Sign production monitoring, PO 2026-11-01).
#
# Runs on the box every 5 minutes (deploy/systemd/aramo-health-probe.timer), as root,
# and checks:
#   container:<name>   running, not unhealthy, no restart since the previous run
#   disk:<path>        used % below MON_DISK_FAIL_PCT
#   memory             MemAvailable % above MON_MEM_AVAIL_MIN_PCT
#   http:<name>        each front-door route answers its expected status through the
#                      LOCAL nginx (curl --resolve <host>:443:127.0.0.1): tenant SPA,
#                      auth (JWKS), api, sign-service, platform-admin
#   tls:<host>         certificate served for <host> has more than MON_TLS_MIN_DAYS left
#   nginx:5xx          5xx share of the requests nginx logged since the previous run
#   sign:kms           sign-service log lines naming a KMS evidence-signing failure
#   sign:custody       custody upload / reconcile failures, ledger or hash mismatches
#   sign:purge         purge run / queue / execute failures
#   sign:purge-r13     an integration envelope purged before its executed copy was confirmed
#   sign:retention     retention / convenience-data purge failures
#   sign:privacy       privacy-request execution failures
#   backup             newest local backup heartbeat is OK and younger than
#                      MON_BACKUP_MAX_AGE_HOURS (deploy/backup/aramo-backup.sh writes it)
#
# Alerting: one SNS email per CHANGE (a check starts failing, or recovers), plus a
# reminder every MON_REMIND_HOURS while a check keeps failing. Metrics (heartbeat,
# failing-check count, 5xx, disk, memory, TLS days, Sign signal counts) go to CloudWatch
# namespace MON_METRIC_NAMESPACE; the off-box watchdog Lambda
# (infrastructure-monitoring/) alerts when the heartbeat stops (box down or probe dead).
#
# The alert carries check names, counts and short details only: never log lines, request
# paths, email addresses or tokens. The operator reads the logs on the box (runbook:
# doc/runbooks/sign/monitoring-and-alerts.md).
#
# Usage:
#   aramo-health-probe.sh              one run (systemd)
#   aramo-health-probe.sh --dry-run    one run, print results, no AWS calls, no state change
# Config: /etc/aramo/monitoring.conf (root:root 0600), loaded by the systemd unit's
# EnvironmentFile=; example: deploy/monitoring/monitoring.conf.example.
# Exit: 0 = ran (whatever the checks found); 2 = usage/config error; 3 = an alert or the
# metrics could not be delivered (systemd marks the run failed, journal keeps the reason).
#
# Pure functions are unit-tested by deploy/monitoring/aramo-health-probe.test.sh (no
# docker, no AWS); the body below `main` runs only when executed, not when sourced.
set -uo pipefail
umask 077

MON_HOST_LABEL="${MON_HOST_LABEL:-astre-prod}"
MON_STATE_DIR="${MON_STATE_DIR:-/var/lib/aramo-monitoring}"
MON_SNS_TOPIC_ARN="${MON_SNS_TOPIC_ARN:-}"
MON_METRIC_NAMESPACE="${MON_METRIC_NAMESPACE:-Aramo/Prod}"
MON_PUBLISH_METRICS="${MON_PUBLISH_METRICS:-1}"
MON_AWS_CLI_IMAGE="${MON_AWS_CLI_IMAGE:-amazon/aws-cli:2.17.0}"
# Container names: docker-compose.prod.yml container_name values.
MON_CONTAINERS="${MON_CONTAINERS:-aramo-prod-nginx aramo-prod-api aramo-prod-auth aramo-prod-sign aramo-prod-platform-admin aramo-prod-intelligence aramo-prod-talent-intake-worker aramo-prod-postgres aramo-prod-redis aramo-prod-certbot}"
# The worker image inherits a TCP healthcheck it cannot pass (no HTTP port): its health
# state is ignored; running + restarts still count.
MON_HEALTH_IGNORE="${MON_HEALTH_IGNORE-aramo-prod-talent-intake-worker}"
MON_NGINX_CONTAINER="${MON_NGINX_CONTAINER:-aramo-prod-nginx}"
MON_SIGN_CONTAINER="${MON_SIGN_CONTAINER:-aramo-prod-sign}"
MON_TENANT_HOST="${MON_TENANT_HOST:-astre.aramo.ai}"
MON_SIGN_HOST="${MON_SIGN_HOST:-sign.aramo.ai}"
MON_ADMIN_HOST="${MON_ADMIN_HOST:-admin.aramo.ai}"
# name|host|path|expected codes (comma list). Unauthenticated reads: 401 proves the
# request reached the service behind nginx (502/503/504/000 = it did not).
MON_ENDPOINTS="${MON_ENDPOINTS:-tenant-spa|${MON_TENANT_HOST}|/|200
auth-jwks|${MON_TENANT_HOST}|/.well-known/jwks.json|200
api|${MON_TENANT_HOST}|/v1/tenant/settings|401
sign|${MON_SIGN_HOST}|/v1/sign/legal/status|401
platform-admin|${MON_ADMIN_HOST}|/platform/me|401}"
MON_TLS_HOSTS="${MON_TLS_HOSTS-${MON_TENANT_HOST} ${MON_SIGN_HOST} ${MON_ADMIN_HOST}}"
MON_TLS_MIN_DAYS="${MON_TLS_MIN_DAYS:-14}"
MON_DISK_PATHS="${MON_DISK_PATHS:-/ /var/lib/docker}"
MON_DISK_FAIL_PCT="${MON_DISK_FAIL_PCT:-85}"
MON_MEM_AVAIL_MIN_PCT="${MON_MEM_AVAIL_MIN_PCT:-10}"
MON_MEMINFO="${MON_MEMINFO:-/proc/meminfo}"
MON_5XX_MIN_COUNT="${MON_5XX_MIN_COUNT:-10}"
MON_5XX_MAX_PCT="${MON_5XX_MAX_PCT:-5}"
MON_BACKUP_DIR="${MON_BACKUP_DIR:-/var/backups/aramo-r15}"
MON_BACKUP_MAX_AGE_HOURS="${MON_BACKUP_MAX_AGE_HOURS:-26}"
# 0 until the M-A8 box enablement has installed the backup timer: a missing heartbeat
# directory is then reported as OK ("not enabled"), not as a failure.
MON_BACKUP_REQUIRED="${MON_BACKUP_REQUIRED:-0}"
MON_REMIND_HOURS="${MON_REMIND_HOURS:-6}"
# First run (no state): look back this far in the logs.
MON_DEFAULT_LOOKBACK_SECONDS="${MON_DEFAULT_LOOKBACK_SECONDS:-600}"

# --- Sign log signals (grounded in apps/sign-service/src/app/**) ----------------------
# kms: kms-evidence-manifest-signer.ts (KmsEvidenceKeyRefusedError message prefix, the
#      empty-signature error, the production boot refusal) + AWS KMS SDK exception names.
MON_RE_SIGN_KMS='KMS evidence signing key refused|KMS Sign returned no signature|sign-service refuses to start|KMSInvalidStateException|KMSInternalException|KMSInvalidSignatureException|DisabledException|KeyUnavailableException|IncorrectKeyException'
# custody: custody/executed-artifact-custody.service.ts + sign-artifact-reconcile.worker.ts,
#      and the ledger/hash refusals (ExecutedArtifactLedgerMismatchError, verifiedSha).
MON_RE_SIGN_CUSTODY='sign_artifact_custody\.(completion_failed|upload_failed|reconcile_envelope_failed|reconcile_failed)|sign_artifact_custody\.reconcile .*failed=[1-9]|ExecutedArtifactLedgerMismatchError|do not match the recorded sha256'
# purge: retention/sign-purge.service.ts.
MON_RE_SIGN_PURGE='sign_purge\.(execute_failed|queue_failed)|purge run failed|sign_purge\.run .*failed=[1-9]'
MON_RE_SIGN_PURGE_R13='sign_purge\.alert_integration_copy_unconfirmed'
# retention: retention/sign-retention.worker.ts + sign-retention.service.ts.
MON_RE_SIGN_RETENTION='retention run failed|convenience-data purge failed'
# privacy: privacy/sign-privacy-execution.service.ts + .worker.ts.
MON_RE_SIGN_PRIVACY='privacy request [^ ]+ execution failed|privacy execution of [^ ]+ failed'
# Remaining-Work Directive §3 B9 — the vendor paths and metering (one check each; every line
# is written by sign-service only when the feature's provider is configured, so these stay at 0
# while the features are dark).
# webhooks: webhook-log.ts (sign_webhook.rejected / .failed: WhatsApp, inbound SMS, Stripe
#      Identity, Stripe Connect, Stripe billing) + payments/sign-payment.service.ts. Only the
#      reasons that mean a misconfigured secret, a replay or a wrong topic alert; a request with
#      no signature at all (MISSING / MALFORMED / NO_SECRET) is internet noise and does not.
MON_RE_SIGN_WEBHOOK='sign_webhook\.rejected source=[a-z_]+ reason=(BAD_SIGNATURE|STALE|WRONG_TOPIC|UNTRUSTED_CERT_URL|CERT_UNAVAILABLE)|sign_webhook\.failed |payment webhook [^ ]+ \([^)]*\) refused'
# messaging: messaging/sign-messaging.service.ts (a provider send error, or the send flow
#      failing) + messaging-adapters.ts (a provider asked for but left off at boot) +
#      sign-messaging.controller.ts (the SNS subscription for inbound STOP removed).
MON_RE_SIGN_MESSAGING='sign_messaging\.send_failed |signing-link message failed|SIGN_(SMS|WHATSAPP)_PROVIDER (includes [a-z0-9]+|is meta) but|SIGN_SMS_MSG91 configuration refused|SIGN_(SMS|WHATSAPP)_PROVIDER: unknown provider|sms inbound: SNS subscription removed'
# tsa-seal: libs/sign trusted-timestamp.service.ts (attempts_exceeded) + trusted-timestamp-
#      retry.worker.ts; libs/sign document-seal.service.ts (the final attempt) + document-seal-
#      retry.worker.ts.
MON_RE_SIGN_TSA_SEAL='trusted_timestamp\.attempts_exceeded|trusted timestamp retry tick failed|document_seal\.attempt_failed .* final|document_seal\.retry_failed'
# metering: libs/subscription usage-provider-report.service.ts (usage_report.failed, the
#      live-mode hold) + billing/sign-usage-report.worker.ts + the usage-record failures of
#      sign-messaging.service.ts and libs/sign identity-verification.service.ts.
MON_RE_SIGN_METERING='usage_report\.failed |usage report tick failed|usage reports not sent: the provider key is live-mode|usage not recorded for message|identity verification usage not recorded'

TAB="$(printf '\t')"

mon_log() { printf '[aramo-health-probe] %s\n' "$*" >&2; }

# ======================================================================================
# Pure functions (unit-tested; no docker, no AWS, no clock reads)
# ======================================================================================

# stdin: nginx access lines in the aramo_redacted format
#   <addr> [<time>] "<METHOD> <uri> <proto>" <status> <bytes> "<ref>" "<ua>" <rt>
# stdout: "<total> <five_xx>". Lines that do not match the format are ignored.
mon_count_5xx() {
  sed -nE 's/^[^"]*"[A-Z]+ [^"]*" ([0-9]{3}) .*$/\1/p' | awk '
    { total++; if ($1 >= 500 && $1 <= 599) bad++ }
    END { printf "%d %d\n", total, bad }'
}

# mon_5xx_verdict <total> <five_xx> <min_count> <max_pct> → OK | FAIL
# FAIL only when BOTH the absolute count and the share cross their thresholds, so one
# 502 on a quiet night does not page anyone.
mon_5xx_verdict() {
  local total="$1" bad="$2" min="$3" max_pct="$4"
  if [ "$bad" -ge "$min" ] && [ "$total" -gt 0 ] && [ $((bad * 100)) -ge $((max_pct * total)) ]; then
    echo FAIL
  else
    echo OK
  fi
}

# mon_count_matches <extended-regex>; stdin: log lines; stdout: matching line count.
mon_count_matches() {
  local n
  n="$(grep -Ec -- "$1" || true)"
  echo "${n:-0}"
}

# mon_container_verdict <state> <health> <restarts> <prev_restarts|-> <ignore_health 0|1>
# stdout: "<OK|FAIL> <detail>". prev "-" = first sighting of this container id.
mon_container_verdict() {
  local state="$1" health="$2" restarts="$3" prev="$4" ignore="$5"
  if [ "$state" != "running" ]; then
    echo "FAIL state=${state}"
    return
  fi
  if [ "$ignore" != "1" ] && [ "$health" = "unhealthy" ]; then
    echo "FAIL health=unhealthy restarts=${restarts}"
    return
  fi
  if [ "$prev" != "-" ] && [ "$restarts" -gt "$prev" ]; then
    echo "FAIL restarted $((restarts - prev))x since the previous run (total ${restarts})"
    return
  fi
  echo "OK health=${health} restarts=${restarts}"
}

# mon_threshold_max <value> <limit> → FAIL when value >= limit (disk used %).
mon_threshold_max() { if [ "$1" -ge "$2" ]; then echo FAIL; else echo OK; fi; }
# mon_threshold_min <value> <limit> → FAIL when value < limit (memory available %, TLS days).
mon_threshold_min() { if [ "$1" -lt "$2" ]; then echo FAIL; else echo OK; fi; }

# mon_http_verdict <code> <expected comma list> → OK | FAIL
mon_http_verdict() {
  local code="$1" e
  local IFS=','
  for e in $2; do
    [ "$code" = "$e" ] && { echo OK; return; }
  done
  echo FAIL
}

# mon_mem_avail_pct; stdin: /proc/meminfo; stdout: integer MemAvailable % of MemTotal.
mon_mem_avail_pct() {
  awk '/^MemTotal:/ {t=$2} /^MemAvailable:/ {a=$2} END { if (t > 0) printf "%d\n", (a * 100) / t; else print 0 }'
}

# mon_backup_verdict <newest_ok_epoch|0> <newest_failed_epoch|0> <now> <max_age_hours> <required 0|1> <dir_exists 0|1>
# stdout: "<OK|FAIL> <detail>"
mon_backup_verdict() {
  local ok="$1" failed="$2" now="$3" max_h="$4" required="$5" exists="$6"
  if [ "$exists" != "1" ]; then
    if [ "$required" = "1" ]; then echo "FAIL no heartbeat directory"; else echo "OK backups not enabled on this box (MON_BACKUP_REQUIRED=0)"; fi
    return
  fi
  if [ "$failed" -gt "$ok" ]; then
    echo "FAIL newest heartbeat is FAILED"
    return
  fi
  if [ "$ok" -eq 0 ]; then
    echo "FAIL no OK heartbeat"
    return
  fi
  local age_h=$(((now - ok) / 3600))
  if [ "$age_h" -ge "$max_h" ]; then
    echo "FAIL newest OK backup is ${age_h}h old (limit ${max_h}h)"
  else
    echo "OK newest OK backup ${age_h}h old"
  fi
}

# mon_transitions <prev_state_file> <results_file> <now> <remind_hours> <new_state_file>
# prev/new state: "<check>\t<failing_since>\t<last_notified>" per failing check.
# results: "<check>\t<OK|FAIL>\t<detail>".
# stdout: one line per notification: "NEW_FAIL\t<check>", "STILL_FAILING\t<check>",
# "RECOVERED\t<check>". Writes the new state file.
mon_transitions() {
  local prev="$1" results="$2" now="$3" remind_h="$4" out="$5"
  local remind_s=$((remind_h * 3600))
  : >"$out"
  awk -F'\t' -v now="$now" -v remind="$remind_s" -v out="$out" '
    FILENAME == ARGV[1] { since[$1] = $2; notified[$1] = $3; next }
    $2 == "FAIL" {
      failing[$1] = 1
      if (!($1 in since)) {
        print "NEW_FAIL\t" $1
        print $1 "\t" now "\t" now > out
      } else if (now - notified[$1] >= remind) {
        print "STILL_FAILING\t" $1
        print $1 "\t" since[$1] "\t" now > out
      } else {
        print $1 "\t" since[$1] "\t" notified[$1] > out
      }
      next
    }
    { seen[$1] = 1 }
    END {
      for (c in since) if (!(c in failing) && (c in seen)) print "RECOVERED\t" c
      # A check that did not run this time (e.g. a container removed from the list)
      # keeps its state rather than "recovering" silently.
      for (c in since) if (!(c in failing) && !(c in seen)) print c "\t" since[c] "\t" notified[c] > out
    }' "$prev" "$results"
}

# mon_restart_prev <restarts_file> <container_id> → previous restart count or "-".
mon_restart_prev() {
  awk -F'\t' -v id="$2" '$1 == id { v = $2 } END { if (v == "") print "-"; else print v }' "$1" 2>/dev/null || echo "-"
}

# mon_json_escape <string> → the string as a JSON string body (no surrounding quotes).
mon_json_escape() {
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } {
    gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\t/, " ");
    if (NR > 1) printf "\\n"; printf "%s", $0 }'
}

# ======================================================================================
# Side-effecting helpers
# ======================================================================================

RESULTS=""

mon_result() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RESULTS"; }

mon_aws() {
  if command -v aws >/dev/null 2>&1; then
    aws "$@"
  else
    docker run --rm -i \
      -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
      -e AWS_REGION -e AWS_DEFAULT_REGION \
      "$MON_AWS_CLI_IMAGE" "$@"
  fi
}

check_containers() {
  local restarts_file="$MON_STATE_DIR/restarts.tsv" new_restarts c line id state health restarts prev ignore verdict
  new_restarts="$(mktemp)"
  for c in $MON_CONTAINERS; do
    line="$(docker inspect -f '{{.Id}} {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}' "$c" 2>/dev/null || true)"
    if [ -z "$line" ]; then
      mon_result "container:${c}" FAIL "container not found"
      continue
    fi
    read -r id state health restarts <<<"$line"
    prev="$(mon_restart_prev "$restarts_file" "$id")"
    ignore=0
    case " $MON_HEALTH_IGNORE " in *" $c "*) ignore=1 ;; esac
    verdict="$(mon_container_verdict "$state" "$health" "$restarts" "$prev" "$ignore")"
    mon_result "container:${c}" "${verdict%% *}" "${verdict#* }"
    printf '%s\t%s\n' "$id" "$restarts" >>"$new_restarts"
  done
  [ "$DRY_RUN" = 1 ] || mv "$new_restarts" "$restarts_file"
  rm -f "$new_restarts"
}

METRIC_DISK_MAX=0
check_disk() {
  local p pct
  for p in $MON_DISK_PATHS; do
    [ -e "$p" ] || continue
    pct="$(df -P "$p" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
    if [ -z "$pct" ]; then
      mon_result "disk:${p}" FAIL "df failed"
      continue
    fi
    [ "$pct" -gt "$METRIC_DISK_MAX" ] && METRIC_DISK_MAX="$pct"
    mon_result "disk:${p}" "$(mon_threshold_max "$pct" "$MON_DISK_FAIL_PCT")" "${pct}% used (limit ${MON_DISK_FAIL_PCT}%)"
  done
}

METRIC_MEM_AVAIL=100
check_memory() {
  METRIC_MEM_AVAIL="$(mon_mem_avail_pct <"$MON_MEMINFO")"
  mon_result memory "$(mon_threshold_min "$METRIC_MEM_AVAIL" "$MON_MEM_AVAIL_MIN_PCT")" "${METRIC_MEM_AVAIL}% available (minimum ${MON_MEM_AVAIL_MIN_PCT}%)"
}

check_http() {
  local name host path expect code
  while IFS='|' read -r name host path expect; do
    [ -n "$name" ] || continue
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 \
      --resolve "${host}:443:127.0.0.1" "https://${host}${path}" 2>/dev/null || true)"
    code="${code:-000}"
    mon_result "http:${name}" "$(mon_http_verdict "$code" "$expect")" "HTTP ${code} (expected ${expect}) ${host}${path}"
  done <<<"$MON_ENDPOINTS"
}

METRIC_TLS_MIN=9999
check_tls() {
  local host end end_epoch days
  if ! command -v openssl >/dev/null 2>&1; then
    mon_result tls FAIL "openssl not installed on the box: TLS expiry not checked here (the watchdog Lambda still checks it)"
    return
  fi
  for host in $MON_TLS_HOSTS; do
    end="$(openssl s_client -connect 127.0.0.1:443 -servername "$host" </dev/null 2>/dev/null |
      openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
    end_epoch="$(date -u -d "$end" +%s 2>/dev/null || true)"
    if [ -z "$end" ] || [ -z "$end_epoch" ]; then
      mon_result "tls:${host}" FAIL "could not read the served certificate"
      continue
    fi
    days=$(((end_epoch - NOW) / 86400))
    [ "$days" -lt "$METRIC_TLS_MIN" ] && METRIC_TLS_MIN="$days"
    mon_result "tls:${host}" "$(mon_threshold_min "$days" "$MON_TLS_MIN_DAYS")" "${days} days left (minimum ${MON_TLS_MIN_DAYS})"
  done
}

METRIC_REQ=0
METRIC_5XX=0
check_nginx_5xx() {
  local counts
  counts="$(docker logs --since "$SINCE" "$MON_NGINX_CONTAINER" 2>/dev/null | mon_count_5xx)"
  METRIC_REQ="${counts%% *}"
  METRIC_5XX="${counts##* }"
  mon_result nginx:5xx "$(mon_5xx_verdict "$METRIC_REQ" "$METRIC_5XX" "$MON_5XX_MIN_COUNT" "$MON_5XX_MAX_PCT")" \
    "${METRIC_5XX} of ${METRIC_REQ} requests were 5xx since the previous run (alert at >=${MON_5XX_MIN_COUNT} and >=${MON_5XX_MAX_PCT}%)"
}

METRIC_SIGN_KMS=0
METRIC_SIGN_CUSTODY=0
METRIC_SIGN_PURGE=0
METRIC_SIGN_R13=0
METRIC_SIGN_WEBHOOK=0
METRIC_SIGN_MESSAGING=0
METRIC_SIGN_TSA_SEAL=0
METRIC_SIGN_METERING=0
check_sign_logs() {
  local logs n
  logs="$(mktemp)"
  if ! docker logs --since "$SINCE" "$MON_SIGN_CONTAINER" >"$logs" 2>&1; then
    mon_result sign:logs FAIL "could not read ${MON_SIGN_CONTAINER} logs"
    rm -f "$logs"
    return
  fi
  METRIC_SIGN_KMS="$(mon_count_matches "$MON_RE_SIGN_KMS" <"$logs")"
  METRIC_SIGN_CUSTODY="$(mon_count_matches "$MON_RE_SIGN_CUSTODY" <"$logs")"
  METRIC_SIGN_PURGE="$(mon_count_matches "$MON_RE_SIGN_PURGE" <"$logs")"
  METRIC_SIGN_R13="$(mon_count_matches "$MON_RE_SIGN_PURGE_R13" <"$logs")"
  for pair in "sign:kms $METRIC_SIGN_KMS" "sign:custody $METRIC_SIGN_CUSTODY" "sign:purge $METRIC_SIGN_PURGE" "sign:purge-r13 $METRIC_SIGN_R13"; do
    set -- $pair
    if [ "$2" -gt 0 ]; then mon_result "$1" FAIL "$2 matching log line(s) since the previous run"; else mon_result "$1" OK "0 matching log lines"; fi
  done
  n="$(mon_count_matches "$MON_RE_SIGN_RETENTION" <"$logs")"
  if [ "$n" -gt 0 ]; then mon_result sign:retention FAIL "$n matching log line(s)"; else mon_result sign:retention OK "0 matching log lines"; fi
  n="$(mon_count_matches "$MON_RE_SIGN_PRIVACY" <"$logs")"
  if [ "$n" -gt 0 ]; then mon_result sign:privacy FAIL "$n matching log line(s)"; else mon_result sign:privacy OK "0 matching log lines"; fi
  METRIC_SIGN_WEBHOOK="$(mon_count_matches "$MON_RE_SIGN_WEBHOOK" <"$logs")"
  METRIC_SIGN_MESSAGING="$(mon_count_matches "$MON_RE_SIGN_MESSAGING" <"$logs")"
  METRIC_SIGN_TSA_SEAL="$(mon_count_matches "$MON_RE_SIGN_TSA_SEAL" <"$logs")"
  METRIC_SIGN_METERING="$(mon_count_matches "$MON_RE_SIGN_METERING" <"$logs")"
  for pair in "sign:webhooks $METRIC_SIGN_WEBHOOK" "sign:messaging $METRIC_SIGN_MESSAGING" "sign:tsa-seal $METRIC_SIGN_TSA_SEAL" "sign:metering $METRIC_SIGN_METERING"; do
    set -- $pair
    if [ "$2" -gt 0 ]; then mon_result "$1" FAIL "$2 matching log line(s) since the previous run"; else mon_result "$1" OK "0 matching log lines"; fi
  done
  rm -f "$logs"
}

check_backup() {
  local dir="$MON_BACKUP_DIR/heartbeat" exists=0 newest_ok=0 newest_failed=0 f m verdict
  if [ -d "$dir" ]; then
    exists=1
    for f in "$dir"/*.json; do
      [ -e "$f" ] || continue
      m="$(stat -c %Y "$f" 2>/dev/null || echo 0)"
      if grep -q '"status":"OK"' "$f"; then
        [ "$m" -gt "$newest_ok" ] && newest_ok="$m"
      else
        [ "$m" -gt "$newest_failed" ] && newest_failed="$m"
      fi
    done
  fi
  verdict="$(mon_backup_verdict "$newest_ok" "$newest_failed" "$NOW" "$MON_BACKUP_MAX_AGE_HOURS" "$MON_BACKUP_REQUIRED" "$exists")"
  mon_result backup "${verdict%% *}" "${verdict#* }"
}

publish_metrics() {
  local failing="$1" dim data
  dim="[{\"Name\":\"Host\",\"Value\":\"$(mon_json_escape "$MON_HOST_LABEL")\"}]"
  data="["
  data+="{\"MetricName\":\"ProbeHeartbeat\",\"Value\":1,\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"FailingChecks\",\"Value\":${failing},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"NginxRequests\",\"Value\":${METRIC_REQ},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"Nginx5xx\",\"Value\":${METRIC_5XX},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"DiskUsedPctMax\",\"Value\":${METRIC_DISK_MAX},\"Unit\":\"Percent\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"MemAvailablePct\",\"Value\":${METRIC_MEM_AVAIL},\"Unit\":\"Percent\",\"Dimensions\":${dim}},"
  if [ "$METRIC_TLS_MIN" -ne 9999 ]; then
    data+="{\"MetricName\":\"TlsDaysRemainingMin\",\"Value\":${METRIC_TLS_MIN},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  fi
  data+="{\"MetricName\":\"SignKmsErrors\",\"Value\":${METRIC_SIGN_KMS},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignCustodyErrors\",\"Value\":${METRIC_SIGN_CUSTODY},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignPurgeErrors\",\"Value\":${METRIC_SIGN_PURGE},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignPurgeR13Alerts\",\"Value\":${METRIC_SIGN_R13},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignWebhookErrors\",\"Value\":${METRIC_SIGN_WEBHOOK},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignMessagingErrors\",\"Value\":${METRIC_SIGN_MESSAGING},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignTimestampSealErrors\",\"Value\":${METRIC_SIGN_TSA_SEAL},\"Unit\":\"Count\",\"Dimensions\":${dim}},"
  data+="{\"MetricName\":\"SignMeteringErrors\",\"Value\":${METRIC_SIGN_METERING},\"Unit\":\"Count\",\"Dimensions\":${dim}}"
  data+="]"
  mon_aws cloudwatch put-metric-data --namespace "$MON_METRIC_NAMESPACE" --metric-data "$data" >/dev/null
}

# Builds the email body from the transitions and the current results.
alert_message() {
  local transitions="$1"
  printf 'Aramo health probe on %s at %s\n\n' "$MON_HOST_LABEL" "$(date -u +%FT%TZ)"
  printf 'Changes:\n'
  awk -F'\t' '{ printf "  %-14s %s\n", $1, $2 }' "$transitions"
  printf '\nCurrently failing:\n'
  awk -F'\t' '$2 == "FAIL" { printf "  %-34s %s\n", $1, $3; n++ } END { if (n == 0) print "  (none)" }' "$RESULTS"
  printf '\nRunbook: doc/runbooks/sign/monitoring-and-alerts.md (one section per check name).\n'
  printf 'On the box: sudo systemctl status aramo-health-probe.service; sudo cat %s/last-status.tsv\n' "$MON_STATE_DIR"
}

main() {
  DRY_RUN=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1 ;;
      -h | --help) sed -n '2,40p' "$0"; exit 0 ;;
      *) mon_log "unknown argument: $1"; exit 2 ;;
    esac
    shift
  done
  command -v docker >/dev/null 2>&1 || { mon_log "docker not found"; exit 2; }
  command -v curl >/dev/null 2>&1 || { mon_log "curl not found"; exit 2; }
  mkdir -p "$MON_STATE_DIR"
  chmod 700 "$MON_STATE_DIR"

  exec 9>"$MON_STATE_DIR/.lock"
  if command -v flock >/dev/null 2>&1 && ! flock -n 9; then
    mon_log "another run holds the lock; skipping"
    exit 0
  fi

  NOW="$(date -u +%s)"
  SINCE="$(cat "$MON_STATE_DIR/last-run" 2>/dev/null || true)"
  case "$SINCE" in '' | *[!0-9]*) SINCE=$((NOW - MON_DEFAULT_LOOKBACK_SECONDS)) ;; esac
  RESULTS="$(mktemp)"

  check_containers
  check_disk
  check_memory
  check_http
  check_tls
  check_nginx_5xx
  check_sign_logs
  check_backup

  local failing
  failing="$(awk -F'\t' '$2 == "FAIL"' "$RESULTS" | wc -l | tr -d ' ')"

  if [ "$DRY_RUN" = 1 ]; then
    column -t -s "$TAB" "$RESULTS" 2>/dev/null || cat "$RESULTS"
    mon_log "dry run: ${failing} failing check(s); no metrics, no alert, no state written"
    rm -f "$RESULTS"
    exit 0
  fi

  local rc=0 state="$MON_STATE_DIR/failing.tsv" new_state transitions
  [ -f "$state" ] || : >"$state"
  new_state="$(mktemp)"
  transitions="$(mktemp)"
  mon_transitions "$state" "$RESULTS" "$NOW" "$MON_REMIND_HOURS" "$new_state" >"$transitions"

  if [ "$MON_PUBLISH_METRICS" = 1 ]; then
    publish_metrics "$failing" || { mon_log "put-metric-data failed"; rc=3; }
  fi

  if [ -s "$transitions" ]; then
    local subject
    subject="[Aramo ${MON_HOST_LABEL}] ${failing} failing check(s)"
    if [ -z "$MON_SNS_TOPIC_ARN" ]; then
      mon_log "MON_SNS_TOPIC_ARN unset: alert not sent"
      alert_message "$transitions" >&2
      rc=3
    elif mon_aws sns publish --topic-arn "$MON_SNS_TOPIC_ARN" --subject "${subject:0:99}" \
      --message "$(alert_message "$transitions")" >/dev/null; then
      mv "$new_state" "$state"
    else
      # Keep the old state so the next run retries the notification.
      mon_log "sns publish failed; state kept for retry"
      rc=3
    fi
  else
    mv "$new_state" "$state"
  fi

  cp "$RESULTS" "$MON_STATE_DIR/last-status.tsv"
  printf '%s\n' "$NOW" >"$MON_STATE_DIR/last-run"
  rm -f "$RESULTS" "$new_state" "$transitions"
  mon_log "done: ${failing} failing check(s)"
  exit "$rc"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
