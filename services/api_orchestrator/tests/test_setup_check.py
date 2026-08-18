# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Manual setup-check contract tests.

The check must be read-only and partial-result friendly: one unavailable
component explains its own limitation without hiding the facts returned by the
others.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest
from api_orchestrator.routers import system as system_router
from fastapi.testclient import TestClient
from kairos_common import ApiError
from kairos_common.recording_config import RecordingConfig


class _Recorder:
    async def preflight(self) -> dict[str, Any]:
        return {"ready": True}


class _BlockedRecorder:
    async def preflight(self) -> dict[str, Any]:
        raise ApiError(
            status_code=507,
            code="insufficient_space",
            message="Insufficient free space to start recording.",
            details={"free_bytes": 10, "required_bytes": 20},
        )


class _Monitor:
    async def topics(self) -> dict[str, Any]:
        return {
            "topics": [
                {
                    "name": "/joint_states",
                    "type": "sensor_msgs/msg/JointState",
                    "publisher_count": 1,
                    "qos": {
                        "reliability": "reliable",
                        "durability": "volatile",
                        "depth": 10,
                    },
                },
                {
                    "name": "/camera/front/image",
                    "type": "sensor_msgs/msg/Image",
                    "publisher_count": 1,
                    "qos": {
                        "reliability": "best_effort",
                        "durability": "volatile",
                        "depth": 5,
                    },
                },
            ]
        }

    async def metrics(self) -> dict[str, Any]:
        return {
            "topics": [
                {"name": "/joint_states", "messages_total": 20, "hz": 100.0},
                {
                    "name": "/camera/front/image",
                    "messages_total": 4,
                    "hz": 30.0,
                },
            ]
        }


class _Streamer:
    async def healthz(self) -> bool:
        return True


def _wire(client: TestClient, *, recorder: Any | None = None) -> None:
    client.app.state.recording_config = RecordingConfig(
        robot_name="myrobot",
        default_topics=["/joint_states", "/camera/*"],
    )
    client.app.state.recorder_client = recorder or _Recorder()
    client.app.state.monitor_client = _Monitor()
    client.app.state.streamer_client = _Streamer()


def test_setup_check_reports_ready_topic_evidence(client: TestClient) -> None:
    _wire(client)

    response = client.post("/api/v1/system/setup-check")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["robot"] == "myrobot"
    assert body["duration_ms"] >= 0
    assert {item["status"] for item in body["checks"]} == {"pass"}
    assert body["topics"][1]["matched_topics"] == ["/camera/front/image"]
    assert body["topics"][1]["receiving_topics"] == ["/camera/front/image"]
    assert body["topics"][1]["status"] == "pass"
    assert body["topics"][1]["qos"]["/camera/front/image"]["reliability"] == (
        "best_effort"
    )


def test_setup_check_keeps_topic_results_when_recorder_is_blocked(
    client: TestClient,
) -> None:
    _wire(client, recorder=_BlockedRecorder())

    body = client.post("/api/v1/system/setup-check").json()

    assert body["status"] == "blocked"
    recorder = next(item for item in body["checks"] if item["id"] == "recorder")
    assert recorder["status"] == "blocker"
    assert recorder["code"] == "insufficient_space"
    assert "free space" in recorder["summary"]
    assert all(topic["status"] == "pass" for topic in body["topics"])


def test_setup_check_marks_unpublished_config_pattern_as_blocker(
    client: TestClient,
) -> None:
    _wire(client)
    client.app.state.recording_config = RecordingConfig(
        robot_name="myrobot",
        default_topics=["/joint_states", "/missing/*"],
    )

    body = client.post("/api/v1/system/setup-check").json()

    assert body["status"] == "blocked"
    missing = next(
        topic for topic in body["topics"] if topic["pattern"] == "/missing/*"
    )
    assert missing["status"] == "blocker"
    assert missing["matched_topics"] == []
    assert "publisher" in missing["summary"]


def test_each_setup_probe_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(system_router, "SETUP_CHECK_TIMEOUT_S", 0.001)

    async def never_finishes() -> None:
        await asyncio.Event().wait()

    result = asyncio.run(system_router._bounded_probe(never_finishes()))
    assert isinstance(result, TimeoutError)
