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


def iter_topic_times(mcap_path: Path, topic: str) -> Iterable[tuple[int, int]]:
    """Yield *topic*'s ``(log_time, publish_time)`` ns pairs, WITHOUT decoding.

    Cheap relative to full ROS2 decode (reads message records only), so callers
    that just need cadence — e.g. an fps estimate — can sample the first N
    without paying to JPEG/CDR-decode every frame. ``log_time`` is the
    recorder's receive time; ``publish_time`` is the sender-side DDS source
    timestamp when the recording writer stored one (rosbag2 on Jazzy does;
    older writers stamp both fields with the same receive time — see
    :func:`source_times` for the fallback rule).
    """
    with mcap_path.open("rb") as stream:
        for _schema, _channel, message in make_reader(stream).iter_messages(
            topics=[topic]
        ):
            yield message.log_time, message.publish_time


def source_times(pairs: list[tuple[int, int]]) -> tuple[list[int], str]:
    """Pick the source-side time series for cadence/loss analysis.

    Prefers MCAP ``publish_time`` (the sender-side DDS source timestamp), which
    is free of receive-side jitter (DDS transport, recorder scheduling/cache
    smear). It does NOT attribute gaps: a message lost before the recorder
    wrote it is simply absent from the MCAP, so its publish_time is gone too —
    the cadence/loss figures remain an inferred estimate, not a measurement of
    source-vs-transport loss. Preferring publish_time only removes the
    receive-side smear from that estimate.

    publish_time is trusted only when the writer recorded a real source stamp
    for EVERY message and the two clocks agree on the recording's time window:

    - every ``publish_time`` is non-zero (0 is MCAP's "unknown" sentinel), AND
    - every ``publish_time`` differs from its ``log_time`` (a writer without a
      source stamp copies the receive time in, so ANY ``publish == log``
      message means the series is log_time, or a log/source mix — either way
      untrustworthy; older rosbag2 stamps them equal on every message), AND
    - the publish clock spans the same wall-clock window as the receive clock
      (within 2x). Interleaved publishers with offset clocks on one topic pass
      the per-message tests but inflate the span and fabricate huge gaps, so a
      span mismatch falls back too.

    Any failure falls back to ``log_time`` (the single recorder clock), so the
    result is never worse than the pre-publish_time behaviour. Returns
    ``(times_ns, time_source)`` with ``time_source`` one of ``"publish_time"``
    / ``"log_time"`` for the caller to stamp into its report (honesty rule: say
    which clock produced the numbers).
    """
    if not pairs:
        return [], "log_time"
    logs = [log for log, _publish in pairs]
    pubs = [publish for _log, publish in pairs]
    if all(p != 0 for p in pubs) and all(p != log for log, p in pairs):
        log_span = max(logs) - min(logs)
        pub_span = max(pubs) - min(pubs)
        # Same wall-clock window (multiplicative form avoids div-by-zero when a
        # span is 0). A single well-behaved publisher tracks log_time within
        # transmission latency, so its span ratio is ~1; an offset-clock mix is
        # rejected here.
        if 2 * log_span >= pub_span and 2 * pub_span >= log_span:
            return pubs, "publish_time"
    return logs, "log_time"
