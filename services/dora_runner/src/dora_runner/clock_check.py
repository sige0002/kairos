"""``clock_check`` pipeline: recorder-vs-publisher clock consistency for a capture.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``objects/<capture_id>``, so it can never disturb an in-flight recording.

The question it answers: **was the recording host's clock consistent with the
publishers' clocks?** Two stamps in the bag come from different machines —
``header.stamp`` inside a message is written by the PUBLISHER's clock (the
robot side in a split deployment), while the MCAP ``log_time`` is written by
the RECORDER's clock on receipt. Their difference should be transport +
queueing latency (milliseconds); a wrong recorder clock turns it into the
clock offset — near-constant, arbitrarily large, and negative when the
recorder runs behind ("received before published"). A clock STEP during the
recording (an NTP correction) shows as the head and tail of the bag
disagreeing about that offset, while fabricating a gap or a time reversal in
``log_time``.

Method (bounded — never a full-bag decode):

- A raw, decode-free pass collects every topic's ``(log_time, publish_time)``
  pairs: counts, the bag's time window, and — where the writer recorded a
  TRUSTWORTHY sender-side ``publish_time`` (see ``mcap_utils.source_times``) —
  the ``publish_time - log_time`` median as an independent cross-check that
  needs no message decode. A large header offset with a small publish offset
  points at late stamping on the publisher, not at the clocks.
- A sampled decode pass reads ``header.stamp`` for up to
  ``max_samples_per_topic`` messages per topic, split between a HEAD window
  and a TAIL window of the bag, and compares each stamp to that message's
  ``log_time``. Median / p05 / p95 / min / max and the negative share are
  reported per topic; the head/tail split is what detects a mid-recording
  step.

Verdicts (threshold-driven, ``threshold_ms`` param, default 500 ms):

- ``offset_suspected`` — ``|median offset| > threshold``,
- ``step_suspected`` — the head and tail medians disagree by more than the
  threshold (both windows need a minimum of samples),
- topics without a decodable, non-zero ``header.stamp`` are reported with a
  reason and never flagged.

``summary.json`` carries ``result: pass|fail`` (fail = any topic flagged) so
the Validation tab's generic renderer can gate on it, and is written to
``data/report/clock_check/<capture_id>/summary.json``.
"""

from __future__ import annotations

import fnmatch
import json
import statistics
import threading
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601
from kairos_common.atomic_io import atomic_write_text
from mcap.reader import make_reader
from mcap_ros2.decoder import DecoderFactory

from dora_runner.mcap_utils import find_mcap, resolve_source_dir, source_times
from dora_runner.models import JobCanceled

PIPELINE_ID = "clock_check"
PIPELINE_VERSION = "1.0.0"

DEFAULT_THRESHOLD_MS = 500.0
DEFAULT_MAX_SAMPLES = 200
# A window median computed on fewer samples than this is too thin to accuse a
# clock of stepping; the topic still gets its overall stats.
MIN_WINDOW_SAMPLES = 5

_NS_PER_MS = 1_000_000


def offset_stats(offsets_ms: list[float]) -> dict[str, Any]:
    """Robust summary of a header-offset series (milliseconds).

    ``median`` is the estimator the verdict uses (robust to a few outliers);
    p05/p95 bound the spread, and ``negative_share`` is the fraction of
    physically impossible "received before published" samples — any
    non-trivial share is clock disagreement, not latency.
    """
    n = len(offsets_ms)
    if n == 0:
        return {
            "count": 0,
            "median_ms": None,
            "p05_ms": None,
            "p95_ms": None,
            "min_ms": None,
            "max_ms": None,
            "negative_share": None,
        }
    ordered = sorted(offsets_ms)
    return {
        "count": n,
        "median_ms": statistics.median(ordered),
        "p05_ms": ordered[max(0, int(0.05 * (n - 1)))],
        "p95_ms": ordered[min(n - 1, int(0.95 * (n - 1)))],
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
        "negative_share": sum(1 for v in ordered if v < 0) / n,
    }


