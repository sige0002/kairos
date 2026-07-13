"""Alert incident evaluation with hysteresis (the unit-testable core).

Each :class:`~topic_monitor.models.AlertRule` watches one metric of one topic and
fires when ``metric op threshold`` holds. To avoid flapping, two timers add
hysteresis (per ``docs/specs/ja/topic_monitor.md``):

- ``clear_after_s``: once the condition stops holding, the alert stays ``firing``
  until it has been false continuously for this long, then it clears.
- ``cooldown_s``: after an alert clears, the same rule will not re-fire until
  this long has elapsed (suppresses immediate re-fire on a noisy boundary).

Incident lifecycle (D-7): an incident is ``(topic, metric)``. :meth:`evaluate`
returns the *current state* of every incident each tick — a ``firing`` alert
while the condition holds (its ``value`` refreshed each tick so the UI can show
the live reading), and a ``cleared`` alert for ``clear_retain_s`` after recovery
so the transition is delivered reliably over the periodic, lossy SSE path (a
one-shot ``cleared`` would be dropped ~half the time: a tick evaluated for the
``metrics`` leg never reaches the ``alert`` buffer). The frontend de-dupes by
``(topic, metric)`` into a single row, so the per-tick re-send is not visible as
duplicate rows.

Default DANGER incidents (D-9 ③): beneath the config rules, every topic the
monitor classifies ``status == "danger"`` (its own expected-hz shortfall
convention) raises a default incident when the danger persists for
``default_sustain_s``, so a real rate collapse is never silent just because no
rule was written for that topic. A config rule on the same ``(topic, hz)``
supersedes the default (no double incident).

This module is pure: it operates on a metric value + a monotonic clock, so the
state machine can be unit-tested by feeding synthetic ``(value, now)`` pairs.
"""

from __future__ import annotations

import operator
import threading
from collections.abc import Callable
from dataclasses import dataclass

from topic_monitor.models import Alert, AlertMetric, AlertOp, AlertRule

# Map the shared AlertOp vocabulary to the comparison it means.
_OPS: dict[AlertOp, Callable[[float, float], bool]] = {
    AlertOp.lt: operator.lt,
    AlertOp.gt: operator.gt,
    AlertOp.le: operator.le,
    AlertOp.ge: operator.ge,
}

# Snapshot key each alert metric reads (``late`` -> the inter-arrival ratio).
_METRIC_KEYS: dict[AlertMetric, str] = {
    AlertMetric.hz: "hz",
    AlertMetric.bandwidth: "bandwidth_bps",
    AlertMetric.gap: "gap_max_ms",
    AlertMetric.late: "inter_arrival_late_ratio",
    AlertMetric.loss: "loss_rate",
}

# How long a cleared incident keeps being reported (state="cleared") after it
# recovers. Long enough to survive the lossy periodic SSE path (the cleared
# transition is re-sent for this whole window); the frontend de-dupes it to one
# muted row. After this it drops from the returned set.
_CLEAR_RETAIN_S = 60.0

# Default DANGER incident (D-9 ③) timers. The monitor's smoothed ``status`` is
# already hysteresis-debounced; the extra sustain makes a synthesized incident
# conservative (a real collapse, not a blip). Clear/cooldown mirror the repo's
# per-robot rule convention (config/airoa_hsr/monitoring/alerts.yaml).
_DEFAULT_SUSTAIN_S = 10.0
_DEFAULT_CLEAR_AFTER_S = 3.0
_DEFAULT_COOLDOWN_S = 10.0

# The per-topic status string that raises a default incident.
_DANGER_STATUS = "danger"


def metric_value(metric: AlertMetric, topic: dict[str, object]) -> float | None:
    """Pull the value an :class:`AlertMetric` watches out of a topic snapshot.

    ``topic`` is one entry of a metrics snapshot (the ``TopicMetrics`` shape).
    Returns ``None`` when the metric is not currently computable (its value is
    ``null``), so the rule is simply not evaluated this tick.
    """
    value = topic.get(_METRIC_KEYS[metric])
    return float(value) if isinstance(value, (int, float)) else None


