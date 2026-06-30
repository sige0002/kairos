"""Internal HTTP client for the dora_runner service."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
from kairos_common import ApiError, JobState

from api_orchestrator.service_client import (
    DEFAULT_TIMEOUT_S,
    RETRIES,
    BaseServiceClient,
)

# Job states that mean the job has stopped (no further polling needed).
_TERMINAL_STATES = {
    JobState.succeeded.value,
    JobState.failed.value,
    JobState.canceled.value,
}


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

    async def run_job_to_completion(
        self,
        payload: dict[str, Any],
        *,
        interval: float = 0.1,
        timeout: float = 120.0,
    ) -> dict[str, Any]:
        """Create a job and poll until it reaches a terminal state.

        Used by synchronous orchestrator flows (e.g. dataset export) that must
        know the outcome before responding. Creates the job, then polls
        ``job_status`` every *interval* seconds until the state is terminal
        (``succeeded`` / ``failed`` / ``canceled``). On ANY terminal state it
        fetches ``job_result`` — dora_runner nests its failure cause under the
        result's ``summary.error`` for failed/canceled jobs, so the caller can
        surface WHY it failed (not just "failed"). Returns ``{"state": <state>,
        "result": <result dict or None>}``. Raises :class:`ApiError` 504 if
        *timeout* elapses first (the underlying dora_runner job keeps running).
        """
        created = await self.create_job(payload)
        job_id = str(created["job_id"])
        loops = max(1, int(timeout / interval) + 1)
        for _ in range(loops):
            status = await self.job_status(job_id)
            state = str(status.get("state", ""))
            if state in _TERMINAL_STATES:
                result: dict[str, Any] | None = None
                try:
                    # Fetch the result on success AND failure: the failed-job
                    # result carries the cause. Best-effort on the failure path
                    # so a result-fetch hiccup never masks the real outcome.
                    result = await self.job_result(job_id)
                except Exception:  # noqa: BLE001
                    if state == JobState.succeeded.value:
                        raise
                    result = None
                return {"state": state, "result": result}
            await asyncio.sleep(interval)
        raise ApiError(
            status_code=504,
            code="job_timeout",
            message="Timed out waiting for the dora_runner job to finish.",
            details={"job_id": job_id, "timeout_s": timeout},
        )

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
