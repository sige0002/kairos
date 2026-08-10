"""``signal_report`` pipeline: post-hoc numeric time-series for Review charts.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``objects/<capture_id>``, so it can never disturb an in-flight recording (it
only ever runs on finished captures).

It is **generic**, not JointState-specific: for every selected topic it decodes
the messages once and walks the *numeric leaves* of each message with the shared
:mod:`kairos_common.field_introspect` logic — the SAME field-path vocabulary
topic_probe's live Signals plotter offers (dotted/indexed paths like
``pose.position.x`` / ``position[2]``). So wrench, odom, cmd_vel, joint_states,
or any message with numeric fields all chart the same way, and a value the UI
saw live is addressable in the sidecar by the identical path.

One job scans the MCAP once ("全数値リーフ一括" — all numeric leaves in one
pass). Per topic:

- the field-path set is derived from the **FIRST message** (bagel-style
  episode-0 schema); a later message missing a leaf extracts to ``null``,
- every numeric leaf value is extracted per message and kept full-resolution,
- a per-topic **continuity** score is computed from the FULL-resolution
  inter-arrival intervals (before downsampling),
- the aligned ``(t_ns, values)`` series is downsampled by a uniform stride so
  each topic emits at most ``max_points`` points; ``t_ns`` is episode-relative
  (offset from the topic's first timestamp, first element ``0``) so the values
  stay JS-safe (absolute epoch ns exceed ``Number.MAX_SAFE_INTEGER``).

On top of the charting series (v1.1) the same single scan also feeds a
**loss-location** view. An *episode-global relative clock* is defined once —
its zero is the earliest full-resolution timestamp across all INCLUDED topics,
and ``span.duration_ns`` is the latest minus that zero. Three additive per-topic
fields live on that global axis (so they stay JS-safe like ``t_ns``): each
topic's ``start_offset_ns`` (first timestamp − global zero), a list of
``loss_events`` inferred from the FULL-resolution inter-arrival intervals
(threshold ``1.5x`` the median interval; each over-long interval is one event
with an estimated lost-message count and a major/minor severity), ``edges``
(how much later than the global start the topic began / how much before the
global end it stopped), and fixed-count density ``bins`` (message counts across
600 equal slices of the global span) for a heatmap. The per-topic ``t_ns`` stays
topic-relative (the chart contract is unchanged); the frontend maps chart-time
to the global axis with ``start_offset_ns``.

Image/camera topics (``sensor_msgs/msg/Image`` / ``CompressedImage``) are
excluded up front — they are the ``video_check`` pipeline's job — as are topics
with no numeric leaves and topics absent from the recording; each exclusion is
recorded in ``skipped_topics`` with a reason.

Timestamps use the same source-clock rule as ``loss_report`` / ``video_check``
(:func:`mcap_utils.source_times`: sender-side ``publish_time`` when the bag
recorded a trustworthy one, else the recorder's ``log_time``); which clock a
topic used is stated in its ``time_source`` (honesty rule). One sidecar is
written to ``data/report/signal_report/<capture_id>/summary.json`` for the
frontend to chart with uPlot, synced against the ``video_check`` mp4.
"""

from __future__ import annotations

import json
import math
import statistics
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from kairos_common import (
    DEFAULT_MAX_FIELDS,
    extract_value,
    iter_numeric_fields,
    utc_now_iso8601,
)
from kairos_common.atomic_io import atomic_write_text

from dora_runner.mcap_utils import (
    enumerate_topics,
    find_mcap,
    iter_decoded_ros2_messages,
    resolve_source_dir,
    source_times,
)
from dora_runner.models import JobCanceled

# Pipeline identity stamped into the summary (reproducibility contract, shared
# with the other bundled pipelines).
PIPELINE_ID = "signal_report"
PIPELINE_VERSION = "1.1.0"

# Default per-topic downsample cap (params.max_points overrides).
DEFAULT_MAX_POINTS = 2000

