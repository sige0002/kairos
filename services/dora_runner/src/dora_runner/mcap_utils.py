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


# Reserved top-level names under data/ that can never be a dataset operator dir
# (mirrors dataset_export's reserved set; kept in sync by test_dataset_export).
_DATASET_RESERVED_TOP = {"recorded", "report", "datasets"}


def validate_dataset_dir(dataset_dir: str) -> str:
    """Return *dataset_dir* if it is a safe ``<operator>/<task>/<NNN>`` path.

    Post-export pipelines (video_check / loss_report) accept a ``dataset_dir``
    job param that is joined under ``data/``; this guard keeps it to exactly
    three plain components (no absolute path, no ``.``/``..``, no empty parts,
    no backslashes) and rejects the reserved top-level dirs, so a
    caller-supplied value can never escape the dataset tree.
    """
    parts = dataset_dir.split("/")
    if len(parts) != 3 or any(
        not p or p in {".", ".."} or "\\" in p or "\x00" in p for p in parts
    ):
        raise ValueError(
            f"invalid dataset_dir (must be <operator>/<task>/<index>): {dataset_dir!r}"
        )
    if parts[0] in _DATASET_RESERVED_TOP:
        raise ValueError(f"invalid dataset_dir (reserved top-level): {dataset_dir!r}")
    return dataset_dir


def resolve_source_dir(data_dir: Path, run_id: str, dataset_dir: str | None) -> Path:
    """Resolve the directory holding a job's MCAP: recorded run or dataset.

    Default is the canonical ``recorded/<run_id>``; with *dataset_dir* set the
    job reads an exported ``<operator>/<task>/<NNN>`` instead (the recording was
    MOVED there by ``dataset_export``, so the run dir no longer exists). Raises
    ``ValueError`` for an unsafe path and ``FileNotFoundError`` when the
    resolved directory is missing.
    """
    if dataset_dir is not None:
        source = data_dir / validate_dataset_dir(dataset_dir)
        if not source.is_dir():
            raise FileNotFoundError(f"No dataset directory found: {source}")
        return source
    source = data_dir / "recorded" / run_id
    if not source.is_dir():
        raise FileNotFoundError(f"No recorded run found: {source}")
    return source


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


def topic_message_count(mcap_path: Path, topic: str) -> int | None:
    """Total messages on *topic* from the MCAP summary statistics (no decode).

    Reads the file's summary section only (O(1), no message scan), so callers
    can report a topic's total count without decoding every message. Returns the
    count, ``0`` if the topic is absent, or ``None`` when the file carries no
    summary/statistics section (unindexed MCAP), so the caller can fall back to
    counting during a scan it already performs.
    """
    with mcap_path.open("rb") as stream:
        summary = make_reader(stream).get_summary()
    if summary is None or summary.statistics is None:
        return None
    channel_ids = {
        cid for cid, channel in summary.channels.items() if channel.topic == topic
    }
    if not channel_ids:
        return 0
    counts = summary.statistics.channel_message_counts
    return sum(counts.get(cid, 0) for cid in channel_ids)


def iter_topic_log_times(mcap_path: Path, topic: str) -> Iterable[int]:
    """Yield *topic*'s message log_times (ns) in order, WITHOUT decoding payloads.

    Cheap relative to full ROS2 decode (reads message records only), so callers
    that just need cadence — e.g. an fps estimate — can sample the first N
    without paying to JPEG/CDR-decode every frame.
    """
    with mcap_path.open("rb") as stream:
        for _schema, _channel, message in make_reader(stream).iter_messages(
            topics=[topic]
        ):
            yield message.log_time
