#!/usr/bin/env bash
# Unit + stubbed end-to-end checks for deploy/monitoring/aramo-health-probe.sh.
# No docker, no AWS, no network: docker, curl and aws are stubs on PATH.
#
# Proves: the 5xx parser on the redacted nginx log format; the 5xx, container, disk,
# memory, HTTP and backup verdicts; the Sign log patterns match the exact log lines
# sign-service writes (and not their success lines); the transition logic (alert once
# on a new failure, remind after the interval, alert on recovery, stay quiet otherwise);
# a stubbed full run sends ONE SNS alert for a new failure, none on the repeat run, and
# a recovery alert when it clears; --dry-run makes no AWS call and writes no state.
#
# Run:  bash deploy/monitoring/aramo-health-probe.test.sh   (exit 0 = all cases correct)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$DIR/aramo-health-probe.sh"
# shellcheck source=deploy/monitoring/aramo-health-probe.sh disable=SC1091
source "$PROBE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
check() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf '  FAIL %s\n    got:  %s\n    want: %s\n' "$name" "$got" "$want"
  fi
}

# --- nginx 5xx --------------------------------------------------------------------
cat >"$TMP/nginx.log" <<'LOG'
203.0.113.7 [01/Nov/2026:10:00:01 +0000] "GET /v1/tenant/settings HTTP/2.0" 401 52 "https://astre.aramo.ai" "Mozilla/5.0 (X11) \"quoted\"" 0.004
203.0.113.7 [01/Nov/2026:10:00:02 +0000] "POST /v1/sign/signing/complete HTTP/2.0" 502 157 "-" "curl/8" 0.100
203.0.113.8 [01/Nov/2026:10:00:03 +0000] "GET /s/[redacted] HTTP/1.1" 200 1024 "-" "Safari" 0.001
203.0.113.9 [01/Nov/2026:10:00:04 +0000] "GET /auth/callback?[redacted] HTTP/1.1" 504 0 "[redacted]" "x" 60.000
2026/11/01 10:00:05 [crit] 30#30: some error line that is not an access line
LOG
check "5xx parse" "$(mon_count_5xx <"$TMP/nginx.log")" "4 2"
check "5xx empty" "$(printf '' | mon_count_5xx)" "0 0"
check "5xx below count" "$(mon_5xx_verdict 4 2 10 5)" "OK"
check "5xx count+share" "$(mon_5xx_verdict 100 10 10 5)" "FAIL"
check "5xx count, low share" "$(mon_5xx_verdict 10000 10 10 5)" "OK"

# --- verdicts ---------------------------------------------------------------------
check "container ok" "$(mon_container_verdict running healthy 0 0 0)" "OK health=healthy restarts=0"
check "container exited" "$(mon_container_verdict exited none 3 3 0)" "FAIL state=exited"
check "container unhealthy" "$(mon_container_verdict running unhealthy 0 0 0)" "FAIL health=unhealthy restarts=0"
check "container unhealthy ignored" "$(mon_container_verdict running unhealthy 0 0 1)" "OK health=unhealthy restarts=0"
check "container restarted" "$(mon_container_verdict running healthy 5 3 0)" "FAIL restarted 2x since the previous run (total 5)"
check "container first sighting" "$(mon_container_verdict running none 7 - 0)" "OK health=none restarts=7"
check "disk below" "$(mon_threshold_max 84 85)" "OK"
check "disk at limit" "$(mon_threshold_max 85 85)" "FAIL"
check "tls ok" "$(mon_threshold_min 30 14)" "OK"
check "tls low" "$(mon_threshold_min 13 14)" "FAIL"
check "http expected" "$(mon_http_verdict 401 401)" "OK"
check "http list" "$(mon_http_verdict 200 200,204)" "OK"
check "http 502" "$(mon_http_verdict 502 401)" "FAIL"
check "http none" "$(mon_http_verdict 000 200)" "FAIL"
printf 'MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:     300000 kB\n' >"$TMP/meminfo"
check "mem pct" "$(mon_mem_avail_pct <"$TMP/meminfo")" "7"
NOWT=1000000000
check "backup not enabled" "$(mon_backup_verdict 0 0 $NOWT 26 0 0)" "OK backups not enabled on this box (MON_BACKUP_REQUIRED=0)"
check "backup required, none" "$(mon_backup_verdict 0 0 $NOWT 26 1 0)" "FAIL no heartbeat directory"
check "backup fresh" "$(mon_backup_verdict $((NOWT - 3600)) 0 $NOWT 26 1 1)" "OK newest OK backup 1h old"
check "backup stale" "$(mon_backup_verdict $((NOWT - 30 * 3600)) 0 $NOWT 26 1 1)" "FAIL newest OK backup is 30h old (limit 26h)"
check "backup failed newest" "$(mon_backup_verdict $((NOWT - 7200)) $((NOWT - 60)) $NOWT 26 1 1)" "FAIL newest heartbeat is FAILED"
check "backup no ok" "$(mon_backup_verdict 0 0 $NOWT 26 1 1)" "FAIL no OK heartbeat"

