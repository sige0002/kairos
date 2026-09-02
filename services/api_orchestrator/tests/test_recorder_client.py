# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Unit tests for the recorder HTTP client: retry, timeout, error mapping.

These drive the async client directly via ``asyncio.run`` to avoid an async
test-plugin dependency (the suite must run green with only pytest + httpx).
"""

from __future__ import annotations

import asyncio

import httpx
import pytest
from api_orchestrator.recorder_client import RecorderClient
from kairos_common import ApiError


async def _with_client(handler: object, call: str, *args: object) -> object:
    """Run one ``RecorderClient`` method against a mocked transport handler."""
    transport = httpx.MockTransport(handler)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport) as http:
        client = RecorderClient("http://recorder:8010", http)
        return await getattr(client, call)(*args)


def test_retries_once_then_succeeds() -> None:
    """A transient transport error is retried, and the second attempt wins."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("first attempt fails")
        return httpx.Response(200, json={"state": "recording"})

    body = asyncio.run(_with_client(handler, "status"))
    assert body == {"state": "recording"}
    assert calls["n"] == 2  # one retry after the first failure


def test_unreachable_after_retries_is_503() -> None:
    """Persistent transport failure surfaces as a unified 503 ApiError."""
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ConnectTimeout("nope")

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(_with_client(handler, "status"))

    assert exc_info.value.status_code == 503
    assert exc_info.value.code == "recorder_unreachable"
    assert attempts["n"] == 2  # first attempt + one retry


def test_recorder_409_passes_through() -> None:
    """A recorder 409 (multiple start) is relayed with its status + code."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409, json={"error": {"code": "already_recording", "message": "busy"}}
        )

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(_with_client(handler, "start", {"run_id": "run_x", "topics": []}))

    assert exc_info.value.status_code == 409
    assert exc_info.value.code == "already_recording"


def test_non_2xx_without_error_body_is_503() -> None:
    """A non-2xx with an unexpected body still becomes a unified error."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="kaboom")

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(_with_client(handler, "metadata"))

    assert exc_info.value.status_code == 503
    assert exc_info.value.code == "recorder_error"


def test_healthz_never_raises() -> None:
    """healthz returns a bool even when the recorder is down."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    assert asyncio.run(_with_client(handler, "healthz")) is False


def test_preflight_calls_read_only_recorder_endpoint() -> None:
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        return httpx.Response(200, json={"ready": True})

    assert asyncio.run(_with_client(handler, "preflight")) == {"ready": True}
    assert seen == [("GET", "/record/preflight")]


def test_conditional_disarm_sends_the_expected_capture_id() -> None:
    seen: list[tuple[str, str, bytes]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.content))
        return httpx.Response(200, json={"disarmed": False, "state": "recording"})

    capture_id = "01983367-c1f6-7000-8000-000000000000"
    assert asyncio.run(_with_client(handler, "disarm_if_armed", capture_id)) == {
        "disarmed": False,
        "state": "recording",
    }
    assert seen == [
        (
            "POST",
            "/record/disarm",
            b'{"expected_capture_id":"01983367-c1f6-7000-8000-000000000000"}',
        )
    ]


def _captured_read_timeout(call: str, *args: object) -> float | None:
    """Drive one client call and return the read timeout httpx used for it."""
    captured: dict[str, float | None] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        # httpx records per-request timeouts in the request extensions.
        captured["timeout"] = request.extensions["timeout"]["read"]
        return httpx.Response(200, json={"state": "idle"})

    asyncio.run(_with_client(handler, call, *args))
    return captured["timeout"]


def test_stop_uses_longer_timeout_than_status() -> None:
    """stop gets the ~35s budget; start gets ~25s (start delay + arming gate);
    status keeps the 3s default.

    Regression guard: a 3s stop would 503 while the recorder is still correctly
    flushing a large bag, and a 3s start would 503 while the recorder applies
    start_delay_s + the --start-paused readiness gate.
    """
    from api_orchestrator.recorder_client import (
        DEFAULT_TIMEOUT_S,
        START_TIMEOUT_S,
        STOP_TIMEOUT_S,
    )

    assert STOP_TIMEOUT_S > 30  # must exceed the recorder's ~30s STOP_TIMEOUT_S
    assert START_TIMEOUT_S > DEFAULT_TIMEOUT_S  # covers start delay + arming
    assert _captured_read_timeout("stop") == STOP_TIMEOUT_S
    assert (
        _captured_read_timeout(
            "disarm_if_armed", "01983367-c1f6-7000-8000-000000000000"
        )
        == STOP_TIMEOUT_S
    )
    assert _captured_read_timeout("status") == DEFAULT_TIMEOUT_S
    assert _captured_read_timeout("start", {"run_id": "r", "topics": []}) == (
        START_TIMEOUT_S
    )


def test_prepare_uses_start_length_timeout_and_no_retry() -> None:
    """prepare gets the same generous budget as start, with a single attempt.

    Regression guard mirroring ``test_stop_uses_longer_timeout_than_status``:
    prepare blocks through spawn + DDS discovery/subscription-match (the same
    latency start absorbs today), so a short timeout would 503 a prepare that
    is still correctly arming, and a retry would just spawn a second session.
    """
    from api_orchestrator.recorder_client import PREPARE_TIMEOUT_S, START_TIMEOUT_S

    assert PREPARE_TIMEOUT_S == START_TIMEOUT_S
    assert _captured_read_timeout("prepare", {"run_id": "r", "topics": []}) == (
        PREPARE_TIMEOUT_S
    )

    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ReadTimeout("still arming")

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(_with_client(handler, "prepare", {"run_id": "r", "topics": []}))

    assert exc_info.value.status_code == 503
    assert attempts["n"] == 1  # one attempt only (retries=0 for prepare)


def test_prepare_returns_armed_body() -> None:
    """A successful prepare returns the recorder's armed body verbatim."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            201,
            json={
                "run_id": "run_x",
                "state": "armed",
                "arming": {"matched_topics": ["/tf"], "missing_topics": []},
                "disarm_at": "2026-06-24T00:02:00.000Z",
            },
        )

    body = asyncio.run(
        _with_client(handler, "prepare", {"run_id": "run_x", "topics": ["/tf"]})
    )
    assert body["run_id"] == "run_x"
    assert body["state"] == "armed"
    assert body["disarm_at"] == "2026-06-24T00:02:00.000Z"


def test_prepare_409_passes_through() -> None:
    """A recorder 409 on prepare (e.g. genuinely already recording) relays as-is."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409, json={"error": {"code": "already_recording", "message": "busy"}}
        )

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(_with_client(handler, "prepare", {"run_id": "r", "topics": []}))

    assert exc_info.value.status_code == 409
    assert exc_info.value.code == "already_recording"


def test_stop_does_not_retry_transport_failure() -> None:
    """stop makes a single (long) attempt — no retry doubling the wait."""
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ReadTimeout("flush took too long")

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(_with_client(handler, "stop"))

    assert exc_info.value.status_code == 503
    assert attempts["n"] == 1  # one attempt only (retries=0 for stop)


def test_conditional_disarm_does_not_retry_transport_failure() -> None:
    """A lost response must not repeat a process-termination command."""
    attempts = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        attempts["n"] += 1
        raise httpx.ReadTimeout("conditional disarm took too long")

    with pytest.raises(ApiError) as exc_info:
        asyncio.run(
            _with_client(
                handler,
                "disarm_if_armed",
                "01983367-c1f6-7000-8000-000000000000",
            )
        )

    assert exc_info.value.status_code == 503
    assert attempts["n"] == 1
