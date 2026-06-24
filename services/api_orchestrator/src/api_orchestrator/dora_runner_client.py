"""Internal HTTP client for the dora_runner service."""

from __future__ import annotations

from typing import Any

import httpx

from api_orchestrator.service_client import (
    DEFAULT_TIMEOUT_S,
    RETRIES,
    BaseServiceClient,
)


class DoraRunnerClient(BaseServiceClient):
    """Async wrapper over dora_runner's internal HTTP API."""

    def __init__(
        self,
        base_url: str,
        client: httpx.AsyncClient,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        retries: int = RETRIES,
    ) -> None:
        super().__init__(
            "dora_runner",
            base_url,
            client,
            timeout_s=timeout_s,
            retries=retries,
        )

    async def pipelines(self) -> dict[str, Any]:
        """Call ``GET /pipelines``."""
        return await self._request("GET", "/pipelines")

    async def create_job(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Call ``POST /jobs``."""
        return await self._request("POST", "/jobs", json=payload)

    async def job_status(self, job_id: str) -> dict[str, Any]:
        """Call ``GET /jobs/{id}/status``."""
        return await self._request("GET", f"/jobs/{job_id}/status")

    async def job_result(self, job_id: str) -> dict[str, Any]:
        """Call ``GET /jobs/{id}/result``."""
        return await self._request("GET", f"/jobs/{job_id}/result")

    async def cancel_job(self, job_id: str) -> dict[str, Any]:
        """Call ``POST /jobs/{id}/cancel``."""
        return await self._request("POST", f"/jobs/{job_id}/cancel")

    async def list_templates(self, *, limit: int, cursor: str | None) -> dict[str, Any]:
        """Call ``GET /validation/templates``."""
        path = f"/validation/templates?limit={limit}"
        if cursor is not None:
            path = f"{path}&cursor={cursor}"
        return await self._request("GET", path)

    async def create_template(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Call ``POST /validation/templates``."""
        return await self._request("POST", "/validation/templates", json=payload)

    async def generate_template(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Call ``POST /validation/templates/generate``."""
        return await self._request(
            "POST", "/validation/templates/generate", json=payload
        )