# Loss-event detection (full-resolution, per topic). An inter-arrival interval
# longer than ``LOSS_THRESHOLD_FACTOR x median`` is one event; below the minimum
# interval count there is no stable cadence to judge against, so no events. An
# event's estimated_lost >= LOSS_MAJOR_LOST is "major", else "minor". The emitted
# list is capped (largest-duration first) so a pathological run cannot bloat the
# sidecar; the number dropped is reported, never silently swallowed.
LOSS_MIN_INTERVALS = 4
LOSS_THRESHOLD_FACTOR = 1.5
LOSS_MAJOR_LOST = 3
LOSS_EVENTS_CAP = 200

# Density heatmap: a fixed number of equal slices across the GLOBAL span, so
# every topic's bins line up on one axis (bin_ns = ceil(span / BIN_COUNT)).
BIN_COUNT = 600

# Charted numeric leaves per topic: reuse field_introspect's total-field cap so
# the sidecar and topic_probe's live dropdown share one bound. Leaves beyond it
# are counted in ``truncated_fields`` (see _first_message_fields).
MAX_TOPIC_FIELDS = DEFAULT_MAX_FIELDS
# Bounded enumeration cap used ONLY to COUNT how many leaves overflow the chart
# cap: field_introspect's array/depth caps already bound the walk, so a large
# value here can never explode on a pathological message — it just lets us report
# an exact ``truncated_fields`` for a message with more than MAX_TOPIC_FIELDS
# leaves (e.g. a MarkerArray).
_FIELD_COUNT_CAP = 100_000

# Image topics are the video_check pipeline's job, not a numeric chart's; exclude
# them by message type so we never decode a heavy image payload here.
IMAGE_TYPES = frozenset({"sensor_msgs/msg/Image", "sensor_msgs/msg/CompressedImage"})

# Continuity, stated verbatim in the sidecar so a reader needs no external doc.
CONTINUITY_DEFINITION = (
    "1 - sum(gap - 1.5*median_interval for gaps > 1.5*median_interval)"
    "/duration, clamped to [0,1]"
)

# skipped_topics reasons.
_SKIP_IMAGE = "image topic (use video_check)"
_SKIP_NOT_IN_RECORDING = "topic not in recording"
_SKIP_NO_NUMERIC = "no numeric fields"
_SKIP_NO_MESSAGES = "no messages on this topic"


def compute_continuity(times_ns: list[int]) -> float | None:
    """Per-topic continuity in ``[0, 1]`` from SORTED inter-arrival times.

    ``1 - sum(gap - 1.5*median_interval for gaps > 1.5*median_interval) /
    duration``, clamped to ``[0, 1]`` (see :data:`CONTINUITY_DEFINITION`). Using
    the median as the cadence baseline makes it robust to a handful of long
    gaps: only the excess of an over-long gap beyond ``1.5x`` the typical
    spacing counts against continuity, normalised by the total duration.

    Returns ``None`` when there is nothing to score — fewer than two samples, or
    a zero-length span (every timestamp identical) where no cadence is defined.
    *times_ns* must be sorted ascending (the caller sorts on the chosen clock).
    """
    n = len(times_ns)
    if n < 2:
        return None
    intervals = [b - a for a, b in zip(times_ns, times_ns[1:], strict=False)]
    duration = times_ns[-1] - times_ns[0]
    if duration <= 0:
        return None
    threshold = 1.5 * statistics.median(intervals)
    excess = sum(gap - threshold for gap in intervals if gap > threshold)
    return max(0.0, min(1.0, 1.0 - excess / duration))


def downsample_stride(n: int, max_points: int) -> int:
    """Uniform stride so ``ceil(n / stride) <= max_points`` (``>= 1``).

    ``1`` when the series already fits; otherwise ``ceil(n / max_points)``, which
    guarantees the strided count never exceeds *max_points*.
    """
    if max_points < 1 or n <= max_points:
        return 1
    return math.ceil(n / max_points)


