# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Alert incident evaluation with hysteresis (the unit-testable core).

Each :class:`~kairos_common.monitoring.models.AlertRule` watches one metric
of one topic and
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

Derived hz incidents (D-9 ③): for every topic that has a static ``expected_hz``
and no config hz rule, the engine synthesizes ONE hz incident from the measured
shortfall — ``warning`` once ``hz < warn_ratio × expected`` is sustained,
escalating to ``danger`` once ``hz < danger_ratio × expected`` (ratios from the
``derived_rules:`` config block). A config rule on the same ``(topic, hz)``
supersedes it.

Default DANGER incidents (D-9 ③): beneath the config + derived rules, every topic
the monitor classifies ``status == "danger"`` with NO static ``expected_hz`` (so
its danger came from a learned baseline) raises a default incident when the
danger persists for ``default_sustain_s``. Precedence on a topic's hz metric is
config > derived > default, so exactly one mechanism owns each topic's hz — no
double incident.

Incident history (fixed contract): every fire→clear episode is also recorded in a
bounded ring (:meth:`AlertEngine.incident_history`) keyed on wall-clock
nanoseconds, retained beyond the live cleared-retention window so a consumer can
settle "what fired during a recording window" after the fact.

This module is pure: it operates on a metric value + a monotonic clock, so the
state machine can be unit-tested by feeding synthetic ``(value, now)`` pairs.
"""

from __future__ import annotations

import operator
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

from kairos_common.monitoring.models import (
    Alert,
    AlertMetric,
    AlertOp,
    AlertRule,
    DerivedRulesConfig,
    Incident,
)

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

# Bounded incident-history ring size (D-7 history). Retains fired+cleared
# episodes beyond the live _CLEAR_RETAIN_S window so the orchestrator can settle
# "what fired during a recording window" at stop time. Oldest episodes are
# evicted once this many are held.
_HISTORY_MAXLEN = 500

# Severity ranking for escalate-only updates of a firing incident's record.
_SEV_RANK = {"warning": 1, "danger": 2}


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
    record: Incident | None = None  # history-ring record of the CURRENT episode


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
        derived_config: DerivedRulesConfig | None = None,
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
        # Auto-derived per-topic hz incidents (keyed by topic name, created
        # lazily). Enabled only when a config object is supplied AND its
        # ``enabled`` flag is set; ``main.py`` always supplies one (default on),
        # so a bare AlertEngine() keeps the pre-feature behavior for unit tests.
        self._derived_config = derived_config
        self._derived_enabled = derived_config is not None and derived_config.enabled
        self._derived_state: dict[str, _RuleState] = {}
        # Bounded incident-history ring + a monotonically increasing episode
        # counter for stable incident ids (see _HISTORY_MAXLEN).
        self._history: deque[Incident] = deque(maxlen=_HISTORY_MAXLEN)
        self._incident_seq = 0
        self._lock = threading.Lock()

    def _derived_expected(self, topic: str) -> float | None:
        """Static ``expected_hz`` for *topic*, or ``None`` (no derived coverage).

        A topic is covered by a derived rule when derived rules are enabled, it
        has a positive static ``expected_hz`` and no config hz rule already
        watches it (config supersedes). Returns the expected rate for a covered
        topic, else ``None``.
        """
        if not self._derived_enabled or topic in self._config_hz_topics:
            return None
        if self._expected_hz_for is None:
            return None
        exp = self._expected_hz_for(topic)
        return float(exp) if exp is not None and exp > 0 else None

    @property
    def rules(self) -> list[AlertRule]:
        return list(self._rules)

    def evaluate(
        self,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
        now_ns: int | None = None,
    ) -> list[Alert]:
        """Return every incident's current state at *now*.

        Args:
            topics_by_name: topic name -> its metric snapshot dict.
            now: monotonic seconds (drives the hysteresis timers).
            ts_iso: UTC ISO8601 string stamped onto a state transition.
            now_ns: wall-clock UNIX nanoseconds stamped onto a fire/clear edge in
                the history ring; defaults to :func:`time.time_ns`.
        """
        if now_ns is None:
            now_ns = time.time_ns()
        alerts: list[Alert] = []
        with self._lock:
            for idx, rule in enumerate(self._rules):
                alert = self._evaluate_rule(
                    idx, rule, topics_by_name, now, ts_iso, now_ns
                )
                if alert is not None:
                    alerts.append(alert)
            if self._derived_enabled:
                alerts.extend(
                    self._evaluate_derived(topics_by_name, now, ts_iso, now_ns)
                )
            if self._default_danger:
                alerts.extend(
                    self._evaluate_defaults(topics_by_name, now, ts_iso, now_ns)
                )
        return alerts

    def incident_history(self, since_ns: int = 0) -> list[Incident]:
        """Return history-ring incidents touched at/after *since_ns*.

        An incident matches when it fired OR cleared at/after ``since_ns``
        (``fired_at_ns >= since_ns or cleared_at_ns >= since_ns``), so a
        recording window catches both incidents that started within it and ones
        that were still open when it began and cleared inside it. Returned oldest
        fire first; each is a copy so a later evaluate cannot mutate a served
        record (e.g. stamp ``cleared_at_ns``) mid-serialization.
        """
        with self._lock:
            return [
                rec.model_copy()
                for rec in self._history
                if rec.fired_at_ns >= since_ns
                or (rec.cleared_at_ns is not None and rec.cleared_at_ns >= since_ns)
            ]

    # -- config rules -------------------------------------------------------

    def _evaluate_rule(
        self,
        idx: int,
        rule: AlertRule,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
        now_ns: int,
    ) -> Alert | None:
        state = self._state[idx]
        topic = topics_by_name.get(rule.topic)
        value = metric_value(rule.metric, topic) if topic is not None else None
        if value is not None:
            state.last_value = value
        condition = value is not None and _OPS[rule.op](value, rule.threshold)
        was_firing = state.firing
        self._advance(
            state,
            condition=condition,
            now=now,
            ts_iso=ts_iso,
            fire_after_s=0.0,  # config rules fire as soon as the condition holds
            clear_after_s=rule.clear_after_s,
            cooldown_s=rule.cooldown_s,
        )
        self._record_edge(
            state,
            was_firing,
            now_ns,
            topic=rule.topic,
            metric=rule.metric,
            severity=rule.severity,
            origin="config",
            op=rule.op,
            threshold=rule.threshold,
            value=value if value is not None else state.last_value,
        )
        return self._build_alert(
            state,
            now=now,
            topic=rule.topic,
            metric=rule.metric,
            op=rule.op,
            threshold=rule.threshold,
            value=value,
            origin="config",
            severity=rule.severity,
        )

    # -- auto-derived per-topic hz incidents (D-9 ③) ------------------------

    def _evaluate_derived(
        self,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
        now_ns: int,
    ) -> list[Alert]:
        """Synthesize one hz incident per expected-rate topic from its shortfall.

        For each topic with a static ``expected_hz`` and no config hz rule, fire a
        single incident once ``hz < warn_ratio × expected`` is sustained; its
        severity is ``danger`` while ``hz < danger_ratio × expected`` and
        ``warning`` otherwise. One incident per topic hz (not two rules), so a
        deep shortfall never raises overlapping warning + danger rows, and it
        supersedes the status-based default for that topic.
        """
        cfg = self._derived_config
        assert cfg is not None  # _derived_enabled implies a config object
        alerts: list[Alert] = []
        active = set(topics_by_name)
        for name, topic in topics_by_name.items():
            exp = self._derived_expected(name)
            if exp is None:
                continue
            hz = metric_value(AlertMetric.hz, topic)
            warn_threshold = cfg.warn_ratio * exp
            danger_threshold = cfg.danger_ratio * exp
            condition = hz is not None and hz < warn_threshold
            state = self._derived_state.get(name)
            if state is None:
                if not condition:
                    continue  # healthy (or hz unknown) -> no incident to track yet
                state = self._derived_state[name] = _RuleState()
            if hz is not None:
                state.last_value = hz
            severity = (
                "danger" if (hz is not None and hz < danger_threshold) else "warning"
            )
            threshold = danger_threshold if severity == "danger" else warn_threshold
            was_firing = state.firing
            self._advance(
                state,
                condition=condition,
                now=now,
                ts_iso=ts_iso,
                fire_after_s=cfg.sustain_s,
                clear_after_s=cfg.clear_after_s,
                cooldown_s=cfg.cooldown_s,
            )
            self._record_edge(
                state,
                was_firing,
                now_ns,
                topic=name,
                metric=AlertMetric.hz,
                severity=severity,
                origin="derived",
                op=AlertOp.lt,
                threshold=threshold,
                value=hz if hz is not None else state.last_value,
            )
            alert = self._build_alert(
                state,
                now=now,
                topic=name,
                metric=AlertMetric.hz,
                op=AlertOp.lt,
                threshold=threshold,
                value=hz,
                origin="derived",
                severity=severity,
            )
            if alert is not None:
                alerts.append(alert)
        self._prune_state(self._derived_state, now, active)
        return alerts

    # -- default DANGER incidents (D-9 ③) -----------------------------------

    def _evaluate_defaults(
        self,
        topics_by_name: dict[str, dict[str, object]],
        now: float,
        ts_iso: str,
        now_ns: int,
    ) -> list[Alert]:
        """Synthesize a hz-DANGER incident for every eligible topic.

        Eligible = the monitor classifies the topic ``status == "danger"`` (which
        requires a rate reference, so unknown/unmonitored topics never qualify),
        no config rule already covers ``(topic, hz)``, and no derived rule covers
        it either (a topic with a static ``expected_hz`` is handled by the derived
        mechanism when it is enabled — this is the no-double-incident guarantee).
        The displayed threshold is that rate reference (static ``expected_hz`` or
        the learned baseline); ``value`` is the current hz.
        """
        alerts: list[Alert] = []
        active = set(topics_by_name)
        for name, topic in topics_by_name.items():
            if name in self._config_hz_topics:
                continue  # a config (topic, hz) rule supersedes the default
            if self._derived_expected(name) is not None:
                continue  # a derived (topic, hz) rule supersedes the default
            danger = topic.get("status") == _DANGER_STATUS
            state = self._default_state.get(name)
            if state is None:
                if not danger:
                    continue  # never seen in danger -> no incident to track yet
                state = self._default_state[name] = _RuleState()
            hz = metric_value(AlertMetric.hz, topic)
            if hz is not None:
                state.last_value = hz
            was_firing = state.firing
            self._advance(
                state,
                condition=danger,
                now=now,
                ts_iso=ts_iso,
                fire_after_s=self._default_sustain_s,
                clear_after_s=_DEFAULT_CLEAR_AFTER_S,
                cooldown_s=_DEFAULT_COOLDOWN_S,
            )
            threshold = self._danger_threshold(name, topic)
            self._record_edge(
                state,
                was_firing,
                now_ns,
                topic=name,
                metric=AlertMetric.hz,
                severity="danger",
                origin="default",
                op=AlertOp.lt,
                threshold=threshold,
                value=hz if hz is not None else state.last_value,
            )
            alert = self._build_alert(
                state,
                now=now,
                topic=name,
                metric=AlertMetric.hz,
                op=AlertOp.lt,
                threshold=threshold,
                value=hz,
                origin="default",
                severity="danger",
            )
            if alert is not None:
                alerts.append(alert)
        self._prune_state(self._default_state, now, active)
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

    def _prune_state(
        self, states: dict[str, _RuleState], now: float, active: set[str]
    ) -> None:
        """Drop synthesized incidents that are idle and whose topic has vanished.

        Shared by the derived and default mechanisms (both key state by topic
        name and create it lazily). The history ring keeps the episode regardless
        — pruning only reclaims the per-topic hysteresis slot.
        """
        stale = [
            name
            for name, st in states.items()
            if not st.firing
            and name not in active
            and (
                st.cleared_mono is None or now - st.cleared_mono >= self._clear_retain_s
            )
        ]
        for name in stale:
            del states[name]

    # -- incident history ring ---------------------------------------------

    def _record_edge(
        self,
        state: _RuleState,
        was_firing: bool,
        now_ns: int,
        *,
        topic: str,
        metric: AlertMetric,
        severity: str,
        origin: str,
        op: AlertOp,
        threshold: float,
        value: float | None,
    ) -> None:
        """Push a fire/clear transition into the bounded history ring.

        Called right after :meth:`_advance` with the ``firing`` flag captured
        BEFORE it. On a rising edge (a new episode) it appends a fresh
        :class:`Incident`; on a falling edge it stamps ``cleared_at_ns`` on that
        episode's record; while firing it escalates the record's severity
        (escalate-only, so a shortfall that dipped into danger is remembered even
        if it eased back to warning before clearing).
        """
        if state.firing:
            if not was_firing:
                self._incident_seq += 1
                record = Incident(
                    id=f"{topic}|{metric.value}|{self._incident_seq}",
                    topic=topic,
                    metric=metric,
                    severity=severity,
                    rule_origin=origin,
                    fired_at_ns=now_ns,
                    cleared_at_ns=None,
                    message=_incident_message(topic, metric, op, threshold, value),
                )
                self._history.append(record)
                state.record = record
            elif state.record is not None and _SEV_RANK.get(
                severity, 0
            ) > _SEV_RANK.get(state.record.severity, 0):
                state.record.severity = severity
        elif was_firing and state.record is not None:
            state.record.cleared_at_ns = now_ns
            state.record = None

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
        origin: str = "config",
        severity: str = "warning",
    ) -> Alert | None:
        """Render the incident's current state as an :class:`Alert`, or ``None``.

        ``firing`` while the condition holds (``since`` = when it started,
        ``value`` = the live reading); ``cleared`` for ``clear_retain_s`` after
        recovery (``since`` = when it cleared); ``None`` once idle. ``origin`` /
        ``severity`` carry the incident provenance into the live payload.
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
                rule_origin=origin,
                severity=severity,
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
                rule_origin=origin,
                severity=severity,
            )
        return None


def _incident_message(
    topic: str, metric: AlertMetric, op: AlertOp, threshold: float, value: float | None
) -> str:
    """A short human-readable summary stamped onto a history-ring incident."""
    op_symbol = {AlertOp.lt: "<", AlertOp.gt: ">", AlertOp.le: "<=", AlertOp.ge: ">="}[
        op
    ]
    reading = "n/a" if value is None else f"{value:g}"
    return f"{topic} {metric.value} {op_symbol} {threshold:g} (value={reading})"
