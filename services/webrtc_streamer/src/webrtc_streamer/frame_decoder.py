# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Single-slot input handoff for demand-driven preview decoding."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)


class FrameDecoder:
    """Retain one pending message; decode only when a media consumer asks.

    A second lock serializes consumers without blocking incoming messages on
    image conversion. At most one active and one pending message are retained.
    Call prepare/close on worker threads, never on the web event loop.
    """

    def __init__(self, publish: Callable[[Any], None]) -> None:
        self._publish = publish
        self._state_lock = threading.Lock()
        self._decode_lock = threading.Lock()
        self._closed = threading.Event()
        self._pending: tuple[Any, Callable[[Any], Any]] | None = None

    def offer(self, message: Any, convert: Callable[[Any], Any]) -> None:
        """Replace the pending message without decoding or copying its bytes."""
        with self._state_lock:
            if not self._closed.is_set():
                self._pending = message, convert

    def prepare(self) -> None:
        """Publish the latest pending image once; retain the last good on error."""
        with self._decode_lock:
            with self._state_lock:
                pending, self._pending = self._pending, None
                if self._closed.is_set() or pending is None:
                    return
            message, convert = pending
            try:
                frame = convert(message)
                with self._state_lock:
                    if not self._closed.is_set():
                        self._publish(frame)
            except Exception:
                logger.exception("failed to prepare preview frame")

    def close(self) -> None:
        """Reject new work, discard pending input, and join any active decode."""
        with self._state_lock:
            self._closed.set()
            self._pending = None
        with self._decode_lock:
            pass
