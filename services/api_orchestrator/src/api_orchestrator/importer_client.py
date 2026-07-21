"""Internal HTTP client for the importer sidecar (cross-host split).

The importer (``deploy/sync/``, defined ONLY in ``compose.recording.yaml``)
pulls finalised runs from the robot over rsync/ssh. The orchestrator asks it to
pull a single run right after Collect Save when the recording config opts in
(``transfer.auto_pull_on_save``); on a single-host deploy no importer runs and
the flag stays false, so this client is never called there.
"""

from __future__ import annotations

from typing import Any

import httpx

from api_orchestrator.service_client import BaseServiceClient


class ImporterClient(BaseServiceClient):
    """Async wrapper over the importer sidecar's tiny HTTP API."""

    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        super().__init__("importer", base_url, client)

    async def pull(self, run_id: str | None = None) -> dict[str, Any]:
        """Queue a pull of one run's files from the robot (returns 202-style ack).

        ``run_id=None`` queues a pull of EVERY finalised run (the importer's
        ``POST /pull {}`` form). The importer serialises pulls and rsyncs only
        FINALISED runs (``metadata.yaml`` present on the robot), so calling
        this for a run that is still finalising is safe — the importer retries
        the listing on its next queued pull rather than half-copying.
        """
        body = {} if run_id is None else {"run_id": run_id}
        return await self._request("POST", "/pull", json=body)
