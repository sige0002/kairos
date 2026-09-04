"""Standard-library primitives for reproducible Kairos load measurements.

The module intentionally keeps collection, parsing, and reporting independent
from the command-line entry point.  This makes the live probes replaceable by
deterministic fakes and ensures that missing evidence is represented explicitly
instead of being confused with a measured zero.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

Unavailable = dict[str, Any]
Runner = Callable[..., Any]

_MISSING = object()
_CADENCE_TOLERANCE_FRACTION = 0.25
_CADENCE_TOLERANCE_MIN_S = 0.05
_CADENCE_TOLERANCE_MAX_S = 0.25
_COMPARISON_PATHS = (
    "scenario.name",
    "scenario.duration_s",
    "scenario.warmup_s",
    "scenario.sample_interval_s",
    "workload.camera_count",
    "workload.services",
    "workload.monitor_topic_set",
    "workload.camera_topics",
    "workload.connected_clients",
    "workload.selected_topics",
    "workload.preview_layout",
    "workload.preview_caps",
    "workload.recorder_state",
    "workload.probe_state",
    "workload.probe_topic",
    "workload.probe_field",
    "workload.robot_motion",
    "environment.rmw",
    "environment.transport_evidence",
    "environment.config_hashes",
    "environment.cpu_count",
    "environment.physical_interfaces",
    "environment.included_container_services",
    "environment.runtime_rmw",
    "environment.tcpdump_config",
    "environment.tcpdump.enabled",
    "environment.tcpdump.interface",
    "environment.tcpdump.group",
    "environment.tcpdump.port",
    "environment.tcpdump.filter",
)
_AXIS_DEPENDENCIES = {
    "workload.services": {
        "environment.included_container_services",
        "environment.runtime_rmw",
    },
    "environment.rmw": {"environment.runtime_rmw"},
}
_NONDECLARABLE_AXES = {
    "scenario.name",
    "environment.included_container_services",
    "environment.runtime_rmw",
    "environment.tcpdump_config",
    "environment.tcpdump.enabled",
    "environment.tcpdump.interface",
    "environment.tcpdump.group",
    "environment.tcpdump.port",
    "environment.tcpdump.filter",
}


def unavailable(reason: str) -> Unavailable:
    """Return the canonical representation of evidence that was not measured."""

    return {"status": "unavailable", "reason": reason}


def parse_proc_stat(text: str) -> dict[str, int]:
    """Parse the aggregate CPU counters from Linux ``/proc/stat`` text."""

    for line in text.splitlines():
        fields = line.split()
        if fields and fields[0] == "cpu":
            try:
                counters = [int(value) for value in fields[1:9]]
            except ValueError as exc:
                raise ValueError("invalid aggregate cpu counters") from exc
            if len(counters) < 4:
                raise ValueError("aggregate cpu line has too few counters")
            # user, nice, system, idle, iowait, irq, softirq, steal.  guest and
            # guest_nice are excluded because Linux already includes them in
            # user and nice respectively.
            while len(counters) < 8:
                counters.append(0)
            idle_ticks = counters[3] + counters[4]
            total_ticks = sum(counters)
            return {
                "busy_ticks": total_ticks - idle_ticks,
                "idle_ticks": idle_ticks,
                "total_ticks": total_ticks,
            }
    raise ValueError("aggregate cpu line not found")


def cpu_delta(
    before: Mapping[str, int], after: Mapping[str, int], *, cpu_count: int
) -> dict[str, int | float]:
    """Calculate host CPU use with explicit whole-machine denominators."""

    _require_positive_cpu_count(cpu_count)
    busy_ticks = after["busy_ticks"] - before["busy_ticks"]
    total_ticks = after["total_ticks"] - before["total_ticks"]
    if busy_ticks < 0 or total_ticks <= 0 or busy_ticks > total_ticks:
        raise ValueError("invalid or non-monotonic cpu counters")
    busy_pct = 100.0 * busy_ticks / total_ticks
    return {
        "busy_ticks": busy_ticks,
        "total_ticks": total_ticks,
        "busy_pct_machine": busy_pct,
        "busy_core_equivalents": busy_pct * cpu_count / 100.0,
        "cpu_count": cpu_count,
    }


def normalize_container_cpu(
    percent_per_core: float, *, cpu_count: int
) -> dict[str, int | float]:
    """Keep Docker's one-core percentage and derive its machine equivalent."""

    _require_positive_cpu_count(cpu_count)
    return {
        "pct_per_core": float(percent_per_core),
        "pct_machine": float(percent_per_core) / cpu_count,
        "cores_used": float(percent_per_core) / 100.0,
        "cpu_count": cpu_count,
    }


def _require_positive_cpu_count(cpu_count: int) -> None:
    if cpu_count <= 0:
        raise ValueError("cpu_count must be positive")


def parse_net_dev(text: str) -> dict[str, dict[str, int]]:
    """Parse byte, packet, and multicast counters from ``/proc/net/dev``."""

    result: dict[str, dict[str, int]] = {}
    for line in text.splitlines():
        if ":" not in line:
            continue
        interface, raw_counters = line.split(":", 1)
        fields = raw_counters.split()
        if len(fields) < 16:
            raise ValueError(f"invalid counters for interface {interface.strip()}")
        try:
            counters = [int(value) for value in fields]
        except ValueError as exc:
            raise ValueError(
                f"invalid counters for interface {interface.strip()}"
            ) from exc
        result[interface.strip()] = {
            "rx_bytes": counters[0],
            "rx_packets": counters[1],
            "rx_multicast_packets": counters[7],
            "tx_bytes": counters[8],
            "tx_packets": counters[9],
        }
    return result


