#!/usr/bin/env python3
"""Bounded metadata-only observers for the exclusive local capacity fixture."""
import argparse
import datetime
import json
import pathlib
import queue
import shutil
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("--out", type=pathlib.Path, required=True)
parser.add_argument("--stop-file", type=pathlib.Path, required=True)
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
messages = queue.Queue()
commands = {
    "docker": ["docker", "stats", "--format", "{{json .}}",
               "ghfind-feed-capacity-postgres-1", "ghfind-feed-capacity-minio-1"],
}
if shutil.which("vm_stat"):
    commands["host-vm"] = ["vm_stat", "1"]
children = []
threads = []

def observe(name, child):
    for line in child.stdout:
        messages.put({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      "source": name, "line": line.rstrip("\n")})
    messages.put({"at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "source": name, "observerEnded": True})

try:
    for name, command in commands.items():
        child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 text=True, bufsize=1)
        children.append(child)
        thread = threading.Thread(target=observe, args=(name, child), daemon=True)
        thread.start()
        threads.append(thread)
    deadline = time.monotonic() + 720
    with (args.out / "external-resources.jsonl").open("x") as output:
        while time.monotonic() < deadline and not args.stop_file.exists():
            try:
                output.write(json.dumps(messages.get(timeout=0.25), ensure_ascii=False) + "\n")
                output.flush()
            except queue.Empty:
                pass
finally:
    for child in children:
        child.terminate()
    for child in children:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
