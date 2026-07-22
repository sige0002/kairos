"""Grayscale example: pull dora_live frames, convert, save + report to the UI.

Demonstrates the full extension loop on real inputs and outputs:

* INPUT  — the frames pull contract (``GET /live/frames`` index +
  ``GET /live/frame?topic=`` payload, ETag/304): decimated compressed camera
  frames, decoded here with cv2.
* WORK   — grayscale conversion; the latest result is written to
  ``$OUT_DIR/latest_gray.jpg`` (host-visible via the compose volume).
* OUTPUT — heartbeat events to ``POST /internal/analysis/events``; they appear
  UNMODIFIED in the Web UI (Monitor → Events → "Extension events") — no
  frontend work.

Env: DORA_LIVE_URL (default http://127.0.0.1:8005), FRAME_TOPIC (empty =
auto-pick an image-codec topic), OUT_DIR (default /out).
"""

from __future__ import annotations

import os
import sys
import time

import cv2
import httpx
import numpy as np
from dora import Node

HEARTBEAT_EVERY_TICKS = 20  # ~10 s at the 500 ms tick
REPICK_AFTER_404S = 6


def log(*parts: object) -> None:
    print("[grayscale]", *parts, file=sys.stderr, flush=True)


def pick_topic(client: httpx.Client, base: str) -> str:
    frames = client.get(f"{base}/live/frames").json()["frames"]
    image_like = [f for f in frames if f.get("codec") == "image"]
    if image_like:
        topic = image_like[0]["topic"]
        log("auto-picked topic:", topic)
        return topic
    if frames:
        log("only non-image codecs indexed (ffmpeg needs PyAV); set FRAME_TOPIC")
    return ""


def main() -> int:
    base = os.environ.get("DORA_LIVE_URL", "http://127.0.0.1:8005").rstrip("/")
    pinned_topic = os.environ.get("FRAME_TOPIC", "")
    out_dir = os.environ.get("OUT_DIR", "/out")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "latest_gray.jpg")
    client = httpx.Client(timeout=2.0)
    topic = pinned_topic
    etag: str | None = None
    ticks = 0
    frames_done = 0
    misses_404 = 0
    cycle_failing = False

    node = Node()
    log("up; pulling from", base, "->", out_path)
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
        ticks += 1

        try:
            if not topic:
                topic = pick_topic(client, base)
                if not topic:
                    continue

            headers = {"If-None-Match": etag} if etag else {}
            resp = client.get(
                f"{base}/live/frame", params={"topic": topic}, headers=headers
            )
            if resp.status_code == 404:
                misses_404 += 1
                if not pinned_topic and misses_404 >= REPICK_AFTER_404S:
                    log(f"topic {topic} gone ({misses_404}x 404); re-picking")
                    topic, etag, misses_404 = "", None, 0
            elif resp.status_code != 304:
                misses_404 = 0
                etag = resp.headers.get("ETag")
                image = cv2.imdecode(
                    np.frombuffer(resp.content, dtype=np.uint8), cv2.IMREAD_COLOR
                )
                if image is not None:
                    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
                    cv2.imwrite(out_path, gray)
                    frames_done += 1

            if ticks % HEARTBEAT_EVERY_TICKS == 0:
                client.post(
                    f"{base}/internal/analysis/events",
                    json={
                        "kind": "grayscale_heartbeat",
                        "source": "example_grayscale",
                        "topic": topic,
                        "frames_done": frames_done,
                        "output": out_path,
                        "t": time.time(),
                    },
                )
            if cycle_failing:
                log("cycle recovered")
                cycle_failing = False
        except Exception as exc:  # noqa: BLE001 - sidecar must outlive stack restarts
            if not cycle_failing:
                log("cycle failed (silent until recovery):", exc)
                cycle_failing = True
            etag = None
    return 0


if __name__ == "__main__":
    sys.exit(main())
