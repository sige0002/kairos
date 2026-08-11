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

Method:

- A decode-free sweep collects the SELECTED topics' ``(log_time,
  publish_time)`` pairs and every channel's encodings. Where the writer
  recorded a TRUSTWORTHY sender-side ``publish_time`` (see
  ``mcap_utils.source_times``), the median ``log_time - publish_time`` is
  reported as an independent cross-check that needs no message decode: it
  measures the recorder-vs-sender clock relationship through DDS source
  stamps, in the SAME orientation as the header offset.
- A bounded decode samples ``header.stamp`` per topic: the first
  ``n_head`` messages and — read in REVERSE so the tail is genuinely the
  bag's end — the last ``n_tail`` (``n_head + n_tail = max_samples_per_topic``,
  default 200). A topic with fewer messages than the budget is read once in
  full instead — its stats cover every message, and the step verdict compares
  its first and last QUARTERS (disjoint by construction), so a sample is
  never counted twice. Decode cost is bounded per topic by
  ``min(max_samples_per_topic, message_count)`` — never a full-bag decode of
  a topic that exceeds the budget, and never a second decode of one that
  doesn't. Topics whose channel is not a CDR/ros2msg one (imported foreign
  bags) are reported with a reason and skipped, not fatal.

Verdicts (threshold-driven, ``threshold_ms`` param, default 500 ms):

- ``offset_suspected`` — ``|median offset| > threshold``,
- ``step_suspected`` — the head and tail medians disagree by more than the
  threshold (both windows need a minimum of samples),
