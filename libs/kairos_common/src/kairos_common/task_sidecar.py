# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Project a capture's task label into a rosbag2lerobot ``task.json`` sidecar.

rosbag2lerobot (the LeRobot v3 converter) reads an optional ``task.json`` next
to a bag's MCAP: ``{"task": "<episode task string>"}``. Writing that projection
at the boundary where bytes leave kairos — an archive destination today, an
export staging tree tomorrow — makes the outgoing tree self-describing: the
converter can consume it directly, with no kairos instance in the loop.

Two rules keep this from becoming a second source of truth:

- The projection is generated **only at the boundary**, from the labels current
  at that moment. It is never written into the live ``objects/`` tree, where a
  later §4.3 label edit would leave it stale.
- What lands at the destination is a snapshot. Label edits after the copy do
  not follow it — the same property every export has.
"""

from __future__ import annotations

import json
from pathlib import Path

from kairos_common.atomic_io import atomic_write_text
from kairos_common.capture_sidecars import (
    SidecarStatus,
    read_object_manifest,
    read_record,
)

TASK_SIDECAR_FILENAME = "task.json"


def effective_task(capture_dir: str | Path, fallback: str | None) -> str | None:
    """The §4.3 effective task label, read from the sidecars on disk.

    The sidecars are the store's source of truth, so reading them at
    projection time is what makes the label current by construction — a row
    cache can lag (``adopt_manifest_facts`` copies ``manifest.task`` back onto
    the row with no ``record.json`` overlay, so a label saved while the digest
    job is hashing can be transiently reverted there).

    Resolution: ``record.json``'s ``labels.task`` override when the key is
    present (a key is present only when an operator overrode it), else the
    sealed manifest's ``task``. *fallback* — the caller's row value — answers
    when the sidecars cannot: a corrupt ``record.json`` (the override is
    unknowable, and the row may still carry it) or an unreadable manifest.
    An unreadable sidecar must not fail an archive the copy itself allows.
    """
    record = read_record(capture_dir)
    if record.status is SidecarStatus.corrupt:
        return fallback
    if record.ok and record.record is not None and "task" in record.record.labels:
        return record.record.labels["task"]
    manifest = read_object_manifest(capture_dir)
    if manifest.ok and manifest.manifest is not None:
        return manifest.manifest.task
    return fallback


def write_task_sidecar(bag_dir: str | Path, task: str) -> Path:
    """Write ``<bag_dir>/task.json`` durably; return the path written.

    Callers decide *whether* a task exists (a capture without an effective
    task label gets no sidecar at all — an empty file would just make the
    converter fall back anyway); this function only spells the format.
    Raises ``OSError`` like every sidecar write: a projection that cannot be
    persisted must be reported, never assumed.

    One tolerance, borrowed from ``copy_tree_verified``: some network
    filesystems refuse directory fsync. ``atomic_write_text`` runs that fsync
    last, after the bytes are synced and the rename is done, so if the target
    reads back exactly as written the only step that can have raised is the
    directory fsync — and nothing could be made MORE durable by failing an
    archive a local disk would have passed.
    """
    payload = json.dumps({"task": task}, ensure_ascii=False) + "\n"
    target = Path(bag_dir) / TASK_SIDECAR_FILENAME
    try:
        return atomic_write_text(target, payload)
    except OSError:
        try:
            written_back = target.read_text(encoding="utf-8")
        except OSError:
            written_back = None
        if written_back == payload:
            return target
        raise
