"""Practice node: pull dora_live camera frames, grayscale them, save the result.

This file is a dora node in a dataflow of YOUR OWN (see dataflow.yml next to
it) — it runs under its own ``dora run``, completely outside the
kairos-managed dataflow. It consumes dora_live's live-frames PULL contract
(``GET /live/frames`` index + ``GET /live/frame`` payload with ETag/304),
which is the designed extension seam for off-robot image processing: the
robot never learns this consumer exists, and stopping it costs the robot
nothing.

Env (all optional):
  DORA_LIVE_URL  control sidecar base (default http://127.0.0.1:8005)
  FRAME_TOPIC    camera topic to pull; empty = auto-pick the first indexed one
  OUT_DIR        where latest_gray.jpg is written (default /out)
"""

from __future__ import annotations

import os
import sys

import cv2
import httpx
import numpy as np
from dora import Node


def log(*parts: object) -> None:
    print("[grayscale]", *parts, file=sys.stderr, flush=True)


def main() -> int:
    base = os.environ.get("DORA_LIVE_URL", "http://127.0.0.1:8005").rstrip("/")
    topic = os.environ.get("FRAME_TOPIC", "")
    out_dir = os.environ.get("OUT_DIR", "/out")
    os.makedirs(out_dir, exist_ok=True)
    client = httpx.Client(timeout=2.0)
    etag: str | None = None
    count = 0

    node = Node()
    log("up; pulling from", base)
    while True:
        ev = node.next(timeout=1.0)
        if ev is None:
            continue
        if ev["kind"] != "dora":
            continue
        if ev["type"] == "STOP":
            break
        if ev["type"] != "INPUT" or ev["id"] != "tick":
            continue

        try:
            if not topic:
                # Robot-independent: ask dora_live what cameras it serves.
                frames = client.get(f"{base}/live/frames").json()["frames"]
                if not frames:
                    log("no frames indexed yet (is a camera topic on the bus?)")
                    continue
                topic = frames[0]["topic"]
                log("auto-selected topic:", topic)
            headers = {"If-None-Match": etag} if etag else {}
            resp = client.get(
                f"{base}/live/frame", params={"topic": topic}, headers=headers
            )
        except Exception as exc:  # noqa: BLE001 - dora_live may be restarting
            log("dora_live unreachable:", exc)
            continue

        if resp.status_code == 304:
            continue  # unchanged since last tick (ETag) — nothing to redo
        if resp.status_code != 200:
            log("no frame yet for", topic, "->", resp.status_code)
            continue
        etag = resp.headers.get("ETag")

        buf = np.frombuffer(resp.content, dtype=np.uint8)
        bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if bgr is None:
            # e.g. an ffmpeg keyframe AU — this practice handles JPEG/PNG only.
            log("payload not cv2-decodable (codec:", resp.headers.get("X-Frame-Codec"), ")")
            continue
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        count += 1
        cv2.imwrite(os.path.join(out_dir, "latest_gray.jpg"), gray)
        log(f"#{count} {topic} {gray.shape[1]}x{gray.shape[0]} mean={gray.mean():.1f}")
    log("STOP; frames processed:", count)
    return 0


if __name__ == "__main__":
    sys.exit(main())
