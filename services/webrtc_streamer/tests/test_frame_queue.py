# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""LatestFrame: latest-frame-wins drop-old behaviour + close semantics."""

from __future__ import annotations

import threading
import time

from webrtc_streamer.frame_queue import LatestFrame


def test_get_returns_the_put_frame() -> None:
    buf: LatestFrame[str] = LatestFrame()
    buf.put("a")
    assert buf.get(timeout=0.1) == "a"


def test_put_overwrites_untaken_frame_and_counts_drop() -> None:
    buf: LatestFrame[int] = LatestFrame()
    buf.put(1)
    buf.put(2)
    buf.put(3)  # 1 and 2 overwritten before any get -> 2 drops
    # Only the newest frame survives (latest-frame-wins).
    assert buf.get(timeout=0.1) == 3
    stats = buf.stats()
    assert stats.produced == 3
    assert stats.dropped == 2
    assert stats.delivered == 1


def test_get_empties_the_slot() -> None:
    buf: LatestFrame[int] = LatestFrame()
    buf.put(5)
    assert buf.get(timeout=0.1) == 5
    # Slot is now empty: a second get times out (returns None).
    assert buf.get(timeout=0.05) is None


def test_latest_nowait_does_not_consume() -> None:
    buf: LatestFrame[int] = LatestFrame()
    buf.put(7)
    # Peeking leaves the frame in place for the next consumer.
    assert buf.latest_nowait() == 7
    assert buf.latest_nowait() == 7
    assert buf.get(timeout=0.1) == 7


def test_get_blocks_until_a_frame_arrives() -> None:
    buf: LatestFrame[str] = LatestFrame()

    def produce() -> None:
        time.sleep(0.05)
        buf.put("late")

    t = threading.Thread(target=produce)
    t.start()
    # get blocks (no frame yet) until produce() puts one.
    assert buf.get(timeout=1.0) == "late"
    t.join()


def test_close_unblocks_waiters_and_rejects_puts() -> None:
    buf: LatestFrame[str] = LatestFrame()
    buf.close()
    assert buf.closed is True
    # put after close is a no-op; get returns None immediately.
    buf.put("x")
    assert buf.get(timeout=0.1) is None
    assert buf.latest_nowait() is None
