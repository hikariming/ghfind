#!/usr/bin/env python3
"""Independent standard-library reference transcript. Synthetic data only.
Recompute golden hashes with --write; default checks the committed fixture.
Neither mode executes SQL, applies rows or prints private payloads.
"""
import base64
import hashlib
import json
import pathlib
import sys

PATH = pathlib.Path(__file__).with_name("transfer-v1.json")

def digest(data):
    return hashlib.sha256(data).hexdigest()

def frame(tokens):
    return b"".join(str(len(b)).encode("ascii") + b":" + b
                    for b in (str(t).encode("utf-8") for t in tokens))

def identity(v):
    return [v[k] for k in ("profile", "resourceId", "schema", "writerContract", "writerEpoch", "routeEpoch")]

def hashes(f):
    m = f["manifest"]
    floors = sorted(f["floors"], key=lambda v: v["githubId"])
    m["deletionFloorsSha256"] = digest(frame([
        "ghfind.feed.transfer.floors.v1", len(floors),
        *(token for floor in floors for token in (floor["githubId"], floor["profileFloor"]))]))
    mh = digest(frame([
        "ghfind.feed.transfer.manifest.v1", m["version"], m["stream"], m["migrationId"], m["journalId"],
        *identity(m["source"]), *identity(m["target"]), m["snapshotSha256"], m["archiveInventorySha256"],
        m["archiveObjects"], m["deletionFloorsSha256"], m["deletionFloorActors"], m["fromSequence"],
        m["throughSequence"], m["anchorHash"], len(m["coverage"]),
        *(token for c in m["coverage"] for token in (c["table"], c["mode"], c["category"], c["snapshotRows"]))]))
    f["manifestHash"] = mh
    previous = m["anchorHash"]
    sequence = m["fromSequence"]
    for batch in f["batches"]:
        batch["manifestHash"] = mh
        batch["previousHash"] = previous
        batch["afterSequence"] = sequence
        for tx in batch["transactions"]:
            sequence += 1
            tx.update(sequence=sequence, transactionId=f'{m["journalId"]}:{sequence}', previousHash=previous)
            tokens = ["ghfind.feed.transfer.transaction.v1", *identity(m["source"]), m["journalId"],
                      sequence, tx["transactionId"], previous, len(tx["changes"])]
            for change in tx["changes"]:
                actor = change["actor"]
                image = base64.b64decode(change["image"], validate=True) if change["image"] is not None else b""
                tokens += [change["table"], change["key"], change["operation"], int(actor is not None)]
                if actor is not None:
                    tokens += [actor["githubId"], actor["profileVersion"]]
                tokens += [len(image), digest(image)]
            previous = tx["hash"] = digest(frame(tokens))
        batch["hash"] = digest(frame([
            "ghfind.feed.transfer.batch.v1", batch["version"], mh, batch["afterSequence"],
            batch["previousHash"], len(batch["transactions"]),
            *(tx["hash"] for tx in batch["transactions"]), int(batch["final"])]))
    return f

if __name__ == "__main__":
    original = json.loads(PATH.read_text())
    updated = hashes(json.loads(json.dumps(original)))
    if sys.argv[1:] == ["--write"]:
        PATH.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + "\n")
    elif sys.argv[1:]:
        raise SystemExit("usage: generate_fixture.py [--write]")
    elif updated != original:
        raise SystemExit("fixture hash mismatch")
    print("synthetic transfer-v1 fixture hashes verified")
