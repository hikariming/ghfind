#!/usr/bin/env python3
"""Independent synthetic v2 hashes; no database/persistence evidence.
UTF-8 byte order is explicit. Python's source values never reserialize row images.
"""
import base64
import copy
import json
import pathlib
import sys
from generate_fixture import frame, digest, identity, hashes as v1_hashes

PATH = pathlib.Path(__file__).with_name("segments-v2.json")
ZERO = "0" * 64

def hashed(tokens):
    return digest(frame(tokens))

def floor_digest(floors):
    rows = sorted(floors, key=lambda f: f["githubId"])
    return hashed(["ghfind.feed.transfer.floors.v1", len(rows),
                   *(n for f in rows for n in (f["githubId"], f["profileFloor"]))])

def progress_hash(p):
    row = p["lastRow"]
    return hashed(["ghfind.feed.transfer.stage-progress.v2", p["sealHash"],
                   p["nextSegment"], p["nextOrdinal"], p["contentBytes"], p["lastSegmentHash"],
                   int(row is not None), *([] if row is None else [row["table"], row["key"], row["operation"]]),
                   p["floorRecords"], p["floorChainHash"], int(p["ready"])])

def checkpoint_hash(c):
    return hashed(["ghfind.feed.transfer.applied-checkpoint.v2", c["manifestHash"],
                   c["sequence"], c["commitHash"], floor_digest(c["floors"]), len(c["floors"]), int(c["final"])])

