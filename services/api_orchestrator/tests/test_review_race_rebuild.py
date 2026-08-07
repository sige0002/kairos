"""E-3: the review that lost the CAS must not outlive the winner on disk.

``record.json`` is authoritative and ``kairos.db`` is a disposable index (§4.1-4,
§8), so the two must never disagree about who won a review race. They can, if the
sidecar is written before the compare-and-swap and the loser's write is left
standing: the API answers 409, the winner's decision is in the database, and the
LOSER's decision is the last thing on disk. Drop the index — the documented
recovery — and the refused decision becomes the stored one.

The race needs two *processes*, which is what the CAS is for: the per-capture
mutex in :class:`CaptureService` serializes two saves inside one process, so a
second terminal on the same orchestrator is refused before it writes anything.
Two services over one data directory is that second process, and the interleaving
is forced rather than raced so the test states a fact instead of a probability.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest
from api_orchestrator import captures as captures_mod
from api_orchestrator.captures import CaptureService
from api_orchestrator.health import StoreHealth
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState, ReviewSaveRequest
from api_orchestrator.store import CaptureStore
from kairos_common import ApiError
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    read_record,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import rebuild

# The two decisions. They differ in every persisted field so neither a partial
# write nor a lucky default can make a wrong answer look right.
WINNER = {"review_status": "adopted", "task_result": "success", "quality": "good"}
LOSER = {"review_status": "excluded", "task_result": "failure", "quality": "not_usable"}


def _seed_capture(store: CaptureStore, layout: DataLayout, instance_id: str) -> str:
    """A completed capture, in the catalog and on disk with its manifest.

    The manifest matters: the rebuild at the end of the test reconstructs the
    row from what is beside the capture, and a directory without one is an
    orphan rather than a capture.
    """
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / f"{capture_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n")
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=instance_id,
            run_id=f"run_{capture_id[:13]}",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
            ended_at="2026-08-01T00:01:00.000Z",
            operator="alice",
            task="pick",
            message_count=100,
            bytes=4096,
        ),
    )
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id[:13]}",
            state=CaptureState.completed,
            operator="alice",
            task="pick",
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    return capture_id


def _service(
    store: CaptureStore, layout: DataLayout, instance_id: str
) -> CaptureService:
    """One orchestrator's view of the store — its own locks, its own connection."""
    return CaptureService(store, layout, StoreHealth(), instance_id=instance_id)


async def _race(
    loser: CaptureService, winner: CaptureService, capture_id: str
) -> tuple[Capture, ApiError]:
    """Run the interleaving the CAS exists to arbitrate, deterministically.

    Both terminals read revision 0. The loser passes its revision check and is
    about to write ``record.json`` when the winner's save completes in full —
    sidecar *and* CAS. The loser then writes its own sidecar over the winner's
    and discovers, one statement later, that it lost.

    Every step here is reachable without the hook; the hook only removes the
    scheduling luck, by holding the loser inside the window between its revision
    check and its sidecar write.
    """
    at_the_window = threading.Event()
    winner_committed = threading.Event()
    real_write = captures_mod._write_record_sidecar

    def hooked(capture_dir: Path, record, **kwargs: object) -> None:
        # Identify the loser by the decision it carries: both services call this
        # same module-level function.
        if record.task_result == LOSER["task_result"]:
            at_the_window.set()
            assert winner_committed.wait(timeout=10), "the winner never committed"
        real_write(capture_dir, record, **kwargs)  # type: ignore[arg-type]

    captures_mod._write_record_sidecar = hooked
    try:
        losing = asyncio.create_task(
            loser.save_review(capture_id, ReviewSaveRequest(base_revision=0, **LOSER))
        )
        # The loser's sidecar write runs in a worker thread, so waiting for it
        # here does not block the loop the winner needs.
        assert await asyncio.to_thread(at_the_window.wait, 10), "loser never started"

        saved = await winner.save_review(
            capture_id, ReviewSaveRequest(base_revision=0, **WINNER)
        )
        winner_committed.set()

        with pytest.raises(ApiError) as conflict:
            await losing
    finally:
        captures_mod._write_record_sidecar = real_write
        winner_committed.set()
    return saved, conflict.value


class TestLostReviewRaceSurvivesARebuild:
    def test_the_loser_does_not_leave_its_decision_on_disk(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        store_a = CaptureStore(layout.db, data_dir=data_dir)
        store_b = CaptureStore(layout.db, data_dir=data_dir)
        try:
            capture_id = _seed_capture(store_a, layout, instance_id)
            saved, conflict = asyncio.run(
                _race(
                    _service(store_a, layout, instance_id),
                    _service(store_b, layout, instance_id),
                    capture_id,
                )
            )

            # Exactly one winner: one save returned, one 409.
            assert conflict.status_code == 409
            assert conflict.code == "review_conflict"
            assert saved.review_status == WINNER["review_status"]

            # record.json is what a rebuild will believe, so it must hold the
            # decision the API acknowledged — not the one it refused.
            record = read_record(layout.capture_dir(capture_id)).record
            assert record is not None
            assert record.review_status == WINNER["review_status"]
            assert record.task_result == WINNER["task_result"]
            assert record.quality == WINNER["quality"]
        finally:
            store_a.close()
            store_b.close()

    def test_dropping_the_index_does_not_reinstate_the_refused_decision(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        store_a = CaptureStore(layout.db, data_dir=data_dir)
        store_b = CaptureStore(layout.db, data_dir=data_dir)
        try:
            capture_id = _seed_capture(store_a, layout, instance_id)
            asyncio.run(
                _race(
                    _service(store_a, layout, instance_id),
                    _service(store_b, layout, instance_id),
                    capture_id,
                )
            )
        finally:
            store_a.close()
            store_b.close()

        # §8: throw the index away and rebuild from the sidecars. With no
        # database left there is no `known_revisions` to fall back on, so
        # whatever record.json says becomes the catalog.
        layout.db.unlink()
        rebuilt = CaptureStore(layout.db, data_dir=data_dir)
        try:
            result = rebuild(
                data_dir,
                instance_id=instance_id,
                recorder_reachable=True,
                live_exclusions=set(),
                known_revisions={},
            )
            rebuilt.apply_rebuild(captures=result.captures, replicas=result.replicas)

            capture = rebuilt.get_capture(capture_id)
            assert capture is not None
            assert capture.review_status == WINNER["review_status"]
            assert capture.task_result == WINNER["task_result"]
            assert capture.quality == WINNER["quality"]
        finally:
            rebuilt.close()
