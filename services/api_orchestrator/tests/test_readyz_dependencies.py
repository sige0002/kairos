# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Readiness classification and concurrent downstream probing."""

from __future__ import annotations

import asyncio

from api_orchestrator.app_factory import _readyz_probe
from fastapi import Response, status


class _Dependency:
    def __init__(self, ok: bool, activity: dict[str, int] | None = None) -> None:
        self.ok = ok
        self.activity = activity

    async def healthz(self) -> bool:
        if self.activity is None:
            return self.ok
        self.activity["active"] += 1
        self.activity["peak"] = max(self.activity["peak"], self.activity["active"])
        await asyncio.sleep(0.01)
        self.activity["active"] -= 1
        return self.ok


def _run(recorder: bool, monitor: bool, streamer: bool) -> tuple[Response, dict]:
    response = Response()
    probe = _readyz_probe(
        _Dependency(recorder), _Dependency(monitor), _Dependency(streamer)
    )
    body = asyncio.run(probe(response))
    return response, body


def test_recorder_unavailable_withdraws_readiness() -> None:
    response, body = _run(False, True, True)

    assert response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert body["status"] == "unavailable"
    assert body["components"]["recorder"] == "unreachable"


def test_optional_dependencies_report_degraded_without_withdrawing_readiness() -> None:
    response, body = _run(True, False, False)

    assert response.status_code == status.HTTP_200_OK
    assert body["status"] == "degraded"
    assert body["components"] == {
        "recorder": "ok",
        "monitor": "unreachable",
        "streamer": "unreachable",
    }


def test_dependency_probes_run_concurrently() -> None:
    activity = {"active": 0, "peak": 0}
    response = Response()
    probe = _readyz_probe(
        _Dependency(True, activity),
        _Dependency(True, activity),
        _Dependency(True, activity),
    )

    body = asyncio.run(probe(response))

    assert body["status"] == "ready"
    assert activity["peak"] == 3
