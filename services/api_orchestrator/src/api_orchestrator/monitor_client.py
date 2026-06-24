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

    async def metrics(self) -> dict[str, Any]:
        """Call monitor ``GET /metrics`` (periodic snapshot of all topics)."""
        return await self._request("GET", "/metrics")

    async def stream_sse(
        self, path: str, *, timeout: float | None = None
    ) -> AsyncIterator[tuple[str, str]]:
        """Open a monitor SSE endpoint and yield ``(event, data)`` pairs.

        Parses the line-oriented SSE wire format (``event:`` / ``data:`` /
        blank-line dispatch). ``data:`` lines accumulate (multi-line allowed);
        a blank line dispatches the buffered event (default type ``message``).
        ``timeout=None`` disables the read timeout for the long-lived stream
        (connect still applies via the client default).
        """
        read_timeout = httpx.Timeout(self._timeout, read=timeout)
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
