# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""E-27: the batch list carries a count, not every episode of every batch.

``GET /api/v1/batches`` bundled a compact row for every capture of every batch:
817 KiB and 71.5 ms at 50 batches x 100 captures, with **one query per batch**
to build it. The detail endpoint already serves the full captures, so the list
was carrying a second, lossier copy of data it did not need.

Not paginated instead, deliberately. ``CoverageCard`` calls this unfiltered and
aggregates every batch to compute per-condition coverage — a default ``limit``
would silently truncate a total that is displayed as complete, which is the
failure this campaign keeps closing. Small and whole beats paged and quietly
short.
"""

from __future__ import annotations

from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Batch, Capture, CaptureState
from fastapi.testclient import TestClient
from kairos_common.ids import new_capture_id

BATCHES = 5
PER_BATCH = 20


def _seed(client: TestClient, layout: DataLayout) -> None:
    store = client.app.state.capture_store
    for b in range(BATCHES):
        batch_id = f"b_{b:04d}"
        store.create_batch(Batch(batch_id=batch_id, project="p", task="pick"))
        for i in range(PER_BATCH):
            capture_id = new_capture_id()
            layout.capture_dir(capture_id).mkdir(parents=True, exist_ok=True)
            store.create_capture(
                Capture(
                    capture_id=capture_id,
                    run_id=f"run_{b}_{i}",
                    state=CaptureState.completed,
                    started_at="2026-08-01T00:00:00.000Z",
                    batch_id=batch_id,
                    index_in_batch=i + 1,
                )
            )


class TestTheBatchListIsACount:
    def test_the_list_does_not_carry_every_episode(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        _seed(client, layout)

        body = client.get("/api/v1/batches").json()

        assert len(body["items"]) == BATCHES
        for item in body["items"]:
            # The count is what the list is for, and it still counts.
            assert item["episode_count"] == PER_BATCH
            assert "episodes" not in item, (
                "the list is still carrying a row per capture; the detail "
                "endpoint already serves those"
            )
        # Nothing is truncated: an aggregation over this list is complete.
        assert {item["batch_id"] for item in body["items"]} == {
            f"b_{b:04d}" for b in range(BATCHES)
        }

    def test_one_query_serves_every_batch_count(
        self, client: TestClient, layout: DataLayout, monkeypatch
    ) -> None:
        """A count per batch was a query per batch — N+1 behind the payload."""
        from api_orchestrator.store import CaptureStore

        _seed(client, layout)
        calls = {"n": 0}
        real = CaptureStore.list_captures_by_batch

        def counting(self, batch_id):
            calls["n"] += 1
            return real(self, batch_id)

        monkeypatch.setattr(CaptureStore, "list_captures_by_batch", counting)

        client.get("/api/v1/batches")

        assert calls["n"] == 0, (
            f"{calls['n']} per-batch capture queries for {BATCHES} batches — "
            "the list is still walking each batch's captures"
        )

    def test_the_detail_still_serves_the_captures(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        _seed(client, layout)

        detail = client.get("/api/v1/batches/b_0000").json()

        assert detail["episode_count"] == PER_BATCH
        assert len(detail["captures"]) == PER_BATCH
        assert detail["captures"][0]["index_in_batch"] == 1
