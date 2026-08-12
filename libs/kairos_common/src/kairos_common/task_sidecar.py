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

TASK_SIDECAR_FILENAME = "task.json"


def write_task_sidecar(bag_dir: str | Path, task: str) -> Path:
    """Write ``<bag_dir>/task.json`` durably; return the path written.

    Callers decide *whether* a task exists (a capture without an effective
    task label gets no sidecar at all — an empty file would just make the
    converter fall back anyway); this function only spells the format.
    Raises ``OSError`` like every sidecar write: a projection that cannot be
    persisted must be reported, never assumed.
    """
    payload = json.dumps({"task": task}, ensure_ascii=False) + "\n"
    return atomic_write_text(Path(bag_dir) / TASK_SIDECAR_FILENAME, payload)
