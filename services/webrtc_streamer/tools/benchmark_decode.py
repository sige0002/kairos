# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Compare source conversion work on identical, deterministic preview inputs.

Run this SAME script against baseline and candidate packages (PYTHONPATH selects
the source tree). JSON reports CPU spent in callbacks/prepare only, not encoding
or network CPU. The virtual schedule makes output hashes comparable.
"""

from __future__ import annotations

import hashlib
import json
import statistics
import time
from types import SimpleNamespace

import cv2
import numpy as np
from webrtc_streamer import convert
from webrtc_streamer.source import RosImageSource


def main() -> None:
    cv2.setNumThreads(1)
    rng = np.random.default_rng(20260908)
    fixtures = []
    for _ in range(4):
        image = rng.integers(0, 256, (1080, 1920, 3), dtype=np.uint8)
        ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        assert ok
        fixtures.append(jpeg.tobytes())
    original = convert.compressed_image_to_bgr
    results = []
    for input_hz in [5, 15, 30, 60]:
        runs = []
        for _ in range(3):
            source = RosImageSource("/benchmark/image/compressed", max_width=854)
            calls = 0

            def decode(msg):
                nonlocal calls
                calls += 1
                return original(msg)

            convert.compressed_image_to_bgr = decode
            prepare = getattr(source, "prepare_frame", lambda: None)
            digest = hashlib.sha256()
            cpu = 0.0
            output_count = 0
            # 120 virtual ticks/s, source at 5/15/30/60 Hz, display at 15 Hz.
            for tick in range(240):
                if tick % (120 // input_hz) == 0:
                    sequence = tick // (120 // input_hz)
                    msg = SimpleNamespace(data=fixtures[sequence % len(fixtures)])
                    started = time.process_time()
                    source._on_compressed(msg)
                    cpu += time.process_time() - started
                if tick % 8 == 1:
                    started = time.process_time()
                    prepare()
                    cpu += time.process_time() - started
                    frame = source.frames.latest_nowait()
                    assert frame is not None
                    digest.update(frame.tobytes())
                    output_count += 1
            source.stop()
            runs.append(
                {
                    "cpu_s": cpu,
                    "decode_calls": calls,
                    "outputs": output_count,
                    "sha256": digest.hexdigest(),
                }
            )
        results.append(
            {
                "input_hz": input_hz,
                "display_hz": 15,
                "duration_virtual_s": 2,
                "median_cpu_s": statistics.median(run["cpu_s"] for run in runs),
                "runs": runs,
            }
        )
    convert.compressed_image_to_bgr = original
    print(json.dumps({"opencv_threads": 1, "cases": results}, indent=2))


if __name__ == "__main__":
    main()
