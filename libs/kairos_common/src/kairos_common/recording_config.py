# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Loader and validator for the recording/monitoring config (RECORDING_CONFIG).

This is three-layer config #2 (deployment tuning) from ``config.md``: the YAML
shared by ``rosbag2_recorder`` (default topics + per-topic QoS for recording),
``topic_monitor`` (expected Hz + QoS for lightweight subscribe), and
``dora_runner`` (validation.required_topics, stage 3). The canonical template
is ``config/<robot>/recording/default.yaml``.

The models mirror that template's schema. Topic matching is glob (fnmatch);
pattern lists are first-match-wins (the consuming services apply that order —
this module only parses and validates structure).

Unknown keys are rejected (``extra="forbid"``) because they are almost always
typos; pydantic reports the offending location so the operator can fix it.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from enum import StrEnum
from pathlib import Path
from typing import Annotated

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class _StrictModel(BaseModel):
    """Base model that forbids unknown keys (typo detection)."""

    model_config = ConfigDict(extra="forbid")


class Reliability(StrEnum):
    """DDS reliability QoS policy."""

    reliable = "reliable"
    best_effort = "best_effort"


class Durability(StrEnum):
    """DDS durability QoS policy."""

    volatile = "volatile"
    transient_local = "transient_local"


class ExpectedHzPattern(_StrictModel):
    """Expected Hz for a topic pattern (topic_monitor Late judgement).

    ``hz`` may be omitted (``None``) to dynamically learn the rate after
    subscribe (see the template comments).
    """

    pattern: str
    hz: Annotated[float, Field(gt=0)] | None = None


class TopicQosOverride(_StrictModel):
    """Per-topic QoS override applied by recorder / monitor (first match wins)."""

    pattern: str
    reliability: Reliability
    durability: Durability
    # KEEP_LAST queue depth; must be >= 1 (0 is not a valid history depth).
    depth: Annotated[int, Field(ge=1)]


class MonitorConfig(_StrictModel):
    """topic_monitor tuning."""

    qos_depth: Annotated[int, Field(ge=1)] = 30
    # Use header.stamp for late/loss when it can be obtained safely.
    stamp_quality: bool = True
    # Sliding-window sizes in seconds.
    window_s: list[Annotated[int, Field(gt=0)]] = Field(default_factory=lambda: [1, 5])
    # Observed-shortfall status thresholds (fractions of expected_hz). A topic is
    # "warning" at >= warn_shortfall under expected, "danger" at >= danger_shortfall.
    warn_shortfall: Annotated[float, Field(ge=0, le=1)] = 0.02
    danger_shortfall: Annotated[float, Field(ge=0, le=1)] = 0.05
    # Below this many expected msgs/window, judge status by absolute deficit (so a
    # low-rate topic does not false-alarm on a single missed message).
    min_status_count: Annotated[float, Field(ge=0)] = 20.0
    # Status hysteresis dwell (seconds): a worse status must persist this long to
    # escalate (escalate_s), a better one to recover (recover_s) — escalate slow.
    status_escalate_s: Annotated[float, Field(ge=0)] = 2.0
    status_recover_s: Annotated[float, Field(ge=0)] = 1.0
    # --- Dynamic baseline learning (OL-2.3) -------------------------------
    # When a topic has NO static expected_hz, learn an observed Hz baseline
    # before judging shortfall. While warming up, the topic reports status
    # "unknown" (never danger) to avoid false alarms during learning. Topics
    # with a static expected_hz keep using it (static always wins).
    baseline_learning: bool = True
    # Minimum observation time before a learned baseline may be declared stable.
    baseline_warmup_s: Annotated[float, Field(ge=0)] = 10.0
    # Coefficient of variation (stddev/mean of windowed Hz) at/under which the
    # learned baseline is "stable" and becomes the shortfall reference.
    baseline_stable_cv: Annotated[float, Field(ge=0)] = 0.15
    # Minimum windowed Hz samples observed before a baseline can be stable.
    baseline_min_samples: Annotated[int, Field(ge=1)] = 30
    # --- Monitor self-load metrics (OL-2.4) -------------------------------
    # Observe the monitor's OWN processing health (sample-callback latency,
    # snapshot freshness) — reported separately from topic health, never
    # decoding payloads. Cheap to collect; toggle off to drop all overhead.
    self_load_metrics: bool = True
    # Warn when mean sample-callback processing exceeds this (milliseconds).
    callback_lag_warn_ms: Annotated[float, Field(ge=0)] = 50.0
    # Warn when the latest metrics snapshot is older than this (seconds).
    snapshot_age_warn_s: Annotated[float, Field(ge=0)] = 2.0


class Storage(StrEnum):
    """rosbag2 storage backend. MCAP is the canonical recording format."""

    mcap = "mcap"


