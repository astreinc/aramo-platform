"""Unit tests for the off-box watchdog Lambda.

Run: python3 -m unittest discover -s infrastructure-monitoring/lambda -v
No AWS, no boto3, no network: CloudWatch, SNS, SSM, HTTP and TLS are in-memory fakes.
"""

import datetime as dt
import json
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import watchdog  # noqa: E402

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 11, 1, 10, 0, 0, tzinfo=UTC)


class Resp:
    def __init__(self, status):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_for(codes):
    """codes: {url: int | Exception}."""

    def opener(req, timeout):
        v = codes[req.full_url]
        if isinstance(v, Exception):
            raise v
        if v >= 400:
            raise urllib.error.HTTPError(req.full_url, v, "x", {}, None)
        return Resp(v)

    return opener


class FakeCloudWatch:
    def __init__(self, points):
        self.points = points
        self.calls = []

    def get_metric_statistics(self, **kw):
        self.calls.append(kw)
        return {"Datapoints": self.points}


class FakeSns:
    def __init__(self):
        self.messages = []

    def publish(self, **kw):
        self.messages.append(kw)


class FakeSsm:
    def __init__(self, value=None):
        self.value = value
        self.puts = 0

    def get_parameter(self, Name):
        if self.value is None:
            raise KeyError(Name)
        return {"Parameter": {"Value": self.value}}

    def put_parameter(self, Name, Value, Type, Overwrite):
        self.value = Value
        self.puts += 1


ENV = {
    "URL_CHECKS": json.dumps(
        [
            {"name": "tenant-spa", "url": "https://astre.example/", "expect": [200]},
            {"name": "api", "url": "https://astre.example/v1/tenant/settings", "expect": [401]},
        ]
    ),
    "TLS_HOSTS": json.dumps(["astre.example"]),
    "METRIC_NAMESPACE": "Aramo/Prod",
    "HOST_LABEL": "astre-prod",
    "STATE_PARAMETER": "/aramo/monitoring/watchdog-state",
    "ALERT_TOPIC_ARN": "arn:aws:sns:us-east-1:000000000000:t",
    "TLS_MIN_DAYS": "14",
    "HEARTBEAT_MAX_AGE_MINUTES": "20",
    "REMIND_HOURS": "6",
}

HEALTHY = {"https://astre.example/": 200, "https://astre.example/v1/tenant/settings": 401}


def not_after_days(days):
    return lambda host: NOW + dt.timedelta(days=days)


def run(codes=HEALTHY, points=None, tls_days=60, ssm=None, now=NOW):
    sns = FakeSns()
    ssm = ssm or FakeSsm()
    cw = FakeCloudWatch([{"Timestamp": now - dt.timedelta(minutes=3), "Sum": 1.0}] if points is None else points)
    out = watchdog.run(ENV, now, cw, sns, ssm, opener_for(codes), not_after_days(tls_days))
    return out, sns, ssm


class Checks(unittest.TestCase):
    def test_healthy_sends_nothing(self):
        out, sns, ssm = run()
        self.assertEqual(out["failing"], [])
        self.assertEqual(sns.messages, [])
        self.assertEqual(ssm.puts, 0)

    def test_expected_401_is_ok_and_502_fails(self):
        codes = dict(HEALTHY)
        codes["https://astre.example/v1/tenant/settings"] = 502
        out, sns, _ = run(codes)
        self.assertEqual(out["failing"], ["url:api"])
        self.assertEqual(len(sns.messages), 1)
        self.assertIn("HTTP 502 (expected 401)", sns.messages[0]["Message"])
        self.assertIn("NEW_FAIL", sns.messages[0]["Message"])

    def test_no_answer_fails(self):
        codes = dict(HEALTHY)
        codes["https://astre.example/"] = TimeoutError()
        out, _, _ = run(codes)
        self.assertEqual(out["failing"], ["url:tenant-spa"])

    def test_tls_expiry(self):
        out, sns, _ = run(tls_days=10)
        self.assertEqual(out["failing"], ["tls:astre.example"])
        self.assertIn("expires in 10.0 days", sns.messages[0]["Message"])

    def test_tls_verify_failure(self):
        def boom(host):
            raise ValueError("bad cert")

        sns = FakeSns()
        cw = FakeCloudWatch([{"Timestamp": NOW, "Sum": 1.0}])
        out = watchdog.run(ENV, NOW, cw, sns, FakeSsm(), opener_for(HEALTHY), boom)
        self.assertEqual(out["failing"], ["tls:astre.example"])

    def test_missing_heartbeat(self):
        out, sns, _ = run(points=[])
        self.assertEqual(out["failing"], ["probe-heartbeat"])
        self.assertIn("no ProbeHeartbeat", sns.messages[0]["Message"])

    def test_heartbeat_query_is_scoped(self):
        cw = FakeCloudWatch([])
        watchdog.run(ENV, NOW, cw, FakeSns(), FakeSsm(), opener_for(HEALTHY), not_after_days(60))
        q = cw.calls[0]
        self.assertEqual(q["Namespace"], "Aramo/Prod")
        self.assertEqual(q["Dimensions"], [{"Name": "Host", "Value": "astre-prod"}])
        self.assertEqual(q["EndTime"] - q["StartTime"], dt.timedelta(minutes=20))


class Transitions(unittest.TestCase):
    def test_alert_once_then_quiet_then_remind_then_recover(self):
        bad = dict(HEALTHY)
        bad["https://astre.example/"] = 503
        ssm = FakeSsm()
        _, sns, _ = run(bad, ssm=ssm)
        self.assertEqual(len(sns.messages), 1)
        _, sns, _ = run(bad, ssm=ssm, now=NOW + dt.timedelta(minutes=5))
        self.assertEqual(sns.messages, [])
        _, sns, _ = run(bad, ssm=ssm, now=NOW + dt.timedelta(hours=6))
        self.assertEqual(len(sns.messages), 1)
        self.assertIn("STILL_FAILING", sns.messages[0]["Message"])
        _, sns, _ = run(HEALTHY, ssm=ssm, now=NOW + dt.timedelta(hours=7))
        self.assertEqual(len(sns.messages), 1)
        self.assertIn("RECOVERED", sns.messages[0]["Message"])
        self.assertEqual(json.loads(ssm.value), {})

    def test_subject_is_short(self):
        bad = {k: 500 for k in HEALTHY}
        _, sns, _ = run(bad)
        self.assertLessEqual(len(sns.messages[0]["Subject"]), 99)

    def test_pure_transitions(self):
        state, changes = watchdog.transitions({}, {"a": (True, ""), "b": (False, "x")}, 100, 3600)
        self.assertEqual(changes, [("NEW_FAIL", "b")])
        self.assertEqual(state, {"b": {"since": 100, "notified": 100}})


if __name__ == "__main__":
    unittest.main()
