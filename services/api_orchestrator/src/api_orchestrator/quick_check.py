"""Stop-time quick-check settlement (Layer 0 + Layer 1 + verdict).

At recording stop the orchestrator settles a lightweight two-layer "quick check"
and persists it on the run (``Run.quick_check``). This module holds the pure,
deterministic pieces of that settlement — the MCAP summary reader, the
expected-Hz resolver, the incident-window filter, the per-layer builders, and
the verdict rules. The I/O orchestration (which downstream calls to make, with
which timeouts, and when to schedule it off the stop path) lives in
:class:`~api_orchestrator.runs.RunService`; keeping the logic here pure makes the
verdict cases trivially unit-testable without a live monitor or recorder.

Division of labor (settled with the user): topic_monitor does always-on live
detection, the orchestrator settles ONE quick check at stop, and dora_runner
does deep on-demand analysis. So this is deliberately cheap:

- **Layer 0** (no MCAP read, ~ms): the monitor ``/metrics`` snapshot pulled at
  stop (per-topic hz / rate_shortfall / gap_max_ms / dds_samples_lost), the
  monitor ``/incidents`` that overlap the recording window, and the recorder's
  ``integrity`` classification (from its manifest). ``dds_samples_lost`` is
  reported whole-window when a start baseline was captured (stop minus start).
- **Layer 1** (MCAP summary-only read, <1s): ONLY the bag's summary/statistics
  section — per-channel message counts and start/end — never a message scan. An
  absent summary section (unclean stop) is NOT backfilled by a full scan; it is
  surfaced honestly (``summary_available=False``) and treated as a strong
  needs_review signal.

Everything degrades honestly: an unreachable monitor, an absent bag, or a
missing summary narrows what the verdict can vouch for rather than failing the
settlement.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

from kairos_common import RecordingConfig, utc_now_iso8601

from api_orchestrator.models import (
    QuickCheck,
    QuickCheckL0Topic,
    QuickCheckL1Topic,
    QuickCheckLayer0,
    QuickCheckLayer1,
    QuickCheckVerdict,
)

logger = logging.getLogger("kairos")

# ---- verdict thresholds (explicit constants; see compute_verdict) ----------

# A topic whose whole-window average rate falls below this fraction of its
# expected_hz is a needs_review trigger (spec: "avg_hz < 0.8 x expected").
HZ_SHORTFALL_RATIO = 0.8
# Integrity classifications the recorder may report; anything other than "ok"
# (including "unknown" / absent) is a needs_review trigger.
INTEGRITY_OK = "ok"
# Incident severity that trips the verdict (a warning-severity incident is
# recorded but does not, on its own, force needs_review).
DANGER_SEVERITY = "danger"


@dataclass
class McapSummary:
    """The subset of an MCAP summary section the quick check needs.

    ``message_counts`` is per-TOPIC (channel counts already summed by topic).
    ``start_ns`` / ``end_ns`` are the summary's message time bounds (nanoseconds,
    log time), or ``None`` when statistics are absent.
    """

    message_counts: dict[str, int] = field(default_factory=dict)
    start_ns: int | None = None
    end_ns: int | None = None

    @property
    def duration_s(self) -> float | None:
        """Bag wall-duration in seconds (``None`` if the bounds are unusable)."""
        if self.start_ns is None or self.end_ns is None or self.end_ns <= self.start_ns:
            return None
        return (self.end_ns - self.start_ns) / 1e9


def resolve_expected_hz(config: RecordingConfig | None, topic: str) -> float | None:
    """Resolve a topic's expected Hz from RECORDING_CONFIG (first match wins).

    Mirrors the monitor's resolver: ``expected_hz_patterns`` are fnmatch globs
    applied in order, and a pattern whose ``hz`` is omitted (dynamically learned)
    is skipped so it never shadows a later concrete rate. ``None`` when no
    pattern with a concrete Hz matches (no rate to judge against).
    """
    if config is None:
        return None
    for pattern in config.expected_hz_patterns:
        if pattern.hz is not None and fnmatch(topic, pattern.pattern):
            return float(pattern.hz)
    return None


def read_mcap_summary(run_dir: Path) -> McapSummary | None:
    """Read ONLY the summary/statistics section of the run's MCAP bag.

    Returns:
        - ``None`` if no ``*.mcap`` file is found (bag absent / not written).
        - an :class:`McapSummary` with empty ``message_counts`` and ``None``
          bounds when the file exists but has NO summary section (unclean stop —
          the caller marks ``summary_available=False``; we never scan messages).
        - a populated :class:`McapSummary` otherwise.

    This is blocking file I/O (seeks to the footer/summary); the caller runs it
    off the event loop via ``asyncio.to_thread``.
    """
    from mcap.reader import make_reader

    mcap_path = _find_mcap(run_dir)
    if mcap_path is None:
        return None
    try:
        with mcap_path.open("rb") as fh:
            summary = make_reader(fh).get_summary()
    except Exception as exc:  # noqa: BLE001
        # A truncated/corrupt bag must degrade to "summary unavailable", never
        # crash the settlement. (mcap can raise assorted parse errors.)
        logger.warning(
            "quick_check: MCAP summary read failed",
            extra={"path": str(mcap_path), "error": str(exc)},
        )
        return McapSummary()
    if summary is None or summary.statistics is None:
        return McapSummary()  # file present, but no summary section.
    stats = summary.statistics
    counts: dict[str, int] = {}
    for channel_id, channel in (summary.channels or {}).items():
        n = int(stats.channel_message_counts.get(channel_id, 0))
        counts[channel.topic] = counts.get(channel.topic, 0) + n
    return McapSummary(
        message_counts=counts,
        start_ns=stats.message_start_time or None,
        end_ns=stats.message_end_time or None,
    )


def _find_mcap(run_dir: Path) -> Path | None:
    """Return the run's ``.mcap`` file (first match), or ``None`` if absent."""
    if not run_dir.is_dir():
        return None
    files = sorted(run_dir.glob("*.mcap"))
    return files[0] if files else None


