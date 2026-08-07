"""C2: ``GET /api/v1/batches`` takes an optional page, and still serves the lot.

E-27 shrank this response by moving the per-capture rows out of it, and recorded
a deliberate refusal to paginate: ``CoverageCard`` calls the endpoint unfiltered
and aggregates every batch, so a **default** limit would silently truncate a
total displayed as complete. At 5000 batches the remaining payload was still
817 KiB every 30 seconds, which is the cost this page window exists to let a
caller opt out of.

The refusal is intact and these tests pin it: with no ``limit`` the response is
the whole list in the same order it always had. Nothing is truncated unless the
caller asked for a window, and a caller that asks gets ``total`` so it can tell
that it has one.
"""

from __future__ import annotations

from api_orchestrator.models import Batch
from fastapi.testclient import TestClient

BATCHES = 12


def _seed(client: TestClient, count: int = BATCHES) -> list[str]:
    """Create *count* batches and return their ids newest-first.

    The list orders by insertion sequence descending, so the last batch created
    is the first one served.
    """
    store = client.app.state.capture_store
    ids = [f"b_{i:04d}" for i in range(count)]
    for batch_id in ids:
        store.create_batch(Batch(batch_id=batch_id, project="p", task="pick"))
    return list(reversed(ids))


def _ids(body: dict) -> list[str]:
    return [item["batch_id"] for item in body["items"]]


class TestTheDefaultIsStillEverything:
    def test_no_limit_serves_every_batch_in_the_order_it_always_had(
        self, client: TestClient
    ) -> None:
        newest_first = _seed(client)

        body = client.get("/api/v1/batches").json()

        assert _ids(body) == newest_first, (
            "the unpaginated list changed; every existing caller — including "
            "Collect's active-batch restore, which looks for one specific "
            "batch and cannot find it on page two — depends on the whole list"
        )

    def test_an_explicit_offset_of_zero_alone_is_still_everything(
        self, client: TestClient
    ) -> None:
        # offset without limit is a legal request and must not become a page:
        # SQLite has no OFFSET without a LIMIT, so this is the branch that
        # rides on ``LIMIT -1`` and could quietly bound the result instead.
        newest_first = _seed(client)

        body = client.get("/api/v1/batches", params={"offset": 0}).json()

        assert _ids(body) == newest_first


class TestTheWindow:
    def test_limit_serves_the_newest_page(self, client: TestClient) -> None:
        newest_first = _seed(client)

        body = client.get("/api/v1/batches", params={"limit": 5}).json()

        assert _ids(body) == newest_first[:5]

    def test_offset_walks_the_pages_with_no_gap_and_no_overlap(
        self, client: TestClient
    ) -> None:
        newest_first = _seed(client)

        walked: list[str] = []
        for offset in range(0, BATCHES, 5):
            page = client.get(
                "/api/v1/batches", params={"limit": 5, "offset": offset}
            ).json()
            walked.extend(_ids(page))

        assert walked == newest_first, (
            "paging over the whole list did not reproduce it exactly; a gap "
            "loses batches and an overlap double-counts them"
        )

    def test_an_offset_past_the_end_is_an_empty_page_not_an_error(
        self, client: TestClient
    ) -> None:
        _seed(client)

        response = client.get(
            "/api/v1/batches", params={"limit": 5, "offset": BATCHES + 100}
        )

        assert response.status_code == 200
        assert response.json()["items"] == []

    def test_a_limit_larger_than_the_list_is_the_whole_list(
        self, client: TestClient
    ) -> None:
        newest_first = _seed(client)

        body = client.get("/api/v1/batches", params={"limit": 500}).json()

        assert _ids(body) == newest_first

    def test_the_window_is_applied_in_sql_not_by_slicing_afterwards(
        self, client: TestClient, monkeypatch
    ) -> None:
        """A page that reads 5000 rows to return 5 is not a page.

        Counting row conversions is the proxy: with ``LIMIT`` in the statement
        only the page's rows come back to be converted, whereas fetching
        everything and slicing converts the lot.
        """
        from api_orchestrator.store import CaptureStore

        _seed(client)
        converted = {"n": 0}
        real = CaptureStore._batch_from_row

        def counting(row):
            converted["n"] += 1
            return real(row)

        monkeypatch.setattr(CaptureStore, "_batch_from_row", staticmethod(counting))

        client.get("/api/v1/batches", params={"limit": 3})

        assert converted["n"] == 3, (
            f"{converted['n']} rows were read to serve a page of 3; the whole "
            "table is still being loaded before the window is applied"
        )


class TestTheTotal:
    def test_total_counts_the_whole_list_not_the_page(self, client: TestClient) -> None:
        _seed(client)

        body = client.get("/api/v1/batches", params={"limit": 3}).json()

        assert len(body["items"]) == 3
        assert body["total"] == BATCHES, (
            "total reported the page rather than the list, so a caller cannot "
            "tell whether there is more to fetch"
        )

    def test_the_filters_scope_the_total_as_well_as_the_page(
        self, client: TestClient
    ) -> None:
        # A total that ignored the filter would claim there is more to fetch
        # under a filter that has already served everything it matches.
        store = client.app.state.capture_store
        for i in range(4):
            store.create_batch(Batch(batch_id=f"act_{i}", status="active"))
        for i in range(6):
            store.create_batch(Batch(batch_id=f"done_{i}", status="completed"))

        body = client.get(
            "/api/v1/batches", params={"status": "completed", "limit": 2}
        ).json()

        assert len(body["items"]) == 2
        assert body["total"] == 6


class TestOutOfRangeValuesAreRefused:
    def test_a_limit_below_one_is_rejected(self, client: TestClient) -> None:
        assert client.get("/api/v1/batches", params={"limit": 0}).status_code == 422
        assert client.get("/api/v1/batches", params={"limit": -1}).status_code == 422

    def test_a_limit_above_the_ceiling_is_rejected(self, client: TestClient) -> None:
        from api_orchestrator.routers.batches import MAX_LIMIT

        ok = client.get("/api/v1/batches", params={"limit": MAX_LIMIT})
        too_big = client.get("/api/v1/batches", params={"limit": MAX_LIMIT + 1})

        assert ok.status_code == 200
        assert too_big.status_code == 422, (
            "an unbounded limit is a denial-of-service knob on an endpoint "
            "whose whole point is that the response can get large"
        )

    def test_a_negative_offset_is_rejected(self, client: TestClient) -> None:
        assert client.get("/api/v1/batches", params={"offset": -1}).status_code == 422

    def test_a_non_numeric_value_is_rejected(self, client: TestClient) -> None:
        assert client.get("/api/v1/batches", params={"limit": "all"}).status_code == 422
