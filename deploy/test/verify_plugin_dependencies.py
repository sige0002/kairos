#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Exercise dependency fixtures on a real image with no network or user data."""

from __future__ import annotations

import argparse
import subprocess
import uuid

# The probe runs inside the container, so it needs neither published ports nor
# ROS or Python dependencies on the host. Both environments coexist in one service.
PROBE = r"""
import importlib.util
import json
import time
import urllib.request
from pathlib import Path
from kairos_common.ids import new_capture_id

base = "http://127.0.0.1:8020"
def request(path, body=None):
    req = urllib.request.Request(base + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=10))

deadline = time.monotonic() + 90
while True:
    try:
        request("/readyz")
        break
    except Exception:
        if time.monotonic() >= deadline:
            raise
        time.sleep(0.25)
assert importlib.util.find_spec("humanize") is None, "service environment was polluted"
capture_id = new_capture_id()
(Path("/data/objects") / capture_id).mkdir(parents=True)
jobs = []
examples = [("requirements_example", "4.10.0"), ("project_example", "4.11.0")]
for pipeline, version in examples:
    job = request("/jobs", {
        "capture_id": capture_id, "pipeline": pipeline, "params": {}
    })
    jobs.append((pipeline, version, job["job_id"]))
for pipeline, version, job_id in jobs:
    deadline = time.monotonic() + 120
    while True:
        status = request(f"/jobs/{job_id}/status")
        if status["state"] in ("succeeded", "failed", "canceled"):
            break
        assert time.monotonic() < deadline, status
        time.sleep(0.25)
    assert status["state"] == "succeeded", status
    summary = request(f"/jobs/{job_id}/result")["summary"]
    assert summary["result"] == "pass", summary
    assert summary["message"] == "12,345", summary
    assert summary["metrics"]["dependency_version"] == version, summary
    print(json.dumps(summary), flush=True)
assert importlib.util.find_spec("humanize") is None, "service environment modified"
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="kairos-dora-runner:plugin-dependency-test")
    args = parser.parse_args()
    for fallback in (False, True):
        name = "kairos-plugin-check-" + uuid.uuid4().hex[:12]
        command = [
            "docker",
            "run",
            "-d",
            "--pull=never",
            "--name",
            name,
            "--network",
            "none",
            "--user",
            "1000:1000",
            "--tmpfs",
            "/data:rw,mode=1777,size=256m",
            "-e",
            "DATA_DIR=/data",
            "-e",
            "KAIROS_DORA_CONTROL_PORT=17112",
            "-e",
            "KAIROS_DORA_DAEMON_PORT=54490",
            "-e",
            "KAIROS_DORA_DAEMON_LISTEN_PORT=54491",
        ]
        if fallback:
            command += ["-e", "KAIROS_DORA_INPROCESS=1"]
        command.append(args.image)
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL)
        try:
            print(f"Checking plugins: fallback={fallback}", flush=True)
            subprocess.run(
                ["docker", "exec", "-i", name, "python"],
                input=PROBE,
                text=True,
                check=True,
                timeout=300,
            )
        except BaseException:
            subprocess.run(["docker", "logs", "--tail", "60", name], check=False)
            raise
        finally:
            # Only this invocation's uniquely named, disposable tmpfs container.
            subprocess.run(
                ["docker", "rm", "-f", name], check=True, stdout=subprocess.DEVNULL
            )


if __name__ == "__main__":
    main()
