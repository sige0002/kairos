# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Internal HTTP client for the lerobot_exporter service (§6.2)."""

from __future__ import annotations

from typing import Any

import httpx

from api_orchestrator.service_client import (
    DEFAULT_TIMEOUT_S,
    RETRIES,
    BaseServiceClient,
)


class LerobotExporterClient(BaseServiceClient):
    """Async wrapper over lerobot_exporter's internal HTTP API.

    The exporter is an OPT-IN overlay (compose/lerobot.yaml): on installations
    without it every call here fails to connect, which the exports router turns
    into ``enabled: false`` / 503 rather than treating as an error state.
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
            "lerobot_exporter",
            base_url,
            client,
            timeout_s=timeout_s,
            retries=retries,
        )

    async def profiles(self) -> dict[str, Any]:
        """Call ``GET /profiles``."""
        return await self._request("GET", "/profiles")

    async def create_export(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Call ``POST /exports``."""
        return await self._request("POST", "/exports", json=payload)

    async def export_status(self, export_id: str) -> dict[str, Any]:
        """Call ``GET /exports/{id}``."""
        return await self._request("GET", f"/exports/{export_id}")

    async def cancel_export(self, export_id: str) -> dict[str, Any]:
        """Call ``POST /exports/{id}/cancel``."""
        return await self._request("POST", f"/exports/{export_id}/cancel")
