"""``loss_report`` pipeline: per-topic gap-based loss estimate for a run.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``recorded/<run_id>`` (message time fields, never decoding payloads), so it can
never disturb an in-flight recording (it only ever runs on finished runs).

The methodology is robot-independent. For each topic we take the message times
(nanoseconds) — **publish_time (sender-side DDS source timestamp) when the bag
recorded one, else log_time (recorder receive time)**; see
``mcap_utils.source_times`` — and compute a robust per-topic median
inter-arrival interval; the expected message count is then ``duration /
median_interval`` and loss is ``1 - actual / expected``. Using the median (not
the mean) makes the estimate robust to drop-gaps: a handful of long gaps does
not inflate the baseline cadence, so they surface as loss instead of being
absorbed. Preferring publish_time keeps receive-side jitter (DDS transport,
recorder scheduling/cache) out of the cadence; each topic's entry says which
clock produced its numbers (``time_source``).

Two thresholds/filters are config-driven (OL-4.3, see
``loss_report_config.py``) and overridable per-job via ``params``:

- ``target_topics``: glob patterns; only matching topics are reported (empty =
  every topic, the original behaviour),
- ``gap_threshold_multiplier``: a topic is flagged ``gap_exceeded`` when its
  worst gap exceeds ``median_interval_ms * multiplier``.

The summary is written to ``data/report/loss_report/<run_id>/summary.json`` so
the orchestrator can surface it on the run's detail view.
"""

from __future__ import annotations

import fnmatch
import json
import statistics
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601
from mcap.reader import make_reader

from dora_runner.loss_report_config import DEFAULT_GAP_THRESHOLD_MULTIPLIER
from dora_runner.mcap_utils import (
    find_mcap,
    resolve_source_dir,
    source_times,
    validate_run_id,
)

# Pipeline identity stamped into the summary (reproducibility contract, shared
# with the other bundled pipelines and the hello_dora plugin example).
# 1.1.0: cadence/loss computed on publish_time when the bag recorded it
# (log_time fallback); topic entries gained ``time_source``.
PIPELINE_ID = "loss_report"
PIPELINE_VERSION = "1.1.0"


def estimate_topic_loss(times_ns: list[int]) -> dict[str, Any]:
    """Estimate gap-based loss for one topic from its message times.

    *times_ns* are MCAP message times in nanoseconds (no decode required) —
    the caller picks the clock (``mcap_utils.source_times``: publish_time when
    recorded, else log_time). Returns ``count`` / ``hz`` /
    ``median_interval_ms`` / ``loss_rate`` / ``gap_max_ms``; with fewer than
    three samples there is nothing to base a cadence on, so the numeric fields
    are ``None`` and ``reason`` explains why.
    """
    n = len(times_ns)
    if n < 3:
        return {
            "count": n,
            "hz": None,
            "median_interval_ms": None,
            "loss_rate": None,
            "gap_max_ms": None,
            "reason": "insufficient samples",
        }
    t = sorted(times_ns)
    intervals_ms = [(t[i] - t[i - 1]) / 1e6 for i in range(1, n)]
    duration_s = (t[-1] - t[0]) / 1e9
    median_iv = statistics.median(intervals_ms)
    hz = (n - 1) / duration_s if duration_s > 0 else None
    if median_iv > 0 and duration_s > 0:
        # +1 because N samples span N-1 intervals; expected counts samples.
        expected = duration_s * 1000.0 / median_iv + 1.0
        loss = max(0.0, 1.0 - n / expected)
    else:
        loss = None
    return {
        "count": n,
        "hz": hz,
        "median_interval_ms": median_iv,
        "loss_rate": loss,
        "gap_max_ms": max(intervals_ms),
    }


def _topic_matches(name: str, patterns: list[str]) -> bool:
    """True if *name* matches any glob in *patterns* (empty list = match all)."""
    if not patterns:
        return True
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def gap_exceeded(estimate: dict[str, Any], multiplier: float) -> bool:
    """True when a topic's worst gap exceeds ``median_interval_ms * multiplier``.

    Returns ``False`` when either figure is unavailable (too few samples), so a
    topic is never flagged on missing data.
    """
    gap = estimate.get("gap_max_ms")
    median = estimate.get("median_interval_ms")
    if gap is None or median is None or median <= 0:
        return False
    return gap > median * multiplier


def run_loss_report(
    *,
    run_id: str,
    data_dir: Path,
    target_topics: list[str] | None = None,
    gap_threshold_multiplier: float = DEFAULT_GAP_THRESHOLD_MULTIPLIER,
    dataset_dir: str | None = None,
) -> dict[str, Any]:
    """Estimate per-topic loss for the run's MCAP.

    The MCAP comes from ``recorded/<run_id>`` by default, or — when
    *dataset_dir* (``<operator>/<task>/<NNN>``) is given — from the exported
    dataset directory, so the report stays computable after ``dataset_export``
    MOVED the recording. The summary is written under
    ``report/loss_report/<run_id>/`` either way.

    *target_topics* is a list of glob patterns; only matching topics are
    reported (``None``/empty = every topic, the original behaviour).
    *gap_threshold_multiplier* flags a topic ``gap_exceeded`` when its worst gap
    exceeds ``median_interval_ms * multiplier``. Both default to the original
    config-free behaviour, so callers that omit them are unaffected.

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the source dir or its MCAP is missing (mapped to a
    failed job by the worker); ``ValueError`` for an unsafe run_id /
    dataset_dir. The MCAP is only read (message time fields, no payload
    decode), so the canonical recording is never touched.
    """
    validate_run_id(run_id)
    patterns = list(target_topics or [])
    source_dir = resolve_source_dir(data_dir, run_id, dataset_dir)
    mcap_path = find_mcap(source_dir)

    # Per-topic collected (log_time, publish_time) pairs + the topic's message
    # type (schema name). The clock actually analysed is chosen per topic below.
    time_pairs: dict[str, list[tuple[int, int]]] = {}
    types: dict[str, str] = {}
    with mcap_path.open("rb") as stream:
        for schema, channel, message in make_reader(stream).iter_messages():
            time_pairs.setdefault(channel.topic, []).append(
                (message.log_time, message.publish_time)
            )
            if channel.topic not in types:
                types[channel.topic] = schema.name if schema is not None else ""

    topics = []
    for name, pairs in sorted(time_pairs.items()):
        if not _topic_matches(name, patterns):
            continue
        times, time_source = source_times(pairs)
        estimate = estimate_topic_loss(times)
        topics.append(
            {
                "name": name,
                "type": types.get(name, ""),
                **estimate,
                # Which clock produced the numbers: "publish_time" (sender-side,
                # jitter-free of the delivery path) or "log_time" (receive-side
                # fallback for bags that did not record a source timestamp).
                "time_source": time_source,
                "gap_exceeded": gap_exceeded(estimate, gap_threshold_multiplier),
            }
        )
    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "run_id": run_id,
        "topics": topics,
        "params": {
            "target_topics": patterns,
            "gap_threshold_multiplier": gap_threshold_multiplier,
        },
        "flagged": [t["name"] for t in topics if t.get("gap_exceeded")],
        "checked_at": utc_now_iso8601(),
    }
    report_dir = data_dir / "report" / "loss_report" / run_id
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return {"summary": summary, "artifacts": [str(summary_path)]}