def detect_loss_events(
    times_sorted: list[int], global_zero: int
) -> tuple[list[dict[str, Any]], int]:
    """Infer loss events from FULL-resolution inter-arrival intervals.

    An interval longer than ``1.5 x`` the median interval is one event, emitted
    on the **episode-global** relative axis (subtract *global_zero* so the values
    stay JS-safe):

    - ``start_ns`` = the previous message's time − *global_zero*,
    - ``duration_ns`` = the interval itself,
    - ``estimated_lost`` = ``max(0, round(interval / median) - 1)`` (how many
      messages the typical cadence would have placed inside the hole),
    - ``severity`` = ``"major"`` when ``estimated_lost >= 3`` else ``"minor"``.

    Returns ``(events, dropped)``. Fewer than :data:`LOSS_MIN_INTERVALS`
    intervals (no stable cadence) or a non-positive median (a burst of identical
    stamps — no meaningful rate) yields ``([], 0)``. The list is capped at
    :data:`LOSS_EVENTS_CAP`, largest-duration first, and *dropped* counts the
    events past the cap (surfaced as ``loss_events_truncated``, never silent).
    """
    intervals = [b - a for a, b in zip(times_sorted, times_sorted[1:], strict=False)]
    if len(intervals) < LOSS_MIN_INTERVALS:
        return [], 0
    median = statistics.median(intervals)
    if median <= 0:
        return [], 0
    threshold = LOSS_THRESHOLD_FACTOR * median
    events: list[dict[str, Any]] = []
    for prev, interval in zip(times_sorted, intervals, strict=False):
        if interval > threshold:
            estimated_lost = max(0, round(interval / median) - 1)
            events.append(
                {
                    "start_ns": prev - global_zero,
                    "duration_ns": interval,
                    "estimated_lost": estimated_lost,
                    "severity": "major"
                    if estimated_lost >= LOSS_MAJOR_LOST
                    else "minor",
                }
            )
    events.sort(key=lambda e: e["duration_ns"], reverse=True)
    if len(events) > LOSS_EVENTS_CAP:
        return events[:LOSS_EVENTS_CAP], len(events) - LOSS_EVENTS_CAP
    return events, 0


def compute_bins(
    times_sorted: list[int], global_zero: int, global_end: int
) -> dict[str, Any] | None:
    """Message-count density across :data:`BIN_COUNT` equal slices of the span.

    Bins are on the episode-global axis so every topic lines up: ``bin_ns =
    ceil(span / BIN_COUNT)`` (the last bin may be short) and ``densities[i]`` is
    how many of this topic's full-resolution timestamps fall in slice ``i``
    (a timestamp exactly at the global end clamps into the last bin). The sum of
    ``densities`` therefore equals the topic's message count. Returns ``None``
    for a topic with fewer than two messages or when the global span is zero
    (no axis to bin against).
    """
    if len(times_sorted) < 2:
        return None
    duration = global_end - global_zero
    if duration <= 0:
        return None
    bin_ns = math.ceil(duration / BIN_COUNT)
    densities = [0] * BIN_COUNT
    for ts in times_sorted:
        idx = (ts - global_zero) // bin_ns
        idx = min(BIN_COUNT - 1, max(0, idx))
        densities[idx] += 1
    return {"count": BIN_COUNT, "bin_ns": bin_ns, "densities": densities}


@dataclass
class _TopicAccum:
    """Full-resolution accumulator for one topic during the single decode pass."""

    msg_type: str
    # Field paths derived from the first message (episode-0 schema), <= cap.
    paths: list[str]
    # Numeric leaves present beyond the chart cap (reported, not charted).
    truncated_fields: int
    # (log_time, publish_time) ns per message, in decode (log-time) order.
    pairs: list[tuple[int, int]] = field(default_factory=list)
    # One value row per message, aligned to ``paths`` (float | None per leaf).
    rows: list[tuple[float | None, ...]] = field(default_factory=list)


@dataclass
class _Resolved:
    """A topic's full-resolution series after clock-choice + co-sorting.

    Computed once per topic before the episode-global zero is known, so the
    global axis (loss_events / edges / bins) can be assembled in a second pass
    over these in-memory results — NOT a second decode pass.
    """

    accum: _TopicAccum
    # Chosen-clock timestamps, sorted ascending (full resolution).
    times_sorted: list[int]
    # Value rows co-sorted with ``times_sorted`` (aligned to ``accum.paths``).
    rows_sorted: list[tuple[float | None, ...]]
    time_source: str
    continuity: float | None


