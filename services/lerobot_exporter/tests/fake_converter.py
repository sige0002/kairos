#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""A stand-in for ``rosbag2lerobot convert``, driven by environment variables.

The real converter needs ffmpeg, the submodule, and minutes of CPU; every
behaviour the exporter has to handle (heartbeats, per-episode results, a
non-zero exit, a stall, a process that ignores SIGTERM) is reproducible in a
few lines. Pointing ``KAIROS_LEROBOT_BIN`` at this script is what lets the
queue, staging, progress and cancel paths be tested end to end through the real
FastAPI app on a host with neither.

It also SNAPSHOTS what it was handed — argv, the staging tree with each
symlink's target, and the manifest extra — into ``meta/fake_input.json``.
Staging is deleted when the export finishes, so the converter's own view is the
only honest place to assert it from.

Environment:
  FAKE_MODE             ok (default) | fail | hang
  FAKE_EPISODES         episodes to "convert" (default: the staged bag count)
  FAKE_EPISODE_DELAY_S  seconds per episode (default 0)
  FAKE_HEARTBEAT_AGE_S  age to backdate progress.json's updated_at by
  FAKE_IGNORE_TERM      1 = install SIG_IGN for SIGTERM (escalation test)
  FAKE_CHILD            1 = spawn a `sleep` child (inherits the pipes) + record its pid
  FAKE_CHILD_SLEEP_S    how long that child lives (default 30)
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    convert = sub.add_parser("convert")
    convert.add_argument("--config", required=True)
    convert.add_argument("--bags", required=True)
    convert.add_argument("--output", required=True)
    convert.add_argument("--task")
    convert.add_argument("--manifest-extra")
    convert.add_argument("--workers", type=int, default=1)
    convert.add_argument("--json", action="store_true")
    # Mirrors the real CLI's --gpu/--no-gpu pair; the exporter always passes
    # --no-gpu unless the deployment opted in (KAIROS_LEROBOT_GPU).
    convert.add_argument("--gpu", dest="gpu", action="store_true")
    convert.add_argument("--no-gpu", dest="gpu", action="store_false")
    return parser.parse_args(argv)


def _snapshot_bags(bags: Path) -> dict:
    """The staging tree as the converter sees it: names, link targets, contents."""
    tree: dict[str, dict] = {}
    for episode in sorted(p for p in bags.iterdir() if p.is_dir()):
        links: dict[str, str] = {}
        real_files: list[str] = []
        task_json = None
        for item in sorted(episode.iterdir()):
            if item.is_symlink():
                links[item.name] = os.readlink(item)
            else:
                real_files.append(item.name)
            if item.name == "task.json":
                task_json = json.loads(item.read_text(encoding="utf-8"))
        tree[episode.name] = {
            "links": links,
            "real_files": real_files,
            "task_json": task_json,
        }
    return tree


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    tmp.replace(path)


def main() -> int:
    args = _parse_args(sys.argv[1:])
    bags = Path(args.bags)
    output = Path(args.output)
    meta = output / "meta"
    meta.mkdir(parents=True, exist_ok=True)

    manifest_extra = {}
    if args.manifest_extra and Path(args.manifest_extra).is_file():
        manifest_extra = json.loads(
            Path(args.manifest_extra).read_text(encoding="utf-8")
        )
    _write_json(
        meta / "fake_input.json",
        {
            "argv": sys.argv[1:],
            "task": args.task,
            "workers": args.workers,
            "config": args.config,
            "bags": _snapshot_bags(bags),
            "manifest_extra": manifest_extra,
        },
    )

    if os.environ.get("FAKE_IGNORE_TERM") == "1":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if os.environ.get("FAKE_CHILD") == "1":
        # Stands in for ffmpeg: same process group, and it INHERITS this
        # process's stdout/stderr, so it holds those pipes open after we exit.
        sleep_s = os.environ.get("FAKE_CHILD_SLEEP_S", "30")
        if os.environ.get("FAKE_CHILD_IGNORE_TERM") == "1":
            # The child survives SIGTERM. Paired with a parent that does NOT
            # (the plain "hang" loop below), this is the F2 case: a cancel's
            # group-SIGTERM kills the parent while the child keeps running.
            # Waiting on the parent alone would call the cancel done with a
            # live writer still going; only escalating to a group SIGKILL,
            # which nothing can ignore, actually stops it.
            #
            # It touches a READY file AFTER installing SIG_IGN, so the test can
            # wait for that before sending the cancel — otherwise the child
            # races interpreter startup against the signal, and a child that
            # dies on a plain SIGTERM would pass the test without the SIGKILL
            # escalation ever running (the exact vacuous-test trap the review
            # caught).
            ready = meta / "fake_child_ready"
            child = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    "import signal,time,sys;"
                    "signal.signal(signal.SIGTERM,signal.SIG_IGN);"
                    "open(sys.argv[2],'w').close();"
                    "time.sleep(float(sys.argv[1]))",
                    sleep_s,
                    str(ready),
                ]
            )
        else:
            child = subprocess.Popen(["sleep", sleep_s])
        _write_json(meta / "fake_child.json", {"pid": child.pid})

    mode = os.environ.get("FAKE_MODE", "ok")
    total = int(os.environ.get("FAKE_EPISODES", "0")) or len(
        [p for p in bags.iterdir() if p.is_dir()]
    )
    delay = float(os.environ.get("FAKE_EPISODE_DELAY_S", "0"))
    backdate = float(os.environ.get("FAKE_HEARTBEAT_AGE_S", "0"))

    if mode == "fail":
        print("fake converter: exploding on purpose", file=sys.stderr)
        return 3

    episodes = []
    for index in range(total):
        _write_json(
            meta / "progress.json",
            {
                "episode_index": index,
                "episode_total": total,
                "messages_done": 5,
                "messages_total": 10,
                "updated_at": time.time() - backdate,
            },
        )
        if mode == "hang":
            while True:
                time.sleep(0.05)
        if delay:
            time.sleep(delay)
        episodes.append({"success": True})
        _write_json(
            meta / "job_summary.json",
            {
                "n_episodes": len(episodes),
                "n_success": len(episodes),
                "n_failed": 0,
            },
        )
    _write_json(meta / "info.json", {"codebase_version": "v3.0"})
    if args.json:
        print(json.dumps({"n_success": total, "n_failed": 0}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
