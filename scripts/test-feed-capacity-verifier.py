#!/usr/bin/env python3
"""Small synthetic verifier tests; no services, load test, or network required."""

import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("feed_capacity_verifier", Path(__file__).with_name("verify-feed-capacity.py"))
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)
SHA = "a" * 40
START = dt.datetime(2026, 9, 9, tzinfo=dt.timezone.utc)


def documents():
    fixture = {"baseline": SHA, "fixtureVersion": "synthetic-capacity-v1", "counts": dict(VERIFIER.EXPECTED_COUNTS)}
    observations = [{"scheduledOffsetMs": (i + 1) * 100, "startedOffsetMs": (i + 1) * 100 + 0.1,
                     "finishedOffsetMs": (i + 1) * 100 + 100.1, "durationMs": 100,
                     "status": 200, "items": 20, "inflight": 1} for i in range(6000)]
    samples = [{"at": (START + dt.timedelta(seconds=i)).isoformat(), "offsetMs": i * 1000,
                "sampleDurationMs": 1, "processCpuSeconds": i / 10, "heapBytes": 100000,
                "goroutines": 10, "gcCount": i // 10, "gcPauseTotalNs": i * 100, "lastGcUnixNs": 1,
                "postgresql": {"activity": [], "database": dict.fromkeys(("commits", "rollbacks", "blocksRead", "blocksHit", "blockReadMs", "blockWriteMs", "tempBytes", "deadlocks"), 0), "ungrantedLocks": 0}}
               for i in range(1, 600)]
    load = {"baseline": SHA, "phase": "load", "startedAt": START.isoformat(), "loadStartedAt": START.isoformat(),
            "durationSeconds": 606, "Scheduled": 6000, "Completed": 6000,
            "Successful": 6000, "ErrorRate": 0, "P95MS": 0, "observations": observations, "resourceSamples": samples}
    deletion = {"baseline": SHA, "phase": "delete", "deletion": {
        "eventsBefore": 250000, "eventsAfter": 0, "rollbackPreservedEvents": True, "cancellationObservedActiveCascade": True,
        "acceptedAttempt": {"status": 202, "durationMs": 1000, "items": 0},
        "cancelledAttempt": {"status": 0, "durationMs": 10, "items": 0, "error": "transport_error"},
        "acceptedResponse": {"deletionId": "feed_delete_synthetic", "status": "queued"},
        "s3FailureObserved": True, "s3FailureRequests": 1, "s3FailureCode": VERIFIER.S3_FAILURE,
        "cleanupPersistedFailure": {"status": "queued", "phase": "archive", "failures": 1, "errorCode": VERIFIER.S3_FAILURE},
        "cleanupAdapterReopened": True, "cleanupFailures": 1, "cleanupPhase": "completed",
        "cleanupRecovery": {"status": "completed", "deletionId": "feed_delete_synthetic", "steps": 3, "processed": 1},
        "recreatedProfileVersion": 2,
    }}
    return {"fixture": fixture, "load": load, "delete": deletion}


def admission(row):
    row.update(status=0, error="concurrency_limit", durationMs=0, items=0, inflight=20,
               finishedOffsetMs=row["startedOffsetMs"])


def transport(row, duration=5000):
    row.update(status=0, error="transport_error", durationMs=duration, items=0,
               finishedOffsetMs=row["startedOffsetMs"] + duration)


def slow(row, duration=801):
    row.update(durationMs=duration, finishedOffsetMs=row["startedOffsetMs"] + duration)


class CapacityVerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.docs = documents()

    def save(self):
        for name, report in self.docs.items():
            (self.directory / (name + ".json")).write_text(json.dumps(report), encoding="utf-8")

    def verify(self, sha=SHA):
        self.save()
        return VERIFIER.verify(self.directory, sha)

    def check_issue(self, result, check, kind=None):
        self.assertFalse(result["passed"])
        self.assertTrue(any(i["check"] == check and (kind is None or i["kind"] == kind) for i in result["issues"]), result["issues"][:10])

    def test_success_recomputes_summary_and_limits_claim(self):
        result = self.verify()
        self.assertTrue(result["passed"], result["issues"])
        self.assertEqual(result["metrics"]["load"]["admittedP95Ms"], 100)
        self.assertFalse(result["monthlyAvailabilityProven"])
        self.assertFalse(result["cloudflareCapacityProven"])
        self.assertEqual(len(result["inputs"]), 3)

    def test_six_of_6000_failures_inclusive_boundary(self):
        for row in self.docs["load"]["observations"][:6]:
            admission(row)
        result = self.verify()
        self.assertTrue(result["passed"], result["issues"])
        self.assertEqual(result["metrics"]["load"]["failureRateOffered"], 0.001)
        self.assertEqual(result["metrics"]["load"]["admittedLatencySamples"], 5994)

    def test_hidden_admission_failures_do_not_use_summary(self):
        for row in self.docs["load"]["observations"][:7]:
            admission(row)
        result = self.verify()
        self.check_issue(result, "load.failureRate", "threshold")
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["metrics"]["load"]["failures"], 7)

    def test_hidden_transport_errors_are_failures_and_latency_samples(self):
        for row in self.docs["load"]["observations"][:7]:
            transport(row)
        result = self.verify()
        self.check_issue(result, "load.failureRate", "threshold")
        self.assertEqual(result["metrics"]["load"]["transportErrors"], 7)
        self.assertEqual(result["metrics"]["load"]["admittedLatencySamples"], 6000)
        self.assertEqual(result["metrics"]["load"]["admittedMaxMs"], 5000)

    def test_transport_timeout_not_omitted_from_p95(self):
        for row in self.docs["load"]["observations"][:301]:
            transport(row)
        result = self.verify()
        self.check_issue(result, "load.admittedP95Ms", "threshold")
        self.assertEqual(result["metrics"]["load"]["admittedP95Ms"], 5000)

    def test_admission_zeros_cannot_lower_p95(self):
        for row in self.docs["load"]["observations"][:6]:
            admission(row)
        for row in self.docs["load"]["observations"][6:306]:
            slow(row)
        result = self.verify()
        self.check_issue(result, "load.admittedP95Ms", "threshold")
        self.assertEqual(result["metrics"]["load"]["admittedP95Ms"], 801)

    def test_p95_800_inclusive(self):
        for row in self.docs["load"]["observations"]:
            slow(row, 800)
        self.assertTrue(self.verify()["passed"])

    def test_missing_offered_slot_and_wrong_denominator(self):
        self.docs["load"]["observations"].pop()
        self.docs["load"]["Completed"] = 5999
        result = self.verify()
        self.check_issue(result, "load.observations.count", "incomplete")
        self.check_issue(result, "load.Completed")

    def test_wrong_scheduled_denominator(self):
        self.docs["load"]["Scheduled"] = 6001
        self.check_issue(self.verify(), "load.Scheduled")

    def test_report_sha_mismatch(self):
        for name in self.docs:
            original = self.docs[name]["baseline"]
            self.docs[name]["baseline"] = "b" * 40
            self.check_issue(self.verify(), name + ".baseline")
            self.docs[name]["baseline"] = original

    def test_invalid_release_sha(self):
        self.check_issue(self.verify("main"), "releaseSha")

    def test_each_seed_and_receipt_count_required(self):
        for key in VERIFIER.EXPECTED_COUNTS:
            value = self.docs["fixture"]["counts"][key]
            self.docs["fixture"]["counts"][key] = value - 1
            self.check_issue(self.verify(), "fixture.counts." + key)
            self.docs["fixture"]["counts"][key] = value

    def test_actual_duration_and_offset_window_required(self):
        self.docs["load"]["durationSeconds"] = 599
        result = self.verify()
        self.check_issue(result, "load.durationSeconds", "threshold")
        self.check_issue(result, "load.observations[5999].finishedOffsetMs")

    def test_missing_observation_is_incomplete(self):
        del self.docs["load"]["observations"][0]["finishedOffsetMs"]
        self.check_issue(self.verify(), "load.observations[0].finishedOffsetMs", "incomplete")

    def test_fixed_offered_cadence(self):
        self.docs["load"]["observations"][10]["scheduledOffsetMs"] += 1
        self.check_issue(self.verify(), "load.observations[10].scheduledOffsetMs")

    def test_lateness_boundary(self):
        row = self.docs["load"]["observations"][0]
        row["startedOffsetMs"] = row["scheduledOffsetMs"] + 1000
        row["finishedOffsetMs"] = row["startedOffsetMs"] + row["durationMs"]
        self.assertTrue(self.verify()["passed"])
        row["startedOffsetMs"] += 0.1
        row["finishedOffsetMs"] += 0.1
        self.check_issue(self.verify(), "load.maximumSchedulingLatenessMs", "threshold")

    def test_zero_status_without_transport_error_rejected(self):
        self.docs["load"]["observations"][0]["status"] = 0
        self.check_issue(self.verify(), "load.observations[0].status")

    def test_boolean_is_not_a_count(self):
        self.docs["load"]["observations"][0]["items"] = True
        self.check_issue(self.verify(), "load.observations[0].items")

    def test_sample_minimum_and_distinct_seconds(self):
        self.docs["load"]["resourceSamples"] = self.docs["load"]["resourceSamples"][:550]
        self.assertTrue(self.verify()["passed"])
        self.docs["load"]["resourceSamples"].pop()
        self.check_issue(self.verify(), "load.resourceSamples.coverage", "incomplete")

    def test_duplicate_samples_do_not_create_coverage(self):
        self.docs["load"]["resourceSamples"] = [copy.deepcopy(self.docs["load"]["resourceSamples"][0]) for _ in range(550)]
        result = self.verify()
        self.check_issue(result, "load.resourceSamples")
        self.check_issue(result, "load.resourceSamples.coverage", "incomplete")

    def test_pg_error_samples_excluded_and_reported(self):
        for row in self.docs["load"]["resourceSamples"][:50]:
            row["error"] = "postgres_observer_timeout_or_error"
            del row["postgresql"]
        result = self.verify()
        self.check_issue(result, "load.resourceSamples.coverage", "incomplete")
        self.assertEqual(result["metrics"]["resources"]["observerErrorSamples"], 50)
        self.assertEqual(result["metrics"]["resources"]["validGoPostgresSamples"], 549)

    def test_empty_postgres_object_not_valid_sample(self):
        self.docs["load"]["resourceSamples"][0]["postgresql"] = {}
        self.check_issue(self.verify(), "load.resourceSamples")

    def test_new_s3_evidence_missing_is_incomplete(self):
        del self.docs["delete"]["deletion"]["s3FailureObserved"]
        self.check_issue(self.verify(), "delete.deletion.s3FailureObserved", "incomplete")

    def test_s3_persisted_failure_and_reopen_required(self):
        self.docs["delete"]["deletion"]["cleanupPersistedFailure"]["phase"] = "primary"
        self.docs["delete"]["deletion"]["cleanupAdapterReopened"] = False
        result = self.verify()
        self.check_issue(result, "delete.deletion.cleanupPersistedFailure.phase")
        self.check_issue(result, "delete.deletion.cleanupAdapterReopened")

    def test_delete_facts_and_matching_operation_required(self):
        changes = {"eventsBefore": 249999, "eventsAfter": 1, "rollbackPreservedEvents": False,
                   "cancellationObservedActiveCascade": False, "recreatedProfileVersion": 1,
                   "s3FailureRequests": 0, "s3FailureCode": "other", "cleanupPhase": "queued"}
        for key, bad in changes.items():
            original = self.docs["delete"]["deletion"][key]
            self.docs["delete"]["deletion"][key] = bad
            self.check_issue(self.verify(), "delete.deletion." + key)
            self.docs["delete"]["deletion"][key] = original
        self.docs["delete"]["deletion"]["cleanupRecovery"]["deletionId"] = "feed_delete_other"
        self.check_issue(self.verify(), "delete.deletion.cleanupRecovery.deletionId")

    def test_cli_missing_delete_overwrites_stale_pass_with_incomplete(self):
        del self.docs["delete"]
        self.save()
        (self.directory / "gate.json").write_text('{"passed":true}')
        result = subprocess.run([sys.executable, str(Path(VERIFIER.__file__)), "--directory", str(self.directory), "--release-sha", SHA], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        gate = json.loads((self.directory / "gate.json").read_text())
        self.check_issue(gate, "delete.json", "incomplete")
        self.assertEqual(gate["status"], "incomplete")

    def test_cli_success_exit_and_hashes(self):
        self.save()
        result = subprocess.run([sys.executable, str(Path(VERIFIER.__file__)), "--directory", str(self.directory), "--release-sha", SHA], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        gate = json.loads((self.directory / "gate.json").read_text())
        self.assertEqual(gate["status"], "passed")
        self.assertEqual(len(gate["inputs"]["load.json"]["sha256"]), 64)

    def test_invalid_and_duplicate_json_still_produces_gate(self):
        self.save()
        for raw in ('{"baseline":', '{"a":1,"a":2}', '{"number":NaN}'):
            (self.directory / "load.json").write_text(raw)
            with self.subTest(raw=raw):
                self.assertEqual(VERIFIER.main(["--directory", str(self.directory), "--release-sha", SHA]), 1)
                gate = json.loads((self.directory / "gate.json").read_text())
                self.check_issue(gate, "load.json", "invalid")
                self.assertIn("deletion", gate["metrics"])

    def test_missing_directory_still_gets_gate(self):
        directory = self.directory / "new"
        self.assertEqual(VERIFIER.main(["--directory", str(directory), "--release-sha", SHA]), 1)
        self.assertEqual(json.loads((directory / "gate.json").read_text())["status"], "incomplete")


if __name__ == "__main__":
    unittest.main()
