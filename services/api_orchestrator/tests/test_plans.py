# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared plan catalog (``/api/v1/plans``) — the batch-label vocabulary.

Pins the seed/adopt contract the frontend relies on: a never-set catalog is
``projects: null`` (the client then seeds it), an explicitly emptied one is
``projects: []`` with a timestamp (honored, never re-seeded), and PUT
validates shape + stamps ``updated_at`` server-side.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

CATALOG = {
    "projects": [
        {
            "name": "Tabletop Manipulation",
            "tasks": [
                {
                    "name": "Pick and Place",
                    "conditions": ["Object: Left", "Object: Right"],
                },
                {"name": "Stacking", "conditions": ["Blocks: 3"]},
            ],
        },
        {"name": "Bin Picking", "tasks": []},
    ]
}


def test_get_never_set_is_null(client: TestClient) -> None:
    resp = client.get("/api/v1/plans")
    assert resp.status_code == 200
    assert resp.json() == {
        "projects": None,
        "failure_reasons": None,
        "operators": None,
        "updated_at": None,
    }


def test_put_then_get_round_trips(client: TestClient) -> None:
    put = client.put("/api/v1/plans", json=CATALOG)
    assert put.status_code == 200, put.text
    body = put.json()
    assert body["projects"] == CATALOG["projects"]
    assert body["updated_at"]  # stamped server-side

    got = client.get("/api/v1/plans").json()
    assert got["projects"] == CATALOG["projects"]
    assert got["updated_at"] == body["updated_at"]


def test_put_empty_is_distinct_from_never_set(client: TestClient) -> None:
    client.put("/api/v1/plans", json=CATALOG)
    resp = client.put("/api/v1/plans", json={"projects": []})
    assert resp.status_code == 200
    got = client.get("/api/v1/plans").json()
    # Explicitly emptied: [] with a timestamp — the client must NOT re-seed.
    assert got["projects"] == []
    assert got["updated_at"] is not None


def test_put_rejects_malformed_shapes(client: TestClient) -> None:
    # conditions must be a list of strings, tasks a list of objects.
    bad = {"projects": [{"name": "P", "tasks": [{"name": "T", "conditions": [1]}]}]}
    assert client.put("/api/v1/plans", json=bad).status_code == 422
    assert client.put("/api/v1/plans", json={"projects": "nope"}).status_code == 422
    # A valid catalog normalizes absent fields (tasks/conditions default []).
    ok = client.put("/api/v1/plans", json={"projects": [{"name": "P"}]})
    assert ok.status_code == 200
    assert ok.json()["projects"] == [{"name": "P", "tasks": []}]


def test_failure_reasons_round_trip(client: TestClient) -> None:
    put = client.put(
        "/api/v1/plans",
        json={**CATALOG, "failure_reasons": ["Grasp missed", "Other"]},
    )
    assert put.status_code == 200, put.text
    assert put.json()["failure_reasons"] == ["Grasp missed", "Other"]

    got = client.get("/api/v1/plans").json()
    assert got["failure_reasons"] == ["Grasp missed", "Other"]


def test_put_without_failure_reasons_preserves_stored_vocabulary(
    client: TestClient,
) -> None:
    # A client that predates the field (projects-only PUT) must not wipe it.
    client.put("/api/v1/plans", json={**CATALOG, "failure_reasons": ["Robot fault"]})
    resp = client.put("/api/v1/plans", json=CATALOG)
    assert resp.status_code == 200
    assert resp.json()["failure_reasons"] == ["Robot fault"]
    assert client.get("/api/v1/plans").json()["failure_reasons"] == ["Robot fault"]


def test_failure_reasons_before_first_push_is_null(client: TestClient) -> None:
    # A catalog set before the field existed: projects stored, reasons never set.
    client.put("/api/v1/plans", json=CATALOG)
    got = client.get("/api/v1/plans").json()
    assert got["projects"] == CATALOG["projects"]
    assert got["failure_reasons"] is None


def test_failure_reasons_rejects_non_strings(client: TestClient) -> None:
    bad = {**CATALOG, "failure_reasons": [1, "ok"]}
    assert client.put("/api/v1/plans", json=bad).status_code == 422


def test_operator_roster_rides_the_catalog(client: TestClient) -> None:
    # Attribution roster (NOT auth): same never-set / omitted-keeps semantics
    # as failure_reasons.
    put = client.put("/api/v1/plans", json={**CATALOG, "operators": ["alice", "bob"]})
    assert put.status_code == 200, put.text
    assert put.json()["operators"] == ["alice", "bob"]
    # A projects-only PUT (older client) must not wipe the roster.
    client.put("/api/v1/plans", json=CATALOG)
    assert client.get("/api/v1/plans").json()["operators"] == ["alice", "bob"]
