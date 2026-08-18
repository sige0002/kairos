# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""E-27: the capture list must not carry what the list does not render.

Every row of ``GET /api/v1/captures`` used to carry that capture's full topic
array. Measured at the adopted scale (5,000 captures x 100 topics): **2.3 MiB
for one 200-row page**, 86-91% of a single item's JSON, and on the frontend
side 59.8 MiB transferred and 73-141 MiB of heap for screens that render none
of it.

It is a memory-and-bandwidth change and nothing else. The frontend measured
settle time before and after (4,438 -> 4,288 ms): unchanged, because the wall
clock there is 26 sequential round trips, not bytes. Anyone who measures this
expecting the screen to appear sooner will conclude it did nothing.

``GET /api/v1/captures/{id}`` still carries topics — the one screen that reads
them (Review's inspection panel) fetches the detail.
"""

from __future__ import annotations

import json

from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState, CaptureTopic
from fastapi.testclient import TestClient
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _capture(client: TestClient, layout: DataLayout, *, topics: int) -> str:
    store = client.app.state.capture_store
    capture_id = new_capture_id()
    layout.capture_dir(capture_id).mkdir(parents=True, exist_ok=True)
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id[:13]}",
            state=CaptureState.completed,
            operator="alice",
            task="pick",
            started_at="2026-08-01T00:00:00.000Z",
            topics=[
                CaptureTopic(
                    name=f"/hsrb/sensor/camera_{i:03d}/image_raw/compressed",
                    type="sensor_msgs/msg/CompressedImage",
                )
                for i in range(topics)
            ],
        )
    )
    store.upsert_replica(
        capture_id, client.app.state.instance_id, ReplicaState.present_unverified
    )
    return capture_id


# Bytes a row may gain purely from the DIGITS of ``topics_count`` ("0" vs
# "100"). Deliberately far below what any per-topic payload would cost: 100
# topics is thousands of bytes, so nothing real can hide under this bound.
_COUNT_DIGITS_HEADROOM = 8


class TestTheListDoesNotCarryTopics:
    def test_a_list_item_does_not_grow_with_the_topic_count(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The invariant, stated so it survives the field being re-added.

        Not "there is no `topics` key" — that is one spelling of the problem.
        A list row must not grow with how many topics the recording had, by
        any name, or the page size becomes a property of the robot's topic
        count rather than of the page.

        The row does carry ``topics_count``, which grows with the DIGITS of
        that number — ``0`` to ``100`` is two bytes. That is the distinction
        this bound draws: a handful of bytes for a number is fine, and any row
        actually carrying per-topic data is larger by thousands.
        """
        bare = _capture(client, layout, topics=0)
        loaded = _capture(client, layout, topics=100)

        items = client.get("/api/v1/captures").json()["items"]
        by_id = {item["capture_id"]: item for item in items}
        assert set(by_id) == {bare, loaded}

        # Same shape, so any size difference is the topics and nothing else.
        sizes = {
            capture_id: len(json.dumps(item, sort_keys=True))
            for capture_id, item in by_id.items()
        }
        growth = sizes[loaded] - sizes[bare]
        assert growth <= _COUNT_DIGITS_HEADROOM, (
            f"the 100-topic row is {growth} bytes larger "
            "than the 0-topic row — the list is carrying per-topic data"
        )
        assert "topics" not in by_id[loaded]
        assert by_id[loaded]["topics_count"] == 100
        assert by_id[bare]["topics_count"] == 0

    def test_the_detail_still_carries_them(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """Dropped from the list, kept where something actually reads them."""
        capture_id = _capture(client, layout, topics=100)

        detail = client.get(f"/api/v1/captures/{capture_id}").json()

        assert len(detail["topics"]) == 100
        assert detail["topics"][0]["name"].startswith("/hsrb/sensor/camera_000")
        assert detail["topics"][0]["type"] == "sensor_msgs/msg/CompressedImage"