class Compression(StrEnum):
    """rosbag2 compression mode."""

    none = "none"
    zstd = "zstd"


class RecordingTuning(_StrictModel):
    """rosbag2_recorder tuning."""

    discovery_timeout_s: Annotated[float, Field(gt=0)] = 10
    # Wait for drivers/cameras to ramp up before recording.
    start_delay_s: Annotated[float, Field(ge=0)] = 2.0
    # Start `ros2 bag record --start-paused`, wait until the recorder has
    # subscribed to the target topics, then resume — so the bag begins with all
    # subscriptions live (no first-frames dropped during DDS discovery/matching).
    # Fail-safe: if the resume can't be confirmed, the start fails visibly rather
    # than leaving a paused recorder silently capturing nothing.
    # The ROS-graph-API readiness gate (distro/locale independent, unlike scraping
    # "Subscribed to topic '...'" logs). OL-①.1: the shipped real-robot config
    # profiles (config/*.yaml) set this true so live recording arms by default;
    # the LIBRARY default stays false so a no-config process and the rclpy-free
    # unit tests never arm. Recommended on for any live deployment.
    start_paused: bool = False
    # Max time to wait for all target topics to be subscribed before resuming
    # anyway (records whatever matched; logs the topics that didn't).
    subscription_ready_timeout_s: Annotated[float, Field(ge=0)] = 5.0
    # Extra settle time AFTER subscriptions are established but BEFORE resume
    # (OL-①.2): absorbs camera/sensor ramp-up so the first recorded frames are
    # real, not warm-up. Distinct from start_delay_s, which sleeps BEFORE spawn
    # (so it cannot see whether subscriptions actually matched). 0 disables.
    post_discovery_delay_s: Annotated[float, Field(ge=0)] = 0.0
    # Two-phase start (prepare -> resume): how long an ``armed`` session (a
    # ``POST /record/prepare`` that spawned + matched subscriptions but was
    # never claimed by a matching ``POST /record/start``) is kept alive before
    # it is auto-disarmed (subprocess killed, empty run dir removed). Bounds
    # the cost of an armed-but-abandoned session: while armed its subscriptions
    # are live (same DDS reader load as recording), so an unclaimed arm must
    # not linger indefinitely.
    prepare_disarm_timeout_s: Annotated[float, Field(gt=0)] = 120.0
    # Whether the Console keeps a recording PRE-ARMED (two-phase start: a
    # standing ``POST /record/prepare`` kept alive by matching re-prepares)
    # while the Collect screen sits ready-to-record, so the operator's Start is
    # a near-instant resume instead of a multi-second spawn + DDS-discovery
    # wait. Read by the FRONTEND only — the recorder itself never acts on it.
    # Cost while armed: the same DDS reader load as recording (a paused
    # rosbag2 receives and discards), so turn this off for a robot whose
    # receive-side budget is already tight (see rosbag2_recorder.md).
    pre_arm: bool = True
    # rosbag2 in-recorder message cache (--max-cache-size, in MiB). The recorder
    # buffers incoming messages in RAM and a writer thread drains them to disk; if
    # the cache fills (burst / slow storage / constrained CPU) rosbag2 DROPS the
    # overflow and logs "Total lost: N". A bigger cache absorbs more burst before
    # any drop. 0 omits the flag → rosbag2's own default (100 MiB). Worst-case RAM
    # is ~2x this (double buffering), so the recorder preflights free RAM before
    # honouring large values (507 insufficient_memory otherwise). The shipped
    # real-robot profiles set 512; the LIBRARY default stays 0 (rosbag2 default).
    max_cache_size_mb: Annotated[int, Field(ge=0, le=4096)] = 0
    storage: Storage = Storage.mcap
    compression: Compression = Compression.none


class RequiredTopic(_StrictModel):
    """A topic a recorded run must contain (dora_runner fast_validation).

    ``name`` may be a glob pattern; ``type`` is optional.
    """

    name: str
    type: str | None = None


class ValidationConfig(_StrictModel):
    """Validation config (dora_runner fast_validation + the stop-time quick check)."""

    required_topics: list[RequiredTopic] = Field(default_factory=list)
    # Shortest recording the stop-time quick check will call "good". A capture
    # below this is reported as needs_review with the duration in the reason —
    # never a hard failure, because a deliberately short take is legitimate and
    # only the operator knows which it was.
    #
    # The default exists because per-topic message PRESENCE is not evidence of a
    # usable recording: in a fraction of a second every topic can happen to
    # deliver one message, and the check then reports "no issues" for what was
    # actually a double-clicked start/stop. Two seconds is comfortably below any
    # real take and comfortably above an accident. ``0`` disables the criterion.
    min_duration_s: float = Field(default=2.0, ge=0)


