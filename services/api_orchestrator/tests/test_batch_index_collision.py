# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""E-7: two tabs in one batch must not both get episode #1.

``index_in_batch`` is what the strip chip, the Review row and every
``episode #N`` in a delete dialog read, and the contract
(`api_orchestrator.md`, batch section) is explicit about who owns it:

    ``index_in_batch`` はクライアントのヒントで、衝突時（複数端末が同番号を
    採番）はサーバーがロック下で再採番し実際に保存した値を応答で返す。

The hint really is only a hint. Collect computes it as ``recordedCount + 1``
from its OWN state (`useBatchMachine.ts`), so a second tab joined to the same
batch — or the same tab after a reload that lost a save — offers a number the
first tab already used. Nothing about the two requests is unusual: different
captures, so the per-capture mutex never sees a contest, and there is no unique
index on ``(batch_id, index_in_batch)``.

Four things have to hold, and each is a separate way to get this wrong:

* a hinted number nobody holds is **kept** (a server that renumbers everything
  would satisfy "no duplicates" and be useless);
* two tabs offering one number end up with two numbers;
* that stays true when the two saves **interleave**, which they do for real —
  ``save_review`` awaits its sidecar write in a worker thread, so a second
  request runs its own compose step inside that window;
* ``record.json`` carries the number the row kept, because §8 rebuilds the
  catalog from the sidecars and a file left holding the hint would put the
  duplicate back.
"""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path

import pytest
from api_orchestrator import captures as captures_mod
from api_orchestrator.captures import CaptureService
from api_orchestrator.health import StoreHealth
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState, ReviewSaveRequest
from api_orchestrator.store import CaptureStore
from fastapi.testclient import TestClient
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    read_record,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import rebuild

BATCH = "batch_20260806_120000"


def _seed_capture(store: CaptureStore, layout: DataLayout, instance_id: str) -> str:
    """A completed capture on disk and in the catalog, with no review yet."""
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


def _claim(index: int) -> ReviewSaveRequest:
    """What Collect's Save sends: a batch, a hinted number, a verdict."""
    return ReviewSaveRequest(
        base_revision=0,
        task_result="success",
        review_status="adopted",
        batch_id=BATCH,
        index_in_batch=index,
    )


def _numbers(store: CaptureStore) -> list[int | None]:
    return [c.index_in_batch for c in store.list_captures_by_batch(BATCH)]


