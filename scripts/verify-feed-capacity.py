#!/usr/bin/env python3
"""Verify local, synthetic Feed capacity evidence without network access.

The 800 ms p95 / 0.1% failure limits are engineering gates for this finite run.
They do not statistically establish monthly 99.9% availability or CF capacity.
Raw fixture.json, load.json, delete.json, and external-resources.jsonl are inputs; reported summary
percentiles and failure rates are deliberately not used to decide the gate.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

OFFERED = 6000
INTERVAL_MS = 100
MAX_REPORT_BYTES = 32 * 1024 * 1024
EXPECTED_COUNTS = {
    "projects": 50000, "users": 5000, "events": 1000000,
    "project_submission_evidence": 50000,
}
S3_FAILURE = "capacity_injected_s3_outage"
CONTAINERS = ("ghfind-feed-capacity-postgres-1", "ghfind-feed-capacity-minio-1")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def integer(value):
    return type(value) is int


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})", value
    ):
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def percentile(values, fraction):
    """Nearest-rank percentile, with no interpolation or admission-zero samples."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def no_constant(_value):
    raise ValueError("non-finite JSON number")


class Gate:
    def __init__(self, release_sha):
        self.result = {
            "format": "ghfind-feed-capacity-gate-v1",
            "releaseSha": release_sha if isinstance(release_sha, str) and re.fullmatch(r"[0-9a-fA-F]{40}", release_sha) else None,
            "status": "incomplete", "passed": False,
            "scope": "Local synthetic finite-run engineering gate; not statistical proof of monthly 99.9% availability or Cloudflare capacity.",
            "monthlyAvailabilityProven": False, "cloudflareCapacityProven": False,
            "limits": {"offered": OFFERED, "intervalMs": INTERVAL_MS,
                       "minimumDurationSeconds": 600, "maximumFailures": 6,
                       "maximumFailureRate": 0.001, "admittedP95Ms": 800,
                       "maximumSchedulingLatenessMs": 1000,
                       "minimumValidGoPostgresSeconds": 550},
            "inputs": {}, "metrics": {}, "issues": [],
        }

    def issue(self, check, kind, message):
        # Messages describe schema/limits, never arbitrary report content.
        self.result["issues"].append({"check": check, "kind": kind, "message": message})

    def field(self, obj, key, predicate, path):
        if not isinstance(obj, dict) or key not in obj:
            self.issue(path + "." + key, "incomplete", "Required evidence field is missing.")
            return None
        value = obj[key]
        if not predicate(value):
            self.issue(path + "." + key, "invalid", "Evidence field has an invalid type or value.")
            return None
        return value

    def finish(self):
        issues = self.result["issues"]
        self.result["passed"] = not issues
        self.result["status"] = (
            "incomplete" if any(i["kind"] in ("incomplete", "invalid") for i in issues)
            else "failed" if issues else "passed"
        )
        return self.result


def read_report(path, gate):
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPORT_BYTES:
                raise ValueError("invalid report file")
            raw = file.read(MAX_REPORT_BYTES + 1)
        if len(raw) > MAX_REPORT_BYTES:
            raise ValueError("report too large")
        gate.result["inputs"][path.name] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        value = json.loads(raw, object_pairs_hook=unique_object, parse_constant=no_constant)
        if not isinstance(value, dict):
            raise ValueError("report root must be object")
        return value
    except FileNotFoundError:
        gate.issue(path.name, "incomplete", "Required local report file is missing.")
    except (OSError, ValueError, UnicodeError, RecursionError):
        gate.issue(path.name, "invalid", "Report must be a bounded regular UTF-8 JSON object with unique keys and finite numbers.")
    return None


def check_baseline(gate, report, name, release_sha):
    baseline = gate.field(report, "baseline", lambda v: isinstance(v, str) and bool(re.fullmatch(r"[0-9a-fA-F]{40}", v)), name)
    if baseline is not None and baseline != release_sha:
        gate.issue(name + ".baseline", "invalid", "Report baseline must equal the exact requested release SHA.")


def check_fixture(gate, report):
    gate.field(report, "fixtureVersion", lambda v: v == "synthetic-capacity-v1", "fixture")
    counts = gate.field(report, "counts", lambda v: isinstance(v, dict), "fixture")
    if counts is not None:
        for key, expected in EXPECTED_COUNTS.items():
            gate.field(counts, key, lambda v, expected=expected: integer(v) and v == expected, "fixture.counts")
        gate.result["metrics"]["seedCounts"] = {key: counts.get(key) for key in EXPECTED_COUNTS if integer(counts.get(key))}


