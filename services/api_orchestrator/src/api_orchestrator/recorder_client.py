"""Internal HTTP client for the rosbag2_recorder service.

The orchestrator drives the recorder over its internal API (``/record/start``,
``/record/stop``, ``/record/status``, ``/record/metadata``, ``/healthz``). On
host networking the recorder binds the host, so the base URL is
``http://localhost:{recorder_port}`` (see ``config.md``).

Transport policy follows ``api_orchestrator.md``: a 3s timeout and one retry
for start/status/metadata (inherited from :class:`BaseServiceClient`); ``stop``
is the exception — it uses a longer :data:`STOP_TIMEOUT_S` budget (no retry)
because the recorder's clean flush of a large bag can take ~30s. When the
recorder is unreachable or errors, the failure surfaces to clients as a ``503``
(or the recorder's own 4xx) in the unified ``{error:{...}}`` shape.

The client takes an injected :class:`httpx.AsyncClient`, so tests can supply a
``MockTransport`` without touching the network.
"""

from __future__ import annotations

from typing import Any

import httpx

from api_orchestrator.service_client import (
    DEFAULT_TIMEOUT_S,
    RETRIES,
    BaseServiceClient,
)

__all__ = [
    "DEFAULT_TIMEOUT_S",
    "RETRIES",
    "START_TIMEOUT_S",
    "STOP_TIMEOUT_S",
    "RecorderClient",
]

# POST /record/stop is special: the recorder's clean SIGINT flush of a large
# bag can take up to ~30s (its STOP_TIMEOUT_S). The orchestrator must wait it
# out — a 3s timeout would 503 while the recorder is still correctly finalizing
# and the final-state re-sync would never run. Give stop a longer budget than
# the recorder's flush, with no retry (one long attempt; stop is idempotent).
STOP_TIMEOUT_S = 35.0

# POST /record/start now blocks while the recorder applies start_delay_s AND
# (for --start-paused) waits for subscriptions to match before resuming
# (subscription_ready_timeout_s). Give it a budget that covers both, with NO
# retry: a slow-but-succeeding start must not be retried into a 409.
START_TIMEOUT_S = 25.0


class RecorderClient(BaseServiceClient):
    """Thin async wrapper over the recorder's internal HTTP API.

    Args:
        base_url: Recorder base URL (e.g. ``http://localhost:8010``).
        client: An :class:`httpx.AsyncClient` (injected so tests can mock the
            transport). The caller owns its lifecycle.
        timeout_s: Per-request timeout in seconds.
        retries: Number of retries after the first attempt (1 = two attempts).
    """

    def __init__(
        self,
        base_url: str,
        client: httpx.AsyncClient,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retries: int = RETRIES,
    ) -> None:
        super().__init__(
            "recorder", base_url, client, timeout_s=timeout_s, retries=retries
        )

    async def start(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Call recorder ``POST /record/start``; returns the recorder body.

        Uses the longer :data:`START_TIMEOUT_S` budget (no retry) because the
        recorder blocks during the start delay + the --start-paused readiness
        gate; retrying a slow-but-succeeding start would hit a 409.
        """
        return await self._request(
            "POST", "/record/start", json=payload, timeout=START_TIMEOUT_S, retries=0
        )

    async def stop(self) -> dict[str, Any]:
        """Call recorder ``POST /record/stop`` (idempotent on the recorder).

        Uses the longer :data:`STOP_TIMEOUT_S` budget (no retry) so a large
        bag's flush has time to finish; start/status keep the 3s + retry policy.
        """
        return await self._request(
            "POST", "/record/stop", timeout=STOP_TIMEOUT_S, retries=0
        )

    async def status(self) -> dict[str, Any]:
        """Call recorder ``GET /record/status``.

        Returns the recorder's status body verbatim (no response model), so any
        additive recorder field — e.g. the ``arming`` snapshot (OL-①.4) — flows
        straight through to callers and the ``/api/v1/record/status`` proxy.
        """
        return await self._request("GET", "/record/status")

    async def metadata(self) -> dict[str, Any]:
        """Call recorder ``GET /record/metadata`` (last run's metadata)."""
        return await self._request("GET", "/record/metadata")
