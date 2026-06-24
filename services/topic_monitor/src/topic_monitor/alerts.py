"""Alert rule evaluation with hysteresis (the unit-testable core).

Each :class:`~topic_monitor.models.AlertRule` watches one metric of one topic and
fires when ``metric op threshold`` holds. To avoid flapping, two timers add
hysteresis (per ``docs/specs/ja/topic_monitor.md``):

- ``clear_after_s``: once the condition stops holding, the alert stays ``firing``
  until it has been false continuously for this long, then it clears.
- ``cooldown_s``: after an alert clears, the same rule will not re-fire until
  this long has elapsed (suppresses immediate re-fire on a noisy boundary).

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
    """Mutable per-rule hysteresis state."""

    firing: bool = False
    since_iso: str | None = None  # UTC ISO8601 the alert started firing
    false_since: float | None = None  # monotonic time the condition went false
    cleared_at: float | None = None  # monotonic time the alert last cleared


class AlertEngine:
    """Evaluate alert rules against metric snapshots with hysteresis.

    One engine holds every configured rule and its state. :meth:`evaluate` is
    called once per snapshot tick with the per-topic metric values; it returns
    the list of currently-firing alerts. Thread-safe (the snapshot builder may
    call it from the request thread).
    """

    def __init__(self, rules: list[AlertRule] | None = None) -> None:
        self._rules = list(rules or [])
        self._state: dict[int, _RuleState] = {
            i: _RuleState() for i in range(len(self._rules))
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
        """Return the alerts firing at *now* given the per-topic metric values.

        Args:
            topics_by_name: topic name -> its metric snapshot dict.
            now: monotonic seconds (drives the hysteresis timers).
            ts_iso: UTC ISO8601 string stamped onto a newly-firing alert.
        """
        firing: list[Alert] = []
        with self._lock:
            for idx, rule in enumerate(self._rules):
                alert = self._evaluate_rule(idx, rule, topics_by_name, now, ts_iso)
                if alert is not None:
                    firing.append(alert)
        return firing

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
        condition = value is not None and _OPS[rule.op](value, rule.threshold)

        if condition:
            self._on_true(state, rule, now, ts_iso)
        else:
            self._on_false(state, rule, now)

        if not state.firing:
            return None
        return Alert(
            topic=rule.topic,
            metric=rule.metric,
            op=rule.op,
            threshold=rule.threshold,
            value=value,
            state="firing",
            since=state.since_iso,
        )

    @staticmethod
    def _on_true(state: _RuleState, rule: AlertRule, now: float, ts_iso: str) -> None:
        """Condition holds: start firing unless within the post-clear cooldown."""
        state.false_since = None
        if state.firing:
            return
        if state.cleared_at is not None and now - state.cleared_at < rule.cooldown_s:
            return  # still cooling down from the previous alert
        state.firing = True
        state.since_iso = ts_iso

    @staticmethod
    def _on_false(state: _RuleState, rule: AlertRule, now: float) -> None:
        """Condition does not hold: clear once false for ``clear_after_s``."""
        if not state.firing:
            return
        if state.false_since is None:
            state.false_since = now
        if now - state.false_since >= rule.clear_after_s:
            state.firing = False
            state.since_iso = None
            state.false_since = None
            state.cleared_at = now
