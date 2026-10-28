"""Unit tests for the backup-freshness Lambda (M-A8 §1.1.7, §5).

Run: python3 -m unittest discover -s infrastructure-backups/lambda -v
No AWS, no boto3: S3 and SNS are in-memory fakes.
"""

import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import freshness  # noqa: E402

UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 28, 8, 0, 0, tzinfo=UTC)


class FakeS3:
    def __init__(self, objects):
        # objects: {key: (last_modified, metadata)}
        self.objects = objects
        self.heads = []
        self.gets = 0

    def get_paginator(self, name):
        assert name == "list_objects_v2"
        fake = self

        class P:
            def paginate(self, Bucket, Prefix):
                keys = sorted(k for k in fake.objects if k.startswith(Prefix))
                # two pages, to exercise pagination
                half = len(keys) // 2
                for chunk in (keys[:half], keys[half:]):
                    yield {"Contents": [{"Key": k, "LastModified": fake.objects[k][0]} for k in chunk]}

        return P()

    def head_object(self, Bucket, Key):
        self.heads.append(Key)
        return {"Metadata": dict(self.objects[Key][1])}

    def get_object(self, **kw):  # must never be called
        self.gets += 1
        raise AssertionError("freshness check must not read object bodies")


class FakeSNS:
    def __init__(self):
        self.published = []

    def publish(self, **kw):
        self.published.append(kw)


def ago(hours):
    return NOW - dt.timedelta(hours=hours)


def healthy():
    return {
        "routine/20261027T033000Z-scheduled/aramo.dump.age": (ago(28.5), {}),
        "routine/20261027T033000Z-scheduled/manifest.tsv": (ago(28.4), {}),
        "routine/20261028T033000Z-scheduled/aramo.dump.age": (ago(4.5), {}),
        "routine/20261028T033000Z-scheduled/manifest.tsv": (ago(4.4), {}),
        "heartbeat/20261027T033000Z-scheduled.json": (ago(28.3), {"status": "OK"}),
        "heartbeat/20261028T033000Z-scheduled.json": (ago(4.3), {"status": "OK"}),
        "restore-checks/20261010T120000Z-20261010T033000Z-scheduled.PASS.txt": (ago(18 * 24), {"result": "PASS"}),
        "restore-checks/20261020T120000Z-20261020T033000Z-scheduled.FAIL.txt": (ago(8 * 24), {"result": "FAIL"}),
    }


ENV = {"BACKUP_BUCKET": "b", "ALERT_TOPIC_ARN": "arn:aws:sns:us-east-1:1:t"}


class FreshnessTest(unittest.TestCase):
    def run_check(self, objects, env=None):
        s3, sns = FakeS3(objects), FakeSNS()
        result = freshness.run(s3, sns, env or ENV, NOW)
        self.assertEqual(s3.gets, 0)
        return result, s3, sns

    def test_healthy_publishes_nothing(self):
        result, _, sns = self.run_check(healthy())
        self.assertTrue(result["ok"], result["problems"])
        self.assertEqual(sns.published, [])
        self.assertEqual(result["facts"]["newest_routine_manifest"], "routine/20261028T033000Z-scheduled/manifest.tsv")

    def test_stale_routine_manifest_alerts(self):
        objs = {k: v for k, v in healthy().items() if "20261028" not in k or not k.startswith("routine/")}
        result, _, sns = self.run_check(objs)
        self.assertFalse(result["ok"])
        self.assertEqual(len(sns.published), 1)
        self.assertIn("routine/ manifest", sns.published[0]["Message"])
        self.assertIn("28.4 h old", sns.published[0]["Message"])

    def test_artifact_without_manifest_is_not_a_complete_run(self):
        objs = healthy()
        del objs["routine/20261028T033000Z-scheduled/manifest.tsv"]
        result, _, _ = self.run_check(objs)
        self.assertFalse(result["ok"])

    def test_no_routine_run_at_all_alerts(self):
        objs = {k: v for k, v in healthy().items() if not k.startswith("routine/")}
        result, _, _ = self.run_check(objs)
        self.assertIn("no routine/ manifest found: no complete backup run exists", result["problems"])

    def test_failed_newest_heartbeat_alerts(self):
        objs = healthy()
        objs["heartbeat/20261028T040000Z-failed-scheduled.json"] = (ago(4), {"status": "FAILED"})
        result, _, sns = self.run_check(objs)
        self.assertFalse(result["ok"])
        self.assertIn("reports status FAILED", sns.published[0]["Message"])

    def test_heartbeat_without_status_metadata_alerts(self):
        objs = healthy()
        objs["heartbeat/20261028T050000Z-x.json"] = (ago(3), {})
        result, _, _ = self.run_check(objs)
        self.assertTrue(any("(missing)" in p for p in result["problems"]))

    def test_missing_heartbeat_alerts(self):
        objs = {k: v for k, v in healthy().items() if not k.startswith("heartbeat/")}
        result, _, _ = self.run_check(objs)
        self.assertIn("no heartbeat/ object found", result["problems"])

    def test_old_pass_restore_check_alerts(self):
        objs = healthy()
        objs["restore-checks/20261010T120000Z-20261010T033000Z-scheduled.PASS.txt"] = (ago(36 * 24), {"result": "PASS"})
        result, _, _ = self.run_check(objs)
        self.assertEqual(len(result["problems"]), 1)
        self.assertIn("days old (limit 35", result["problems"][0])

    def test_newer_fail_does_not_hide_older_pass(self):
        result, s3, _ = self.run_check(healthy())
        self.assertTrue(result["ok"])
        self.assertEqual(result["facts"]["newest_restore_pass"], "restore-checks/20261010T120000Z-20261010T033000Z-scheduled.PASS.txt")
        self.assertIn("restore-checks/20261020T120000Z-20261020T033000Z-scheduled.FAIL.txt", s3.heads)

    def test_only_fail_reports_alerts(self):
        objs = {k: v for k, v in healthy().items() if ".PASS." not in k}
        result, _, _ = self.run_check(objs)
        self.assertTrue(any(p.startswith("no PASS report") for p in result["problems"]))

    def test_thresholds_come_from_env(self):
        env = dict(ENV, ROUTINE_MAX_AGE_HOURS="2")
        result, _, _ = self.run_check(healthy(), env)
        self.assertEqual(len(result["problems"]), 1)
        self.assertIn("limit 2.0 h", result["problems"][0])

    def test_empty_bucket_reports_all_three(self):
        result, _, sns = self.run_check({})
        self.assertEqual(len(result["problems"]), 3)
        self.assertEqual(len(sns.published), 1)
        self.assertEqual(sns.published[0]["TopicArn"], ENV["ALERT_TOPIC_ARN"])


if __name__ == "__main__":
    unittest.main()