- ``offset_kind`` classifies a flagged topic using the cross-check:
  ``clock_disagreement`` when the header offset is consistent with the
  DDS-stamp clock offset (the recorder clock itself is off),
  ``source_stamping`` when the DDS stamps prove the clocks agreed and the
  header stamps themselves are foreign/late (a re-recorded bag REPLAY carries
  the original session's header stamps and lands here), ``indeterminate``
  when no trustworthy publish_time exists to tell the two apart.
- Topics without a decodable, non-zero ``header.stamp`` are reported with a
  reason and never flagged; a topic whose sampled messages were only PARTLY
  stamped discloses the unstamped share instead of presenting a clean median.

``summary.json`` carries ``result: pass|fail`` (fail = any topic flagged) so
the Validation tab's generic renderer can gate on it — and a ``note`` when
there was nothing to check (an empty bag, or globs matching no topic), so an
empty green never silently vouches for a bag it did not look at. Written to
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
# The channel shapes the ROS2 decoder can read; anything else (an imported
# foreign bag's json/protobuf channel) is reported and skipped, not fatal.
_DECODABLE_MESSAGE_ENCODINGS = {"cdr"}
_DECODABLE_SCHEMA_ENCODINGS = {"ros2msg", "ros2idl"}


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
        "p05_ms": ordered[int(0.05 * (n - 1))],
        "p95_ms": ordered[int(0.95 * (n - 1))],
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
    """Median ``log_time - publish_time`` (ms) when publish_time is trustworthy.

    The recorder-vs-sender clock relationship measured through DDS source
    stamps, in the SAME orientation as the header offset ("how much later
    than the sender's stamp did the recorder's clock read"). Reuses the
    ``source_times`` trust rule: only a series the writer stamped with a REAL
    sender-side source timestamp for every message (and whose two clocks span
    the same window) yields a figure; otherwise ``None`` — a writer that
    copied the receive time in would make the offset a vacuous 0.
    """
    _times, time_source = source_times(pairs)
    if time_source != "publish_time":
        return None
    return statistics.median((log - pub) / _NS_PER_MS for log, pub in pairs)


def _sample_topic(
    mcap_path: Path,
    topic: str,
    quota: int,
    *,
    reverse: bool,
    cancel: threading.Event | None,
) -> tuple[list[float], int]:
    """Decode up to *quota* messages of one topic from one end of the bag.

    Returns ``(offsets_ms, unstamped)`` where *offsets_ms* are the
    ``log_time - header.stamp`` values of the stamped messages probed and
    *unstamped* counts the probed messages without a usable stamp. The
    iteration stops at *quota* messages PROBED, so the decode cost of a call
    is at most *quota* messages regardless of the bag length; ``reverse=True``
    reads from the bag's end, which is what makes the tail window genuinely
    the tail.
    """
    offsets: list[float] = []
    unstamped = 0
    probed = 0
    with mcap_path.open("rb") as stream:
        reader = make_reader(stream, decoder_factories=[DecoderFactory()])
        for _schema, _channel, message, decoded in reader.iter_decoded_messages(
            topics=[topic], reverse=reverse
        ):
            if cancel is not None and cancel.is_set():
                raise JobCanceled
            stamp_ns = _header_stamp_ns(decoded)
            if stamp_ns is None:
                unstamped += 1
            else:
                offsets.append((message.log_time - stamp_ns) / _NS_PER_MS)
            probed += 1
            if probed >= quota:
                break
    return offsets, unstamped


def _classify_offset(
    header_median_ms: float, publish_offset_ms: float | None, threshold_ms: float
) -> str:
    """What kind of problem a flagged offset is, per the DDS cross-check.

    - ``clock_disagreement``: the header offset matches the clock offset the
      DDS source stamps measure — the recorder clock itself is off.
    - ``source_stamping``: the DDS stamps prove the two clocks agreed, so the
      header stamps themselves are foreign or late (a re-recorded REPLAY
      carries the original session's stamps and lands here).
    - ``indeterminate``: no trustworthy publish_time to tell the two apart.
    """
    if publish_offset_ms is None:
        return "indeterminate"
    if abs(header_median_ms - publish_offset_ms) <= threshold_ms:
        return "clock_disagreement"
    return "source_stamping"


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

    # ---- pass 1: decode-free sweep (pairs for SELECTED topics only) ---------
    time_pairs: dict[str, list[tuple[int, int]]] = {}
    types: dict[str, str] = {}
    undecodable: dict[str, str] = {}
    with mcap_path.open("rb") as stream:
        for schema, channel, message in make_reader(stream).iter_messages():
            if cancel is not None and cancel.is_set():
                raise JobCanceled
            topic = channel.topic
            if not _topic_matches(topic, patterns):
                continue
            time_pairs.setdefault(topic, []).append(
                (message.log_time, message.publish_time)
            )
            if topic not in types:
                types[topic] = schema.name if schema is not None else ""
                schema_encoding = schema.encoding if schema is not None else ""
                if (
                    channel.message_encoding not in _DECODABLE_MESSAGE_ENCODINGS
                    or schema_encoding not in _DECODABLE_SCHEMA_ENCODINGS
                ):
                    undecodable[topic] = (
                        f"not a ROS2 channel (message encoding "
                        f"{channel.message_encoding!r}, schema encoding "
                        f"{schema_encoding!r}); header.stamp cannot be read"
                    )

    # ---- pass 2: bounded per-topic header sampling --------------------------
    # Budget split; a topic smaller than the whole budget is read ONCE and
    # split chronologically, so head and tail never overlap and no message is
    # ever sampled twice (count <= message_count, always).
    n_head = (max_samples_per_topic + 1) // 2
    n_tail = max_samples_per_topic // 2

    topics = []
    flagged: list[str] = []
    for name in sorted(time_pairs):
        pairs = time_pairs[name]
        message_count = len(pairs)
        entry: dict[str, Any] = {
            "name": name,
            "type": types.get(name, ""),
            "message_count": message_count,
        }
        if name in undecodable:
            entry.update(offset_stats([]))
            entry.update(
                {
                    "head_median_ms": None,
                    "tail_median_ms": None,
                    "publish_offset_median_ms": _publish_offset_median_ms(pairs),
                    "unstamped_sampled": 0,
                    "reason": undecodable[name],
                    "offset_suspected": False,
                    "step_suspected": False,
                    "offset_kind": None,
                }
            )
            topics.append(entry)
            continue

        if message_count <= n_head + n_tail:
            # The whole topic fits the budget: read it once, base the stats on
            # EVERY sample, and compare the first and last QUARTERS for the
            # step verdict — a late step inside a chronological half would be
            # outvoted by that half's clean majority and stay invisible.
            samples, unstamped = _sample_topic(
                mcap_path, name, message_count, reverse=False, cancel=cancel
            )
            quarter = min(len(samples) // 2, max(len(samples) // 4, MIN_WINDOW_SAMPLES))
            head, tail = samples[:quarter], samples[-quarter:] if quarter else []
            combined = samples
        else:
            head, unstamped_head = _sample_topic(
                mcap_path, name, n_head, reverse=False, cancel=cancel
            )
            tail, unstamped_tail = _sample_topic(
                mcap_path, name, n_tail, reverse=True, cancel=cancel
            )
            unstamped = unstamped_head + unstamped_tail
            combined = head + tail
        stats = offset_stats(combined)
        publish_offset = _publish_offset_median_ms(pairs)
        entry.update(stats)
        entry.update(
            {
                "head_median_ms": (
                    statistics.median(head) if len(head) >= MIN_WINDOW_SAMPLES else None
                ),
                "tail_median_ms": (
                    statistics.median(tail) if len(tail) >= MIN_WINDOW_SAMPLES else None
                ),
                # Sender-side cross-check (no decode), same orientation as the
                # header offset: how much later than the sender's stamp the
                # recorder's clock read.
                "publish_offset_median_ms": publish_offset,
                # Probed-but-unusable stamps: disclosed so a partially
                # unstamped topic never presents a clean median silently.
                "unstamped_sampled": unstamped,
            }
        )
        if stats["count"] == 0:
            entry["reason"] = (
                "no usable header.stamp (headerless type or zero stamps)"
                if unstamped > 0
                else "no messages sampled"
            )
            entry["offset_suspected"] = False
            entry["step_suspected"] = False
            entry["offset_kind"] = None
        else:
            entry["offset_suspected"] = abs(stats["median_ms"]) > threshold_ms
            entry["step_suspected"] = (
                entry["head_median_ms"] is not None
                and entry["tail_median_ms"] is not None
                and abs(entry["head_median_ms"] - entry["tail_median_ms"])
                > threshold_ms
            )
            if entry["offset_suspected"] or entry["step_suspected"]:
                entry["offset_kind"] = _classify_offset(
                    stats["median_ms"], publish_offset, threshold_ms
                )
                flagged.append(name)
            else:
                entry["offset_kind"] = None
        topics.append(entry)

    note: str | None = None
    if not time_pairs:
        note = (
            "target_topics matched no topic; nothing was checked"
            if patterns
            else "the bag contains no messages; nothing was checked"
        )

    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "capture_id": capture_id,
        "result": "fail" if flagged else "pass",
        "note": note,
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
            "(publisher clock): expected to be transport latency. "
            "publish_offset = log_time - publish_time (DDS source stamp), "
            "the same orientation measured without decoding. offset_kind "
            "classifies a flagged topic: clock_disagreement when the two "
            "agree (the recorder clock is off), source_stamping when the "
            "DDS stamps prove the clocks agreed and the header stamps "
            "themselves are foreign or late (e.g. a re-recorded replay), "
            "indeterminate without a trustworthy publish_time. An inferred "
            "check, not a measurement of which clock is right."
        ),
        "checked_at": utc_now_iso8601(),
    }
    report_dir = data_dir / "report" / "clock_check" / capture_id
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    # allow_nan=False: a sidecar with a bare `Infinity`/`NaN` token is not
    # JSON and the browser cannot read it — fail the job loudly instead.
    atomic_write_text(summary_path, json.dumps(summary, indent=2, allow_nan=False))
    return {"summary": summary, "artifacts": [str(summary_path)]}