def network_delta(
    before: Mapping[str, Mapping[str, int]],
    after: Mapping[str, Mapping[str, int]],
    *,
    physical_interfaces: set[str],
) -> dict[str, dict[str, int | str]]:
    """Return deltas for physical interfaces and loopback, never hiding ``lo``."""

    selected = (physical_interfaces | {"lo"}) & before.keys() & after.keys()
    result: dict[str, dict[str, int | str]] = {}
    for interface in sorted(selected):
        deltas = {
            field: after[interface][field] - before[interface][field]
            for field in (
                "rx_bytes",
                "tx_bytes",
                "rx_packets",
                "tx_packets",
                "rx_multicast_packets",
            )
        }
        if any(value < 0 for value in deltas.values()):
            raise ValueError(f"non-monotonic network counters for {interface}")
        result[interface] = {
            "kind": "loopback" if interface == "lo" else "physical",
            **deltas,
        }
    return result


def aggregate_samples(
    samples: list[dict[str, Any]], *, warmup_samples: int
) -> dict[str, Any]:
    """Aggregate numeric leaves after warm-up while retaining every raw sample."""

    if warmup_samples < 0 or warmup_samples >= len(samples):
        raise ValueError("warmup must leave at least one measurement sample")
    measured = samples[warmup_samples:]
    flattened = [_flatten(sample) for sample in measured]
    paths = sorted({path for sample in flattened for path in sample})
    summary: dict[str, Any] = {}
    for path in paths:
        values = [sample[path] for sample in flattened if path in sample]
        numeric = [
            float(value)
            for value in values
            if isinstance(value, (int, float)) and not isinstance(value, bool)
        ]
        if numeric:
            summary[path] = {
                "count": len(numeric),
                "min": min(numeric),
                "mean": sum(numeric) / len(numeric),
                "max": max(numeric),
            }
            unavailable_count = sum(_is_unavailable(value) for value in values)
            if unavailable_count:
                summary[path]["unavailable_count"] = unavailable_count
            continue
        missing_values = [value for value in values if _is_unavailable(value)]
        if missing_values:
            reasons = {str(value["reason"]) for value in missing_values}
            reason = next(iter(reasons)) if len(reasons) == 1 else "multiple reasons"
            summary[path] = {
                **unavailable(reason),
                "count": len(missing_values),
            }
    return {
        "raw_samples": samples,
        "warmup_samples": warmup_samples,
        "measurement_sample_count": len(measured),
        "summary": summary,
    }


def fixed_window_evidence(
    samples: Sequence[Mapping[str, Any]], *, duration_s: float, interval_s: float
) -> dict[str, Any]:
    """Validate and describe one fixed monotonic sampling window.

    A window starts with sample zero and must contain exactly
    ``ceil(duration / interval)`` samples.  The permitted scheduler jitter is
    explicit and bounded to 25% of one interval (at least 50 ms, at most 250
    ms).  A missed deadline or a catch-up burst is invalid rather than silently
    being summarized as a like-for-like benchmark result.
    """

    deadlines = _fixed_window_deadlines(duration_s, interval_s)
    expected_count = len(deadlines)
    actual_count = len(samples)
    if actual_count != expected_count:
        raise ValueError(
            f"fixed-window sample count {actual_count} does not equal expected "
            f"{expected_count}"
        )
    elapsed: list[float] = []
    for sample in samples:
        value = sample.get("elapsed_s")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("fixed-window sample is missing numeric elapsed_s")
        value = float(value)
        if not math.isfinite(value) or value < 0:
            raise ValueError("fixed-window elapsed_s must be finite and non-negative")
        elapsed.append(value)

    interval_s = float(interval_s)
    tolerance_s = _cadence_tolerance_s(interval_s)
    deadline_errors = [
        actual - expected for actual, expected in zip(elapsed, deadlines, strict=True)
    ]
    if any(abs(error) > tolerance_s for error in deadline_errors):
        raise ValueError("fixed-window deadline exceeded its tolerance")
    intervals = [
        after - before for before, after in zip(elapsed, elapsed[1:], strict=False)
    ]

    max_gap_s = max(intervals, default=0.0)
    return {
        "status": "valid",
        "expected_sample_count": expected_count,
        "actual_sample_count": actual_count,
        "interval_s": interval_s,
        "tolerance_s": tolerance_s,
        "expected_deadlines_s": deadlines,
        "deadline_errors_s": deadline_errors,
        "intervals_s": intervals,
        "max_gap_s": max_gap_s,
        "max_overrun_s": max(0.0, max(deadline_errors, default=0.0)),
        "elapsed_s": elapsed[-1],
    }


def _fixed_window_deadlines(duration_s: float, interval_s: float) -> list[float]:
    """Return the monotonic end-of-interval deadlines for one fixed window."""

    duration = _finite_positive_float(duration_s, "duration_s")
    interval = _finite_positive_float(interval_s, "interval_s")
    return [
        min((index + 1) * interval, duration)
        for index in range(math.ceil(duration / interval))
    ]


