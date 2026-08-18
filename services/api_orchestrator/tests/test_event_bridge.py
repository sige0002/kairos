# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""EventHub monitor-bridge connectivity (EVENT_BRIDGE) tests.

The hub's monitor SSE legs publish an aggregated ``bridge`` event on up/down
transitions so the UI can show an honest "robot offline" (in the cross-host
split the monitor runs ON the robot). These tests drive ``_bridge`` with a
scripted fake monitor: fail -> connect-and-stream -> clean close, and assert
the published transition sequence and the ``monitor_status`` property.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import api_orchestrator.events as events_mod
import httpx
from api_orchestrator.events import EVENT_BRIDGE, EVENT_METRICS, EventHub
from api_orchestrator.monitor_client import MonitorClient


class _ScriptedMonitor:
    """stream_sse fake: 1st call raises, 2nd yields one event then closes."""

    def __init__(self) -> None:
        self.calls = 0

    def stream_sse(self, path: str) -> AsyncIterator[tuple[str, str]]:
        self.calls += 1
        call = self.calls

        async def _gen() -> AsyncIterator[tuple[str, str]]:
            if call == 1:
                raise ConnectionError("robot off")
            yield ("metrics", '{"ts": 1}')

        return _gen()


def test_bridge_publishes_down_up_down_transitions(monkeypatch) -> None:
    monkeypatch.setattr(events_mod, "RECONNECT_BACKOFF_S", 0.01)

    async def scenario() -> tuple[list[tuple[str, dict]], str | None]:
        hub = EventHub(_ScriptedMonitor())
        task = asyncio.create_task(hub._bridge("/metrics/stream", EVENT_METRICS))
        # fail (down) -> reconnect -> stream (up) + metrics -> close (down):
        # wait until the full sequence landed in the ring, then cancel.
        for _ in range(200):
            if len([e for e in hub._ring if e.event == EVENT_BRIDGE]) >= 3:
                break
            await asyncio.sleep(0.01)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        return [(e.event, e.data) for e in hub._ring], hub.monitor_status

    ring, status = asyncio.run(scenario())
    bridge_seq = [d["monitor"] for t, d in ring if t == EVENT_BRIDGE]
    assert bridge_seq[:3] == ["down", "up", "down"]
    assert (EVENT_METRICS, {"ts": 1}) in ring
    assert status == "down"


def test_monitor_status_is_none_before_any_attempt_resolves() -> None:
    hub = EventHub(_ScriptedMonitor())
    assert hub.monitor_status is None


def test_bridge_streams_from_a_healthy_monitor(monkeypatch) -> None:
    """End-to-end over the REAL MonitorClient.stream_sse (mock transport):
    a healthy monitor must yield a bridge "up" transition AND the republished
    metrics event. Regression: building the per-stream httpx.Timeout from the
    client's Timeout instance used to assert, silently killing the bridge for
    healthy monitors too."""
    monkeypatch.setattr(events_mod, "RECONNECT_BACKOFF_S", 0.01)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b'event: metrics\ndata: {"ts":2}\n\n')

    async def scenario() -> list[tuple[str, dict]]:
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        hub = EventHub(MonitorClient("http://monitor", client))
        task = asyncio.create_task(hub._bridge("/metrics/stream", EVENT_METRICS))
        for _ in range(200):
            if any(e.event == EVENT_METRICS for e in hub._ring):
                break
            await asyncio.sleep(0.01)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        await client.aclose()
        return [(e.event, e.data) for e in hub._ring]

    ring = asyncio.run(scenario())
    assert (EVENT_BRIDGE, {"monitor": "up"}) in ring
    assert (EVENT_METRICS, {"ts": 2}) in ring
