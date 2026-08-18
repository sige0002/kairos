# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""``GET /api/v1/batches/coverage`` — per-condition totals aggregated in SQL.

Collect's Coverage card used to fetch every batch and add them up in the
browser. E-27 measured that at 817 KiB every 30 seconds with 5000 batches, and
recorded why paging the list cannot fix it: a total computed from one page is
silently short, and a truncated number presented as complete is the failure
E-27 exists to forbid. So the SUM moved to where the rows are.

What the endpoint promises, and what these tests pin:

* ``recorded`` is the sum of the batches' monotone ``episodes_recorded``, and
  ``is_floor`` is true if ANY term of that sum is a floor — the same semantics
  the card computed client-side (§8.2 rule 6).
* Only conditions actually OBSERVED appear. Unioning in a task's planned
  conditions as zero rows stays the caller's job: the plan catalog is a
  client-side vocabulary, and a server inventing rows for it would be
  reporting a plan rather than a measurement.
* The aggregate never reads the batch list — which is the entire point.
"""

from __future__ import annotations

from api_orchestrator.models import Batch
from api_orchestrator.store import CaptureStore
from fastapi.testclient import TestClient


def _batch(
    store: CaptureStore,
    batch_id: str,
    *,
    task: str | None = "pick",
    condition: str | None = "daylight",
    project: str | None = None,
    project_id: str | None = None,
    task_id: str | None = None,
    condition_id: str | None = None,
    robot: str | None = None,
    operator: str | None = None,
    created_at: str | None = None,
    recorded: int = 0,
    floor: bool = False,
) -> str:
    """A batch whose counter reads *recorded*, via the real store paths.

    ``episodes_recorded`` is only ever moved by two methods, so the fixtures
    use them rather than writing the columns directly: ``rebuild_...`` is what
    marks a counter as a floor (a rebuild can only count the recordings still
    on disk), and ``increment_...`` is the review save. Rebuilding first and
    incrementing after is also the real sequence for a floor batch that kept
    recording — the flag stays set because the earlier part of the sum is
    still unknowable.
    """
    store.create_batch(
        Batch(
            batch_id=batch_id,
            task=task,
            condition=condition,
            project=project,
            project_id=project_id,
            task_id=task_id,
            condition_id=condition_id,
            robot=robot,
            operator=operator,
            created_at=created_at,
        )
    )
    if floor:
        store.rebuild_episodes_recorded(batch_id)
    for _ in range(recorded):
        store.increment_episodes_recorded(batch_id)
    return batch_id


def _rows(client: TestClient, task: str = "pick") -> list[dict]:
    response = client.get("/api/v1/batches/coverage", params={"task": task})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["task"] == task
    # Existing callers only relied on these three fields. Keep their contract
    # test separate from the additive canonical condition id below.
    return [
        {name: value for name, value in row.items() if name != "condition_id"}
        for row in body["rows"]
    ]


class TestTheAggregate:
    def test_a_task_nobody_has_recorded_is_an_empty_aggregate(
        self, client: TestClient
    ) -> None:
        """No rows — not an error. Nothing recorded is a real, sayable answer."""
        assert _rows(client, "never-run") == []

    def test_totals_sum_every_batch_of_a_condition(self, client: TestClient) -> None:
        store = client.app.state.capture_store
        _batch(store, "b1", condition="daylight", recorded=3)
        _batch(store, "b2", condition="daylight", recorded=4)
        _batch(store, "b3", condition="night", recorded=2)

        assert _rows(client) == [
            {"condition": "daylight", "recorded": 7, "is_floor": False},
            {"condition": "night", "recorded": 2, "is_floor": False},
        ]

    def test_rows_are_ordered_by_condition_so_a_merge_is_stable(
        self, client: TestClient
    ) -> None:
        """The caller unions its plan vocabulary in; an unstable order would
        reshuffle the card between polls for no reason."""
        store = client.app.state.capture_store
        for index, condition in enumerate(["night", "daylight", "rain"]):
            _batch(store, f"b{index}", condition=condition, recorded=1)

        assert [row["condition"] for row in _rows(client)] == [
            "daylight",
            "night",
            "rain",
        ]


class TestTheFloorFlagPropagates:
    def test_one_rebuilt_batch_makes_the_whole_total_a_floor(
        self, client: TestClient
    ) -> None:
        """A sum is a lower bound as soon as one term is.

        There is no way to say which part of the total is uncertain, so the
        flag rides on the sum rather than on the batch — the operator reads
        the total, not the batches behind it.
        """
        store = client.app.state.capture_store
        _batch(store, "solid", condition="daylight", recorded=5)
        _batch(store, "rebuilt", condition="daylight", recorded=2, floor=True)

        assert _rows(client) == [
            {"condition": "daylight", "recorded": 7, "is_floor": True}
        ]

    def test_a_floor_does_not_leak_into_a_neighbouring_condition(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        _batch(store, "rebuilt", condition="night", recorded=1, floor=True)
        _batch(store, "solid", condition="daylight", recorded=1)

        assert _rows(client) == [
            {"condition": "daylight", "recorded": 1, "is_floor": False},
            {"condition": "night", "recorded": 1, "is_floor": True},
        ]


class TestWhatIsExcluded:
    def test_only_the_named_task_is_counted(self, client: TestClient) -> None:
        """Totals for different tasks are unrelated work; adding them up would
        answer a question nobody asked."""
        store = client.app.state.capture_store
        _batch(store, "pick1", task="pick", condition="daylight", recorded=3)
        _batch(store, "place1", task="place", condition="daylight", recorded=9)

        assert _rows(client, "pick") == [
            {"condition": "daylight", "recorded": 3, "is_floor": False}
        ]
        assert _rows(client, "place") == [
            {"condition": "daylight", "recorded": 9, "is_floor": False}
        ]

    def test_a_batch_with_no_condition_is_not_a_condition(
        self, client: TestClient
    ) -> None:
        """NULL, empty, and the console's display dash all mean "unset".

        The dash is in the data because a console that had to send SOMETHING
        once wrote its placeholder into the catalog as a real value (E-5).
        Counting it would report a condition named after the absence of one,
        which is the same guard the card's client-side ``bump`` applied.
        """
        store = client.app.state.capture_store
        _batch(store, "null_cond", condition=None, recorded=4)
        _batch(store, "empty_cond", condition="", recorded=5)
        _batch(store, "dash_cond", condition="—", recorded=6)
        _batch(store, "real_cond", condition="daylight", recorded=1)

        assert _rows(client) == [
            {"condition": "daylight", "recorded": 1, "is_floor": False}
        ]

    def test_task_is_required(self, client: TestClient) -> None:
        """422, not a cross-task total. If one is ever wanted it gets its own
        endpoint rather than arriving by omission."""
        assert client.get("/api/v1/batches/coverage").status_code == 422
        assert client.get("/api/v1/batches/coverage?task=").status_code == 422
        assert client.get("/api/v1/batches/coverage?task_id=").status_code == 422

    def test_scope_trims_values_and_rejects_whitespace_axes(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        _batch(store, "trimmed", task="pick", robot="myrobot", recorded=1)
        response = client.get(
            "/api/v1/batches/coverage",
            params={"task": " pick ", "robot": " myrobot "},
        )
        assert response.status_code == 200, response.text
        assert response.json()["scope"]["task"] == "pick"
        assert response.json()["scope"]["robot"] == "myrobot"
        for axis in ("project", "project_id", "task", "task_id", "robot", "operator"):
            assert (
                client.get(
                    "/api/v1/batches/coverage",
                    params={"task": "pick", axis: "   "},
                ).status_code
                == 422
            )


class TestItReallyAggregatesInSql:
    def test_coverage_never_reads_the_batch_list(self, client: TestClient) -> None:
        """The whole point: reading every row to add up a handful of numbers is
        the cost this endpoint exists to remove."""
        store = client.app.state.capture_store
        _batch(store, "b1", condition="daylight", recorded=3)
        _batch(store, "b2", condition="night", recorded=1)

        def _forbidden(*_args: object, **_kwargs: object) -> list[Batch]:
            raise AssertionError(
                "coverage must aggregate with SQL GROUP BY, not read the list"
            )

        store.list_batches = _forbidden  # type: ignore[method-assign]
        try:
            assert _rows(client) == [
                {"condition": "daylight", "recorded": 3, "is_floor": False},
                {"condition": "night", "recorded": 1, "is_floor": False},
            ]
        finally:
            del store.list_batches

    def test_coverage_is_not_shadowed_by_the_batch_id_route(
        self, client: TestClient
    ) -> None:
        """Routes match in registration order, so ``/coverage`` has to be
        declared before ``/{batch_id}`` — otherwise this asks for a batch
        called "coverage" and gets a 404."""
        response = client.get("/api/v1/batches/coverage", params={"task": "pick"})

        assert response.status_code == 200
        assert "rows" in response.json()


class TestScopedCoverage:
    def test_all_requested_axes_are_anded_and_ids_group_conditions(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        common = {
            "project": "project-a",
            "project_id": "project-a-id",
            "task": "pick",
            "task_id": "pick-id",
            "condition": "dry",
            "condition_id": "dry-id",
            "robot": "myrobot",
            "operator": "operator-a",
            "created_at": "2026-08-01T00:00:00.000Z",
        }
        _batch(store, "matching", recorded=3, **common)
        _batch(
            store,
            "wrong-robot",
            recorded=9,
            robot="otherrobot",
            **{key: value for key, value in common.items() if key != "robot"},
        )
        _batch(
            store,
            "wrong-condition-id",
            recorded=5,
            condition_id="other-id",
            **{key: value for key, value in common.items() if key != "condition_id"},
        )

        response = client.get(
            "/api/v1/batches/coverage",
            params={
                "project_id": "project-a-id",
                "project": "project-a",
                "task_id": "pick-id",
                "task": "pick",
                "robot": "myrobot",
                "operator": "operator-a",
                "created_from": "2026-08-01T00:00:00Z",
                "created_to": "2026-08-02T00:00:00Z",
            },
        )

        assert response.status_code == 200, response.text
        assert response.json()["scope"] == {
            "project_id": "project-a-id",
            "project": "project-a",
            "task_id": "pick-id",
            "task": "pick",
            "robot": "myrobot",
            "operator": "operator-a",
            "created_from": "2026-08-01T00:00:00.000Z",
            "created_to": "2026-08-02T00:00:00.000Z",
        }
        assert response.json()["rows"] == [
            {
                "condition": "dry",
                "condition_id": "dry-id",
                "recorded": 3,
                "is_floor": False,
            },
            {
                "condition": "dry",
                "condition_id": "other-id",
                "recorded": 5,
                "is_floor": False,
            },
        ]

    def test_range_is_half_open_and_rejects_non_utc_or_reversed_values(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        _batch(
            store,
            "at-start",
            recorded=2,
            created_at="2026-08-01T00:00:00.000Z",
        )
        _batch(
            store,
            "at-end",
            recorded=7,
            created_at="2026-08-02T00:00:00.000Z",
        )
        response = client.get(
            "/api/v1/batches/coverage",
            params={
                "task": "pick",
                "created_from": "2026-08-01T00:00:00Z",
                "created_to": "2026-08-02T00:00:00Z",
            },
        )
        assert response.status_code == 200
        assert response.json()["rows"][0]["recorded"] == 2
        assert (
            client.get(
                "/api/v1/batches/coverage",
                params={"task": "pick", "created_from": "2026-08-01T00:00:00+09:00"},
            ).status_code
            == 422
        )
        assert (
            client.get(
                "/api/v1/batches/coverage",
                params={
                    "task": "pick",
                    "created_from": "2026-08-02T00:00:00Z",
                    "created_to": "2026-08-01T00:00:00Z",
                },
            ).status_code
            == 422
        )

    def test_canonical_task_id_can_scope_a_legacy_name_less_request(
        self, client: TestClient
    ) -> None:
        store = client.app.state.capture_store
        _batch(store, "identified", task="pick", task_id="pick-id", recorded=4)
        response = client.get("/api/v1/batches/coverage", params={"task_id": "pick-id"})
        assert response.status_code == 200
        assert response.json()["task"] is None
        assert response.json()["rows"][0]["recorded"] == 4