def _finite_positive_float(value: object, name: str) -> float:
    """Return a finite positive float or raise a stable artifact error."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite positive number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError(f"{name} must be a finite positive number") from exc
    if not math.isfinite(number) or number <= 0:
        raise ValueError(f"{name} must be a finite positive number")
    return number


def _finite_nonnegative_float(value: object, name: str) -> float:
    """Return a finite non-negative float or raise a stable artifact error."""

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite non-negative number")
    try:
        number = float(value)
    except OverflowError as exc:
        raise ValueError(f"{name} must be a finite non-negative number") from exc
    if not math.isfinite(number) or number < 0:
        raise ValueError(f"{name} must be a finite non-negative number")
    return number


def _cadence_tolerance_s(interval_s: float) -> float:
    """Return the documented bounded scheduler allowance for one interval."""

    return max(
        _CADENCE_TOLERANCE_MIN_S,
        min(_CADENCE_TOLERANCE_MAX_S, interval_s * _CADENCE_TOLERANCE_FRACTION),
    )


def validate_result_artifact(result: Mapping[str, Any]) -> None:
    """Reject a result that lacks or contradicts fixed-window evidence."""

    if result.get("schema_version") != "kairos.perf.result/v2":
        raise ValueError("unsupported result schema; expected kairos.perf.result/v2")
    manifest = result.get("manifest")
    if not isinstance(manifest, Mapping):
        raise ValueError("result has no object manifest")
    scenario = manifest.get("scenario")
    if not isinstance(scenario, Mapping):
        raise ValueError("result has no object scenario manifest")
    duration_s = scenario.get("duration_s")
    warmup_s = scenario.get("warmup_s")
    interval_s = scenario.get("sample_interval_s")
    try:
        duration = _finite_positive_float(duration_s, "duration_s")
        interval = _finite_positive_float(interval_s, "sample_interval_s")
        warmup = _finite_nonnegative_float(warmup_s, "warmup_s")
    except ValueError as exc:
        raise ValueError("result has invalid scenario timing") from exc
    if warmup >= duration:
        raise ValueError("result has invalid scenario timing")
    samples = result.get("raw_samples")
    if not isinstance(samples, list) or not all(
        isinstance(item, Mapping) for item in samples
    ):
        raise ValueError("result has no raw fixed-window samples")
    expected = fixed_window_evidence(samples, duration_s=duration, interval_s=interval)
    recorded = result.get("cadence")
    if not isinstance(recorded, Mapping) or any(
        recorded.get(key) != value for key, value in expected.items()
    ):
        raise ValueError("result has invalid cadence evidence")
    warmup_samples = result.get("warmup_samples")
    measurement_count = result.get("measurement_sample_count")
    if (
        isinstance(warmup_samples, bool)
        or not isinstance(warmup_samples, int)
        or warmup_samples < 0
        or warmup_samples >= len(samples)
        or isinstance(measurement_count, bool)
        or not isinstance(measurement_count, int)
        or measurement_count < 1
        or measurement_count != len(samples) - warmup_samples
        or warmup_samples != math.ceil(warmup / interval)
    ):
        raise ValueError("result has invalid warm-up sample accounting")
    environment = manifest.get("environment")
    fingerprint = (
        environment.get("workspace_fingerprint")
        if isinstance(environment, Mapping)
        else None
    )
    if not isinstance(fingerprint, str) or not re.fullmatch(
        r"[0-9a-f]{64}", fingerprint
    ):
        raise ValueError("result has no reproducible workspace fingerprint")


def _flatten(value: Any, prefix: str = "") -> dict[str, Any]:
    if isinstance(value, Mapping) and not _is_unavailable(value):
        flattened: dict[str, Any] = {}
        for key, child in value.items():
            child_path = f"{prefix}.{key}" if prefix else str(key)
            flattened.update(_flatten(child, child_path))
        return flattened
    if isinstance(value, list):
        flattened = {}
        for index, child in enumerate(value):
            child_path = f"{prefix}.{index}" if prefix else str(index)
            flattened.update(_flatten(child, child_path))
        return flattened
    return {prefix: value} if prefix else {}


def _is_unavailable(value: object) -> bool:
    return (
        isinstance(value, Mapping)
        and value.get("status") == "unavailable"
        and isinstance(value.get("reason"), str)
    )


def sha256_file(path: str | Path) -> str:
    """Return a lowercase SHA-256 digest of a file's exact bytes."""

    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(
    *,
    scenario_name: str,
    duration_s: float,
    warmup_s: float,
    sample_interval_s: float,
    camera_count: int,
    selected_topics: list[str],
    preview_layout: str,
    preview_caps: Mapping[str, Any],
    recorder_state: str,
    probe_state: str,
    robot_motion: str,
    rmw: str,
    transport_evidence: Mapping[str, Any],
    config_hashes: Mapping[str, str],
    git_sha: str,
    services: Mapping[str, str] | None = None,
    monitor_topic_set: str | None = None,
    camera_topics: list[str] | None = None,
    connected_clients: int | None = None,
    probe_topic: str | None = None,
    probe_field: str | None = None,
    cpu_count: int | None = None,
    physical_interfaces: list[str] | None = None,
    included_container_services: list[str] | None = None,
) -> dict[str, Any]:
    """Build the comparison manifest that identifies a benchmark workload."""

    if recorder_state not in {
        "created",
        "armed",
        "recording",
        "completed",
        "unavailable",
    }:
        raise ValueError("invalid recorder_state")
    if probe_state not in {"idle", "active", "unavailable"}:
        raise ValueError("invalid probe_state")
    if duration_s <= 0 or sample_interval_s <= 0 or warmup_s < 0:
        raise ValueError("scenario durations must be positive")
    if warmup_s >= duration_s:
        raise ValueError("warmup_s must be less than duration_s")
    if camera_count < 0:
        raise ValueError("camera_count must not be negative")
    if connected_clients is not None and connected_clients < 0:
        raise ValueError("connected_clients must not be negative")
    return {
        "schema_version": 1,
        "scenario": {
            "name": scenario_name,
            "duration_s": float(duration_s),
            "warmup_s": float(warmup_s),
            "sample_interval_s": float(sample_interval_s),
        },
        "workload": {
            "services": dict(services) if services is not None else None,
            "monitor_topic_set": monitor_topic_set,
            "camera_count": camera_count,
            "camera_topics": list(camera_topics or []),
            "connected_clients": connected_clients,
            "selected_topics": list(selected_topics),
            "preview_layout": preview_layout,
            "preview_caps": dict(preview_caps),
            "recorder_state": recorder_state,
            "probe_state": probe_state,
            "probe_topic": probe_topic,
            "probe_field": probe_field,
            "robot_motion": robot_motion,
        },
        "environment": {
            "rmw": rmw,
            "transport_evidence": dict(transport_evidence),
            "config_hashes": dict(config_hashes),
            "cpu_count": cpu_count,
            "physical_interfaces": list(physical_interfaces or []),
            "included_container_services": list(included_container_services or []),
            # Deliberately recorded but excluded from comparison compatibility:
            # a before/after change normally has different source revisions.
            "git_sha": git_sha,
        },
    }


