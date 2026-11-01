"""Aramo off-box watchdog (Sign production monitoring, PO 2026-11-01).

Runs every 5 minutes (EventBridge rule -> this Lambda), OUTSIDE the box, so it still
reports when the box, its network or the on-box probe is down. Each run:

  1. URL checks  - HTTPS GET of each configured public URL; the status must be in the
                   check's expected list (an unauthenticated read answering 401 proves the
                   request reached the service behind nginx; 502/503/504 or no answer = down).
  2. TLS checks  - the certificate each configured host serves has more than
                   TLS_MIN_DAYS days left (and verifies against the system trust store).
  3. Heartbeat   - the on-box probe (deploy/monitoring/aramo-health-probe.sh) published the
                   ProbeHeartbeat metric within HEARTBEAT_MAX_AGE_MINUTES.

Alerting is by change, like the on-box probe: one SNS email when a check starts failing,
a reminder every REMIND_HOURS while it keeps failing, one when it recovers. The state is
a small JSON document in one SSM parameter (check name -> failing-since, last-notified).
Messages carry check names, status codes and ages only.
"""

import datetime as _dt
import json
import os
import socket
import ssl
import urllib.error
import urllib.request

USER_AGENT = "aramo-watchdog/1"


def check_url(opener, url, expect, timeout=10.0):
    """Return (ok, detail)."""
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
    try:
        with opener(req, timeout=timeout) as resp:
            code = resp.status
    except urllib.error.HTTPError as err:  # 4xx/5xx arrive as exceptions
        code = err.code
    except Exception as err:  # DNS, TCP, TLS, timeout
        return False, "no HTTP answer (%s)" % type(err).__name__
    if code in expect:
        return True, "HTTP %d" % code
    return False, "HTTP %d (expected %s)" % (code, ",".join(str(e) for e in expect))


def cert_not_after(host, port=443, timeout=10.0):
    """notAfter of the verified certificate host serves, as an aware datetime."""
    ctx = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            cert = tls.getpeercert()
    return _dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(cert["notAfter"]), tz=_dt.timezone.utc)


def check_tls(not_after_fn, host, now, min_days):
    try:
        not_after = not_after_fn(host)
    except Exception as err:
        return False, "TLS handshake/verify failed (%s)" % type(err).__name__
    days = (not_after - now).total_seconds() / 86400.0
    if days < min_days:
        return False, "certificate expires in %.1f days (minimum %s)" % (days, min_days)
    return True, "%.1f days left" % days


def check_heartbeat(cloudwatch, namespace, host_label, now, max_age_minutes):
    res = cloudwatch.get_metric_statistics(
        Namespace=namespace,
        MetricName="ProbeHeartbeat",
        Dimensions=[{"Name": "Host", "Value": host_label}],
        StartTime=now - _dt.timedelta(minutes=max_age_minutes),
        EndTime=now,
        Period=60,
        Statistics=["Sum"],
    )
    points = res.get("Datapoints") or []
    if not points:
        return False, "no ProbeHeartbeat from %s in the last %d minutes (box down, probe stopped, or publish failing)" % (
            host_label,
            max_age_minutes,
        )
    newest = max(p["Timestamp"] for p in points)
    return True, "newest heartbeat %s" % newest.isoformat()


def transitions(state, results, now_s, remind_s):
    """state: {check: {"since": s, "notified": s}}; results: {check: (ok, detail)}.

    Returns (new_state, changes) where changes is a list of (kind, check)."""
    new_state = {}
    changes = []
    for name in sorted(results):
        ok, _ = results[name]
        prev = state.get(name)
        if ok:
            if prev is not None:
                changes.append(("RECOVERED", name))
            continue
        if prev is None:
            changes.append(("NEW_FAIL", name))
            new_state[name] = {"since": now_s, "notified": now_s}
        elif now_s - prev.get("notified", 0) >= remind_s:
            changes.append(("STILL_FAILING", name))
            new_state[name] = {"since": prev.get("since", now_s), "notified": now_s}
        else:
            new_state[name] = prev
    # A check that no longer runs (removed from config) is dropped silently.
    return new_state, changes


def format_message(host_label, now, results, changes):
    lines = ["Aramo off-box watchdog (%s) at %s" % (host_label, now.strftime("%Y-%m-%dT%H:%M:%SZ")), "", "Changes:"]
    lines += ["  %-14s %s" % (kind, name) for kind, name in changes]
    lines += ["", "Currently failing:"]
    failing = ["  %-28s %s" % (n, results[n][1]) for n in sorted(results) if not results[n][0]]
    lines += failing or ["  (none)"]
    lines += ["", "Runbook: doc/runbooks/sign/monitoring-and-alerts.md"]
    return "\n".join(lines)


def run(env, now, cloudwatch, sns, ssm, opener, not_after_fn):
    url_checks = json.loads(env["URL_CHECKS"])
    tls_hosts = json.loads(env["TLS_HOSTS"])
    host_label = env.get("HOST_LABEL", "astre-prod")
    results = {}
    for c in url_checks:
        results["url:" + c["name"]] = check_url(opener, c["url"], [int(e) for e in c["expect"]])
    for h in tls_hosts:
        results["tls:" + h] = check_tls(not_after_fn, h, now, float(env.get("TLS_MIN_DAYS", "14")))
    results["probe-heartbeat"] = check_heartbeat(
        cloudwatch, env["METRIC_NAMESPACE"], host_label, now, int(env.get("HEARTBEAT_MAX_AGE_MINUTES", "20"))
    )

    param = env["STATE_PARAMETER"]
    try:
        state = json.loads(ssm.get_parameter(Name=param)["Parameter"]["Value"] or "{}")
    except Exception:
        state = {}
    now_s = int(now.timestamp())
    new_state, changes = transitions(state, results, now_s, int(float(env.get("REMIND_HOURS", "6")) * 3600))
    if changes:
        failing = sum(1 for r in results.values() if not r[0])
        sns.publish(
            TopicArn=env["ALERT_TOPIC_ARN"],
            Subject=("[Aramo %s] watchdog: %d failing" % (host_label, failing))[:99],
            Message=format_message(host_label, now, results, changes),
        )
    if new_state != state:
        ssm.put_parameter(Name=param, Value=json.dumps(new_state, sort_keys=True) or "{}", Type="String", Overwrite=True)
    return {"failing": sorted(n for n, r in results.items() if not r[0]), "changes": changes}


def handler(event, context):  # pragma: no cover - thin AWS wiring
    import boto3  # provided by the Lambda Python runtime

    result = run(
        os.environ,
        _dt.datetime.now(_dt.timezone.utc),
        boto3.client("cloudwatch"),
        boto3.client("sns"),
        boto3.client("ssm"),
        urllib.request.urlopen,
        cert_not_after,
    )
    print(json.dumps(result))
    return result