# --- Sign log patterns: the exact lines sign-service writes -----------------------
E=11111111-2222-3333-4444-555555555555
cat >"$TMP/sign.log" <<LOG
[Nest] 1  - 11/01/2026, 10:00:00 AM     LOG [SignArtifactReconcileWorker] artifact custody reconcile enabled
[Nest] 1  - 11/01/2026, 10:00:00 AM     LOG [ExecutedArtifactCustodyService] sign_artifact_custody.reconcile envelopes=2 recorded=4 adopted=0 failed=0
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [ExecutedArtifactCustodyService] sign_artifact_custody.reconcile envelopes=2 recorded=3 adopted=0 failed=1
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [ExecutedArtifactCustodyService] sign_artifact_custody.upload_failed kind=EXECUTED_DOCUMENT artifact_id=$E error=AccessDenied
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [ExecutedArtifactCustodyService] sign_artifact_custody.completion_failed envelope_id=$E error=artifact bytes do not match the recorded sha256; custody refused
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [SignPurgeWorker] purge run failed: boom
[Nest] 1  - 11/01/2026, 10:00:00 AM     LOG [SignPurgeService] sign_purge.run queued_retention=1 queued_all_parties=0 executed=1 waiting_lock=0 held=0 failed=0
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [SignPurgeService] sign_purge.run queued_retention=0 queued_all_parties=0 executed=0 waiting_lock=0 held=0 failed=2
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [SignPurgeService] sign_purge.execute_failed envelope_id=$E error=x
[Nest] 1  - 11/01/2026, 10:00:00 AM     LOG [SignPurgeService] sign_purge.waiting_object_lock envelope_id=$E locked_versions=2 until=2033-01-01T00:00:00.000Z
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [SignPurgeService] sign_purge.alert_integration_copy_unconfirmed envelope_id=$E
[Nest] 1  - 11/01/2026, 10:00:00 AM   ERROR [ExceptionsHandler] KMS evidence signing key refused: key state is Disabled, expected Enabled
[Nest] 1  - 11/01/2026, 10:00:00 AM   ERROR [ExceptionsHandler] KMSInvalidStateException: arn is pending deletion
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [SignRetentionWorker] retention run failed: x
[Nest] 1  - 11/01/2026, 10:00:00 AM    WARN [SignPrivacyExecutionService] privacy request PR-7K3M-9QX2-H4TD execution failed: Error
LOG
check "kms lines" "$(mon_count_matches "$MON_RE_SIGN_KMS" <"$TMP/sign.log")" "2"
check "custody lines" "$(mon_count_matches "$MON_RE_SIGN_CUSTODY" <"$TMP/sign.log")" "3"
check "purge lines" "$(mon_count_matches "$MON_RE_SIGN_PURGE" <"$TMP/sign.log")" "3"
check "r13 lines" "$(mon_count_matches "$MON_RE_SIGN_PURGE_R13" <"$TMP/sign.log")" "1"
check "retention lines" "$(mon_count_matches "$MON_RE_SIGN_RETENTION" <"$TMP/sign.log")" "1"
check "privacy lines" "$(mon_count_matches "$MON_RE_SIGN_PRIVACY" <"$TMP/sign.log")" "1"
check "no match" "$(printf 'all good\n' | mon_count_matches "$MON_RE_SIGN_KMS")" "0"

