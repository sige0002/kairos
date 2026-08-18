# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Host system info (``GET /api/v1/system``): CPU + GPU + utilization + disk.

Read-only, non-intrusive operator context for the UI header and the Monitor /
Collect system cards. Static facts (CPU model + logical core count from
``/proc/cpuinfo``, the GPU name from ``nvidia-smi``) are joined with cheap,
briefly-cached utilization samples (CPU busy %, runtime data-dir disk
free/total, GPU utilization %).

The probes themselves — and the caching that keeps them cheap — live in
:mod:`api_orchestrator.system_probe`. This endpoint never raises: any probe
failure (no ``/proc``, no ``nvidia-smi``, timeout, parse error, a missing data
dir) degrades the relevant field to ``null`` so the UI can honestly show "—" for
what it cannot measure.
"""

from __future__ import annotations

import asyncio
import fnmatch
import time
from collections.abc import Awaitable
from typing import Any

from fastapi import APIRouter, Request
from kairos_common import ApiError, utc_now_iso8601

from api_orchestrator import system_probe
from api_orchestrator.system_probe import SystemInfo

router = APIRouter(prefix="/api/v1/system", tags=["system"])

# Calls run concurrently and are individually capped, leaving response
# serialization headroom under the five-second operator-facing budget.
SETUP_CHECK_TIMEOUT_S = 4.0


@router.get("")
async def system_info(request: Request) -> SystemInfo:
    """Return host CPU/GPU names + live utilization/disk. Always 200 (nulls on
    failure)."""
    state = request.app.state
    settings = getattr(state, "settings", None)
    data_dir = getattr(settings, "data_dir", None)
    gpu = await system_probe._cached_gpu_name(state)
    cpu_percent, disk, gpu_percent = await system_probe._cached_utilization(
        state, data_dir, gpu is not None
    )
    return SystemInfo(
        cpu=system_probe._read_cpu_info(),
        gpu=gpu,
        cpu_percent=cpu_percent,
        disk=disk,
        gpu_percent=gpu_percent,
    )


def _probe_error(
    probe_id: str,
    label: str,
    result: BaseException,
    *,
    status: str,
    action: str,
) -> dict[str, Any]:
    """Turn one failed downstream probe into an operator-facing check."""
    if isinstance(result, ApiError):
        return {
            "id": probe_id,
            "label": label,
            "status": status,
            "summary": result.message,
            "code": result.code,
            "details": result.details,
            "action": action,
        }
    return {
        "id": probe_id,
        "label": label,
        "status": status,
        "summary": f"{label} could not be checked.",
        "code": "check_failed",
        "details": {"cause": str(result)},
        "action": action,
    }


def _overall_status(checks: list[dict[str, Any]], topics: list[dict[str, Any]]) -> str:
    statuses = {item["status"] for item in [*checks, *topics]}
    if "blocker" in statuses:
        return "blocked"
    if statuses & {"warning", "unknown"}:
        return "attention"
    return "ready"


async def _bounded_probe(call: Awaitable[Any]) -> Any | BaseException:
    """Return a probe value or its exception within the setup-check budget."""
    try:
        return await asyncio.wait_for(call, timeout=SETUP_CHECK_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - partial diagnostic by design
        return exc


@router.post("/setup-check")
async def setup_check(request: Request) -> dict[str, Any]:
    """Run an explicit, read-only setup diagnostic for the active robot.

    The downstream calls run concurrently. A failed component becomes a
    structured partial result instead of aborting the whole report, so facts
    from the recorder and ROS graph remain visible when (for example) the
    preview service is unavailable.
    """
    started = time.monotonic()
    state = request.app.state
    config = getattr(state, "recording_config", None)

    (
        recorder_result,
        topics_result,
        metrics_result,
        streamer_result,
    ) = await asyncio.gather(
        _bounded_probe(state.recorder_client.preflight()),
        _bounded_probe(state.monitor_client.topics()),
        _bounded_probe(state.monitor_client.metrics()),
        _bounded_probe(state.streamer_client.healthz()),
    )

    checks: list[dict[str, Any]] = []
    if config is None:
        checks.append(
            {
                "id": "recording_config",
                "label": "Recording config",
                "status": "blocker",
                "summary": "No valid recording config is loaded.",
                "code": "recording_config_unavailable",
                "action": (
                    "Select or repair a recording config, then run the check again."
                ),
            }
        )
        patterns: list[str] = []
        robot = None
    else:
        patterns = list(config.default_topics)
        robot = config.robot_name
        checks.append(
            {
                "id": "recording_config",
                "label": "Recording config",
                "status": "pass" if patterns else "warning",
                "summary": (
                    f"Loaded {len(patterns)} configured topic pattern"
                    f"{'s' if len(patterns) != 1 else ''}."
                    if patterns
                    else "The config is valid but has no default topic patterns."
                ),
                "action": (
                    None
                    if patterns
                    else "Add the topics this robot is expected to record."
                ),
            }
        )

    if isinstance(recorder_result, BaseException):
        checks.append(
            _probe_error(
                "recorder",
                "Recorder preflight",
                recorder_result,
                status="blocker",
                action=(
                    "Resolve the recorder storage or memory condition, then run again."
                ),
            )
        )
    else:
        checks.append(
            {
                "id": "recorder",
                "label": "Recorder preflight",
                "status": "pass",
                "summary": (
                    "The recorder can start with the current storage and memory limits."
                ),
                "action": None,
            }
        )

    discovered: list[dict[str, Any]] = []
    if isinstance(topics_result, BaseException):
        checks.append(
            _probe_error(
                "topic_graph",
                "ROS topic graph",
                topics_result,
                status="blocker",
                action=(
                    "Check the monitor service and ROS domain/network, then run again."
                ),
            )
        )
    else:
        discovered = [
            item
            for item in topics_result.get("topics", [])
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        ]

    metrics: list[dict[str, Any]] = []
    if isinstance(metrics_result, BaseException):
        checks.append(
            _probe_error(
                "monitor_intake",
                "Monitor intake",
                metrics_result,
                status="warning",
                action=(
                    "Check the monitor service; recording may work but live evidence "
                    "is unavailable."
                ),
            )
        )
    else:
        metrics = [
            item
            for item in metrics_result.get("topics", [])
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        ]

    topic_results: list[dict[str, Any]] = []
    receiving_names = {
        str(item["name"])
        for item in metrics
        if (item.get("messages_total") or 0) > 0 or item.get("hz") is not None
    }
    if not isinstance(topics_result, BaseException):
        for pattern in patterns:
            matches = [
                item
                for item in discovered
                if fnmatch.fnmatch(str(item["name"]), pattern)
                and (item.get("publisher_count") or 0) > 0
            ]
            names = [str(item["name"]) for item in matches]
            receiving = [name for name in names if name in receiving_names]
            if not names:
                status = "blocker"
                summary = "No active publisher matches this configured pattern."
                action = "Start the sensor/driver or select the correct robot config."
            elif not receiving:
                status = "warning"
                summary = (
                    "Publisher found, but the monitor has not received a sample yet."
                )
                action = (
                    "Wait briefly; if this persists, inspect monitor QoS and ROS "
                    "networking."
                )
            else:
                status = "pass"
                suffix = "s" if len(receiving) != 1 else ""
                summary = f"{len(receiving)} publishing topic{suffix} received."
                action = None
            topic_results.append(
                {
                    "pattern": pattern,
                    "status": status,
                    "summary": summary,
                    "matched_topics": names,
                    "receiving_topics": receiving,
                    "qos": {
                        str(item["name"]): item.get("qos")
                        for item in matches
                        if item.get("qos") is not None
                    },
                    "action": action,
                }
            )

        blocked = sum(item["status"] == "blocker" for item in topic_results)
        blocked_verb = "has" if blocked == 1 else "have"
        checks.append(
            {
                "id": "topic_graph",
                "label": "ROS topic coverage",
                "status": "blocker" if blocked else "pass",
                "summary": (
                    f"{blocked} configured pattern"
                    f"{'s' if blocked != 1 else ''} {blocked_verb} no active publisher."
                    if blocked
                    else "Every configured topic pattern has an active publisher."
                ),
                "action": None,
            }
        )

    if not isinstance(metrics_result, BaseException):
        not_receiving = sum(item["status"] == "warning" for item in topic_results)
        matched_total = sum(len(item["matched_topics"]) for item in topic_results)
        if patterns and matched_total == 0:
            intake_status = "unknown"
            intake_summary = (
                "No configured publisher was available to test monitor intake."
            )
        elif not_receiving:
            suffix = "s" if not_receiving != 1 else ""
            verb = "have" if not_receiving != 1 else "has"
            intake_status = "warning"
            intake_summary = (
                f"{not_receiving} configured pattern{suffix} {verb} no received "
                "samples yet."
            )
        else:
            intake_status = "pass"
            intake_summary = "The monitor is receiving every matched configured topic."
        checks.append(
            {
                "id": "monitor_intake",
                "label": "Monitor intake",
                "status": intake_status,
                "summary": intake_summary,
                "action": None,
            }
        )

    if isinstance(streamer_result, BaseException) or streamer_result is not True:
        failure = (
            streamer_result
            if isinstance(streamer_result, BaseException)
            else RuntimeError("streamer health check returned unavailable")
        )
        checks.append(
            _probe_error(
                "preview",
                "Camera preview",
                failure,
                status="warning",
                action="Check the streamer service if camera preview is needed.",
            )
        )
    else:
        checks.append(
            {
                "id": "preview",
                "label": "Camera preview",
                "status": "pass",
                "summary": "The preview service is reachable.",
                "action": None,
            }
        )

    return {
        "status": _overall_status(checks, topic_results),
        "checked_at": utc_now_iso8601(),
        "duration_ms": round((time.monotonic() - started) * 1000),
        "robot": robot,
        "ros_domain_id": getattr(state.settings, "ros_domain_id", None),
        "checks": checks,
        "topics": topic_results,
    }
