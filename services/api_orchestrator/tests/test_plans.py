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
    assert resp.json() == {"projects": None, "updated_at": None}


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