def comparison_mismatches(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> list[str]:
    """List manifest dimensions that make a before/after comparison invalid."""

    mismatches = [
        *_runtime_rmw_consistency_mismatches("baseline", baseline),
        *_runtime_rmw_consistency_mismatches("candidate", candidate),
        *_workspace_consistency_mismatches("baseline", baseline),
        *_workspace_consistency_mismatches("candidate", candidate),
    ]
    allowed_axes, declaration_mismatch = _shared_allowed_axes(baseline, candidate)
    if declaration_mismatch:
        mismatches.append("comparison.allowed_axes")
    for path in _COMPARISON_PATHS:
        before = _nested_value(baseline, path)
        after = _nested_value(candidate, path)
        # Partial historical manifests can still be reported. A field becomes
        # incompatible when its two recorded values differ, including when only
        # one side recorded the dimension.
        if before is _MISSING and after is _MISSING:
            continue
        if before != after and path not in allowed_axes:
            mismatches.append(path)
    baseline_fingerprint = _nested_value(baseline, "environment.workspace_fingerprint")
    candidate_fingerprint = _nested_value(
        candidate, "environment.workspace_fingerprint"
    )
    if (
        baseline_fingerprint is not _MISSING
        and candidate_fingerprint is not _MISSING
        and baseline_fingerprint != candidate_fingerprint
    ):
        mismatches.append("environment.workspace_fingerprint")
    return mismatches


def _workspace_consistency_mismatches(
    label: str, manifest: Mapping[str, Any]
) -> list[str]:
    """Require a clean, reproducible workspace when the evidence is present."""

    dirty = _nested_value(manifest, "environment.git_dirty")
    fingerprint = _nested_value(manifest, "environment.workspace_fingerprint")
    if dirty is _MISSING and fingerprint is _MISSING:
        return []
    errors: list[str] = []
    if dirty is not False:
        errors.append(f"{label}.environment.git_dirty")
    if not isinstance(fingerprint, str) or not re.fullmatch(
        r"[0-9a-f]{64}", fingerprint
    ):
        errors.append(f"{label}.environment.workspace_fingerprint")
    return errors


def _runtime_rmw_consistency_mismatches(
    label: str, manifest: Mapping[str, Any]
) -> list[str]:
    """Find available runtime RMW values that contradict their own manifest."""

    declared = _nested_value(manifest, "environment.rmw")
    runtime = _nested_value(manifest, "environment.runtime_rmw")
    if not isinstance(declared, str) or not isinstance(runtime, Mapping):
        return []
    return [
        f"{label}.environment.runtime_rmw.{service}"
        for service, value in runtime.items()
        if not _is_unavailable(value) and value != declared
    ]


def _shared_allowed_axes(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> tuple[set[str], bool]:
    """Resolve one identically declared, known comparison dimension."""

    before = _nested_value(baseline, "comparison.allowed_axes")
    after = _nested_value(candidate, "comparison.allowed_axes")
    if before is _MISSING and after is _MISSING:
        return set(), False
    if before != after:
        return set(), True
    valid = (
        isinstance(before, list)
        and len(before) == 1
        and isinstance(before[0], str)
        and before[0] in _COMPARISON_PATHS
        and before[0] not in _NONDECLARABLE_AXES
    )
    if not valid:
        return set(), True
    primary_axis = before[0]
    return {primary_axis, *_AXIS_DEPENDENCIES.get(primary_axis, set())}, False


def _nested_value(value: Mapping[str, Any], path: str) -> Any:
    current: Any = value
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            return _MISSING
        current = current[part]
    return current


def extract_service_metrics(service: str, payload: Mapping[str, Any] | None) -> dict:
    """Extract comparable evidence from a ROS-facing service API response."""

    if service == "monitor":
        return _extract_monitor(payload)
    if service == "streamer":
        return _extract_streamer(payload)
    if service == "recorder":
        return _extract_recorder(payload)
    if service == "probe":
        return _extract_probe(payload)
    raise ValueError(f"unknown service: {service}")


def _extract_monitor(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    if payload is None or _is_unavailable(payload):
        return unavailable("endpoint unreachable")
    topics = payload.get("topics")
    topic_entries = topics if isinstance(topics, list) else []
    result: dict[str, Any] = {
        "topic_rates_hz": _topic_values(topic_entries, "hz"),
        "topic_bandwidth_bps": _topic_values(topic_entries, "bandwidth_bps"),
        "messages_total": _topic_values(topic_entries, "messages_total"),
    }
    self_load = payload.get("self_load")
    for field in ("callback_lag_ms", "callback_lag_p95_ms", "snapshot_age_s"):
        result[field] = _field_or_unavailable(self_load, field)
    return result


def _topic_values(topics: Iterable[Any], field: str) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for topic in topics:
        if not isinstance(topic, Mapping) or "name" not in topic:
            continue
        values[str(topic["name"])] = _field_or_unavailable(topic, field)
    return values


def _extract_streamer(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    if payload is None or _is_unavailable(payload):
        return unavailable("endpoint unreachable")
    streams: list[dict[str, Any]] = []
    raw_streams = payload.get("streams")
    for stream in raw_streams if isinstance(raw_streams, list) else []:
        if not isinstance(stream, Mapping):
            continue
        width = stream.get("width")
        height = stream.get("height")
        resolution: Any = (
            {"width": width, "height": height}
            if width is not None and height is not None
            else unavailable("field absent")
        )
        streams.append(
            {
                "stream_id": _field_or_unavailable(stream, "stream_id"),
                "topic": _field_or_unavailable(stream, "topic"),
                "client_count": _field_or_unavailable(stream, "clients"),
                "received_fps": _field_or_unavailable(stream, "received_fps"),
                "decoded_fps": _field_or_unavailable(stream, "decoded_fps"),
                "output_fps": _field_or_unavailable(stream, "output_fps"),
                "resolution": resolution,
            }
        )
    return {"streams": streams}


def _extract_recorder(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    if payload is None or _is_unavailable(payload):
        return unavailable("endpoint unreachable")
    return {
        field: _field_or_unavailable(payload, field)
        for field in (
            "state",
            "message_count",
            "bytes",
            "dropped_messages",
            "integrity",
            "post_stop_validation",
        )
    }


def _extract_probe(payload: Mapping[str, Any] | None) -> dict[str, Any]:
    if payload is None or _is_unavailable(payload):
        return {
            "state": "idle",
            "topic": unavailable("probe inactive"),
            "field": unavailable("probe inactive"),
            "sample_value": unavailable("probe inactive"),
            "sample_timestamp": unavailable("probe inactive"),
        }
    return {
        "state": "active",
        "topic": _field_or_unavailable(payload, "topic"),
        "field": _field_or_unavailable(payload, "field"),
        "sample_value": _field_or_unavailable(payload, "value"),
        "sample_timestamp": _field_or_unavailable(payload, "t"),
    }


def _field_or_unavailable(value: object, field: str) -> Any:
    if not isinstance(value, Mapping) or value.get(field) is None:
        return unavailable("field absent")
    return value[field]


def capture_multicast_packets(
    *,
    enabled: bool,
    duration_s: float,
    run: Runner | None = None,
    interface: str | None = None,
    multicast_host: str | None = None,
    port: int | None = None,
) -> dict[str, Any]:
    """Run the optional #69 packet check with a strict wall-clock bound."""

    if not enabled:
        return unavailable("tcpdump disabled")
    if duration_s <= 0:
        raise ValueError("duration_s must be positive")
    if not interface or not multicast_host or port is None:
        return unavailable("tcpdump filter not configured")
    packet_filter = f"udp and dst host {multicast_host} and dst port {port}"
    argv = ["tcpdump", "-i", interface, "-nn", "-q", packet_filter]
    runner = run or _run_bounded_tcpdump
    try:
        completed = runner(argv, timeout=duration_s + 1.0)
        output = "\n".join(
            str(value)
            for value in (
                getattr(completed, "stdout", ""),
                getattr(completed, "stderr", ""),
            )
            if value
        )
    except FileNotFoundError:
        return unavailable("tcpdump not installed")
    except subprocess.TimeoutExpired as exc:
        # tcpdump normally runs until the bound expires; its packet summary is
        # still useful when the injected/default runner exposes partial output.
        output = "\n".join(
            _decode_output(value) for value in (exc.stdout, exc.stderr) if value
        )
    match = re.search(r"(\d+) packets captured", output)
    if match is None:
        return unavailable("tcpdump packet count unavailable")
    return {"status": "available", "packet_count": int(match.group(1))}


def _run_bounded_tcpdump(argv: list[str], *, timeout: float) -> Any:
    """Interrupt tcpdump cleanly so it prints its final packet-count summary."""

    process = subprocess.Popen(  # noqa: S603 - argv is constructed without a shell
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        stdout, _ = process.communicate(timeout=max(0.1, timeout - 1.0))
    except subprocess.TimeoutExpired:
        process.send_signal(signal.SIGINT)
        try:
            stdout, _ = process.communicate(timeout=0.75)
        except subprocess.TimeoutExpired:
            process.kill()
            stdout, _ = process.communicate()
    return subprocess.CompletedProcess(
        argv, process.returncode, stdout=stdout, stderr=""
    )


def _decode_output(value: str | bytes) -> str:
    return value.decode(errors="replace") if isinstance(value, bytes) else value


def collect_fixed_window(
    *,
    duration_s: float,
    interval_s: float,
    collect: Callable[[], dict[str, Any]],
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> list[dict[str, Any]]:
    """Collect samples at fixed deadlines without depending on wall-clock time."""

    deadlines = _fixed_window_deadlines(duration_s, interval_s)
    start = monotonic()
    samples: list[dict[str, Any]] = []
    for deadline in deadlines:
        sleep(max(0.0, start + deadline - monotonic()))
        sampled_at = monotonic()
        sample = dict(collect())
        sample["elapsed_s"] = sampled_at - start
        samples.append(sample)
    return samples


def fetch_json(
    url: str,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
    timeout_s: float = 2.0,
) -> dict[str, Any]:
    """Fetch one bounded JSON endpoint, returning explicit unavailable evidence."""

    try:
        with opener(url, timeout=timeout_s) as response:
            payload = json.loads(response.read())
    except (OSError, TimeoutError, urllib.error.URLError, json.JSONDecodeError):
        return unavailable("endpoint unreachable")
    if not isinstance(payload, dict):
        return unavailable("endpoint returned non-object JSON")
    return payload


def write_json_result(result: Mapping[str, Any], path: str | Path) -> None:
    """Write one complete result with a unique same-directory atomic replace."""

    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(
        dir=output.parent,
        prefix=f".{output.name}.",
        suffix=".tmp",
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(
                json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False)
            )
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def render_comparison_markdown(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> str:
    """Render a concise comparison, refusing unlike scenario manifests."""

    baseline_manifest = baseline.get("manifest", {})
    candidate_manifest = candidate.get("manifest", {})
    mismatches = comparison_mismatches(baseline_manifest, candidate_manifest)
    scenario_name = _nested_value(baseline_manifest, "scenario.name")
    if scenario_name is _MISSING:
        scenario_name = "unknown"
    if mismatches:
        mismatch_lines = "\n".join(f"- `{path}`" for path in mismatches)
        return (
            f"# Benchmark comparison: {scenario_name}\n\n"
            "## INVALID COMPARISON\n\n"
            "The following workload/environment dimensions differ:\n\n"
            f"{mismatch_lines}\n"
        )

    rows = [
        _comparison_row(
            "Whole-machine CPU",
            baseline,
            candidate,
            "host.cpu_busy_pct_machine",
            kind="percent",
        )
    ]
    if _metric_present(baseline, candidate, "host.load1"):
        rows.append(
            _comparison_row(
                "Load average (1m)",
                baseline,
                candidate,
                "host.load1",
                kind="number",
            )
        )
    for container in _container_names(baseline, candidate):
        core_label = (
            "Container CPU (% of one core)"
            if container == "monitor"
            else f"Container CPU {container} (% of one core)"
        )
        machine_label = (
            "Container CPU (% of machine)"
            if container == "monitor"
            else f"Container CPU {container} (% of machine)"
        )
        rows.extend(
            (
                _comparison_row(
                    core_label,
                    baseline,
                    candidate,
                    f"containers.{container}.pct_per_core",
                    kind="percent",
                ),
                _comparison_row(
                    machine_label,
                    baseline,
                    candidate,
                    f"containers.{container}.pct_machine",
                    kind="percent",
                ),
            )
        )
    for process in _dynamic_names(
        baseline, candidate, r"processes\.([^.]+)\.pct_per_core"
    ):
        rows.append(
            _comparison_row(
                f"Process CPU {process} (% of one core)",
                baseline,
                candidate,
                f"processes.{process}.pct_per_core",
                kind="percent",
            )
        )
        machine_metric = f"processes.{process}.pct_machine"
        if _metric_present(baseline, candidate, machine_metric):
            rows.append(
                _comparison_row(
                    f"Process CPU {process} (% of machine)",
                    baseline,
                    candidate,
                    machine_metric,
                    kind="percent",
                )
            )
    for interface in _physical_interface_names(baseline, candidate):
        for direction in ("rx", "tx"):
            metric = f"network.{interface}.{direction}_bytes_per_s"
            if direction == "rx" or _metric_present(baseline, candidate, metric):
                rows.append(
                    _comparison_row(
                        f"Physical {direction.upper()} ({interface})",
                        baseline,
                        candidate,
                        metric,
                        kind="bytes_per_second",
                    )
                )
    for direction in ("rx", "tx"):
        metric = f"network.lo.{direction}_bytes_per_s"
        if _metric_present(baseline, candidate, metric):
            rows.append(
                _comparison_row(
                    f"Loopback {direction.upper()} (lo)",
                    baseline,
                    candidate,
                    metric,
                    kind="bytes_per_second",
                )
            )
    service_rows = (
        (
            "Monitor callback lag",
            "services.monitor.callback_lag_ms",
            "milliseconds",
        ),
        ("Recorder messages", "services.recorder.message_count", "number"),
        ("Recorder bytes", "services.recorder.bytes", "bytes"),
        (
            "Recorder dropped messages",
            "services.recorder.dropped_messages",
            "number",
        ),
    )
    for label, metric, kind in service_rows:
        if _metric_present(baseline, candidate, metric):
            rows.append(_comparison_row(label, baseline, candidate, metric, kind=kind))
    for prefix, suffix, unit in (
        ("services.monitor.topic_rates_hz.", "rate", "hertz"),
        ("services.monitor.topic_bandwidth_bps.", "bandwidth", "bytes_per_second"),
    ):
        for topic in _metric_suffixes(baseline, candidate, prefix):
            rows.append(
                _comparison_row(
                    f"{topic} {suffix}",
                    baseline,
                    candidate,
                    f"{prefix}{topic}",
                    kind=unit,
                )
            )
    stream_fields = (
        ("received_fps", "received FPS", "hertz"),
        ("decoded_fps", "decoded FPS", "hertz"),
        ("output_fps", "output FPS", "hertz"),
        ("client_count", "clients", "number"),
    )
    for stream in _stream_indexes(baseline, candidate):
        for field, label, kind in stream_fields:
            metric = f"services.streamer.streams.{stream}.{field}"
            if _metric_present(baseline, candidate, metric):
                rows.append(
                    _comparison_row(
                        f"Streamer {stream} {label}",
                        baseline,
                        candidate,
                        metric,
                        kind=kind,
                    )
                )
        width = f"services.streamer.streams.{stream}.resolution.width"
        height = f"services.streamer.streams.{stream}.resolution.height"
        if _metric_present(baseline, candidate, width) or _metric_present(
            baseline, candidate, height
        ):
            rows.append(
                _resolution_row(
                    f"Streamer {stream} resolution",
                    baseline,
                    candidate,
                    width,
                    height,
                )
            )
    for label, metric in (
        ("Recorder state", "services.recorder.state"),
        ("Recorder integrity", "services.recorder.integrity"),
        ("Recorder post-stop validation", "services.recorder.post_stop_validation"),
    ):
        if _evidence_present(baseline, candidate, metric):
            rows.append(_categorical_row(label, baseline, candidate, metric))
    if _direct_metric_present(baseline, candidate, "observer_overhead.self_user_cpu_s"):
        rows.append(
            _direct_comparison_row(
                "Observer self CPU",
                baseline,
                candidate,
                "observer_overhead.self_user_cpu_s",
                "seconds",
            )
        )
    rows.append(
        _comparison_row(
            "ROS user-data multicast packets",
            baseline,
            candidate,
            "multicast.packet_count",
            kind="number",
        )
    )
    return (
        f"# Benchmark comparison: {scenario_name}\n\n"
        "| Metric | Before | After | Delta |\n"
        "|---|---:|---:|---:|\n" + "\n".join(rows) + "\n"
    )


def _physical_interface_names(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> list[str]:
    """Find physical NICs from manifests, with old-result summary fallback."""

    names: set[str] = set()
    for result in (baseline, candidate):
        configured = _nested_value(result, "manifest.environment.physical_interfaces")
        if isinstance(configured, list):
            names.update(name for name in configured if isinstance(name, str) and name)
        summary = result.get("summary")
        if isinstance(summary, Mapping):
            for metric in summary:
                match = re.fullmatch(r"network\.([^.]+)\.rx_bytes_per_s", str(metric))
                if match and match.group(1) != "lo":
                    names.add(match.group(1))
    return sorted(names)


def _container_names(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> list[str]:
    """Find every container that has an aggregated CPU metric."""

    names: set[str] = set()
    for result in (baseline, candidate):
        summary = result.get("summary")
        if not isinstance(summary, Mapping):
            continue
        for metric in summary:
            match = re.fullmatch(r"containers\.([^.]+)\.pct_per_core", str(metric))
            if match:
                names.add(match.group(1))
    return sorted(names)


def _metric_present(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any], metric: str
) -> bool:
    """Return whether either result recorded a summary entry for ``metric``."""

    return any(
        isinstance(result.get("summary"), Mapping) and metric in result["summary"]
        for result in (baseline, candidate)
    )


def _dynamic_names(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any], pattern: str
) -> list[str]:
    names: set[str] = set()
    expression = re.compile(pattern)
    for result in (baseline, candidate):
        summary = result.get("summary")
        if not isinstance(summary, Mapping):
            continue
        for metric in summary:
            match = expression.fullmatch(str(metric))
            if match:
                names.add(match.group(1))
    return sorted(names)


def _metric_suffixes(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any], prefix: str
) -> list[str]:
    suffixes: set[str] = set()
    for result in (baseline, candidate):
        summary = result.get("summary")
        if isinstance(summary, Mapping):
            suffixes.update(
                str(metric)[len(prefix) :]
                for metric in summary
                if str(metric).startswith(prefix) and len(str(metric)) > len(prefix)
            )
    return sorted(suffixes)


def _stream_indexes(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> list[str]:
    return _dynamic_names(
        baseline, candidate, r"services\.streamer\.streams\.([0-9]+)\..+"
    )


def _evidence_present(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any], metric: str
) -> bool:
    return any(
        _result_value(result, metric) is not _MISSING
        for result in (baseline, candidate)
    )


def _result_value(result: Mapping[str, Any], metric: str) -> Any:
    summary = result.get("summary")
    if isinstance(summary, Mapping):
        aggregate = summary.get(metric)
        if isinstance(aggregate, Mapping):
            if "value" in aggregate:
                return aggregate["value"]
            if "mean" in aggregate:
                return aggregate["mean"]
    samples = result.get("raw_samples")
    if isinstance(samples, list):
        for sample in reversed(samples):
            if isinstance(sample, Mapping):
                value = _nested_value(sample, metric)
                if value is not _MISSING:
                    return value
    return _MISSING


def _categorical_row(
    label: str,
    baseline: Mapping[str, Any],
    candidate: Mapping[str, Any],
    metric: str,
) -> str:
    before = _result_value(baseline, metric)
    after = _result_value(candidate, metric)
    before_text = "unavailable" if before is _MISSING else str(before)
    after_text = "unavailable" if after is _MISSING else str(after)
    delta = "unchanged" if before == after and before is not _MISSING else "changed"
    return f"| {label} | {before_text} | {after_text} | {delta} |"


def _resolution_row(
    label: str,
    baseline: Mapping[str, Any],
    candidate: Mapping[str, Any],
    width_metric: str,
    height_metric: str,
) -> str:
    before = (
        _summary_mean(baseline, width_metric),
        _summary_mean(baseline, height_metric),
    )
    after = (
        _summary_mean(candidate, width_metric),
        _summary_mean(candidate, height_metric),
    )
    before_text = _format_resolution(before)
    after_text = _format_resolution(after)
    delta = "unchanged" if before == after else "changed"
    return f"| {label} | {before_text} | {after_text} | {delta} |"


def _format_resolution(values: tuple[Any, Any]) -> str:
    width, height = values
    if not isinstance(width, (int, float)) or not isinstance(height, (int, float)):
        return "unavailable"
    return f"{width:.0f}x{height:.0f}"


def _direct_metric_present(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any], metric: str
) -> bool:
    return any(
        _nested_value(result, metric) is not _MISSING
        for result in (baseline, candidate)
    )


def _direct_comparison_row(
    label: str,
    baseline: Mapping[str, Any],
    candidate: Mapping[str, Any],
    metric: str,
    kind: str,
) -> str:
    before = _nested_value(baseline, metric)
    after = _nested_value(candidate, metric)
    if not isinstance(before, (int, float)) or not isinstance(after, (int, float)):
        return f"| {label} | unavailable | unavailable | unavailable |"
    delta = float(after) - float(before)
    unit = " s" if kind == "seconds" else ""
    return f"| {label} | {before:.4f}{unit} | {after:.4f}{unit} | {delta:+.4f}{unit} |"


def _comparison_row(
    label: str,
    baseline: Mapping[str, Any],
    candidate: Mapping[str, Any],
    metric: str,
    *,
    kind: str,
) -> str:
    before = _summary_mean(baseline, metric)
    after = _summary_mean(candidate, metric)
    if not isinstance(before, (int, float)) or not isinstance(after, (int, float)):
        return (
            f"| {label} | {_format_missing(before)} | {_format_missing(after)} "
            "| unavailable |"
        )
    delta = float(after) - float(before)
    if kind == "percent":
        return (
            f"| {label} | {before:.2f}% | {after:.2f}% | "
            f"{delta:+.2f} percentage points |"
        )
    if kind == "bytes_per_second":
        return f"| {label} | {before:.2f} B/s | {after:.2f} B/s | {delta:+.2f} B/s |"
    if kind == "milliseconds":
        return f"| {label} | {before:.4f} ms | {after:.4f} ms | {delta:+.4f} ms |"
    if kind == "hertz":
        return f"| {label} | {before:.2f} Hz | {after:.2f} Hz | {delta:+.2f} Hz |"
    if kind == "bytes":
        return f"| {label} | {before:.2f} B | {after:.2f} B | {delta:+.2f} B |"
    return f"| {label} | {before:.2f} | {after:.2f} | {delta:+.2f} |"


def _summary_mean(result: Mapping[str, Any], metric: str) -> Any:
    summary = result.get("summary")
    if not isinstance(summary, Mapping):
        return unavailable("summary absent")
    value = summary.get(metric)
    if not isinstance(value, Mapping):
        return unavailable("metric absent")
    if _is_unavailable(value):
        return value
    mean = value.get("mean")
    if (
        not isinstance(mean, (int, float))
        or isinstance(mean, bool)
        or not math.isfinite(mean)
    ):
        return unavailable("mean absent")
    return mean


def _format_missing(value: object) -> str:
    if _is_unavailable(value):
        return f"unavailable ({value['reason']})"
    return "unavailable"
