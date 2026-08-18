# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Internal HTTP client for the topic_monitor service.

The orchestrator proxies the monitor's discovery + live metrics and subscribes
to its SSE streams to aggregate into ``GET /api/v1/events``. On host networking
the monitor binds the host, so the base URL is
``http://localhost:{topic_monitor_port}`` (see ``config.md``, default 8001).

Request/retry/error policy is inherited from :class:`BaseServiceClient`. SSE
subscription uses :meth:`stream_sse`, which opens a long-lived GET and yields
parsed ``(event, data)`` pairs; the aggregator wraps those into the unified
``/api/v1/events`` stream.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx

from api_orchestrator.service_client import BaseServiceClient


class MonitorClient(BaseServiceClient):
    """Async wrapper over topic_monitor's internal HTTP + SSE API."""

    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        super().__init__("monitor", base_url, client)

    async def topics(self) -> dict[str, Any]:
        """Call monitor ``GET /topics`` (ROS 2 graph discovery)."""
        return await self._request("GET", "/topics")

    async def metrics(
        self, *, timeout: float | None = None, retries: int | None = None
    ) -> dict[str, Any]:
        """Call monitor ``GET /metrics`` (periodic snapshot of all topics).

        ``timeout`` / ``retries`` override the default 3s + 1-retry policy — the
        stop-time quick-check settlement passes a short budget so a slow monitor
        can't blow the total settlement budget.
        """
        return await self._request("GET", "/metrics", timeout=timeout, retries=retries)

    async def incidents(
        self,
        since_ns: int,
        *,
        timeout: float | None = None,
        retries: int | None = None,
    ) -> dict[str, Any]:
        """Call monitor ``GET /incidents?since_ns=<int>`` (fired-alert history).

        Returns ``{"incidents": [{id, topic, metric, severity, rule_origin,
        fired_at_ns, cleared_at_ns|null, message}]}``. The stop-time quick check
        uses this to fold incidents that overlap the recording window into
        Layer 0. The endpoint is newer than the rest of the monitor API, so
        callers degrade gracefully: a ``404`` (older monitor) or a transport
        failure surfaces as an :class:`~kairos_common.ApiError` and the caller
        marks that part of Layer 0 unavailable rather than failing settlement.
        """
        return await self._request(
            "GET",
            "/incidents",
            params={"since_ns": int(since_ns)},
            timeout=timeout,
            retries=retries,
        )

    async def stream_sse(
        self, path: str, *, timeout: float | None = None
    ) -> AsyncIterator[tuple[str, str]]:
        """Open a monitor SSE endpoint and yield ``(event, data)`` pairs.

        Parses the line-oriented SSE wire format (``event:`` / ``data:`` /
        blank-line dispatch). ``data:`` lines accumulate (multi-line allowed);
        a blank line dispatches the buffered event (default type ``message``).
        ``timeout=None`` disables the read timeout for the long-lived stream
        (connect/write/pool still follow the client policy).
        """
        read_timeout = self._stream_timeout(timeout)
        async with self._client.stream(
            "GET", f"{self._base_url}{path}", timeout=read_timeout
        ) as resp:
            resp.raise_for_status()
            event = "message"
            data_lines: list[str] = []
            async for raw in resp.aiter_lines():
                line = raw.rstrip("\r")
                if line == "":
                    if data_lines:
                        yield event, "\n".join(data_lines)
                    event = "message"
                    data_lines = []
                    continue
                if line.startswith(":"):
                    continue  # SSE comment / heartbeat.
                field, _, value = line.partition(":")
                value = value[1:] if value.startswith(" ") else value
                if field == "event":
                    event = value
                elif field == "data":
                    data_lines.append(value)
                # id/retry fields are not needed for the upstream legs.

    def _stream_timeout(self, read: float | None) -> httpx.Timeout:
        """The base policy with only ``read`` swapped (None = endless stream).

        Built field-by-field: ``httpx.Timeout(<Timeout>, read=...)`` asserts —
        an instance base and per-field overrides cannot be combined.
        """
        return httpx.Timeout(
            connect=self._timeout.connect,
            read=read,
            write=self._timeout.write,
            pool=self._timeout.pool,
        )
