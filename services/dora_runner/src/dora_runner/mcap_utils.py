"""Direct MCAP helpers for validation pipelines."""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from mcap.reader import make_reader
from mcap_ros2.reader import read_ros2_messages

# A run_id becomes a path component under data/recorded and data/report; the
# charset guard prevents path traversal (mirrors the recorder's RUN_ID_PATTERN).
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def validate_run_id(run_id: str) -> str:
    """Return *run_id* if it is a safe single path component, else ValueError.

    Job pipelines join ``run_id`` into ``data/recorded/<run_id>`` and
    ``data/report/<pipeline>/<run_id>``; without this a caller-supplied
    ``../..`` would escape the data root.
    """
    if not _RUN_ID_RE.match(run_id):
        raise ValueError(f"invalid run_id (must match ^[A-Za-z0-9_-]+$): {run_id!r}")
    return run_id


def find_mcap(run_dir: Path) -> Path:
    """Return the first MCAP in a run directory."""
    mcaps = sorted(run_dir.glob("*.mcap"))
    if not mcaps:
        raise FileNotFoundError(f"No MCAP file found in {run_dir}")
    return mcaps[0]


def enumerate_topics(mcap_path: Path) -> list[dict[str, str]]:
    """Enumerate topics/types without ROS2 message decoding."""
    with mcap_path.open("rb") as stream:
        summary = make_reader(stream).get_summary()
    if summary is None:
        return []
    topics: list[dict[str, str]] = []
    for channel in summary.channels.values():
        schema = summary.schemas.get(channel.schema_id)
        topics.append(
            {
                "name": channel.topic,
                "type": schema.name if schema is not None else "",
            }
        )
    return sorted(topics, key=lambda item: item["name"])


def iter_decoded_ros2_messages(
    mcap_path: Path, *, topics: list[str] | None = None
) -> Iterable[Any]:
    """Yield decoded ROS2 messages for future validation/conversion nodes."""
    return read_ros2_messages(str(mcap_path), topics=topics)