def _topic_matches(name: str, patterns: list[str]) -> bool:
    """True if *name* matches any glob in *patterns* (empty list = match all)."""
    if not patterns:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def _header_stamp_ns(ros_msg: Any) -> int | None:
    """The message's top-level ``header.stamp`` in ns, or ``None``.

    ``None`` for types without a top-level std_msgs Header and for a zero
    stamp (the "never stamped" sentinel — comparing it to wall-clock log_time
    would fabricate a ~56-year offset, not reveal one).
    """
    header = getattr(ros_msg, "header", None)
    stamp = getattr(header, "stamp", None)
    sec = getattr(stamp, "sec", None)
    nanosec = getattr(stamp, "nanosec", None)
    if sec is None or nanosec is None:
        return None
    stamp_ns = int(sec) * 1_000_000_000 + int(nanosec)
    return stamp_ns if stamp_ns != 0 else None


def _publish_offset_median_ms(pairs: list[tuple[int, int]]) -> float | None:
    """Median ``publish_time - log_time`` (ms) when publish_time is trustworthy.

    Reuses the ``source_times`` trust rule: only a series the writer stamped
    with a REAL sender-side source timestamp for every message (and whose two
    clocks span the same window) yields a figure; otherwise ``None`` — a
    writer that copied the receive time in would make the offset a vacuous 0.
    """
    _times, time_source = source_times(pairs)
    if time_source != "publish_time":
        return None
    return statistics.median((pub - log) / _NS_PER_MS for log, pub in pairs)


def _collect_window_offsets(
    mcap_path: Path,
    quotas: dict[str, int],
    *,
    start_time: int,
    end_time: int | None,
    cancel: threading.Event | None,
) -> tuple[dict[str, list[float]], set[str]]:
    """Decode one bag window, collecting per-topic header offsets (ms).

    *quotas* maps each wanted topic to its remaining sample budget; iteration
    stops early once every budget is exhausted, so the decode cost is bounded
    by the quotas, not the bag length. Returns the per-topic offsets and the
    set of topics that yielded at least one message but never a usable
    header stamp (unstamped/headerless).
    """
    offsets: dict[str, list[float]] = {name: [] for name in quotas}
    headerless: set[str] = set()
    remaining = dict(quotas)
    kwargs: dict[str, Any] = {"topics": list(quotas), "start_time": start_time}
    if end_time is not None:
        kwargs["end_time"] = end_time
    with mcap_path.open("rb") as stream:
        reader = make_reader(stream, decoder_factories=[DecoderFactory()])
        for _schema, channel, message, decoded in reader.iter_decoded_messages(
            **kwargs
        ):
            if cancel is not None and cancel.is_set():
                raise JobCanceled
            topic = channel.topic
            if remaining.get(topic, 0) <= 0:
                continue
            stamp_ns = _header_stamp_ns(decoded)
            if stamp_ns is None:
                headerless.add(topic)
                remaining[topic] -= 1
            else:
                offsets[topic].append((message.log_time - stamp_ns) / _NS_PER_MS)
                remaining[topic] -= 1
            if all(budget <= 0 for budget in remaining.values()):
                break
    return offsets, headerless


