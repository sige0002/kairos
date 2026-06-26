"""``loss_report`` pipeline: per-topic gap-based loss estimate for a run.

Event-driven (button -> job), post-hoc, and read-only with respect to the
canonical recording: it only READS the finished MCAP under
``recorded/<run_id>`` (message log_times, never decoding payloads), so it can
never disturb an in-flight recording (it only ever runs on finished runs).

The methodology is robot-independent and config-free. For each topic we take
the message log_times (nanoseconds) and compute a robust per-topic median
inter-arrival interval; the expected message count is then ``duration /
median_interval`` and loss is ``1 - actual / expected``. Using the median (not
the mean) makes the estimate robust to drop-gaps: a handful of long gaps does
not inflate the baseline cadence, so they surface as loss instead of being
absorbed.

The summary is written to ``data/report/loss_report/<run_id>/summary.json`` so
the orchestrator can surface it on the run's detail view.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601
from mcap.reader import make_reader

from dora_runner.mcap_utils import find_mcap, validate_run_id


def estimate_topic_loss(log_times_ns: list[int]) -> dict[str, Any]:
    """Estimate gap-based loss for one topic from its message log_times.

    *log_times_ns* are MCAP log times in nanoseconds (no decode required).
    Returns ``count`` / ``hz`` / ``median_interval_ms`` / ``loss_rate`` /
    ``gap_max_ms``; with fewer than three samples there is nothing to base a
    cadence on, so the numeric fields are ``None`` and ``reason`` explains why.
    """
    n = len(log_times_ns)
    if n < 3:
        return {
            "count": n,
            "hz": None,
            "median_interval_ms": None,
            "loss_rate": None,
            "gap_max_ms": None,
            "reason": "insufficient samples",
        }
    t = sorted(log_times_ns)
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


def run_loss_report(*, run_id: str, data_dir: Path) -> dict[str, Any]:
    """Estimate per-topic loss for ``recorded/<run_id>``'s MCAP.

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the run dir or its MCAP is missing (mapped to a
    failed job by the worker); ``ValueError`` for an unsafe run_id. The MCAP is
    only read (message log_times, no payload decode), so the canonical
    recording is never touched.
    """
    validate_run_id(run_id)
    run_dir = data_dir / "recorded" / run_id
    if not run_dir.is_dir():
        raise FileNotFoundError(f"No recorded run found: {run_dir}")
    mcap_path = find_mcap(run_dir)

    # Per-topic collected log_times + the topic's message type (schema name).
    log_times: dict[str, list[int]] = {}
    types: dict[str, str] = {}
    with mcap_path.open("rb") as stream:
        for schema, channel, message in make_reader(stream).iter_messages():
            log_times.setdefault(channel.topic, []).append(message.log_time)
            if channel.topic not in types:
                types[channel.topic] = schema.name if schema is not None else ""

    topics = [
        {"name": name, "type": types.get(name, ""), **estimate_topic_loss(times)}
        for name, times in sorted(log_times.items())
    ]
    summary: dict[str, Any] = {
        "run_id": run_id,
        "topics": topics,
        "checked_at": utc_now_iso8601(),
    }
    report_dir = data_dir / "report" / "loss_report" / run_id
    report_dir.mkdir(parents=True, exist_ok=True)
    summary_path = report_dir / "summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return {"summary": summary, "artifacts": [str(summary_path)]}
