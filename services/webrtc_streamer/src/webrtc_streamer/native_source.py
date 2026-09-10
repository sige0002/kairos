# SPDX-License-Identifier: Apache-2.0
"""Explicit opt-in C ABI: only encoded VP8 packets cross into Python."""

from __future__ import annotations

import ctypes as C
import os
import threading
from typing import Any

from webrtc_streamer.frame_queue import LatestFrame


class NativeImageSource:
    def __init__(
        self,
        topic: str,
        *,
        max_width: int | None = None,
        max_height: int | None = None,
        max_fps: int = 15,
    ) -> None:
        self._args = (topic.encode(), max_width or 0, max_height or 0, max_fps)
        self._lock = threading.Lock()
        self._encode_lock = threading.Lock()
        self._lib: Any = None
        self._handle: Any = None
        self.frames: LatestFrame[Any] = LatestFrame()

    def _load(self) -> Any:
        lib = C.CDLL(
            os.getenv(
                "KAIROS_STREAMER_NATIVE_LIBRARY",
                "/opt/kairos/lib/libkairos_streamer_native.so",
            )
        )
        lib.ks_abi_version.restype = C.c_uint32
        if lib.ks_abi_version() != 1:
            raise RuntimeError("native streamer ABI mismatch")
        lib.ks_error.restype = C.c_char_p
        lib.ks_create.argtypes = [C.c_char_p, C.c_int, C.c_int, C.c_int]
        lib.ks_create.restype = C.c_void_p
        for name in ("ks_start", "ks_destroy"):
            getattr(lib, name).argtypes = [C.c_void_p]
            getattr(lib, name).restype = C.c_int
        lib.ks_next.argtypes = [
            C.c_void_p,
            C.c_int,
            C.c_int,
            C.POINTER(C.c_void_p),
            C.POINTER(C.c_size_t),
            C.POINTER(C.c_int64),
            C.POINTER(C.c_int),
        ]
        lib.ks_next.restype = C.c_int
        lib.ks_stats.argtypes = [
            C.c_void_p,
            C.POINTER(C.c_double),
            *[C.POINTER(C.c_uint64)] * 4,
        ]
        lib.ks_stats.restype = C.c_int
        return lib

    def _check(self, result: int) -> None:
        if result < 0:
            raise RuntimeError(self._lib.ks_error().decode(errors="replace"))

    def start(self) -> None:
        with self._lock:
            if self._handle:
                return
            self._lib = self._load()
            self._handle = self._lib.ks_create(*self._args)
            if not self._handle:
                self._check(-1)
            try:
                self._check(self._lib.ks_start(self._handle))
            except BaseException:
                self._lib.ks_destroy(self._handle)
                self._handle = None
                raise

    def stop(self) -> None:
        with self._encode_lock, self._lock:
            if self._handle:
                self._check(self._lib.ks_destroy(self._handle))
                self._handle = None
        self.frames.close()

    def prepare_frame(self) -> None:
        """Native conversion is requested by next_packet, never by a BGR consumer."""
        raise RuntimeError("native source requires the shared packet peer manager")

    def next_packet(
        self, keyframe: bool, bitrate: int
    ) -> tuple[bytes, int, bool] | None:
        with self._encode_lock:
            with self._lock:
                if not self._handle:
                    raise RuntimeError("native source is stopped")
                handle = self._handle
            data, size, pts, key = C.c_void_p(), C.c_size_t(), C.c_int64(), C.c_int()
            self._check(
                self._lib.ks_next(
                    handle,
                    keyframe,
                    bitrate,
                    C.byref(data),
                    C.byref(size),
                    C.byref(pts),
                    C.byref(key),
                )
            )
            if not size.value:
                return None
            return C.string_at(data, size.value), pts.value, bool(key.value)

    @property
    def processing(self) -> dict[str, int | float]:
        with self._lock:
            if not self._handle:
                return {}
            fps = C.c_double()
            counts = [C.c_uint64() for _ in range(4)]
            self._check(
                self._lib.ks_stats(
                    self._handle,
                    C.byref(fps),
                    *[C.byref(n) for n in counts],
                )
            )
            return dict(
                zip(
                    (
                        "received",
                        "decoded",
                        "encoded",
                        "conversion_errors",
                        "input_fps",
                    ),
                    [*[n.value for n in counts], fps.value],
                    strict=True,
                )
            )

    @property
    def fps(self) -> float:
        return float(self.processing.get("input_fps", 0))
