"""Template live node: pull dora_live frames, watch brightness, post events.

Consumes the two designed extension seams and nothing else:

* frames PULL contract — ``GET /live/frames`` (index) +
  ``GET /live/frame?topic=`` (payload, ETag/304), decimated compressed frames.
* event intake — ``POST /internal/analysis/events`` with a freeform body
  (``t`` = epoch seconds is the only reserved key; auto-stamped if absent).
  Consumers read them back at ``GET /live/events?since=``.

The robot-side stack never learns this consumer exists; killing this
container costs recording/monitoring nothing.

Honesty notes baked into the template (adversarial-review findings):
* the heartbeat is TICK-driven — it fires even when no frame ever decodes,
  so a dead camera and a dead sidecar are distinguishable.
* auto-pick prefers ``codec == "image"`` topics: ffmpeg-lane payloads are
  H.264/HEVC access units that ``cv2.imdecode`` cannot decode (they need
  PyAV); if only ffmpeg topics exist that limitation is logged loudly.
* a topic that starts to 404 (renamed/removed from the live config) is
  re-picked after a few misses instead of looping forever.

Env (all optional):
  DORA_LIVE_URL   control sidecar base (default http://127.0.0.1:8005;
                  set http://<robot>:8005 when running off-robot)
  FRAME_TOPIC     camera topic to pull; empty = auto-pick from the index
  DARK_THRESHOLD  mean-gray level below which a dark_frame event fires (40)
"""

from __future__ import annotations

import os
import sys
import time

import cv2
import httpx
import numpy as np
from dora import Node

HEARTBEAT_EVERY_TICKS = 20  # one liveness event per ~10 s at the 500 ms tick
REPICK_AFTER_404S = 6  # consecutive 404s before an auto-picked topic is dropped


def log(*parts: object) -> None:
    print("[live_ext]", *parts, file=sys.stderr, flush=True)


def pick_topic(client: httpx.Client, base: str) -> str:
    """Auto-pick a camera topic from the frames index (prefer decodable)."""
    frames = client.get(f"{base}/live/frames").json()["frames"]
    if not frames:
        return ""
    image_like = [f for f in frames if f.get("codec") == "image"]
    if image_like:
        topic = image_like[0]["topic"]
        log("auto-picked topic:", topic)
        return topic
    topic = frames[0]["topic"]
    log(
        "auto-picked topic:",
        topic,
        f"(codec={frames[0].get('codec')} — NOT cv2-decodable; ffmpeg lanes "
        "need PyAV. Set FRAME_TOPIC or use an image-codec camera.)",
    )
    return topic


def main() -> int:
    base = os.environ.get("DORA_LIVE_URL", "http://127.0.0.1:8005").rstrip("/")
    pinned_topic = os.environ.get("FRAME_TOPIC", "")
    threshold = float(os.environ.get("DARK_THRESHOLD", "40"))
    client = httpx.Client(timeout=2.0)
    topic = pinned_topic
    etag: str | None = None
    ticks = 0
    frames_seen = 0
    misses_404 = 0
    last_mean: float | None = None
    cycle_failing = False

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
                # 404 = topic gone from the store (renamed config, restart) —
                # NOT "no new frame". Re-pick auto topics instead of zombieing.
                misses_404 += 1
                if not pinned_topic and misses_404 >= REPICK_AFTER_404S:
                    log(f"topic {topic} gone ({misses_404}x 404); re-picking")
                    topic, etag, misses_404 = "", None, 0
            elif resp.status_code != 304:
                misses_404 = 0
                etag = resp.headers.get("ETag")
                image = cv2.imdecode(
                    np.frombuffer(resp.content, dtype=np.uint8),
                    cv2.IMREAD_GRAYSCALE,
                )
                if image is not None:
                    frames_seen += 1
                    last_mean = float(image.mean())
                    if last_mean < threshold:
                        client.post(
                            f"{base}/internal/analysis/events",
                            json={
                                "kind": "dark_frame",
                                "source": "extension_template",
                                "topic": topic,
                                "mean_gray": round(last_mean, 1),
                                "threshold": threshold,
                            },
                        )

            # Tick-driven liveness: fires even when frames never arrive or
            # never decode — frames_seen tells the two apart.
            if ticks % HEARTBEAT_EVERY_TICKS == 0:
                client.post(
                    f"{base}/internal/analysis/events",
                    json={
                        "kind": "brightness_heartbeat",
                        "source": "extension_template",
                        "topic": topic,
                        "mean_gray": (
                            round(last_mean, 1) if last_mean is not None else None
                        ),
                        "frames_seen": frames_seen,
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
