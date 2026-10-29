"""Aramo backup-freshness check (M-A8 §1.1.7).

Runs once a day (EventBridge rule -> this Lambda) and publishes ONE message to the
alert SNS topic when any of these holds:

  1. the newest routine/ manifest (routine/<run_id>/manifest.tsv) is older than
     ROUTINE_MAX_AGE_HOURS (26), or there is none;
  2. the newest heartbeat/ object reports a status other than OK, or there is none;
  3. the newest restore-checks/ report whose result is PASS is older than
     RESTORE_CHECK_MAX_AGE_DAYS (35), or there is none.

It reads object KEYS, timestamps and user METADATA only (ListObjectsV2 and
HeadObject). It never downloads an object body, so it needs no KMS permission:
HeadObject on an SSE-KMS object does not decrypt anything. The writer and the
restorer put the status into object metadata:
  heartbeat/<run_id>.json           x-amz-meta-status = OK | FAILED
  restore-checks/<…>.txt            x-amz-meta-result = PASS | FAIL

The message carries ages, keys and statuses only; there is no backup content in
the bucket that this function could read anyway.
"""

import datetime as _dt
import os

ROUTINE_PREFIX = "routine/"
HEARTBEAT_PREFIX = "heartbeat/"
RESTORE_CHECKS_PREFIX = "restore-checks/"
MANIFEST_SUFFIX = "/manifest.tsv"

# HEAD at most this many of the newest restore-check reports looking for a PASS.
MAX_REPORT_HEADS = 60


def _list(s3, bucket, prefix):
    """Every object under prefix as (key, last_modified)."""
    out = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []) or []:
            out.append((obj["Key"], obj["LastModified"]))
    return out


def _newest(objs):
    return max(objs, key=lambda o: o[1]) if objs else None


def _meta(s3, bucket, key, name):
    head = s3.head_object(Bucket=bucket, Key=key)
    return (head.get("Metadata") or {}).get(name, "").strip().upper()


def _age_hours(now, ts):
    return (now - ts).total_seconds() / 3600.0


def evaluate(s3, bucket, now, routine_max_age_hours=26, restore_check_max_age_days=35):
    """Return (problems, facts). problems is a list of strings; empty = healthy."""
    problems = []
    facts = {}

    # 1. routine manifest freshness
    manifests = [o for o in _list(s3, bucket, ROUTINE_PREFIX) if o[0].endswith(MANIFEST_SUFFIX)]
    newest = _newest(manifests)
    if newest is None:
        problems.append("no routine/ manifest found: no complete backup run exists")
    else:
        age = _age_hours(now, newest[1])
        facts["newest_routine_manifest"] = newest[0]
        facts["newest_routine_age_hours"] = round(age, 1)
        if age > routine_max_age_hours:
            problems.append(
                "newest routine/ manifest %s is %.1f h old (limit %s h)" % (newest[0], age, routine_max_age_hours)
            )

    # 2. newest heartbeat status
    newest = _newest(_list(s3, bucket, HEARTBEAT_PREFIX))
    if newest is None:
        problems.append("no heartbeat/ object found")
    else:
        status = _meta(s3, bucket, newest[0], "status")
        facts["newest_heartbeat"] = newest[0]
        facts["newest_heartbeat_status"] = status or "(missing)"
        if status != "OK":
            problems.append("newest heartbeat %s reports status %s" % (newest[0], status or "(missing)"))

    # 3. newest PASS restore check
    reports = sorted(_list(s3, bucket, RESTORE_CHECKS_PREFIX), key=lambda o: o[1], reverse=True)
    newest_pass = None
    for key, ts in reports[:MAX_REPORT_HEADS]:
        if _meta(s3, bucket, key, "result") == "PASS":
            newest_pass = (key, ts)
            break
    if newest_pass is None:
        problems.append("no PASS report in restore-checks/ (among the newest %d)" % MAX_REPORT_HEADS)
    else:
        age_days = _age_hours(now, newest_pass[1]) / 24.0
        facts["newest_restore_pass"] = newest_pass[0]
        facts["newest_restore_pass_age_days"] = round(age_days, 1)
        if age_days > restore_check_max_age_days:
            problems.append(
                "newest PASS restore check %s is %.1f days old (limit %s days)"
                % (newest_pass[0], age_days, restore_check_max_age_days)
            )

    return problems, facts


def format_message(bucket, problems, facts):
    lines = ["Aramo backup-freshness check FAILED for s3://%s" % bucket, ""]
    lines += ["- " + p for p in problems]
    lines += ["", "Facts:"]
    lines += ["  %s = %s" % (k, facts[k]) for k in sorted(facts)]
    lines += ["", "Runbook: doc/runbooks/RUNBOOK-backups.md (Monitoring)."]
    return "\n".join(lines)


def run(s3, sns, env, now):
    bucket = env["BACKUP_BUCKET"]
    problems, facts = evaluate(
        s3,
        bucket,
        now,
        routine_max_age_hours=float(env.get("ROUTINE_MAX_AGE_HOURS", "26")),
        restore_check_max_age_days=float(env.get("RESTORE_CHECK_MAX_AGE_DAYS", "35")),
    )
    if problems:
        sns.publish(
            TopicArn=env["ALERT_TOPIC_ARN"],
            Subject="Aramo backups: freshness check FAILED",
            Message=format_message(bucket, problems, facts),
        )
    return {"ok": not problems, "problems": problems, "facts": facts}


def handler(event, context):  # pragma: no cover - thin AWS wiring
    import boto3  # provided by the Lambda Python runtime

    result = run(
        boto3.client("s3"),
        boto3.client("sns"),
        os.environ,
        _dt.datetime.now(_dt.timezone.utc),
    )
    print({"ok": result["ok"], "problems": len(result["problems"])})
    return result
