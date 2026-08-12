# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Contract changes the endurance campaign's cross-cutting findings needed.

Four unrelated defects that all end in the same place — a client forced to
invent something, or a server refusing to say what it knows:

* **an empty plan catalog left Collect with no project or task to send**, and
  the console filled the hole with the ``'—'` placeholder it displays. A
  batch labelled with a dash is a fabricated label in the catalog forever;
  ``null`` is the true statement and the API would not accept it (E-5's tail);
* **``operator``/``task`` on a recording were unbounded**, the one door into
  the views tree that E-11's dataset-side cap could not close, because
  ``list_view_entries`` falls back to the capture's own labels;
* **``episodes_recorded`` came back as 0 after a rebuild** even though the
  recordings themselves say which batch they belong to, so Collect's coverage
  read ``0 / 30`` for a batch with thirty episodes on disk;
* **``GET /api/v1/captures`` capped ``limit`` at 200**, which made Datasets
  page a 5,000-capture store in 26 sequential round trips (E-27).
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import MAX_LABEL_BYTES, DataLayout
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings


def _reopen(settings: Settings, fake_recorder: FakeRecorder) -> TestClient:
    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(
            transport=httpx.MockTransport(fake_recorder.handler)
        ),
    )
    return TestClient(app)


class TestABatchNeedNotBeLabelled:
    """An empty catalog has no project to name, and ``null`` says so."""

    def test_a_batch_can_be_created_with_neither_project_nor_task(
        self, client: TestClient
    ) -> None:
        created = client.post("/api/v1/batches", json={"target_episodes": 5})
        assert created.status_code == 201, created.text
        body = created.json()
        assert body["project"] is None
        assert body["task"] is None

    def test_the_absence_survives_a_rebuild_as_absence(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """Replay must not turn a missing label into an empty string.

        ``batch_created`` omits null fields, so the reader has to distinguish
        "not recorded" from "recorded as blank" — and `''` would render as a
        label that exists and is empty rather than as one nobody set.
        """
        batch_id = client.post("/api/v1/batches", json={"target_episodes": 5}).json()[
            "batch_id"
        ]
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            listed = reopened.get("/api/v1/batches").json()["items"]
            restored = next(b for b in listed if b["batch_id"] == batch_id)
            assert restored["project"] is None
            assert restored["task"] is None

    def test_a_labelled_batch_is_unaffected(self, client: TestClient) -> None:
        """The positive control: this loosens a requirement, nothing else."""
        created = client.post("/api/v1/batches", json={"project": "p", "task": "pick"})
        assert created.status_code == 201, created.text
        assert created.json()["project"] == "p"
        assert created.json()["task"] == "pick"


class TestRecordingLabelsAreBounded:
    """The capture-side door into the views tree (E-11's COALESCE path)."""

    @pytest.mark.parametrize("field", ["operator", "task"])
    @pytest.mark.parametrize("endpoint", ["start", "prepare"])
    def test_an_oversized_label_is_refused_before_recording(
        self, field: str, endpoint: str, client: TestClient
    ) -> None:
        body = {"topics": ["/joint_states"], field: "o" * 10_000}
        response = client.post(f"/api/v1/record/{endpoint}", json=body)
        assert response.status_code == 400, response.text
        error = response.json()["error"]
        assert error["code"] == "label_too_long"
        assert str(MAX_LABEL_BYTES) in error["message"]
        assert error["details"]["field"] == field

    def test_nothing_was_started(
        self, client: TestClient, fake_recorder: FakeRecorder
    ) -> None:
        """Refused BEFORE the recorder is told, not cleaned up afterwards."""
        client.post(
            "/api/v1/record/start",
            json={"topics": ["/joint_states"], "operator": "o" * 10_000},
        )
        assert fake_recorder.state == "idle"
        assert client.get("/api/v1/captures").json()["items"] == []

    def test_a_normal_label_still_records(self, client: TestClient) -> None:
        """The positive control, in the unit that matters: 三バイト文字も通る."""
        started = client.post(
            "/api/v1/record/start",
            json={"topics": ["/joint_states"], "operator": "田中", "task": "掴む"},
        )
        assert started.status_code == 200, started.text
        assert client.post("/api/v1/record/stop").status_code == 200


class TestEpisodesRecordedAfterARebuild:
    """A floor derived from the recordings, and labelled as a floor."""

    def _batch_with_reviews(self, client: TestClient, count: int) -> str:
        batch_id = client.post(
            "/api/v1/batches", json={"project": "p", "task": "pick"}
        ).json()["batch_id"]
        for index in range(1, count + 1):
            started = client.post(
                "/api/v1/record/start", json={"topics": ["/joint_states"]}
            ).json()
            client.post("/api/v1/record/stop")
            saved = client.patch(
                f"/api/v1/captures/{started['capture_id']}/review",
                json={
                    "base_revision": 0,
                    "task_result": "success",
                    "review_status": "adopted",
                    "batch_id": batch_id,
                    "index_in_batch": index,
                },
            )
            assert saved.status_code == 200, saved.text
        return batch_id

    def test_the_counter_is_rebuilt_from_the_recordings(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """It used to come back 0, so Collect read `0 / 30` with three on disk.

        The counter counts review saves, which the ledger does not record — but
        every capture's ``record.json`` names its batch, and the number of them
        is a LOWER BOUND nobody has to guess at. Zero was not a lower bound; it
        was a wrong one.
        """
        batch_id = self._batch_with_reviews(client, 3)
        assert (
            client.get(f"/api/v1/batches/{batch_id}").json()["episodes_recorded"] == 3
        )
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            body = reopened.get(f"/api/v1/batches/{batch_id}").json()
            assert body["episodes_recorded"] == 3

    def test_the_rebuilt_counter_says_it_is_a_floor(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """Machine-readable, because it really can be an undercount.

        A capture reviewed into the batch and later DELETED still incremented
        the live counter, and its record.json is gone — so the rebuilt figure
        can be lower than the true one. Presenting a floor as an exact count is
        the same class of quiet wrongness the counter exists to avoid, and the
        display has to be able to tell the difference.
        """
        batch_id = self._batch_with_reviews(client, 2)
        assert (
            client.get(f"/api/v1/batches/{batch_id}").json()[
                "episodes_recorded_is_floor"
            ]
            is False
        )
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            body = reopened.get(f"/api/v1/batches/{batch_id}").json()
            assert body["episodes_recorded_is_floor"] is True

    def test_a_batch_whose_recordings_are_gone_reads_zero_and_says_so(
        self,
        client: TestClient,
        fake_recorder: FakeRecorder,
        settings: Settings,
        data_dir: Path,
    ) -> None:
        """Nothing on disk to count is still a floor, not a measurement."""
        batch_id = client.post(
            "/api/v1/batches", json={"project": "p", "task": "pick"}
        ).json()["batch_id"]
        client.close()
        (data_dir / "kairos.db").unlink()

        with _reopen(settings, fake_recorder) as reopened:
            body = reopened.get(f"/api/v1/batches/{batch_id}").json()
            assert body["episodes_recorded"] == 0
            assert body["episodes_recorded_is_floor"] is True

    def test_a_live_batch_is_not_marked_as_a_floor(self, client: TestClient) -> None:
        """The positive control: the marker must mean something.

        A marker that were always true would satisfy every assertion above and
        tell the display nothing.
        """
        batch_id = self._batch_with_reviews(client, 1)
        body = client.get(f"/api/v1/batches/{batch_id}").json()
        assert body["episodes_recorded"] == 1
        assert body["episodes_recorded_is_floor"] is False
        listed = client.get("/api/v1/batches").json()["items"]
        assert all(b["episodes_recorded_is_floor"] is False for b in listed)


class TestTheCaptureListPagesInFewerRoundTrips:
    def test_a_thousand_captures_can_be_asked_for_at_once(
        self, client: TestClient, layout: DataLayout, instance_id: str
    ) -> None:
        """E-27 measured 26 sequential round trips over 5,000 captures.

        The default stays 50 — a page an operator waits for should not become a
        5,000-row response — but a client that is deliberately walking the whole
        store may say so.
        """
        from test_batch_index_collision import _seed_capture

        store = client.app.state.capture_store
        for _ in range(3):
            _seed_capture(store, layout, instance_id)

        assert client.get("/api/v1/captures?limit=1000").status_code == 200
        assert client.get("/api/v1/captures?limit=1001").status_code == 422
        # Unchanged: the default is not the maximum.
        assert len(client.get("/api/v1/captures").json()["items"]) == 3