def _resolve_topic(accum: _TopicAccum) -> _Resolved:
    """Pick the source clock and co-sort the value rows onto it (full-res).

    The chosen clock (``source_times``) need not arrive in decode order, so the
    value rows are co-sorted with it; continuity is scored on the same sorted
    full-resolution series (before any downsample). This is split out from
    :func:`_build_topic_entry` so the caller can compute the episode-global zero
    across every resolved topic first.
    """
    chosen, time_source = source_times(accum.pairs)
    n = len(chosen)
    order = sorted(range(n), key=lambda i: chosen[i])
    times_sorted = [chosen[i] for i in order]
    rows_sorted = [accum.rows[i] for i in order]
    return _Resolved(
        accum=accum,
        times_sorted=times_sorted,
        rows_sorted=rows_sorted,
        time_source=time_source,
        continuity=compute_continuity(times_sorted),
    )


def _first_message_fields(ros_msg: object) -> tuple[list[str], int]:
    """Field paths (<= MAX_TOPIC_FIELDS) + overflow count for a topic's message 0.

    Enumerates all numeric leaves (bounded by field_introspect's array/depth
    caps) to report an exact ``truncated_fields``, then keeps the first
    MAX_TOPIC_FIELDS as the charted set (declaration order).
    """
    all_paths = iter_numeric_fields(ros_msg, max_fields=_FIELD_COUNT_CAP)
    paths = all_paths[:MAX_TOPIC_FIELDS]
    return paths, len(all_paths) - len(paths)


def _build_topic_entry(
    resolved: _Resolved, max_points: int, global_zero: int, global_end: int
) -> dict[str, Any]:
    """Assemble one topic's sidecar entry: chart series + global loss view.

    ``t_ns`` is emitted **relative to ``start_ns``** (first element ``0``):
    absolute epoch nanoseconds (~1.75e18) exceed JS ``Number.MAX_SAFE_INTEGER``
    (~9.007e15), so a JSON consumer would quantize them (ULP ~256 ns). The
    absolute chosen-clock endpoints are kept as ``start_ns`` / ``end_ns``
    metadata — consumers must NOT do sub-microsecond math on those in JS.

    ``start_offset_ns`` / ``loss_events`` / ``edges`` / ``bins`` are on the
    episode-global relative axis (offsets from *global_zero*, kept small and
    JS-safe); ``edges`` says how much later than the global start this topic
    began and how much before the global end it stopped.
    """
    accum = resolved.accum
    times_sorted = resolved.times_sorted
    rows_sorted = resolved.rows_sorted
    n = len(times_sorted)

    start_ns = times_sorted[0]
    end_ns = times_sorted[-1]
    stride = downsample_stride(n, max_points)
    keep = range(0, n, stride)
    # Relative to start_ns so the charted x-axis stays JS-safe (see docstring).
    t_ns = [times_sorted[i] - start_ns for i in keep]
    fields = {
        path: [rows_sorted[i][col] for i in keep]
        for col, path in enumerate(accum.paths)
    }

    loss_events, dropped = detect_loss_events(times_sorted, global_zero)

    entry: dict[str, Any] = {
        "msg_type": accum.msg_type,
        "message_count": n,
        "start_ns": start_ns,
        "end_ns": end_ns,
        "start_offset_ns": start_ns - global_zero,
        "continuity": resolved.continuity,
        "continuity_definition": CONTINUITY_DEFINITION,
        "time_source": resolved.time_source,
        "downsample": {"stride": stride, "points": len(t_ns)},
        "t_ns": t_ns,
        "fields": fields,
        "truncated_fields": accum.truncated_fields,
        "loss_events": loss_events,
        "edges": {
            "start_delay_ns": start_ns - global_zero,
            "end_early_ns": global_end - end_ns,
        },
        "bins": compute_bins(times_sorted, global_zero, global_end),
    }
    if dropped:
        entry["loss_events_truncated"] = dropped
    return entry