class TransferConfig(_StrictModel):
    """Post-save run transfer (cross-host split; read by api_orchestrator).

    In the robot-edge split the recorder writes MCAP on the ROBOT's disk and
    the recording PC pulls finalised runs over rsync/ssh (``deploy/sync/``).
    With ``auto_pull_on_save`` the orchestrator asks its importer sidecar
    (``compose/recording.yaml``) to pull the run right after Collect Save
    (``POST /api/v1/episodes``), so the run is reviewable seconds later with
    no manual ``make import-runs``. Default OFF — nothing is ever transferred
    without an explicit opt-in; the flag is inert on a single-host deploy
    (the data is already local and no importer runs there). The robot-side
    copy is left in place either way (robot-side retention is a separate TBD).
    """

    auto_pull_on_save: bool = False


class RecordingConfig(_StrictModel):
    """Top-level recording/monitoring config (the RECORDING_CONFIG YAML)."""

    robot_name: str
    # Default record/monitor targets (glob allowed).
    default_topics: list[str] = Field(default_factory=list)
    # Pattern -> expected Hz (first match wins).
    expected_hz_patterns: list[ExpectedHzPattern] = Field(default_factory=list)
    # Pattern -> QoS for record/subscribe (first match wins).
    topic_qos_overrides: list[TopicQosOverride] = Field(default_factory=list)
    monitor: MonitorConfig = Field(default_factory=MonitorConfig)
    recording: RecordingTuning = Field(default_factory=RecordingTuning)
    validation: ValidationConfig = Field(default_factory=ValidationConfig)
    transfer: TransferConfig = Field(default_factory=TransferConfig)


def _format_validation_error(path: Path, exc: ValidationError) -> str:
    """Render a pydantic ``ValidationError`` into a readable, multi-line message."""
    lines = [f"Invalid recording config: {path}"]
    for err in exc.errors():
        loc = ".".join(str(part) for part in err["loc"]) or "(root)"
        lines.append(f"  - {loc}: {err['msg']}")
    return "\n".join(lines)


def load_recording_config(path: str | Path) -> RecordingConfig:
    """Load and validate a :class:`RecordingConfig` from a YAML file.

    Args:
        path: Path to the ``RECORDING_CONFIG`` YAML file.

    Returns:
        A validated :class:`RecordingConfig`.

    Raises:
        FileNotFoundError: If *path* does not exist.
        ValueError: If the YAML is not a mapping or fails validation (the
            message lists each offending field and unknown keys).
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Recording config not found: {path}")

    try:
        with path.open("r", encoding="utf-8") as fh:
            raw = yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        # A hand edit that left the file unparseable. Callers degrade on
        # ValueError and OSError; YAMLError is neither, so letting it out
        # turned "this config is unusable" — which every caller is written to
        # survive — into a service that does not start.
        raise ValueError(f"Recording config is not valid YAML: {path}\n{exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError(f"Recording config root must be a mapping: {path}")

    try:
        return RecordingConfig.model_validate(raw)
    except ValidationError as exc:
        raise ValueError(_format_validation_error(path, exc)) from exc


# The failures every consumer is written to survive. ``OSError`` covers both the
# absent file (FileNotFoundError is one) and the one that is there but cannot be
# read — a permission error, or a directory in its place. Those are the same
# fact to a caller that has no config either way, so treating them differently
# only decided WHICH services refused to start over it.
DEGRADE_ON_UNUSABLE: tuple[type[Exception], ...] = (OSError, ValueError)


def _warn_unavailable(logger: logging.Logger, path: Path, exc: Exception) -> None:
    """Default report: one WARNING naming the failure, then carry on."""
    logger.warning("recording config unavailable: %s", exc)


def load_recording_config_or_none(
    path: str | Path,
    logger: logging.Logger,
    *,
    on_unavailable: Callable[
        [logging.Logger, Path, Exception], None
    ] = _warn_unavailable,
    degrade_on: tuple[type[Exception], ...] = DEGRADE_ON_UNUSABLE,
) -> RecordingConfig | None:
    """Load the RECORDING_CONFIG, degrading to ``None`` when it is unusable.

    Every service that reads this file is written to run without it — the
    recorder falls back to each publisher's offered QoS, the monitor seeds no
    topics, the orchestrator serves empty defaults — so a missing or malformed
    config is reported and swallowed rather than being a reason to refuse to
    boot.

    Args:
        path: The ``RECORDING_CONFIG`` path.
        logger: The caller's logger, handed to *on_unavailable*.
        on_unavailable: How the failure is reported. The default logs one
            WARNING; pass a reporter to word it differently (it can tell an
            absent file from an unusable one by the exception type).
        degrade_on: Which failures degrade to ``None``, should a caller need a
            narrower set than :data:`DEGRADE_ON_UNUSABLE`.
    """
    path = Path(path)
    try:
        return load_recording_config(path)
    except degrade_on as exc:
        on_unavailable(logger, path, exc)
        return None
