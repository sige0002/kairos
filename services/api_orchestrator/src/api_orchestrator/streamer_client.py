"""Internal HTTP client for the webrtc_streamer service.

The orchestrator does not proxy the streamer's media/signaling (the frontend
connects to it directly per the spec); it only pings the streamer's health for
``/readyz`` component reporting. On host networking the streamer binds the host,
so the base URL is ``http://localhost:{webrtc_port}`` (see ``config.md``,
default 8002).

This is intentionally just :meth:`BaseServiceClient.healthz`.
"""

from __future__ import annotations

import httpx

from api_orchestrator.service_client import BaseServiceClient


class StreamerClient(BaseServiceClient):
    """Health-only client for the webrtc_streamer service."""

    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        super().__init__("streamer", base_url, client)