# --- transitions ------------------------------------------------------------------
: >"$TMP/s0"
printf 'a\tOK\tx\nb\tFAIL\ty\n' >"$TMP/r1"
check "new fail" "$(mon_transitions "$TMP/s0" "$TMP/r1" 1000 6 "$TMP/s1" | tr '\t' ' ')" "NEW_FAIL b"
check "state after new fail" "$(tr '\t' ' ' <"$TMP/s1")" "b 1000 1000"
check "quiet while failing" "$(mon_transitions "$TMP/s1" "$TMP/r1" 2000 6 "$TMP/s2" | tr '\t' ' ')" ""
check "state kept" "$(tr '\t' ' ' <"$TMP/s2")" "b 1000 1000"
check "reminder" "$(mon_transitions "$TMP/s2" "$TMP/r1" $((1000 + 6 * 3600)) 6 "$TMP/s3" | tr '\t' ' ')" "STILL_FAILING b"
check "state after reminder" "$(tr '\t' ' ' <"$TMP/s3")" "b 1000 $((1000 + 6 * 3600))"
printf 'a\tOK\tx\nb\tOK\ty\n' >"$TMP/r2"
check "recovered" "$(mon_transitions "$TMP/s3" "$TMP/r2" 30000 6 "$TMP/s4" | tr '\t' ' ')" "RECOVERED b"
check "state empty" "$(cat "$TMP/s4")" ""
printf 'a\tOK\tx\n' >"$TMP/r3"
check "absent check keeps state" "$(mon_transitions "$TMP/s1" "$TMP/r3" 2000 6 "$TMP/s5" | tr '\t' ' ')" ""
check "absent check state" "$(tr '\t' ' ' <"$TMP/s5")" "b 1000 1000"

check "restart prev missing file" "$(mon_restart_prev "$TMP/nope" abc)" "-"
printf 'abc\t4\n' >"$TMP/rs"
check "restart prev" "$(mon_restart_prev "$TMP/rs" abc)" "4"
check "json escape" "$(mon_json_escape 'a"b\c')" 'a\"b\\c'

# --- stubbed end-to-end -----------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
# docker: inspect → one running healthy container; logs → nginx/sign fixtures chosen by
# the SIGN_FIXTURE file (so a run can be made clean or failing).
cat >"$BIN/docker" <<STUB
#!/usr/bin/env bash
case "\$1" in
  inspect) echo "id-\${!#} running healthy 0" ;;
  logs)
    c="\${!#}"
    if [ "\$c" = "aramo-prod-sign" ]; then cat "$TMP/sign-fixture"; else cat "$TMP/nginx.log"; fi ;;
  *) exit 0 ;;
esac
STUB
cat >"$BIN/curl" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do last="$a"; done
case "$last" in
  */v1/*|*/platform/*) printf 401 ;;
  *) printf 200 ;;
esac
STUB
cat >"$BIN/aws" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$1 \$2" >>"$TMP/aws-calls"
exit 0
STUB
chmod +x "$BIN"/*

run_probe() {
  PATH="$BIN:$PATH" \
    MON_STATE_DIR="$TMP/state" MON_SNS_TOPIC_ARN="arn:aws:sns:us-east-1:000000000000:t" \
    MON_CONTAINERS="aramo-prod-sign" MON_DISK_PATHS="$TMP" MON_DISK_FAIL_PCT=101 MON_TLS_HOSTS="" \
    MON_MEMINFO="$TMP/meminfo" MON_MEM_AVAIL_MIN_PCT=5 MON_BACKUP_DIR="$TMP/nobackup" \
    bash "$PROBE" "$@" >/dev/null 2>&1
}

cp "$TMP/sign.log" "$TMP/sign-fixture"
run_probe --dry-run
check "dry-run exit" "$?" "0"
check "dry-run: no aws call" "$(cat "$TMP/aws-calls" 2>/dev/null)" ""
check "dry-run: no state" "$(ls "$TMP/state" 2>/dev/null | grep -v '^\.lock$' | tr '\n' ' ')" ""

run_probe
check "run 1 exit" "$?" "0"
check "run 1: metrics + one alert" "$(tr '\n' ',' <"$TMP/aws-calls")" "cloudwatch put-metric-data,sns publish,"
check "run 1: sign failures in state" "$(cut -f1 "$TMP/state/failing.tsv" | sort | tr '\n' ' ')" "sign:custody sign:kms sign:privacy sign:purge sign:purge-r13 sign:retention "
: >"$TMP/aws-calls"
run_probe
check "run 2: still failing, no new alert" "$(tr '\n' ',' <"$TMP/aws-calls")" "cloudwatch put-metric-data,"
: >"$TMP/aws-calls"
printf 'all quiet\n' >"$TMP/sign-fixture"
run_probe
check "run 3: recovery alert" "$(tr '\n' ',' <"$TMP/aws-calls")" "cloudwatch put-metric-data,sns publish,"
check "run 3: state empty" "$(cat "$TMP/state/failing.tsv")" ""
check "status file: no FAIL" "$(cut -f2 "$TMP/state/last-status.tsv" | grep -c FAIL)" "0"
check "status file: rows" "$(wc -l <"$TMP/state/last-status.tsv" | tr -d ' ')" "16"

echo "aramo-health-probe.test.sh — ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