def run_clock_check(
    *,
    capture_id: str,
    data_dir: Path,
    threshold_ms: float = DEFAULT_THRESHOLD_MS,
    max_samples_per_topic: int = DEFAULT_MAX_SAMPLES,
    target_topics: list[str] | None = None,
    cancel: threading.Event | None = None,
) -> dict[str, Any]:
    """Check the capture's recorder clock against its publishers' clocks.

    The MCAP comes from ``objects/<capture_id>`` and the summary is written
    under ``report/clock_check/<capture_id>/``. Returns the
    ``{summary, artifacts}`` JobResult shape; raises ``FileNotFoundError``
    when the capture dir or its MCAP is missing and ``ValueError`` for a
    capture_id that is not a UUIDv7 (both mapped to a failed job by the
    worker). Read-only with respect to the recording.
    """
    patterns = list(target_topics or [])
    source_dir = resolve_source_dir(data_dir, capture_id)
    mcap_path = find_mcap(source_dir)

    # ---- pass 1: decode-free sweep (counts, window, publish cross-check) ----
    time_pairs: dict[str, list[tuple[int, int]]] = {}
    types: dict[str, str] = {}
    with mcap_path.open("rb") as stream:
        for schema, channel, message in make_reader(stream).iter_messages():
            if cancel is not None and cancel.is_set():
                raise JobCanceled
            time_pairs.setdefault(channel.topic, []).append(
                (message.log_time, message.publish_time)
            )
            if channel.topic not in types:
                types[channel.topic] = schema.name if schema is not None else ""

    selected = {
        name: pairs
        for name, pairs in time_pairs.items()
        if _topic_matches(name, patterns)
    }

    head_offsets: dict[str, list[float]] = {}
    tail_offsets: dict[str, list[float]] = {}
    headerless: set[str] = set()
    if selected:
        all_logs = [log for pairs in selected.values() for log, _pub in pairs]
        t0, t1 = min(all_logs), max(all_logs)
        half_quota = max(1, max_samples_per_topic // 2)
        quotas = {name: half_quota for name in selected}
        # Head window: everything from the start; the per-topic quotas (with
        # the global early break) bound the decode, not the window end.
        head_offsets, headerless_head = _collect_window_offsets(
            mcap_path, quotas, start_time=t0, end_time=None, cancel=cancel
        )
        # Tail window: sized so even the sparsest selected topic can fill its
        # quota (its estimated cadence x quota, padded), capped at half the
        # bag so head and tail never fully overlap on a short recording.
        duration = max(1, t1 - t0)
        sparsest_interval = max(
            duration // max(1, len(pairs)) for pairs in selected.values()
        )
        window = min(duration // 2, sparsest_interval * half_quota * 2)
        tail_offsets, headerless_tail = _collect_window_offsets(
            mcap_path, quotas, start_time=t1 - window, end_time=None, cancel=cancel
        )
        headerless = headerless_head | headerless_tail

    topics = []
    flagged: list[str] = []
    for name in sorted(selected):
        pairs = selected[name]
        head = head_offsets.get(name, [])
        tail = tail_offsets.get(name, [])
        combined = head + tail
        stats = offset_stats(combined)
        entry: dict[str, Any] = {
            "name": name,
            "type": types.get(name, ""),
            "message_count": len(pairs),
            **stats,
            "head_median_ms": (
                statistics.median(head) if len(head) >= MIN_WINDOW_SAMPLES else None
            ),
            "tail_median_ms": (
                statistics.median(tail) if len(tail) >= MIN_WINDOW_SAMPLES else None
            ),
            # Sender-side cross-check (no decode): big header offset + small
            # publish offset = late stamping on the publisher, not the clocks.
            "publish_offset_median_ms": _publish_offset_median_ms(pairs),
        }
        if stats["count"] == 0:
            entry["reason"] = (
                "no usable header.stamp (headerless type or zero stamps)"
                if name in headerless
                else "no samples in the analysed windows"
            )
            entry["offset_suspected"] = False
            entry["step_suspected"] = False
        else:
            entry["offset_suspected"] = abs(stats["median_ms"]) > threshold_ms
            entry["step_suspected"] = (
                entry["head_median_ms"] is not None
                and entry["tail_median_ms"] is not None
                and abs(entry["head_median_ms"] - entry["tail_median_ms"])
                > threshold_ms
            )
            if entry["offset_suspected"] or entry["step_suspected"]:
                flagged.append(name)
        topics.append(entry)

    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "capture_id": capture_id,
        "result": "fail" if flagged else "pass",
        "topics": topics,
        "flagged": flagged,
        "params": {
            "threshold_ms": threshold_ms,
            "max_samples_per_topic": max_samples_per_topic,
            "target_topics": patterns,
        },
        # The honesty note the Review/Validation surfaces can carry verbatim.
        "definition": (
            "offset = log_time (recorder receive clock) - header.stamp "
            "(publisher clock): expected to be transport latency; a large or "
            "negative median indicates clock disagreement, and differing "
            "head/tail medians indicate a clock step during the recording. "
            "An inferred check, not a measurement of which clock is right."
        ),
        "checked_at": utc_now_iso8601(),
    }
    report_dir = data_dir / "report" / "clock_check" / capture_id
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    atomic_write_text(summary_path, json.dumps(summary, indent=2))
    return {"summary": summary, "artifacts": [str(summary_path)]}
