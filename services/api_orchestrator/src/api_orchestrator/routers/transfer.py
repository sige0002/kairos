"""Transfer endpoints (``/api/v1/transfer``) — pulling captures off the robot.

In the cross-host split the recorder writes MCAP on the ROBOT's disk and the
recording PC copies finished captures over through the importer sidecar
(``deploy/sync/``, defined only in ``compose/recording.yaml``; it binds
127.0.0.1, so the orchestrator is its only caller — the UI goes through here).

§10.6 rekeys this to ``capture_id``. Two consequences worth stating:

* Completion is still not reported here — the importer ack is fire-and-forget.
  What the frontend watches instead is the capture's **replica state**, which
  flips to ``present_unverified`` once the reconciler adopts the arrived
  directory. The v1 ``bag_local`` boolean is gone: it could only say "here" or
  "not here", and could not distinguish a copy that never arrived from one that
  was deliberately deleted.
* The importer stages under ``.incoming/<capture_id>`` and the orchestrator
  moves it into ``objects/`` with one ``os.replace``, so a capture visible under
  ``objects/`` is never a partial copy (§2).
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/v1/transfer", tags=["transfer"])


class TransferPullRequest(BaseModel):
    """Body for ``POST /api/v1/transfer/pull``.

    No ``capture_id`` means "pull every finished capture" — forwarded to the
    importer as its explicit ``{"all": true}`` opt-in (an empty body is a 400
    on that side, so a sweep is always a deliberate request).
    """

    capture_id: str | None = None


@router.get("/status")
async def transfer_status(request: Request) -> dict[str, object]:
    """Whether the pull channel exists at all, plus the auto-pull opt-in.

    The importer's ``/healthz`` answers only on a recording-PC (split) deploy,
    so ``available`` doubles as the frontend's split-mode signal.
    """
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
    """Queue a pull of one capture (or all finished ones) from the robot."""
    ack = await request.app.state.importer_client.pull(body.capture_id)
    return {"queued": True, "capture_id": body.capture_id, **ack}


@router.get("/pull/{capture_id}")
async def transfer_pull_status(request: Request, capture_id: str) -> dict[str, object]:
    """One capture's pull state: ``queued → running → ok | failed`` (S3-1).

    The 202 from ``POST /pull`` lands before the importer has touched ssh, so
    it can never be the completion signal — and a pull whose rsync died used
    to be invisible outside the importer's container log, leaving the UI
    saying "Transferring…" forever. Arrival is still confirmed by the replica
    state; THIS is the failure channel. 404 = no pull known (importer restart
    loses the in-memory view; the replica state remains the durable answer).
    """
    return await request.app.state.importer_client.pull_status(capture_id)