def incidents_in_window(
    incidents: list[dict[str, Any]], start_ns: int | None, stop_ns: int | None
) -> list[dict[str, Any]]:
    """Keep only incidents whose active interval overlaps the recording window.

    An incident is active over ``[fired_at_ns, cleared_at_ns]`` (``cleared_at_ns``
    ``None`` = still active). It overlaps ``[start_ns, stop_ns]`` when it fired at
    or before the window ended AND had not cleared before the window began. When
    the window bounds are unknown, the list is passed through unfiltered (the
    caller already scoped the fetch with ``since_ns``). Malformed items are
    dropped rather than raising.
    """
    if start_ns is None and stop_ns is None:
        return [i for i in incidents if isinstance(i, dict)]
    kept: list[dict[str, Any]] = []
    for item in incidents:
        if not isinstance(item, dict):
            continue
        fired = _as_int(item.get("fired_at_ns"))
        cleared = _as_int(item.get("cleared_at_ns"))
        if fired is None:
            kept.append(item)  # can't place it in time; keep it (honest).
            continue
        if stop_ns is not None and fired > stop_ns:
            continue  # fired after the window closed.
        if start_ns is not None and cleared is not None and cleared < start_ns:
            continue  # cleared before the window opened.
        kept.append(item)
    return kept