@dataclass(slots=True)
class _RuleState:
    """Mutable per-incident hysteresis + lifecycle state."""

    firing: bool = False
    since_iso: str | None = None  # UTC ISO8601 the alert started firing
    true_since: float | None = None  # monotonic time the condition went true
    false_since: float | None = None  # monotonic time the condition went false
    cleared_mono: float | None = None  # monotonic time the alert last cleared
    cleared_iso: str | None = None  # UTC ISO8601 the alert last cleared
    last_value: float | None = None  # most recent metric value (cleared payload)


class AlertEngine:
    """Evaluate alert incidents against metric snapshots with hysteresis.

    One engine holds every configured rule plus the synthesized default DANGER
    incidents and their state. :meth:`evaluate` is called once per snapshot tick
    with the per-topic metric values; it returns the current state of every
    incident (firing + recently-cleared). Thread-safe (the snapshot builder may
    call it from the request thread).
    """

    def __init__(
        self,
        rules: list[AlertRule] | None = None,
        *,
        expected_hz_for: Callable[[str], float | None] | None = None,
        default_danger: bool = True,
        clear_retain_s: float = _CLEAR_RETAIN_S,
        default_sustain_s: float = _DEFAULT_SUSTAIN_S,
    ) -> None:
        self._rules = list(rules or [])
        self._state: dict[int, _RuleState] = {
            i: _RuleState() for i in range(len(self._rules))
        }
        # Default DANGER incidents (keyed by topic name, created lazily). Skipped
        # for a (topic, hz) already covered by a config rule (supersede).
        self._default_danger = default_danger
        self._expected_hz_for = expected_hz_for
        self._clear_retain_s = clear_retain_s
        self._default_sustain_s = default_sustain_s
        self._default_state: dict[str, _RuleState] = {}
        self._config_hz_topics = {
            r.topic for r in self._rules if r.metric == AlertMetric.hz
        }
        self._lock = threading.Lock()

    @property
    def rules(self) -> list[AlertRule]:
        return list(self._rules)

    def evaluate(
        self,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
    ) -> list[Alert]:
        """Return every incident's current state at *now*.

        Args:
            topics_by_name: topic name -> its metric snapshot dict.
            now: monotonic seconds (drives the hysteresis timers).
            ts_iso: UTC ISO8601 string stamped onto a state transition.
        """
        alerts: list[Alert] = []
        with self._lock:
            for idx, rule in enumerate(self._rules):
                alert = self._evaluate_rule(idx, rule, topics_by_name, now, ts_iso)
                if alert is not None:
                    alerts.append(alert)
            if self._default_danger:
                alerts.extend(self._evaluate_defaults(topics_by_name, now, ts_iso))
        return alerts

    # -- config rules -------------------------------------------------------

    def _evaluate_rule(
        self,
        idx: int,
        rule: AlertRule,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
    ) -> Alert | None:
        state = self._state[idx]
        topic = topics_by_name.get(rule.topic)
        value = metric_value(rule.metric, topic) if topic is not None else None
        if value is not None:
            state.last_value = value
        condition = value is not None and _OPS[rule.op](value, rule.threshold)
        self._advance(
            state,
            condition=condition,
            now=now,
            ts_iso=ts_iso,
            fire_after_s=0.0,  # config rules fire as soon as the condition holds
            clear_after_s=rule.clear_after_s,
            cooldown_s=rule.cooldown_s,
        )
        return self._build_alert(
            state,
            now=now,
            topic=rule.topic,
            metric=rule.metric,
            op=rule.op,
            threshold=rule.threshold,
            value=value,
        )

    # -- default DANGER incidents (D-9 ③) -----------------------------------

    def _evaluate_defaults(
        self,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
    ) -> list[Alert]:
        """Synthesize a hz-DANGER incident for every eligible topic.

        Eligible = the monitor classifies the topic ``status == "danger"`` (which
        requires a rate reference, so unknown/unmonitored topics never qualify)
        and no config rule already covers ``(topic, hz)``. The displayed
        threshold is that rate reference (static ``expected_hz`` or the learned
        baseline); ``value`` is the current hz.
        """
        alerts: list[Alert] = []
        active = set(topics_by_name)
        for name, topic in topics_by_name.items():
            if name in self._config_hz_topics:
                continue  # a config (topic, hz) rule supersedes the default
            danger = topic.get("status") == _DANGER_STATUS
            state = self._default_state.get(name)
            if state is None:
                if not danger:
                    continue  # never seen in danger -> no incident to track yet
                state = self._default_state[name] = _RuleState()
            hz = metric_value(AlertMetric.hz, topic)
            if hz is not None:
                state.last_value = hz
            self._advance(
                state,
                condition=danger,
                now=now,
                ts_iso=ts_iso,
                fire_after_s=self._default_sustain_s,
                clear_after_s=_DEFAULT_CLEAR_AFTER_S,
                cooldown_s=_DEFAULT_COOLDOWN_S,
            )
            alert = self._build_alert(
                state,
                now=now,
                topic=name,
                metric=AlertMetric.hz,
                op=AlertOp.lt,
                threshold=self._danger_threshold(name, topic),
                value=hz,
            )
            if alert is not None:
                alerts.append(alert)
        self._prune_defaults(now, active)
        return alerts

    def _danger_threshold(self, name: str, topic: dict[str, object]) -> float:
        """The rate reference to display for a default DANGER incident.

        Prefer the static ``expected_hz``; fall back to the learned baseline, and
        finally reconstruct it from ``hz + deficit_per_s`` (the exact reference
        the shortfall math used). ``0.0`` only if none is resolvable.
        """
        exp = self._expected_hz_for(name) if self._expected_hz_for is not None else None
        if exp is not None and exp > 0:
            return float(exp)
        baseline = topic.get("baseline_hz")
        if isinstance(baseline, (int, float)) and baseline > 0:
            return float(baseline)
        hz = topic.get("hz")
        deficit = topic.get("deficit_per_s")
        if isinstance(hz, (int, float)) and isinstance(deficit, (int, float)):
            return float(hz) + float(deficit)
        return 0.0

    def _prune_defaults(self, now: float, active: set[str]) -> None:
        """Drop default incidents that are idle and whose topic has vanished."""
        stale = [
            name
            for name, st in self._default_state.items()
            if not st.firing
            and name not in active
            and (
                st.cleared_mono is None or now - st.cleared_mono >= self._clear_retain_s
            )
        ]
        for name in stale:
            del self._default_state[name]

    # -- shared state machine ----------------------------------------------

    def _advance(
        self,
        state: _RuleState,
        *,
        condition: bool,
        now: float,
        ts_iso: str,
        fire_after_s: float,
        clear_after_s: float,
        cooldown_s: float,
    ) -> None:
        """Advance one incident's hysteresis given the condition at *now*."""
        if condition:
            state.false_since = None
            if state.firing:
                return
            if state.cleared_mono is not None and now - state.cleared_mono < cooldown_s:
                state.true_since = None  # still cooling down from the last clear
                return
            if state.true_since is None:
                state.true_since = now
            if now - state.true_since >= fire_after_s:
                state.firing = True
                state.since_iso = ts_iso
                state.cleared_mono = None
                state.cleared_iso = None
                state.true_since = None
        else:
            state.true_since = None
            if not state.firing:
                return
            if state.false_since is None:
                state.false_since = now
            if now - state.false_since >= clear_after_s:
                state.firing = False
                state.since_iso = None
                state.false_since = None
                state.cleared_mono = now
                state.cleared_iso = ts_iso

    def _build_alert(
        self,
        state: _RuleState,
        *,
        now: float,
        topic: str,
        metric: AlertMetric,
        op: AlertOp,
        threshold: float,
        value: float | None,
    ) -> Alert | None:
        """Render the incident's current state as an :class:`Alert`, or ``None``.

        ``firing`` while the condition holds (``since`` = when it started,
        ``value`` = the live reading); ``cleared`` for ``clear_retain_s`` after
        recovery (``since`` = when it cleared); ``None`` once idle.
        """
        if state.firing:
            return Alert(
                topic=topic,
                metric=metric,
                op=op,
                threshold=threshold,
                value=value if value is not None else state.last_value,
                state="firing",
                since=state.since_iso,
            )
        if (
            state.cleared_iso is not None
            and state.cleared_mono is not None
            and now - state.cleared_mono < self._clear_retain_s
        ):
            return Alert(
                topic=topic,
                metric=metric,
                op=op,
                threshold=threshold,
                value=value if value is not None else state.last_value,
                state="cleared",
                since=state.cleared_iso,
            )
        return None
