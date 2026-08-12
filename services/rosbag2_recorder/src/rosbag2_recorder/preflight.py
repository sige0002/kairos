# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Start-time preconditions: somewhere to write, and room to write it.

Split out of :mod:`rosbag2_recorder.recorder` unchanged. Every check here
raises a 507 :class:`ApiError`, so ``/readyz`` and ``POST /record/start`` refuse
for the same reason in the same shape.

The checks take the live :class:`~rosbag2_recorder.recorder.RecorderSession`
rather than plain paths because they read both the store layout it owns
(``_objects_root``, ``_data_dir``, ``_make_host_writable``) and its effective
config (``_max_cache_size_mb``), and because ``_available_ram_bytes`` is looked
up through the session on purpose — tests substitute it per instance.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from kairos_common import ApiError
from kairos_common.capture_sidecars import incoming_dir, trash_dir

if TYPE_CHECKING:
    from rosbag2_recorder.recorder import RecorderSession

# Refuse to start a recording if less free space than this is available; a few
# hundred MB is a conservative floor so we fail fast (507) rather than mid-run.
MIN_FREE_BYTES = 256 * 1024 * 1024


def ensure_ready(session: RecorderSession) -> None:
    """Raise if the recorder cannot serve recordings (readiness probe).

    Readiness == the objects root is writable with enough free space.
    Reuses the same check ``start`` runs so /readyz predicts start success.
    """
    session._check_writable_and_space()


def check_writable_and_space(session: RecorderSession) -> None:
    """Raise 507 if ``/data/objects`` is not writable or space is low.

    Also creates ``.trash/`` and ``.incoming/``. The recorder is the only
    service running as root, so it is the only one that can hand uid 1000 a
    writable root. ``.trash`` is where the orchestrator renames captures on
    delete (§7 step 3) and ``.incoming`` is where imports are staged before
    their ``os.replace`` into ``objects/`` (§2); a root-owned one of either
    would fail at runtime, on the operator's delete or import, rather than
    here at startup. Creating all three side by side is also what makes
    them same-filesystem by construction, which those renames require.
    """
    root = session._objects_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        # Keep the objects root host-writable (so capture dirs can be moved
        # to .trash and removed) — §2.
        session._make_host_writable(root)
        for sibling_root in (
            trash_dir(session._data_dir),
            incoming_dir(session._data_dir),
        ):
            sibling_root.mkdir(parents=True, exist_ok=True)
            session._make_host_writable(sibling_root)
    except OSError as exc:
        raise ApiError(
            status_code=507,
            code="data_not_writable",
            message="Recording directory is not writable.",
            details={"path": str(root), "error": str(exc)},
        ) from exc
    if not os.access(root, os.W_OK):
        raise ApiError(
            status_code=507,
            code="data_not_writable",
            message="Recording directory is not writable.",
            details={"path": str(root)},
        )
    free = shutil.disk_usage(root).free
    if free < MIN_FREE_BYTES:
        raise ApiError(
            status_code=507,
            code="insufficient_space",
            message="Insufficient free space to start recording.",
            details={"free_bytes": free, "required_bytes": MIN_FREE_BYTES},
        )
    session._check_cache_ram()


def check_cache_ram(session: RecorderSession) -> None:
    """Raise 507 if the configured record cache needs more RAM than is free.

    rosbag2 double-buffers the message cache, so worst-case memory is ~2x
    ``--max-cache-size``. We require that plus the disk safety margin to be
    available so a large cache can't OOM-kill the recorder mid-run. Skipped
    when the cache is unset (rosbag2 default) or free RAM can't be read.
    """
    cache_mb = session._max_cache_size_mb()
    if cache_mb <= 0:
        return
    need = 2 * cache_mb * 1024 * 1024 + MIN_FREE_BYTES
    avail = session._available_ram_bytes()
    if avail is not None and avail < need:
        raise ApiError(
            status_code=507,
            code="insufficient_memory",
            message="Not enough free RAM for the configured record cache.",
            details={
                "required_bytes": need,
                "available_bytes": avail,
                "max_cache_size_mb": cache_mb,
            },
        )


def available_ram_bytes() -> int | None:
    """Free RAM in bytes from ``/proc/meminfo`` MemAvailable (None if absent)."""
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    return None