def _as_int(value: Any) -> int | None:
    """Coerce a JSON number to int, or ``None`` if it isn't one."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def build_layer0(
    *,
    integrity: str | None,
    backstop: str | None,
    monitor_topics: list[dict[str, Any]] | None,
    baseline_dds: dict[str, int] | None,
    incidents: list[dict[str, Any]] | None,
    topic_names: list[str],
    config: RecordingConfig | None,
) -> QuickCheckLayer0:
    """Assemble Layer 0 from the recorder integrity + monitor snapshot/incidents.

    ``monitor_topics`` is the ``topics`` array of the monitor ``/metrics`` body
    (``None`` when the monitor was unreachable). ``baseline_dds`` is the per-topic
    ``dds_samples_lost`` captured at record START (``None`` = no baseline; the
    monitor's cumulative value is then reported as-is). ``topic_names`` scopes the
    per-topic map to the run's recorded topics (falls back to every monitor topic
    when empty). ``incidents`` is already window-filtered by the caller.

    ``available`` reflects only the MONITOR-derived parts (metrics/incidents);
    ``integrity`` comes from the recorder and is populated regardless.
    """
    available = monitor_topics is not None or incidents is not None
    topics: dict[str, QuickCheckL0Topic] = {}
    if monitor_topics is not None:
        by_name = {str(t.get("name")): t for t in monitor_topics if isinstance(t, dict)}
        wanted = topic_names or list(by_name.keys())
        for name in wanted:
            metric = by_name.get(name)
            if metric is None:
                continue
            dds = _as_int(metric.get("dds_samples_lost"))
            if dds is not None and baseline_dds is not None:
                # Whole-window delta (never negative — a monitor restart would
                # reset the cumulative counter below the baseline).
                dds = max(0, dds - baseline_dds.get(name, 0))
            topics[name] = QuickCheckL0Topic(
                hz=_as_float(metric.get("hz")),
                expected_hz=resolve_expected_hz(config, name),
                rate_shortfall=_as_float(metric.get("rate_shortfall")),
                gap_max_ms=_as_float(metric.get("gap_max_ms")),
                dds_samples_lost=dds,
            )
    return QuickCheckLayer0(
        available=available,
        integrity=integrity,
        topics=topics,
        incidents=list(incidents or []),
        backstop=backstop,
    )


def build_layer1(
    *,
    summary: McapSummary | None,
    config: RecordingConfig | None,
    required_topics: list[str],
) -> QuickCheckLayer1:
    """Assemble Layer 1 from the MCAP summary + the run's required topics.

    ``summary`` is ``None`` when no bag exists (``available=False``); an
    :class:`McapSummary` with empty counts and no bounds means the bag exists but
    has no summary section (``summary_available=False``). ``required_topics`` are
    the topics that SHOULD be present (the run's recorded set / default_topics),
    used to compute ``missing_topics``.
    """
    if summary is None:
        return QuickCheckLayer1(available=False, summary_available=False)
    summary_available = bool(summary.message_counts) or summary.start_ns is not None
    if not summary_available:
        return QuickCheckLayer1(available=True, summary_available=False)

    duration = summary.duration_s
    topics: dict[str, QuickCheckL1Topic] = {}
    empty_topics: list[str] = []
    for name, count in sorted(summary.message_counts.items()):
        avg_hz = (count / duration) if duration and duration > 0 else None
        topics[name] = QuickCheckL1Topic(
            message_count=count,
            avg_hz=round(avg_hz, 3) if avg_hz is not None else None,
            expected_hz=resolve_expected_hz(config, name),
        )
        if count == 0:
            empty_topics.append(name)
    present = set(summary.message_counts)
    missing_topics = [t for t in required_topics if t not in present]
    return QuickCheckLayer1(
        available=True,
        summary_available=True,
        topics=topics,
        missing_topics=missing_topics,
        empty_topics=empty_topics,
        duration_s=round(duration, 3) if duration is not None else None,
    )


def compute_verdict(
    layer0: QuickCheckLayer0, layer1: QuickCheckLayer1
) -> QuickCheckVerdict:
    """Derive the quality call from the two layers (explicit, simple rules).

    ``needs_review`` if ANY of: integrity != "ok"; a danger-severity incident
    fired during the window; a Layer 1 topic's avg_hz < 0.8 x expected_hz;
    missing or empty required topics; or the MCAP summary was unavailable.
    Otherwise ``good``. Every trigger appends a specific, human-readable reason;
    an empty reason list means ``good``.
    """
    reasons: list[str] = []

    # Integrity (recorder). "unknown"/absent is not "ok" -> honest needs_review.
    if layer0.integrity != INTEGRITY_OK:
        if layer0.integrity in (None, "unknown"):
            reasons.append("recording integrity could not be confirmed")
        else:
            reasons.append(f"recording integrity is '{layer0.integrity}'")

    # Danger-severity incidents overlapping the window.
    for inc in layer0.incidents:
        if not isinstance(inc, dict) or inc.get("severity") != DANGER_SEVERITY:
            continue
        topic = inc.get("topic", "?")
        metric = inc.get("metric", "?")
        reasons.append(f"danger incident during recording: {topic} {metric}")

    # Layer 1 rate shortfall vs expected (whole-window average).
    for name, t in layer1.topics.items():
        if t.expected_hz and t.avg_hz is not None:
            if t.avg_hz < HZ_SHORTFALL_RATIO * t.expected_hz:
                reasons.append(
                    f"{name} avg {t.avg_hz:g}Hz < expected {t.expected_hz:g}Hz"
                )

    # Missing / empty required topics.
    for name in layer1.missing_topics:
        reasons.append(f"required topic missing from bag: {name}")
    for name in layer1.empty_topics:
        reasons.append(f"topic recorded 0 messages: {name}")

    # Missing MCAP summary (unclean stop) — strong needs_review signal.
    if not layer1.summary_available:
        reasons.append("MCAP summary unavailable (unclean stop?)")

    quality = "needs_review" if reasons else "good"
    return QuickCheckVerdict(quality=quality, reasons=reasons)


# Extension events attached to a settlement are informational text, never a
# verdict input; a runaway extension must not bloat the persisted run either.
EXTENSION_EVENTS_CAP = 50


def extension_events_in_window(
    events: list[Any], start_ns: int | None, stop_ns: int | None
) -> list[dict[str, Any]]:
    """Keep live extension events whose ``t`` falls inside the recording window.

    Event bodies are freeform by contract; ``t`` is epoch SECONDS (the intake
    stamps it when absent). An event without a usable ``t`` cannot be placed in
    the window and is dropped (unlike incidents there is no "still active"
    semantic to be honest about). Unknown window bounds pass everything
    through. Output is capped at :data:`EXTENSION_EVENTS_CAP` (newest kept) —
    these are display text for the post-take panel, not a verdict input.
    """
    kept: list[dict[str, Any]] = []
    for item in events:
        if not isinstance(item, dict):
            continue
        t = item.get("t")
        if not isinstance(t, (int, float)):
            continue
        t_ns = int(float(t) * 1e9)
        if start_ns is not None and t_ns < start_ns:
            continue
        if stop_ns is not None and t_ns > stop_ns:
            continue
        kept.append(item)
    return kept[-EXTENSION_EVENTS_CAP:]


def assemble_quick_check(
    *,
    layer0: QuickCheckLayer0,
    layer1: QuickCheckLayer1,
    elapsed_ms: int,
    computed_at: str | None = None,
    extension_events: list[dict[str, Any]] | None = None,
) -> QuickCheck:
    """Combine the two layers + verdict into the persisted :class:`QuickCheck`."""
    return QuickCheck(
        computed_at=computed_at or utc_now_iso8601(),
        elapsed_ms=elapsed_ms,
        layer0=layer0,
        layer1=layer1,
        verdict=compute_verdict(layer0, layer1),
        extension_events=list(extension_events or []),
    )


def _as_float(value: Any) -> float | None:
    """Coerce a JSON number to float, or ``None`` if it isn't one."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None
