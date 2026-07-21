"""Transfer endpoints (``/api/v1/transfer``) — UI-triggered run pulls (split).

In the cross-host split the recorder writes MCAP on the ROBOT's disk and the
recording PC copies finalised runs over through the importer sidecar
(``deploy/sync/``, defined only in ``compose.recording.yaml``; it binds
127.0.0.1, so the orchestrator is its only caller — the UI goes through here).

- ``GET /status`` reports whether the transfer channel exists at all: the
  importer's ``/healthz`` answers only on a recording-PC (split) deploy, so
  ``available`` is the frontend's split-mode signal. ``auto_pull_on_save``
  mirrors the live recording config's opt-in for context.
- ``POST /pull`` queues a pull of one run (``run_id``) or of every finalised
  run (empty body) and relays the importer's 202-style ack. The importer
  serialises pulls and copies only finalised runs, so the call is safe at any
  time; an unreachable importer (single-host deploy) surfaces as the client's
  unified 503 ``importer_unreachable``.

Completion is NOT reported here — the importer ack is fire-and-forget. The
frontend observes it through the runs list: ``bag_local`` flips true once
``metadata.yaml`` lands locally (rsync writes it last, so it is the
"fully imported, never partial" marker).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/transfer", tags=["transfer"])


class TransferPullRequest(BaseModel):
    """Body for ``POST /api/v1/transfer/pull``; no ``run_id`` = all finalised."""

    run_id: str | None = None


@router.get("/status")
async def transfer_status(request: Request) -> dict[str, object]:
    """Whether the pull channel is available + the auto-pull opt-in state."""
    config = request.app.state.recording_config
    return {
        "available": await request.app.state.importer_client.healthz(),
        "auto_pull_on_save": bool(
            config is not None and config.transfer.auto_pull_on_save
        ),
    }


@router.post("/pull", status_code=202)
async def transfer_pull(
    request: Request, body: TransferPullRequest
) -> dict[str, object]:
    """Queue a pull of one run (or all finalised runs) from the robot."""
    ack = await request.app.state.importer_client.pull(body.run_id)
    return {"queued": True, "run_id": body.run_id, **ack}
