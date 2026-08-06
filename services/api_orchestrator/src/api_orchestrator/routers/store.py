"""Store health, reconciliation and views regeneration.

Contract §8 (rebuild reporting), §9-3 (SUSPECT and Repair) and §6 (views).
These endpoints exist because the store's two worst conditions are invisible in
an ordinary capture list:

* a rebuild that could not parse some manifests — those captures have no row at
  all (§8 rule 4 forbids inventing one), so they cannot appear in a list;
* a reconciler pass that refused to apply itself because too many copies
  vanished at once — the catalog then looks *normal* while the disk is not.

``GET /api/v1/store/health`` is where both become visible without reading logs,
and ``POST /api/v1/store/repair`` is the operator acknowledgement that clears
SUSPECT. Repair deliberately re-checks the volume marker first: §9-3 requires
that an approval given while the volume is unidentifiable be refused, because
"yes, those really are gone" cannot be meant about a disk nobody can confirm.
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from kairos_common import ApiError

from api_orchestrator import layout as layout_mod
from api_orchestrator import views as views_mod
from api_orchestrator.models import StoreHealth

router = APIRouter(prefix="/api/v1/store", tags=["store"])
views_router = APIRouter(prefix="/api/v1/views", tags=["store"])


@router.get("/health", response_model=StoreHealth)
async def store_health(request: Request) -> StoreHealth:
    """What the catalog knows about its own condition."""
    return StoreHealth.model_validate(request.app.state.store_health.snapshot())


@router.post("/reconcile")
async def reconcile(request: Request) -> dict[str, Any]:
    """Run a reconciliation pass now and report what it did.

    The same pass the background loop runs. Exposed so an operator who just
    fixed a mount does not have to wait out the interval, and so tests can drive
    it deterministically instead of sleeping.
    """
    result = await request.app.state.reconciler.run_once()
    return result.to_dict()


@router.post("/repair")
async def repair(request: Request) -> dict[str, Any]:
    """Clear SUSPECT after an operator confirms the storage is as it appears.

    Refused while the volume marker is unreadable (§9-3): the latch exists
    precisely because a vanished volume is indistinguishable from vanished
    files, and an approval that cannot name the volume it is approving is not
    an approval.
    """
    health = request.app.state.store_health
    layout = request.app.state.data_layout
    if layout_mod.read_volume_marker(layout) is None:
        raise ApiError(
            status_code=409,
            code="volume_unidentified",
            message=(
                "The data volume has no readable marker, so it cannot be "
                "confirmed as the one the catalog describes. Check that the "
                "storage is mounted, then repair again."
            ),
        )
    health.clear_suspect()
    # ``approved`` is what the operator just supplied: the threshold guard was
    # withholding a decision pending a human, and this is the human. Re-running
    # the ordinary pass instead would hit the same threshold and re-latch,
    # making Repair a button that does nothing.
    result = await request.app.state.reconciler.run_once(approved=True)
    return {"repaired": True, "reconcile": result.to_dict()}


@views_router.post("/refresh")
async def refresh_views(request: Request) -> dict[str, Any]:
    """Regenerate the ``views/`` symlink tree from committed memberships (§6).

    The orchestrator owns this tree; dora_runner asks rather than writing. The
    rebuild is a generation directory plus one atomic symlink flip, so ``views``
    never stops resolving and no reader ever sees a half-built tree.

    Off the loop, like the background refresher's own call: regeneration is a
    filesystem walk that now waits behind whichever regeneration is already
    running, and doing either of those on the event loop would stall every
    other request — including, on a bad day, the one holding the lock.
    """
    store = request.app.state.capture_store
    layout = request.app.state.data_layout
    result = await asyncio.to_thread(
        views_mod.regenerate, layout, store.list_view_entries()
    )
    return result.to_dict()
