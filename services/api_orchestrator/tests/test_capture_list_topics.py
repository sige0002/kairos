"""The capture list carries a topic COUNT, never the topic array (E-27).

``topics`` is per-recording data no list row renders, and it dominates the
page: measured here at 50 captures x 30 topics, a page carrying the arrays is
310,811 bytes against 43,711 without them. So the list serves
:class:`CaptureListItem` and the array stays on the detail.

What the list still owes a client is the one thing a row actually shows about
topics — how many there were. Without ``topics_count`` a console would have to
fetch each capture's detail to render that number, spending a request per row
to undo the saving. These tests pin both halves: the array is absent, the count
is present and correct, and the two can never disagree.
"""

from __future__ import annotations

from api_orchestrator.models import Capture, CaptureTopic, TopicQos
from fastapi.testclient import TestClient
from kairos_common.ids import new_capture_id


def _topics(count: int) -> list[CaptureTopic]:
    """Realistically wide topic rows — name, type and QoS, as recorded."""
    return [
        CaptureTopic(
            name=f"/hsrb/sensor/camera_{i}/image_raw/compressed",
            type="sensor_msgs/msg/CompressedImage",
            qos=TopicQos(reliability="best_effort", durability="volatile", depth=10),
        )
        for i in range(count)
    ]


def _seed(
    client: TestClient, instance_id: str, *, topics: int, captures: int = 1
) -> str:
    store = client.app.state.capture_store
    last = ""
    for index in range(captures):
        last = new_capture_id()
        store.create_capture(
            Capture(
                capture_id=last,
                run_id=f"run_{index:04d}",
                source_instance_id=instance_id,
                state="completed",
                topics=_topics(topics),
            )
        )
    return last


class TestTheListCarriesTheCountNotTheArray:
    def test_a_list_row_has_no_topics_array(
        self, client: TestClient, instance_id: str
    ) -> None:
        _seed(client, instance_id, topics=30)

        item = client.get("/api/v1/captures").json()["items"][0]

        assert "topics" not in item

    def test_a_list_row_reports_how_many_topics_were_captured(
        self, client: TestClient, instance_id: str
    ) -> None:
        _seed(client, instance_id, topics=30)

        item = client.get("/api/v1/captures").json()["items"][0]

        assert item["topics_count"] == 30

    def test_a_recording_with_no_topics_reports_zero(
        self, client: TestClient, instance_id: str
    ) -> None:
        """Zero is a real answer — a failed start records the attempt with no
        topics discovered — and must not read as "unknown"."""
        _seed(client, instance_id, topics=0)

        item = client.get("/api/v1/captures").json()["items"][0]

        assert item["topics_count"] == 0


class TestTheDetailIsUnchanged:
    def test_the_detail_still_serves_every_topic(
        self, client: TestClient, instance_id: str
    ) -> None:
        capture_id = _seed(client, instance_id, topics=30)

        detail = client.get(f"/api/v1/captures/{capture_id}").json()

        assert len(detail["topics"]) == 30
        assert detail["topics"][0]["name"].endswith("/image_raw/compressed")
        assert detail["topics"][0]["type"] == "sensor_msgs/msg/CompressedImage"
        assert detail["topics"][0]["qos"]["reliability"] == "best_effort"

    def test_the_count_can_never_disagree_with_the_array_beside_it(
        self, client: TestClient, instance_id: str
    ) -> None:
        """The list's number and the detail's array describe one recording.

        They are derived from the same field rather than stored separately, so
        a client that reads "30 topics" in the list and opens the row finds
        thirty of them — the failure this pins is the two drifting apart.
        """
        capture_id = _seed(client, instance_id, topics=17)

        listed = client.get("/api/v1/captures").json()["items"][0]
        detail = client.get(f"/api/v1/captures/{capture_id}").json()

        assert listed["topics_count"] == len(detail["topics"]) == 17

    def test_a_supplied_count_cannot_override_the_real_one(self) -> None:
        """Constructing a capture with a wrong count does not produce one.

        The count is derived on the model, so the only way to change it is to
        change the topics — which is what makes the guarantee above hold for
        every path that builds a capture, not just the two the tests exercise.
        """
        capture = Capture(
            capture_id=new_capture_id(),
            state="completed",
            topics=_topics(3),
            topics_count=999,
        )

        assert capture.topics_count == 3


class TestThePageStaysSmall:
    def test_a_page_of_wide_recordings_is_not_dominated_by_topics(
        self, client: TestClient, instance_id: str
    ) -> None:
        """The regression this guards: putting the arrays back.

        50 captures x 30 topics measured 310,811 bytes with the arrays and
        43,711 without. The bound below is deliberately loose — it is here to
        catch the array returning, not to pin a byte count that legitimate
        field additions would trip.
        """
        _seed(client, instance_id, topics=30, captures=50)

        response = client.get("/api/v1/captures?limit=50")
        body = response.json()

        assert len(body["items"]) == 50
        assert all(item["topics_count"] == 30 for item in body["items"])
        assert all("topics" not in item for item in body["items"])
        # With the arrays this page was ~310 KiB; without them ~44 KiB.
        assert len(response.content) < 100_000, (
            f"the capture list grew to {len(response.content)} bytes — "
            "did the topic arrays come back?"
        )