def hashes(f):
    m = f["manifest"]
    mh = v1_hashes({"manifest": m, "floors": f["initialFloors"], "batches": []})["manifestHash"]
    seq = m["fromSequence"] + 1
    txid = f'{m["journalId"]}:{seq}'
    ordinal = content = floors = 0
    previous = floor_chain = ZERO
    after_floors = {r["githubId"]: r["profileFloor"] for r in f["initialFloors"]}
    checkpoints = []
    last_key = None
    for i, segment in enumerate(f["segments"]):
        segment.update(version=2, transactionId=txid, sequence=seq, previousCommitHash=m["anchorHash"],
                       index=i, firstOrdinal=ordinal, previousSegmentHash=previous)
        tokens = ["ghfind.feed.transfer.segment.v2", *identity(m["source"]), m["journalId"],
                  2, txid, seq, m["anchorHash"], i, ordinal, previous, len(segment["changes"])]
        for change in segment["changes"]:
            row = change["row"]
            key = tuple(row[n].encode("utf-8") for n in ("table", "key", "operation"))
            if last_key is not None and key <= last_key:
                raise ValueError("fixture must follow UTF-8 byte key order")
            last_key = key
            actor, before = row["actor"], change["beforeHash"]
            image = b"" if row["image"] is None else base64.b64decode(row["image"], validate=True)
            tokens += [row["table"], row["key"], row["operation"], int(actor is not None)]
            if actor is not None:
                tokens += [actor["githubId"], actor["profileVersion"]]
            tokens += [int(before is not None), *([] if before is None else [before]), len(image), digest(image)]
            content += sum(len(row[n].encode("utf-8")) for n in ("table", "key", "operation")) + len(image)
            content += (16 if actor is not None else 0) + (64 if before is not None else 0)
            if row["operation"] == "floor":
                floors += 1
                floor_chain = hashed(["ghfind.feed.transfer.floor-chain.v2", floor_chain,
                                      row["table"], row["key"], actor["githubId"], actor["profileVersion"]])
                after_floors[actor["githubId"]] = max(after_floors.get(actor["githubId"], 0), actor["profileVersion"])
        ordinal += len(segment["changes"])
        previous = segment["hash"] = hashed(tokens)
        checkpoints.append(dict(nextSegment=i+1, nextOrdinal=ordinal, contentBytes=content,
                                lastSegmentHash=previous, lastRow=dict(zip(("table", "key", "operation"),
                                                                         (segment["changes"][-1]["row"][n] for n in ("table", "key", "operation")))),
                                floorRecords=floors, floorChainHash=floor_chain, ready=i+1 == len(f["segments"])))
    s = dict(version=2, manifestHash=mh, transactionId=txid, sequence=seq, previousCommitHash=m["anchorHash"],
             totalChanges=ordinal, contentBytes=content, segmentCount=len(f["segments"]), lastSegmentHash=previous,
             floorRecords=floors, floorChainHash=floor_chain)
    s["transactionHash"] = hashed(["ghfind.feed.transfer.transaction.v2", *identity(m["source"]), m["journalId"],
                                   2, txid, seq, m["anchorHash"], ordinal, content, len(f["segments"]), previous, floors, floor_chain])
    s["hash"] = hashed(["ghfind.feed.transfer.seal.v2", 2, mh, s["transactionHash"]])
    f["seal"] = s
    p = dict(sealHash=s["hash"], nextSegment=0, nextOrdinal=0, contentBytes=0,
             lastSegmentHash=ZERO, lastRow=None, floorRecords=0, floorChainHash=ZERO, ready=False)
    p["hash"] = progress_hash(p)
    f["receipts"] = []
    for i, after in enumerate(checkpoints):
        f["segments"][i]["sealHash"] = s["hash"]
        after["sealHash"] = s["hash"]
        after["hash"] = progress_hash(after)
        receipt = dict(version=2, sealHash=s["hash"], segmentIndex=i, segmentHash=f["segments"][i]["hash"],
                       beforeProgressHash=p["hash"], after=after)
        receipt["hash"] = hashed(["ghfind.feed.transfer.stage-receipt.v2", 2, s["hash"], i,
                                  receipt["segmentHash"], p["hash"], after["hash"]])
        f["receipts"].append(receipt)
        p = after
    cp = dict(manifestHash=mh, sequence=m["fromSequence"], commitHash=m["anchorHash"], floors=f["initialFloors"], final=False)
    decision_tokens = ["ghfind.feed.transfer.decisions.v2", s["hash"],
                       floor_digest([dict(githubId=k, profileFloor=v) for k, v in after_floors.items()]), ordinal]
    decision_ordinal = 0
    for segment in f["segments"]:
        for change in segment["changes"]:
            row, action = change["row"], "apply"
            if row["operation"] == "floor":
                action = "retain_max_floor"
            elif row["operation"] in ("erase", "command_tombstone"):
                assert row["actor"]["profileVersion"] <= after_floors.get(row["actor"]["githubId"], 0)
                action = "erase" if row["operation"] == "erase" else "tombstone"
            elif row["operation"] == "upsert" and row["actor"] is not None:
                if row["actor"]["profileVersion"] <= after_floors.get(row["actor"]["githubId"], 0):
                    action = "suppress_deleted_generation"
            decision_tokens += [decision_ordinal, action]
            decision_ordinal += 1
    decision_hash = hashed(decision_tokens)
    r = dict(version=2, outcome="applied", sealHash=s["hash"], stageProgressHash=p["hash"],
             beforeCheckpointHash=checkpoint_hash(cp), transactionHash=s["transactionHash"], floorChainHash=floor_chain,
             decisionHash=decision_hash, mapVersion="synthetic-map-v1", normalizedStateHash="c"*64, atomicApplyId="77777777-7777-4777-8777-777777777777",
             after=dict(manifestHash=mh, sequence=seq, commitHash=s["transactionHash"],
                        floors=[dict(githubId=k, profileFloor=v) for k, v in sorted(after_floors.items())], final=seq==m["throughSequence"]))
    r["hash"] = hashed(["ghfind.feed.transfer.atomic-receipt.v2", 2, r["outcome"], s["hash"], p["hash"],
                        r["beforeCheckpointHash"], s["transactionHash"], floor_chain, decision_hash, r["mapVersion"],
                        r["normalizedStateHash"], r["atomicApplyId"], checkpoint_hash(r["after"])])
    f["syntheticAtomicReceipt"] = r
    return f

if __name__ == "__main__":
    original = json.loads(PATH.read_text())
    updated = hashes(copy.deepcopy(original))
    if sys.argv[1:] == ["--write"]:
        PATH.write_text(json.dumps(updated, ensure_ascii=False, indent=2)+"\n")
    elif sys.argv[1:]:
        raise SystemExit("usage: generate_segments_fixture.py [--write]")
    elif updated != original:
        raise SystemExit("v2 fixture mismatch")
    print("synthetic v2 segment/seal/stage/atomic-receipt hashes verified; no DB apply")