class TestOneNumberPerEpisode:
    def test_a_hinted_number_nobody_holds_is_kept(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """The positive control: the server is not free to renumber at will.

        Without this, "no duplicates" is satisfied by a server that ignores the
        hint entirely and hands out its own numbers — which would silently move
        every episode away from the number the operator watched appear on the
        strip.
        """
        store = CaptureStore(layout.db, data_dir=data_dir)
        try:
            service = _service(store, layout, instance_id)
            first = _seed_capture(store, layout, instance_id)
            second = _seed_capture(store, layout, instance_id)

            saved_first = asyncio.run(service.save_review(first, _claim(1)))
            saved_second = asyncio.run(service.save_review(second, _claim(2)))

            assert saved_first.index_in_batch == 1
            assert saved_second.index_in_batch == 2
        finally:
            store.close()

    def test_two_tabs_claiming_one_number_do_not_both_get_it(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """The adopted scenario: a second tab's stale count offers a used number."""
        store = CaptureStore(layout.db, data_dir=data_dir)
        try:
            service = _service(store, layout, instance_id)
            first = _seed_capture(store, layout, instance_id)
            second = _seed_capture(store, layout, instance_id)

            saved_first = asyncio.run(service.save_review(first, _claim(1)))
            saved_second = asyncio.run(service.save_review(second, _claim(1)))

            # The first tab keeps the number it showed; the second is told, in
            # its own response, what it actually got.
            assert saved_first.index_in_batch == 1
            assert saved_second.index_in_batch != 1
            assert saved_second.index_in_batch is not None
            # And the response is the truth, not a hopeful echo.
            assert store.get_capture(second).index_in_batch == (
                saved_second.index_in_batch
            )
            assert sorted(_numbers(store)) == [1, 2]
        finally:
            store.close()

    def test_a_deleted_episodes_number_is_not_handed_out_again(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """A discarded capture keeps its number; the gap is not backfilled.

        #2 is still what the ledger line, the operator's notes and any archived
        folder call that episode, so reissuing it would make "#2" ambiguous
        across the batch's own history — the rule E-29 settled for the dataset
        display index. A stale tab offering 2 therefore lands above the
        high-water mark, leaving a hole rather than a second #2.

        The tombstone is created through the delete path rather than by writing
        a state column, so this tracks whatever "deleted" actually means.
        """
        store = CaptureStore(layout.db, data_dir=data_dir)
        try:
            service = _service(store, layout, instance_id)
            keep = _seed_capture(store, layout, instance_id)
            doomed = _seed_capture(store, layout, instance_id)
            asyncio.run(service.save_review(keep, _claim(1)))
            asyncio.run(service.save_review(doomed, _claim(2)))
            asyncio.run(service.delete(doomed, kind="delete", reason="a mistake"))
            # The premise: #2 is gone from the live roster.
            assert sorted(_numbers(store)) == [1]

            latecomer = _seed_capture(store, layout, instance_id)
            saved = asyncio.run(service.save_review(latecomer, _claim(2)))
            assert saved.index_in_batch == 3
        finally:
            store.close()

    def test_the_sidecar_carries_the_number_the_row_kept(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """§8 rebuilds from ``record.json``, so the file must not keep the hint.

        A renumber that lives only in the database is undone by the documented
        recovery: delete the index, restart, and the duplicate is back.
        """
        store = CaptureStore(layout.db, data_dir=data_dir)
        try:
            service = _service(store, layout, instance_id)
            first = _seed_capture(store, layout, instance_id)
            second = _seed_capture(store, layout, instance_id)
            asyncio.run(service.save_review(first, _claim(1)))
            saved_second = asyncio.run(service.save_review(second, _claim(1)))

            record = read_record(layout.capture_dir(second)).record
            assert record is not None
            assert record.index_in_batch == saved_second.index_in_batch
            # The restamp must not invent a revision the client did not get.
            assert record.revision == saved_second.review_revision
        finally:
            store.close()

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
            assert sorted(_numbers(rebuilt)) == [1, 2]
        finally:
            rebuilt.close()


class TestTheSavesInterleave:
    """The window is real: ``save_review`` suspends at its sidecar write.

    ``await asyncio.to_thread(_write_record_sidecar, ...)`` is a suspension
    point on the one event loop that serves both requests, so a second PATCH
    genuinely runs its read-and-compose step while the first is between
    composing and committing. A renumber decided at compose time is therefore
    decided against a catalog that is about to change, and both requests pick
    the same free number.

    The hook below only removes the scheduling luck; every step it forces is
    reachable without it.
    """

    def test_a_forced_interleaving_still_produces_two_numbers(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        store = CaptureStore(layout.db, data_dir=data_dir)
        try:
            service = _service(store, layout, instance_id)
            held = _seed_capture(store, layout, instance_id)
            passer = _seed_capture(store, layout, instance_id)

            saved = asyncio.run(_interleaved(service, service, held, passer))
            assert sorted(v.index_in_batch for v in saved) == [1, 2]
            assert sorted(_numbers(store)) == [1, 2]
        finally:
            store.close()

    def test_two_orchestrators_on_one_data_dir_do_not_both_hand_out_one(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """The same interleaving across processes, where no in-process lock helps.

        Two ``CaptureStore``/``CaptureService`` pairs over one ``kairos.db`` are
        the second orchestrator (the E-3 construction). Their locks are separate
        objects, so nothing in this process serializes them.

        This ordering is settled before either reaches the database, so it does
        not on its own prove where the number comes from — the narrower window
        below is what does that.
        """
        store_a = CaptureStore(layout.db, data_dir=data_dir)
        store_b = CaptureStore(layout.db, data_dir=data_dir)
        try:
            held = _seed_capture(store_a, layout, instance_id)
            passer = _seed_capture(store_a, layout, instance_id)
            saved = asyncio.run(
                _interleaved(
                    _service(store_a, layout, instance_id),
                    _service(store_b, layout, instance_id),
                    held,
                    passer,
                )
            )
            assert sorted(v.index_in_batch for v in saved) == [1, 2]
            assert sorted(_numbers(store_a)) == [1, 2]
        finally:
            store_a.close()
            store_b.close()

    def test_a_second_process_cannot_read_the_roster_mid_allocation(
        self, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """The window that only the database can close: scan against scan.

        Two orchestrators both look at the batch, both see #1 free, and both
        then write it. Nothing in this process can prevent that — each
        ``CaptureStore`` has its own lock — so the allocation has to hold the
        database's write lock across the scan and the update, which is what
        ``BEGIN IMMEDIATE`` in ``save_review_cas`` is for.

        The construction: A is parked *inside* its allocation, having taken that
        lock. B then runs. If B can read the roster while A holds it, B sees #1
        free and both captures end up as #1. If it cannot, B waits for A's
        commit and allocates above it.

        The sleep only gives B time to get as far as it is able to; it is not
        what makes the result deterministic. With the guard removed B gets all
        the way through and the assertion below fails on ``[1, 1]``.
        """
        store_a = CaptureStore(layout.db, data_dir=data_dir)
        store_b = CaptureStore(layout.db, data_dir=data_dir)
        in_allocation = threading.Event()
        b_started = threading.Event()
        release_a = threading.Event()
        real_free_index = CaptureStore._free_index
        saved: dict[str, Capture] = {}

        def hooked(conn, capture_id, *, batch_id, hint):  # type: ignore[no-untyped-def]
            value = real_free_index(conn, capture_id, batch_id=batch_id, hint=hint)
            if capture_id == first:
                in_allocation.set()
                assert release_a.wait(timeout=10), "A was never released"
            return value

        # Each save gets its own thread and its own event loop: the parked one
        # blocks synchronously inside the store, so a driver sharing its loop
        # could never wake up to release it.
        def save(tag: str, store: CaptureStore, capture_id: str) -> None:
            service = _service(store, layout, instance_id)
            saved[tag] = asyncio.run(service.save_review(capture_id, _claim(1)))

        first = _seed_capture(store_a, layout, instance_id)
        second = _seed_capture(store_a, layout, instance_id)

        def run_b() -> None:
            b_started.set()
            save("b", store_b, second)

        a = threading.Thread(target=save, args=("a", store_a, first))
        b = threading.Thread(target=run_b)
        try:
            CaptureStore._free_index = staticmethod(hooked)  # type: ignore[method-assign]
            a.start()
            assert in_allocation.wait(timeout=10), "A never reached its allocation"
            b.start()
            assert b_started.wait(timeout=10)
            # Long enough for B to reach its own scan if anything lets it.
            time.sleep(0.3)
            release_a.set()
            a.join(timeout=10)
            b.join(timeout=10)
            assert not a.is_alive() and not b.is_alive()

            assert saved["a"].index_in_batch == 1
            assert saved["b"].index_in_batch == 2
            assert sorted(_numbers(store_a)) == [1, 2]
        finally:
            CaptureStore._free_index = staticmethod(real_free_index)  # type: ignore[method-assign]
            release_a.set()
            a.join(timeout=10)
            b.join(timeout=10)
            store_a.close()
            store_b.close()


async def _interleaved(
    holder: CaptureService,
    passer_service: CaptureService,
    held: str,
    passer: str,
) -> tuple[Capture, Capture]:
    """Both saves claim #1; the first is parked at its sidecar write.

    ``held`` reaches ``_write_record_sidecar`` and stops there. ``passer`` then
    runs its whole save — read, compose, sidecar, commit — and takes #1. Only
    then does ``held`` continue, so its own commit happens against a catalog in
    which #1 is gone.
    """
    at_the_window = threading.Event()
    passer_committed = threading.Event()
    real_write = captures_mod._write_record_sidecar

    def hooked(capture_dir: Path, record, **kwargs: object) -> None:
        if record.capture_id == held:
            at_the_window.set()
            assert passer_committed.wait(timeout=10), "the passer never committed"
        real_write(capture_dir, record, **kwargs)  # type: ignore[arg-type]

    captures_mod._write_record_sidecar = hooked
    try:
        holding = asyncio.create_task(holder.save_review(held, _claim(1)))
        # The sidecar write runs in a worker thread, so waiting on it here does
        # not block the loop the passer needs.
        assert await asyncio.to_thread(at_the_window.wait, 10), "holder never started"

        passed = await passer_service.save_review(passer, _claim(1))
        passer_committed.set()
        return await holding, passed
    finally:
        captures_mod._write_record_sidecar = real_write
        passer_committed.set()


class TestThroughTheApi:
    def test_the_second_tabs_response_names_the_number_it_actually_got(
        self, client: TestClient, data_dir: Path, layout: DataLayout, instance_id: str
    ) -> None:
        """End to end over HTTP, against a batch the API created.

        Collect adopts the number from the response
        (`api_orchestrator.md`: クライアントは応答値を採用する), so a body that
        echoes the rejected hint is the failure the operator sees — two strip
        chips reading "#1".
        """
        store: CaptureStore = client.app.state.capture_store
        created = client.post(
            "/api/v1/batches",
            json={"project": "p", "task": "pick", "target_episodes": 5},
        )
        assert created.status_code == 201
        batch_id = created.json()["batch_id"]

        first = _seed_capture(store, layout, instance_id)
        second = _seed_capture(store, layout, instance_id)
        body = {
            "base_revision": 0,
            "task_result": "success",
            "review_status": "adopted",
            "batch_id": batch_id,
            "index_in_batch": 1,
        }
        one = client.patch(f"/api/v1/captures/{first}/review", json=body)
        two = client.patch(f"/api/v1/captures/{second}/review", json=body)
        assert one.status_code == 200, one.text
        assert two.status_code == 200, two.text
        assert one.json()["index_in_batch"] == 1
        assert two.json()["index_in_batch"] == 2

        detail = client.get(f"/api/v1/batches/{batch_id}")
        assert detail.status_code == 200
        numbers = [c["index_in_batch"] for c in detail.json()["captures"]]
        assert sorted(numbers) == [1, 2]


@pytest.mark.parametrize("hint", [0, 7])
def test_a_batchless_or_unhinted_save_is_left_alone(
    hint: int, data_dir: Path, layout: DataLayout, instance_id: str
) -> None:
    """Nothing here may start numbering captures that asked for no number.

    A save with no ``batch_id`` has nowhere for a number to mean anything, and
    a save that omits ``index_in_batch`` is not offering a hint at all — the
    Review screen's edits are exactly that. Both must come back unnumbered.
    """
    store = CaptureStore(layout.db, data_dir=data_dir)
    try:
        service = _service(store, layout, instance_id)
        batchless = _seed_capture(store, layout, instance_id)
        saved = asyncio.run(
            service.save_review(
                batchless,
                ReviewSaveRequest(
                    base_revision=0, task_result="success", index_in_batch=hint
                ),
            )
        )
        assert saved.batch_id is None
        assert saved.index_in_batch == hint

        unhinted = _seed_capture(store, layout, instance_id)
        saved = asyncio.run(
            service.save_review(
                unhinted,
                ReviewSaveRequest(
                    base_revision=0, task_result="failure", batch_id=BATCH
                ),
            )
        )
        assert saved.index_in_batch is None
    finally:
        store.close()
