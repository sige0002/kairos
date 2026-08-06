"""Bag import under interruption and contention (the E-15 follow-ups).

Three of the listed cases were already pinned elsewhere and are not repeated
here — a bag still being written is
``TestBagImport::test_a_bag_without_metadata_is_rejected_with_a_remedy``
(``ros2 bag record`` writes ``metadata.yaml`` only on a clean shutdown, so
"still recording" IS "no metadata.yaml"); a source that moved between the scan
and the click is
``test_a_source_that_vanished_after_the_scan_fails_that_bag_only``; and the
sweep of an abandoned partial is
``test_an_abandoned_partial_is_swept_and_the_others_are_not``.

What is left is what those do not reach:

* the sweep is exercised on a **running** orchestrator. A kill mid-copy is
  followed by a *restart*, and §8 lets that restart rebuild the catalog from
  what is on disk — a different reader, walking the same partial;
* nothing drives the copy semaphore with more bags than it has slots;
* the duplicate-import guard is in-flight only, and "in flight" is not the
  window two browsers actually race in.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.store import CaptureExistsError
from conftest import FakeRecorder, reconcile
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.capture_sidecars import ObjectManifestV2, write_object_manifest
from kairos_common.ids import new_capture_id
from test_transfer_import import _await_import, _make_bag


def _restart(
    data_dir: Path, fake_recorder: FakeRecorder, *, drop_db: bool
) -> TestClient:
    """A second orchestrator process over the same data dir.

    ``drop_db`` is §8's documented recovery ("delete kairos.db and restart"),
    which is also what a schema change does — so it is the reader most likely
    to meet debris nobody recorded.
    """
    if drop_db:
        (data_dir / "kairos.db").unlink(missing_ok=True)
    settings = Settings(
        data_dir=str(data_dir),
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
    )
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


class TestAKillDuringTheCopy:
    """`.incoming/<id>` is bytes nobody has a row for. Nothing may adopt it."""

    def _partial(self, layout: DataLayout, *, age_s: float) -> tuple[str, Path]:
        """Staging as a killed copy leaves it: bag bytes, no manifest.

        The manifest is written LAST precisely so this state is
        distinguishable, so omitting it is the whole point rather than a
        shortcut.
        """
        capture_id = new_capture_id()
        staging = layout.incoming_dir(capture_id)
        staging.mkdir(parents=True)
        (staging / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"half" * 64)
        (staging / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
        stale = time.time() - age_s
        import os

        for path in sorted(staging.rglob("*")) + [staging]:
            os.utime(path, (stale, stale))
        return capture_id, staging

    def test_a_restart_that_rebuilds_does_not_turn_the_partial_into_a_capture(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        """The half the running-process sweep test cannot cover.

        A rebuild reconstructs the catalog by walking the store, and an
        unfinished import holds a readable bag and a ``metadata.yaml``. If the
        walk reached into ``.incoming`` it would mint a capture for bytes whose
        copy never finished — the completed-looking short recording that the
        staging directory exists to prevent.
        """
        with _restart(data_dir, fake_recorder, drop_db=False) as client:
            layout: DataLayout = client.app.state.data_layout
            capture_id, staging = self._partial(layout, age_s=7200)

        with _restart(data_dir, fake_recorder, drop_db=True) as client:
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404
            listed = client.get("/api/v1/captures?include_deleted=true").json()
            assert listed["items"] == []
            # Still there: a rebuild is a reader. Reclaiming the space is the
            # reconciler's job and it has its own grace period.
            assert staging.is_dir()

            reconcile(client)
            assert not staging.exists()
            assert client.get(f"/api/v1/captures/{capture_id}").status_code == 404


class TestMoreBagsThanCopySlots:
    def test_forty_bags_all_land_and_the_registry_agrees_with_the_catalog(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """The bulk run under ``_COPY_SLOTS`` (2), which is what I-1 installed.

        The progress the dialog shows is the registry; the captures are the
        catalog. A queued import that is dropped, double-counted or left
        ``running`` forever shows up as those two disagreeing — which is the
        assertion, rather than "no exception was raised".
        """
        bags = 40
        queued = []
        for index in range(bags):
            source = tmp_path / "bulk" / f"bag_{index:03d}"
            _make_bag(source)
            response = client.post("/api/v1/imports", json={"source_path": str(source)})
            assert response.status_code == 202, response.text
            queued.append(response.json())

        assert len({q["capture_id"] for q in queued}) == bags

        for record in queued:
            status = _await_import(client, record["import_id"])
            assert status["state"] == "succeeded", status

        imports = client.get("/api/v1/imports").json()["imports"]
        assert len(imports) == bags
        assert {i["state"] for i in imports} == {"succeeded"}

        captures = client.get(f"/api/v1/captures?limit={bags + 10}").json()["items"]
        assert len(captures) == bags
        assert {c["capture_id"] for c in captures} == {q["capture_id"] for q in queued}


class TestARejectedCatalogRow:
    """The insert can fail. It must never be reported as an import that worked."""

    def test_a_refused_row_is_not_reported_as_a_successful_import(
        self, client: TestClient, layout: DataLayout, tmp_path: Path, monkeypatch
    ) -> None:
        """``create_capture`` raises ``CaptureExistsError`` for ANY unique clash.

        It was swallowed as "the id was just minted, so this cannot happen" —
        true of ``capture_id`` and false of ``run_id``, which is UNIQUE as
        well. The result was an import that said "succeeded" with no row in
        Review and a replica pointing at a capture that did not exist.

        The bytes really are on disk by this point, so the report has to be
        I-5's shape — the files are here, the catalog is behind — rather than
        either "succeeded" or "nothing arrived".
        """
        store = client.app.state.capture_store
        real_create = store.create_capture

        def refuse(capture):  # type: ignore[no-untyped-def]
            raise CaptureExistsError(capture.capture_id)

        source = tmp_path / "refused"
        _make_bag(source)
        monkeypatch.setattr(store, "create_capture", refuse)
        queued = client.post(
            "/api/v1/imports", json={"source_path": str(source)}
        ).json()
        status = _await_import(client, queued["import_id"])

        assert status["state"] == "failed", status
        assert status["error"]["code"] == "import_catalog_pending"
        # And it says the truth about the bytes: they are in objects/.
        assert layout.capture_dir(queued["capture_id"]).is_dir()

        # The recovery it promises actually works.
        monkeypatch.setattr(store, "create_capture", real_create)
        reconcile(client)
        assert client.get(f"/api/v1/captures/{queued['capture_id']}").status_code == 200


class TestAStoreThatAlreadyHasDuplicateRunIds:
    """Recovery for installs the run_id collision already damaged.

    Fixing the allocator stops NEW duplicates. It does nothing for a store
    where a bulk import already wrote several captures carrying one display
    name — and there the damage is not the names, it is that
    ``apply_rebuild`` raised ``UNIQUE constraint failed: captures.run_id`` and
    took the whole reconcile pass with it. That pass is also the incoming
    sweep, the trash reaper and the views prune, so every one of them stopped.
    """

    def test_a_duplicate_display_name_does_not_stop_the_reconcile_pass(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        # Debris the SAME pass is supposed to collect, at the far end of
        # ``run_once`` (the sweep is the last step, the rebuild is in the
        # middle). Its removal is the proof that the pass ran to completion
        # rather than merely that nothing was raised where the test could see.
        abandoned = layout.incoming_dir(new_capture_id())
        abandoned.mkdir(parents=True)
        (abandoned / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n")
        stale = time.time() - 7200
        for path in [*abandoned.rglob("*"), abandoned]:
            os.utime(path, (stale, stale))

        shared = "imported_20260806_101010"
        ids = []
        for index in range(3):
            capture_id = new_capture_id()
            capture_dir = layout.capture_dir(capture_id)
            capture_dir.mkdir(parents=True)
            (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 64)
            (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
            write_object_manifest(
                capture_dir,
                ObjectManifestV2(
                    capture_id=capture_id,
                    source_instance_id=client.app.state.instance_id,
                    run_id=shared,
                    state="completed",
                    started_at="2026-08-06T10:10:10.000Z",
                    ended_at="2026-08-06T10:11:10.000Z",
                    message_count=3,
                    bytes=72,
                    imported_from=f"/somewhere/bag_{index}",
                ),
            )
            ids.append(capture_id)

        # The pass completes rather than raising, which is the whole assertion:
        # before the guard this was an unhandled IntegrityError out of every
        # reconcile from here on.
        reconcile(client)

        landed = [
            cid
            for cid in ids
            if client.get(f"/api/v1/captures/{cid}").status_code == 200
        ]
        # One can hold the name; the others are skipped and logged, not merged
        # into it and not silently renamed.
        assert len(landed) == 1
        # The pass reached its final step. Before the guard it died at the
        # rebuild, so this staging directory — and the trash reaper, and the
        # views prune — were never reached again on any pass.
        assert not abandoned.exists()


class TestTwoBrowsersImportingOneFolder:
    """One source bag is one capture (I-4/I-5). The guard has to cover the
    whole window, not only the part where a copy is still running."""

    def test_a_second_browser_cannot_reimport_a_bag_the_first_one_finished(
        self, client: TestClient, tmp_path: Path
    ) -> None:
        """The window two browsers actually race in.

        Both scanned the folder while it was importable. The first browser's
        bulk run finishes bag N. The second browser then reaches bag N in its
        own run — and ``import_already_running`` cannot fire, because nothing
        is running any more. ``already_imported`` is checked only by the scan,
        whose answer the second browser took before any of this happened.

        The result was a second capture over the same bytes: two rows, two
        capture ids, one source, and nothing afterwards to say which is which.
        """
        source = tmp_path / "shared"
        _make_bag(source)

        first = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert first.status_code == 202
        assert _await_import(client, first.json()["import_id"])["state"] == "succeeded"

        second = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert second.status_code == 409, second.text
        error = second.json()["error"]
        assert error["code"] == "already_imported"
        # Naming the holder, like ``import_already_running`` and
        # ``destination_claimed`` do: "refused" without the incumbent leaves an
        # operator unable to go and look at what they already have.
        assert error["details"]["capture_id"] == first.json()["capture_id"]

        captures = client.get("/api/v1/captures").json()["items"]
        assert len(captures) == 1

    def test_a_bag_whose_capture_was_deleted_can_be_imported_again(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        """The positive control: the refusal must be about the BYTES being here.

        Deleting the capture removes ``objects/<id>`` and with it the manifest
        the check reads, so the source stops being "already imported". A guard
        keyed on anything more durable would strand an operator who deleted a
        bag and wants it back — with no way to undo, since the source is the
        only remaining copy.
        """
        source = tmp_path / "again"
        _make_bag(source)
        first = client.post("/api/v1/imports", json={"source_path": str(source)})
        capture_id = first.json()["capture_id"]
        assert _await_import(client, first.json()["import_id"])["state"] == "succeeded"

        deleted = client.post(
            f"/api/v1/captures/{capture_id}/delete",
            json={"kind": "delete", "reason": "wrong bag"},
        )
        assert deleted.status_code == 200, deleted.text
        for _ in range(20):
            if not layout.capture_dir(capture_id).exists():
                break
            reconcile(client)
            time.sleep(0.01)
        assert not layout.capture_dir(capture_id).exists()

        again = client.post("/api/v1/imports", json={"source_path": str(source)})
        assert again.status_code == 202, again.text
        assert again.json()["capture_id"] != capture_id