def postgres_sample_valid(value):
    if not isinstance(value, dict) or not isinstance(value.get("database"), dict) or not isinstance(value.get("activity"), list):
        return False
    if not integer(value.get("ungrantedLocks")) or value["ungrantedLocks"] < 0:
        return False
    database = value["database"]
    for key in ("commits", "rollbacks", "blocksRead", "blocksHit", "tempBytes", "deadlocks"):
        if not integer(database.get(key)) or database[key] < 0:
            return False
    for key in ("blockReadMs", "blockWriteMs"):
        if not number(database.get(key)) or database[key] < 0:
            return False
    for activity in value["activity"]:
        if not isinstance(activity, dict) or not integer(activity.get("connections")) or activity["connections"] < 1:
            return False
        if any(key not in activity or (activity[key] is not None and not isinstance(activity[key], str)) for key in ("state", "wait_event_type", "wait_event")):
            return False
    return True


def check_resources(gate, report, load_start, end_ms):
    rows = gate.field(report, "resourceSamples", lambda v: isinstance(v, list), "load")
    if rows is None:
        return
    if len(rows) > 10000:
        gate.issue("load.resourceSamples", "invalid", "Resource sample count exceeds the bounded report contract.")
        return
    valid, observer_errors, malformed, seconds = [], 0, 0, set()
    previous_offset = -1
    for row in rows:
        if not isinstance(row, dict):
            malformed += 1
            continue
        offset, at = row.get("offsetMs"), timestamp(row.get("at"))
        basic = (
            number(offset) and 0 <= offset <= end_ms and offset > previous_offset
            and at is not None and load_start is not None
            and abs((at - load_start).total_seconds() * 1000 - offset) <= 2
            and number(row.get("sampleDurationMs")) and 0 <= row["sampleDurationMs"] <= 2000
            and number(row.get("processCpuSeconds")) and row["processCpuSeconds"] >= 0
            and all(integer(row.get(k)) and row[k] >= 0 for k in ("heapBytes", "goroutines", "gcCount", "gcPauseTotalNs", "lastGcUnixNs"))
            and row.get("goroutines", 0) > 0
        )
        if number(offset):
            previous_offset = offset
        if not basic:
            malformed += 1
            continue
        if row.get("error"):
            observer_errors += 1
            continue
        if not postgres_sample_valid(row.get("postgresql")):
            malformed += 1
            continue
        valid.append(row)
        seconds.add(int(offset // 1000))
    if malformed:
        gate.issue("load.resourceSamples", "invalid", "Resource evidence contains malformed, duplicated, or out-of-window Go/PostgreSQL samples.")
    if len(seconds) < 550:
        gate.issue("load.resourceSamples.coverage", "incomplete", "At least 550 distinct sampled seconds with valid Go and PostgreSQL data are required.")
    metrics = {"totalSamples": len(rows), "validGoPostgresSamples": len(valid), "validGoPostgresSeconds": len(seconds), "observerErrorSamples": observer_errors, "malformedSamples": malformed,
               "interpretation": "Observed resource ranges are context only; no CPU, GC, or database causal attribution is established."}
    if valid:
        metrics.update({"firstOffsetMs": valid[0]["offsetMs"], "lastOffsetMs": valid[-1]["offsetMs"],
                        "processCpuSecondsFirst": valid[0]["processCpuSeconds"], "processCpuSecondsLast": valid[-1]["processCpuSeconds"],
                        "maxHeapBytes": max(r["heapBytes"] for r in valid), "maxGoroutines": max(r["goroutines"] for r in valid),
                        "gcCountFirst": valid[0]["gcCount"], "gcCountLast": valid[-1]["gcCount"],
                        "gcPauseTotalNsFirst": valid[0]["gcPauseTotalNs"], "gcPauseTotalNsLast": valid[-1]["gcPauseTotalNs"]})
    gate.result["metrics"]["resources"] = metrics


def check_load(gate, report):
    gate.field(report, "phase", lambda v: v == "load", "load")
    duration = gate.field(report, "durationSeconds", lambda v: number(v) and v >= 0, "load")
    if duration is not None and duration < 600:
        gate.issue("load.durationSeconds", "threshold", "Actual report duration must be at least 600 seconds.")
    started_raw = gate.field(report, "startedAt", lambda v: timestamp(v) is not None, "load")
    load_raw = gate.field(report, "loadStartedAt", lambda v: timestamp(v) is not None, "load")
    started, load_start = timestamp(started_raw), timestamp(load_raw)
    startup_ms = (load_start - started).total_seconds() * 1000 if started and load_start else 0
    if startup_ms < 0:
        gate.issue("load.loadStartedAt", "invalid", "Load start precedes report start.")
    end_ms = max(0, duration * 1000 - startup_ms) if duration is not None else 0
    for key in ("Scheduled", "Completed"):
        gate.field(report, key, lambda v: integer(v) and v == OFFERED, "load")
    rows = gate.field(report, "observations", lambda v: isinstance(v, list), "load")
    if rows is None:
        check_resources(gate, report, load_start, end_ms)
        return
    if len(rows) != OFFERED:
        gate.issue("load.observations.count", "incomplete", "Exactly 6000 offered observations must be present; completed-only samples are insufficient.")
    successes, failures, admission, transport, wrong_page_size = 0, 0, 0, 0, 0
    latency, wall_latency, lateness = [], [], []
    for index, row in enumerate(rows[:OFFERED]):
        path = "load.observations[" + str(index) + "]"
        if not isinstance(row, dict):
            gate.issue(path, "incomplete", "Every offered slot requires a complete observation.")
            continue
        scheduled = gate.field(row, "scheduledOffsetMs", lambda v: number(v) and v == (index + 1) * INTERVAL_MS, path)
        began = gate.field(row, "startedOffsetMs", lambda v: number(v) and v >= 0, path)
        finished = gate.field(row, "finishedOffsetMs", lambda v: number(v) and v >= 0, path)
        elapsed = gate.field(row, "durationMs", lambda v: number(v) and v >= 0, path)
        inflight = gate.field(row, "inflight", lambda v: integer(v) and 1 <= v <= 20, path)
        status = gate.field(row, "status", lambda v: integer(v) and (v == 0 or 100 <= v <= 599), path)
        items = gate.field(row, "items", lambda v: integer(v) and v >= 0, path)
        error = row.get("error", "")
        if not isinstance(error, str):
            gate.issue(path + ".error", "invalid", "Error classification must be a string.")
            error = "invalid_error"
        if status == 200 and not error and items != 20:
            wrong_page_size += 1
        if status == 200 and not error and items == 20:
            successes += 1
        else:
            failures += 1
        if error == "transport_error":
            transport += 1
        if status == 0 and error not in ("transport_error", "concurrency_limit"):
            gate.issue(path + ".status", "invalid", "A zero status must retain its transport or admission error classification.")
        if error in ("transport_error", "concurrency_limit") and status != 0:
            gate.issue(path + ".error", "invalid", "Transport/admission failures cannot claim an HTTP response.")
        if began is not None and scheduled is not None:
            delay = began - scheduled
            lateness.append(delay)
            if delay < -0.01:
                gate.issue(path + ".startedOffsetMs", "invalid", "Observation starts before its fixed 100 ms offered slot.")
        if began is not None and finished is not None:
            if finished < began or finished > end_ms + 2:
                gate.issue(path + ".finishedOffsetMs", "invalid", "Observation end must follow its start within the measured load window.")
            if elapsed is not None and elapsed > finished - began + 2:
                gate.issue(path + ".durationMs", "invalid", "HTTP duration exceeds its observed start/end interval.")
        if error == "concurrency_limit":
            admission += 1
            if not (elapsed == 0 and items == 0 and began == finished and inflight == 20):
                gate.issue(path + ".admission", "invalid", "Admission rejection must retain the zero-duration saturated-slot observation.")
        else:
            if elapsed is not None:
                latency.append(elapsed)
            if began is not None and finished is not None and finished >= began:
                wall_latency.append(finished - began)
    # Use observed offered slots as denominator; never the report's successes or
    # admitted-only summary. Incomplete observations fail independently.
    failure_rate = failures / len(rows) if rows else None
    p95 = percentile(latency, 0.95)
    max_late = max(lateness) if lateness else None
    if wrong_page_size:
        gate.issue("load.fixturePageSize", "threshold", "Every successful page in this fixed 50000-project synthetic fixture must contain exactly 20 items; this does not change production short-page behavior.")
    if len(rows) == OFFERED and failures > 6:
        gate.issue("load.failureRate", "threshold", "Failures including admission and transport errors exceed 6 of 6000 offered requests.")
    if p95 is None:
        gate.issue("load.admittedP95Ms", "incomplete", "No complete admitted request latency evidence is available.")
    elif p95 > 800:
        gate.issue("load.admittedP95Ms", "threshold", "Recomputed admitted HTTP p95, including transport failures, exceeds 800 ms.")
    if max_late is not None and max_late > 1000:
        gate.issue("load.maximumSchedulingLatenessMs", "threshold", "Maximum scheduled-arrival lateness exceeds 1000 ms; 10 RPS execution quality is insufficient.")
    gate.result["metrics"]["load"] = {
        "offered": len(rows), "successful": successes, "failures": failures,
        "admissionRejected": admission, "transportErrors": transport,
        "unexpectedSuccessfulPageSizes": wrong_page_size,
        "admitted": len(rows) - admission, "failureRateOffered": failure_rate,
        "admittedLatencySamples": len(latency), "admittedP50Ms": percentile(latency, 0.5),
        "admittedP95Ms": p95, "admittedP99Ms": percentile(latency, 0.99),
        "admittedMaxMs": max(latency) if latency else None,
        "admittedObservedIntervalP95Ms": percentile(wall_latency, 0.95),
        "latencyMethod": "Nearest-rank durationMs for all admitted HTTP attempts, including transport errors; concurrency_limit slots excluded.",
        "maximumSchedulingLatenessMs": max_late, "durationSeconds": duration,
        "loadWindowSeconds": end_ms / 1000,
    }
    check_resources(gate, report, load_start, end_ms)


def check_delete(gate, report):
    gate.field(report, "phase", lambda v: v == "delete", "delete")
    deletion = gate.field(report, "deletion", lambda v: isinstance(v, dict), "delete")
    if deletion is None:
        return
    path = "delete.deletion"
    for key, expected in (("eventsBefore", 250000), ("eventsAfter", 0)):
        gate.field(deletion, key, lambda v, expected=expected: integer(v) and v == expected, path)
    for key in ("rollbackPreservedEvents", "cancellationObservedActiveCascade", "s3FailureObserved", "cleanupAdapterReopened"):
        gate.field(deletion, key, lambda v: v is True, path)
    gate.field(deletion, "s3FailureCode", lambda v: v == S3_FAILURE, path)
    gate.field(deletion, "s3FailureRequests", lambda v: integer(v) and 1 <= v <= 2, path)
    gate.field(deletion, "cleanupFailures", lambda v: integer(v) and v >= 1, path)
    gate.field(deletion, "cleanupPhase", lambda v: v == "completed", path)
    gate.field(deletion, "recreatedProfileVersion", lambda v: integer(v) and v > 1, path)
    for key, status, error in (("acceptedAttempt", 202, ""), ("cancelledAttempt", 0, "transport_error")):
        attempt = gate.field(deletion, key, lambda v: isinstance(v, dict), path)
        if attempt is not None:
            gate.field(attempt, "status", lambda v, status=status: integer(v) and v == status, path + "." + key)
            gate.field(attempt, "durationMs", lambda v: number(v) and v >= 0, path + "." + key)
            if attempt.get("error", "") != error:
                gate.issue(path + "." + key + ".error", "invalid", "Deletion HTTP attempt does not match the expected accepted/cancelled outcome.")
    persisted = gate.field(deletion, "cleanupPersistedFailure", lambda v: isinstance(v, dict), path)
    if persisted is not None:
        for key, expected in (("status", "queued"), ("phase", "archive"), ("errorCode", S3_FAILURE)):
            gate.field(persisted, key, lambda v, expected=expected: v == expected, path + ".cleanupPersistedFailure")
        gate.field(persisted, "failures", lambda v: integer(v) and v >= 1, path + ".cleanupPersistedFailure")
    accepted = gate.field(deletion, "acceptedResponse", lambda v: isinstance(v, dict), path)
    recovered = gate.field(deletion, "cleanupRecovery", lambda v: isinstance(v, dict), path)
    accepted_id, recovered_id = None, None
    for key, obj, expected in (("acceptedResponse", accepted, "queued"), ("cleanupRecovery", recovered, "completed")):
        if obj is not None:
            gate.field(obj, "status", lambda v, expected=expected: v == expected, path + "." + key)
            identity = gate.field(obj, "deletionId", lambda v: isinstance(v, str) and bool(re.fullmatch(r"feed_delete_[A-Za-z0-9_-]{1,160}", v)), path + "." + key)
            if key == "acceptedResponse":
                accepted_id = identity
            else:
                recovered_id = identity
    if accepted_id is not None and recovered_id is not None and accepted_id != recovered_id:
        gate.issue(path + ".cleanupRecovery.deletionId", "invalid", "Recovered deletion must match the accepted deletion operation.")
    if recovered is not None:
        gate.field(recovered, "steps", lambda v: integer(v) and 1 <= v <= 8, path + ".cleanupRecovery")
        gate.field(recovered, "processed", lambda v: integer(v) and 0 <= v <= 800, path + ".cleanupRecovery")
    gate.result["metrics"]["deletion"] = {
        "eventsBefore": deletion.get("eventsBefore") if integer(deletion.get("eventsBefore")) else None,
        "eventsAfter": deletion.get("eventsAfter") if integer(deletion.get("eventsAfter")) else None,
        "recreatedProfileVersion": deletion.get("recreatedProfileVersion") if integer(deletion.get("recreatedProfileVersion")) else None,
        "accepted202": isinstance(deletion.get("acceptedAttempt"), dict) and deletion["acceptedAttempt"].get("status") == 202,
        "s3FailureObserved": deletion.get("s3FailureObserved") is True,
        "adapterReopened": deletion.get("cleanupAdapterReopened") is True,
        "completed": isinstance(recovered, dict) and recovered.get("status") == "completed",
    }


def check_external_resources(gate, directory, load):
    path = Path(directory) / "external-resources.jsonl"
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(descriptor, "rb") as file:
            info = os.fstat(file.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_REPORT_BYTES:
                raise ValueError("invalid resource file")
            raw = file.read(MAX_REPORT_BYTES + 1)
        if len(raw) > MAX_REPORT_BYTES:
            raise ValueError("resource file too large")
        gate.result["inputs"][path.name] = {"sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        lines = raw.decode("utf-8").splitlines()
    except FileNotFoundError:
        gate.issue(path.name, "incomplete", "Required external resource observation file is missing.")
        return
    except (OSError, ValueError, UnicodeError):
        gate.issue(path.name, "invalid", "External resource evidence must be a bounded regular UTF-8 JSONL file.")
        return
    if not raw.endswith(b"\n"):
        gate.issue(path.name, "incomplete", "External resource stream is empty or lacks its final complete newline.")
    if len(lines) > 20000:
        gate.issue(path.name, "invalid", "External resource evidence exceeds the bounded line count.")
        return
    load_start = timestamp(load.get("loadStartedAt")) if isinstance(load, dict) else None
    observations = load.get("observations") if isinstance(load, dict) else None
    finishes = [r["finishedOffsetMs"] for r in observations[:OFFERED] if isinstance(r, dict) and number(r.get("finishedOffsetMs"))] if isinstance(observations, list) else []
    end = max(finishes) if finishes else None
    if load_start is None or end is None:
        gate.issue("externalResources.window", "incomplete", "A valid load start and observed request completion window are required.")
        return
    offsets = {name: [] for name in (*CONTAINERS, "host-vm")}
    malformed, ignored, outside, ended = 0, 0, 0, 0
    for line in lines:
        try:
            row = json.loads(line, object_pairs_hook=unique_object, parse_constant=no_constant)
        except (ValueError, RecursionError):
            malformed += 1
            continue
        if not isinstance(row, dict):
            malformed += 1
            continue
        at = timestamp(row.get("at"))
        source = row.get("source")
        if at is None or at.utcoffset() != dt.timedelta(0) or source not in ("docker", "host-vm"):
            malformed += 1
            continue
        if row.get("observerEnded") is True:
            ended += 1
            continue
        payload = row.get("line")
        if not isinstance(payload, str):
            malformed += 1
            continue
        offset = (at - load_start).total_seconds() * 1000
        if not -2000 <= offset <= end + 5000:
            outside += 1
            continue
        if source == "host-vm":
            # Linux vmstat / macOS vm_stat headers, errors, and termination
            # messages never count. Only the numeric data rows are coverage.
            if re.match(r"^\s*\d", payload) and len(payload.split()) >= 10:
                offsets[source].append(offset)
            else:
                ignored += 1
            continue
        cleaned = ANSI.sub("", payload).strip()
        try:
            docker = json.loads(cleaned, object_pairs_hook=unique_object, parse_constant=no_constant)
        except (ValueError, RecursionError):
            ignored += 1
            continue
        if not isinstance(docker, dict):
            ignored += 1
            continue
        name = docker.get("Name")
        cpu = docker.get("CPUPerc")
        memory = docker.get("MemUsage")
        valid_cpu = isinstance(cpu, str) and re.fullmatch(r"\d+(?:\.\d+)?%", cpu) is not None
        if not (name in CONTAINERS and docker.get("Container") == name and valid_cpu
                and number(float(cpu[:-1])) and isinstance(memory, str) and memory.strip()):
            malformed += 1
            continue
        offsets[name].append(offset)
    if malformed:
        gate.issue(path.name, "invalid", "External resource stream contains malformed JSONL, identity, timestamp, or Docker metric evidence.")
    coverage = {}
    for name, values in offsets.items():
        seconds = len({math.floor(v / 1000) for v in values})
        span = (max(values) - min(values)) / 1000 if values else 0
        required = 550 if name == "host-vm" else 250
        coverage[name] = {"validSamples": len(values), "distinctSeconds": seconds, "spanSeconds": span,
                          "firstOffsetMs": min(values) if values else None, "lastOffsetMs": max(values) if values else None}
        if seconds < required or span < 590:
            gate.issue("externalResources." + name + ".coverage", "incomplete", "Observer must cover at least 590 seconds and the required distinct sampled seconds within the load window.")
    gate.result["metrics"]["externalResources"] = {
        "coverage": coverage, "malformedLines": malformed, "ignoredNonSampleLines": ignored,
        "outOfWindowLines": outside, "observerEndedLines": ended,
        "interpretation": "Checks observation coverage only; sampled host/container metrics do not establish CPU, GC, memory, or database causality.",
    }


def verify(directory, release_sha):
    gate = Gate(release_sha)
    if gate.result["releaseSha"] is None:
        gate.issue("releaseSha", "invalid", "An exact 40-hex release SHA is required.")
    load = None
    for name, check in (("fixture", check_fixture), ("load", check_load), ("delete", check_delete)):
        report = read_report(Path(directory) / (name + ".json"), gate)
        if name == "load":
            load = report
        if report is not None:
            check_baseline(gate, report, name, release_sha)
            check(gate, report)
    check_external_resources(gate, directory, load)
    return gate.finish()


def write_gate(directory, result):
    path = Path(directory)
    path.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".gate-", suffix=".json", dir=path)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            json.dump(result, file, indent=2, sort_keys=True, allow_nan=False)
            file.write("\n")
        os.replace(name, path / "gate.json")
    finally:
        if os.path.exists(name):
            os.unlink(name)


class GateArgumentParser(argparse.ArgumentParser):
    def error(self, _message):
        raise ValueError("invalid arguments")


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    parser = GateArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--release-sha", required=True)
    try:
        args = parser.parse_args(arguments)
    except ValueError:
        # Even a bad invocation should invalidate stale output when the intended
        # output directory is unambiguous. Never echo arbitrary argument values.
        directories = []
        for index, value in enumerate(arguments):
            if value == "--directory" and index + 1 < len(arguments) and not arguments[index + 1].startswith("--"):
                directories.append(arguments[index + 1])
            elif value.startswith("--directory=") and value != "--directory=":
                directories.append(value.split("=", 1)[1])
        if len(directories) == 1:
            gate = Gate(None)
            gate.issue("arguments", "invalid", "Use --directory and --release-sha with an exact 40-hex release SHA.")
            try:
                write_gate(directories[0], gate.finish())
            except (OSError, ValueError):
                pass
        print("Feed capacity gate incomplete: invalid CLI arguments.", file=sys.stderr)
        return 1
    try:
        result = verify(args.directory, args.release_sha)
    except Exception:
        # An unexpected checker failure must never leave a prior passing gate.
        gate = Gate(args.release_sha)
        gate.issue("verifier", "incomplete", "Verifier could not complete evidence validation.")
        result = gate.finish()
    try:
        write_gate(args.directory, result)
    except (OSError, ValueError):
        print("Feed capacity gate incomplete: could not write gate.json.", file=sys.stderr)
        return 1
    print("Feed capacity gate: " + result["status"] + "; " + str(len(result["issues"])) + " issue(s). Finite-run engineering gate only; monthly availability is not proven.")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