def _select_topics(
    all_types: dict[str, str], requested: list[str] | None
) -> tuple[list[str], dict[str, str]]:
    """Split the requested (or all) topics into scan targets vs skipped.

    ``requested`` ``None`` means every topic in the bag. Image topics and topics
    absent from the recording are skipped up front (with a reason); the rest are
    returned as scan targets — a "no numeric fields" / "no messages" verdict can
    only be reached during/after the decode pass, so those are added by the
    caller.
    """
    names = sorted(all_types) if requested is None else requested
    scan_targets: list[str] = []
    skipped: dict[str, str] = {}
    for name in names:
        if name not in all_types:
            skipped[name] = _SKIP_NOT_IN_RECORDING
        elif all_types[name] in IMAGE_TYPES:
            skipped[name] = _SKIP_IMAGE
        else:
            scan_targets.append(name)
    return scan_targets, skipped


def run_signal_report(
    *,
    capture_id: str,
    data_dir: Path,
    topics: list[str] | None = None,
    max_points: int = DEFAULT_MAX_POINTS,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """Extract per-topic numeric time-series from a capture's MCAP into a sidecar.

    The MCAP comes from ``objects/<capture_id>`` and the summary is written
    under ``report/signal_report/<capture_id>/``.

    *topics* is an optional allow-list; ``None`` selects every non-image topic in
    the bag that has at least one numeric leaf. *max_points* caps each topic's
    downsampled point count (default :data:`DEFAULT_MAX_POINTS`).

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the capture dir or its MCAP is missing (mapped to a
    failed job by the worker); ``ValueError`` for a capture_id that is not a
    UUIDv7, or a ``max_points < 1``. The MCAP is only read (decoded post-hoc),
    so the canonical recording is never touched.
    """
    if max_points < 1:
        raise ValueError("max_points must be >= 1")
    source_dir = resolve_source_dir(data_dir, capture_id)
    mcap_path = find_mcap(source_dir)

    all_types = {t["name"]: t["type"] for t in enumerate_topics(mcap_path)}
    scan_targets, skipped = _select_topics(all_types, topics)

    accums: dict[str, _TopicAccum] = {}
    if scan_targets:
        for decoded in iter_decoded_ros2_messages(mcap_path, topics=scan_targets):
            # Cancellation checkpoint: the decode pass is the job's wall time.
            if cancel is not None and cancel.is_set():
                raise JobCanceled
            topic = decoded.channel.topic
            if topic in skipped:
                # Already ruled out (no numeric leaves on its first message).
                continue
            accum = accums.get(topic)
            if accum is None:
                paths, truncated = _first_message_fields(decoded.ros_msg)
                if not paths:
                    skipped[topic] = _SKIP_NO_NUMERIC
                    continue
                accum = _TopicAccum(
                    msg_type=decoded.schema.name or all_types.get(topic, ""),
                    paths=paths,
                    truncated_fields=truncated,
                )
                accums[topic] = accum
            accum.pairs.append((decoded.log_time_ns, decoded.publish_time_ns))
            accum.rows.append(
                tuple(extract_value(decoded.ros_msg, p) for p in accum.paths)
            )

    # A scan target that yielded no messages (channel present, no records).
    for name in scan_targets:
        if name not in accums and name not in skipped:
            skipped[name] = _SKIP_NO_MESSAGES

    # Resolve every included topic (clock choice + co-sort) BEFORE building
    # entries, so the episode-global relative clock — zero = earliest full-res
    # timestamp across all included topics — is known when the per-topic global
    # fields (loss_events / edges / bins) are assembled. No extra decode pass.
    resolved = {name: _resolve_topic(accums[name]) for name in sorted(accums)}
    if resolved:
        global_zero = min(r.times_sorted[0] for r in resolved.values())
        global_end = max(r.times_sorted[-1] for r in resolved.values())
    else:
        global_zero = global_end = 0

    topics_out = {
        name: _build_topic_entry(r, max_points, global_zero, global_end)
        for name, r in resolved.items()
    }

    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "capture_id": capture_id,
        "generated_at": utc_now_iso8601(),
        "params": {"topics": topics, "max_points": max_points},
        "span": {"duration_ns": global_end - global_zero},
        "topics": topics_out,
        "skipped_topics": dict(sorted(skipped.items())),
    }
    report_dir = data_dir / "report" / "signal_report" / capture_id
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    atomic_write_text(summary_path, json.dumps(summary, indent=2))
    return {"summary": summary, "artifacts": [str(summary_path)]}
