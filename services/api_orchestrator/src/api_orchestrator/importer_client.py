"""Internal HTTP client for the importer sidecar (cross-host split).

The importer (``deploy/sync/``, defined ONLY in ``compose.recording.yaml``)
pulls finished captures from the robot over rsync/ssh. The orchestrator asks it
to pull one right after the first review save when the recording config opts in
(``transfer.auto_pull_on_save``); a single-host deploy runs no importer and
keeps the flag false, so this client is constructed but never called there.
"""

from __future__ import annotations

from typing import Any

import httpx

from api_orchestrator.service_client import BaseServiceClient


class ImporterClient(BaseServiceClient):
    """Async wrapper over the importer sidecar's tiny HTTP API."""

    async def pull(self, capture_id: str | None = None) -> dict[str, Any]:
        """Queue a pull of one capture's files (202-style ack).

        ``capture_id=None`` queues a pull of EVERY finished capture. The
        importer serialises pulls and copies only captures whose manifest is
        terminal (§10.6), so calling this for one that is still finalising is
        safe — it is simply skipped until the next pull.
        """
        body = {} if capture_id is None else {"capture_id": capture_id}
        return await self._request("POST", "/pull", json=body)

    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        super().__init__("importer", base_url, client)
