# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Internal HTTP client for the importer sidecar (cross-host split).

The importer (``deploy/sync/``, defined ONLY in ``compose/recording.yaml``)
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

        ``capture_id=None`` queues a pull of EVERY finished capture via the
        importer's explicit ``{"all": true}`` opt-in — an empty body is a 400
        there, deliberately, so a lost key can never degrade a targeted pull
        into a sweep. The importer serialises pulls and copies only captures
        whose manifest is terminal (§10.6), so calling this for one that is
        still finalising is safe — it is simply skipped until the next pull.
        """
        body: dict[str, Any] = (
            {"all": True} if capture_id is None else {"capture_id": capture_id}
        )
        return await self._request("POST", "/pull", json=body)

    async def pull_status(self, capture_id: str) -> dict[str, Any]:
        """This capture's last pull state (queued/running/ok/failed) — S3-1.

        404s (as an :class:`ApiError`) when the importer knows no pull for it,
        including after an importer restart: the tracking is in-memory, and the
        durable answer is the replica state the reconciler adopts.
        """
        return await self._request("GET", f"/pull/{capture_id}")

    def __init__(self, base_url: str, client: httpx.AsyncClient) -> None:
        super().__init__("importer", base_url, client)
