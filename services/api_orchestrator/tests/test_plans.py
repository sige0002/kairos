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
            "project_id": "project-tabletop",
            "name": "Tabletop Manipulation",
            "tasks": [
                {
                    "task_id": "task-pick-place",
                    "name": "Pick and Place",
                    "conditions": [
                        {"condition_id": "condition-left", "name": "Object: Left"},
                        {"condition_id": "condition-right", "name": "Object: Right"},
                    ],
                },
                {
                    "task_id": "task-stacking",
                    "name": "Stacking",
                    "conditions": [
                        {"condition_id": "condition-blocks-3", "name": "Blocks: 3"}
                    ],
                },
            ],
        },
        {"project_id": "project-bin", "name": "Bin Picking", "tasks": []},
    ]
}


EMPTY_SHORTCUTS = {"left": None, "center": None, "right": None}


def canonical_projects(projects: list[dict]) -> list[dict]:
    """The tree as the API returns it: every task carries its shortcut slots."""
    return [
        {
            **project,
            "tasks": [
                {
                    **task,
                    "failure_shortcuts": task.get("failure_shortcuts", EMPTY_SHORTCUTS),
                }
                for task in project.get("tasks", [])
            ],
        }
        for project in projects
    ]


def test_get_never_set_is_null(client: TestClient) -> None:
    resp = client.get("/api/v1/plans")
    assert resp.status_code == 200
    assert resp.json() == {
        "projects": None,
        "failure_reasons": None,
        "operators": None,
        "updated_at": None,
        "revision": 0,
    }


def test_put_then_get_round_trips(client: TestClient) -> None:
    put = client.put("/api/v1/plans", json={"base_revision": 0, **CATALOG})
    assert put.status_code == 200, put.text
    body = put.json()
    assert body["projects"] == canonical_projects(CATALOG["projects"])
    assert body["updated_at"]  # stamped server-side
    assert body["revision"] == 1

    got = client.get("/api/v1/plans").json()
    assert got["projects"] == canonical_projects(CATALOG["projects"])
    assert got["updated_at"] == body["updated_at"]


def test_put_empty_is_distinct_from_never_set(client: TestClient) -> None:
    client.put("/api/v1/plans", json={"base_revision": 0, **CATALOG})
    resp = client.put("/api/v1/plans", json={"base_revision": 1, "projects": []})
    assert resp.status_code == 200
    got = client.get("/api/v1/plans").json()
    # Explicitly emptied: [] with a timestamp — the client must NOT re-seed.
    assert got["projects"] == []
    assert got["updated_at"] is not None


def test_put_rejects_malformed_shapes(client: TestClient) -> None:
    # conditions must be a list of strings, tasks a list of objects.
    bad = {
        "base_revision": 0,
        "projects": [{"name": "P", "tasks": [{"name": "T", "conditions": [1]}]}],
    }
    assert client.put("/api/v1/plans", json=bad).status_code == 422
    assert (
        client.put(
            "/api/v1/plans", json={"base_revision": 0, "projects": "nope"}
        ).status_code
        == 422
    )
    # IDs and canonical condition objects are mandatory in the rollout shape.
    ok = client.put(
        "/api/v1/plans",
        json={"base_revision": 0, "projects": [{"project_id": "p", "name": "P"}]},
    )
    assert ok.status_code == 200
    assert ok.json()["projects"] == [{"project_id": "p", "name": "P", "tasks": []}]


def test_failure_reasons_round_trip(client: TestClient) -> None:
    put = client.put(
        "/api/v1/plans",
        json={
            "base_revision": 0,
            **CATALOG,
            "failure_reasons": ["Grasp missed", "Other"],
        },
    )
    assert put.status_code == 200, put.text
    assert put.json()["failure_reasons"] == ["Grasp missed", "Other"]

    got = client.get("/api/v1/plans").json()
    assert got["failure_reasons"] == ["Grasp missed", "Other"]


def test_put_without_failure_reasons_preserves_stored_vocabulary(
    client: TestClient,
) -> None:
    # A client that predates the field (projects-only PUT) must not wipe it.
    client.put(
        "/api/v1/plans",
        json={"base_revision": 0, **CATALOG, "failure_reasons": ["Robot fault"]},
    )
    resp = client.put("/api/v1/plans", json={"base_revision": 1, **CATALOG})
    assert resp.status_code == 200
    assert resp.json()["failure_reasons"] == ["Robot fault"]
    assert client.get("/api/v1/plans").json()["failure_reasons"] == ["Robot fault"]


def test_failure_reasons_before_first_push_is_null(client: TestClient) -> None:
    # A catalog set before the field existed: projects stored, reasons never set.
    client.put("/api/v1/plans", json={"base_revision": 0, **CATALOG})
    got = client.get("/api/v1/plans").json()
    assert got["projects"] == canonical_projects(CATALOG["projects"])
    assert got["failure_reasons"] is None


def test_failure_reasons_rejects_non_strings(client: TestClient) -> None:
    bad = {"base_revision": 0, **CATALOG, "failure_reasons": [1, "ok"]}
    assert client.put("/api/v1/plans", json=bad).status_code == 422


def test_shared_vocabularies_are_normalized_and_reject_ambiguous_labels(
    client: TestClient,
) -> None:
    normalized = client.put(
        "/api/v1/plans",
        json={
            "base_revision": 0,
            **CATALOG,
            "failure_reasons": ["  Cafe\u0301  "],
            "operators": ["  Alice  "],
        },
    )
    assert normalized.status_code == 200
    assert normalized.json()["failure_reasons"] == ["Café"]
    assert normalized.json()["operators"] == ["Alice"]
    duplicate = client.put(
        "/api/v1/plans",
        json={
            "base_revision": 1,
            **CATALOG,
            "failure_reasons": ["Café", "Cafe\u0301"],
            "operators": ["—"],
        },
    )
    assert duplicate.status_code == 422


def test_operator_roster_rides_the_catalog(client: TestClient) -> None:
    # Attribution roster (NOT auth): same never-set / omitted-keeps semantics
    # as failure_reasons.
    put = client.put(
        "/api/v1/plans",
        json={"base_revision": 0, **CATALOG, "operators": ["alice", "bob"]},
    )
    assert put.status_code == 200, put.text
    assert put.json()["operators"] == ["alice", "bob"]
    # A projects-only PUT (older client) must not wipe the roster.
    client.put("/api/v1/plans", json={"base_revision": 1, **CATALOG})
    assert client.get("/api/v1/plans").json()["operators"] == ["alice", "bob"]


def test_put_requires_a_matching_revision_and_does_not_overwrite(
    client: TestClient,
) -> None:
    assert client.put("/api/v1/plans", json=CATALOG).status_code == 422
    first = client.put("/api/v1/plans", json={"base_revision": 0, **CATALOG})
    assert first.status_code == 200
    changed = {**CATALOG, "projects": [{**CATALOG["projects"][0], "name": "Renamed"}]}
    stale = client.put("/api/v1/plans", json={"base_revision": 0, **changed})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "plans_conflict"
    assert stale.json()["error"]["details"] == {
        "current_revision": 1,
        "base_revision": 0,
    }
    assert client.get("/api/v1/plans").json()["projects"] == canonical_projects(
        CATALOG["projects"]
    )


def test_labels_are_canonicalized_and_invalid_duplicates_are_rejected(
    client: TestClient,
) -> None:
    catalog = {
        "base_revision": 0,
        "projects": [
            {
                "project_id": "p",
                "name": "  Cafe\u0301  ",
                "tasks": [
                    {
                        "task_id": "t",
                        "name": " T ",
                        "conditions": [{"condition_id": "c", "name": " C "}],
                    }
                ],
            }
        ],
    }
    assert (
        client.put("/api/v1/plans", json=catalog).json()["projects"][0]["name"]
        == "Café"
    )
    duplicate = {
        "base_revision": 1,
        "projects": [
            {"project_id": "p1", "name": "P", "tasks": []},
            {"project_id": "p2", "name": "P", "tasks": []},
        ],
    }
    assert client.put("/api/v1/plans", json=duplicate).status_code == 422
    reserved = {
        "base_revision": 1,
        "projects": [{"project_id": "p", "name": "—", "tasks": []}],
    }
    assert client.put("/api/v1/plans", json=reserved).status_code == 422


def test_entity_ids_cannot_be_reused_under_different_parents(
    client: TestClient,
) -> None:
    reused_task = {
        "base_revision": 0,
        "projects": [
            {
                "project_id": "p1",
                "name": "P1",
                "tasks": [{"task_id": "shared-task", "name": "T1", "conditions": []}],
            },
            {
                "project_id": "p2",
                "name": "P2",
                "tasks": [{"task_id": "shared-task", "name": "T2", "conditions": []}],
            },
        ],
    }
    assert client.put("/api/v1/plans", json=reused_task).status_code == 422
    reused_condition = {
        "base_revision": 0,
        "projects": [
            {
                "project_id": "p1",
                "name": "P1",
                "tasks": [
                    {
                        "task_id": "t1",
                        "name": "T1",
                        "conditions": [
                            {"condition_id": "shared-condition", "name": "C1"}
                        ],
                    },
                    {
                        "task_id": "t2",
                        "name": "T2",
                        "conditions": [
                            {"condition_id": "shared-condition", "name": "C2"}
                        ],
                    },
                ],
            }
        ],
    }
    assert client.put("/api/v1/plans", json=reused_condition).status_code == 422


# ---- per-task failure-reason shortcuts (#35) ---------------------------------

SHORTCUTS_CATALOG = {
    "base_revision": 0,
    "failure_reasons": ["Grasp missed", "Object dropped", "Wrong placement", "Other"],
    "projects": [
        {
            "project_id": "project-tabletop",
            "name": "Tabletop Manipulation",
            "tasks": [
                {
                    "task_id": "task-pick-place",
                    "name": "Pick and Place",
                    "conditions": [],
                    "failure_shortcuts": {
                        "left": "Grasp missed",
                        "center": "Object dropped",
                        "right": "Wrong placement",
                    },
                },
                {
                    "task_id": "task-stacking",
                    "name": "Stacking",
                    "conditions": [],
                },
            ],
        }
    ],
}


def test_failure_shortcuts_round_trip_and_survive_reload(client: TestClient) -> None:
    put = client.put("/api/v1/plans", json=SHORTCUTS_CATALOG)
    assert put.status_code == 200, put.text
    got = client.get("/api/v1/plans").json()
    tasks = {t["task_id"]: t for t in got["projects"][0]["tasks"]}
    assert tasks["task-pick-place"]["failure_shortcuts"] == {
        "left": "Grasp missed",
        "center": "Object dropped",
        "right": "Wrong placement",
    }
    # A task without the field loads with all slots unassigned.
    assert tasks["task-stacking"]["failure_shortcuts"] == {
        "left": None,
        "center": None,
        "right": None,
    }


def test_old_payloads_without_shortcuts_stay_valid(client: TestClient) -> None:
    # A catalog written before the field existed must load without intervention.
    client.put("/api/v1/plans", json={"base_revision": 0, **CATALOG})
    got = client.get("/api/v1/plans").json()
    for project in got["projects"]:
        for task in project["tasks"]:
            assert task["failure_shortcuts"] == {
                "left": None,
                "center": None,
                "right": None,
            }
    # And a PUT that still omits the field on tasks remains valid.
    resp = client.put("/api/v1/plans", json={"base_revision": 1, **CATALOG})
    assert resp.status_code == 200, resp.text


def test_failure_reason_vocabulary_is_not_capped_at_three(client: TestClient) -> None:
    reasons = [f"Reason {i}" for i in range(10)]
    put = client.put(
        "/api/v1/plans",
        json={"base_revision": 0, **CATALOG, "failure_reasons": reasons},
    )
    assert put.status_code == 200, put.text
    assert put.json()["failure_reasons"] == reasons


def test_shortcut_slots_may_be_unassigned(client: TestClient) -> None:
    catalog = {
        "base_revision": 0,
        "failure_reasons": ["Grasp missed"],
        "projects": [
            {
                "project_id": "p",
                "name": "P",
                "tasks": [
                    {
                        "task_id": "t",
                        "name": "T",
                        "conditions": [],
                        "failure_shortcuts": {"left": "Grasp missed"},
                    }
                ],
            }
        ],
    }
    resp = client.put("/api/v1/plans", json=catalog)
    assert resp.status_code == 200, resp.text
    assert client.get("/api/v1/plans").json()["projects"][0]["tasks"][0][
        "failure_shortcuts"
    ] == {"left": "Grasp missed", "center": None, "right": None}


def test_shortcut_must_reference_the_submitted_vocabulary(client: TestClient) -> None:
    bad = {
        "base_revision": 0,
        "failure_reasons": ["Grasp missed"],
        "projects": [
            {
                "project_id": "p",
                "name": "P",
                "tasks": [
                    {
                        "task_id": "t",
                        "name": "T",
                        "conditions": [],
                        "failure_shortcuts": {"left": "Not a real reason"},
                    }
                ],
            }
        ],
    }
    resp = client.put("/api/v1/plans", json=bad)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "failure_shortcut_unknown_reason"
    assert resp.json()["error"]["details"]["slot"] == "left"


def test_shortcut_validates_against_stored_vocabulary_when_omitted(
    client: TestClient,
) -> None:
    client.put(
        "/api/v1/plans",
        json={"base_revision": 0, **CATALOG, "failure_reasons": ["Robot fault"]},
    )
    # Omitted failure_reasons keeps the stored list — a shortcut naming
    # something else must be refused, not stored as a stale mapping.
    catalog = {
        "base_revision": 1,
        "projects": [
            {
                "project_id": "p",
                "name": "P",
                "tasks": [
                    {
                        "task_id": "t",
                        "name": "T",
                        "conditions": [],
                        "failure_shortcuts": {"center": "Ghost reason"},
                    }
                ],
            }
        ],
    }
    resp = client.put("/api/v1/plans", json=catalog)
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "failure_shortcut_unknown_reason"


def test_shortcuts_cannot_assign_one_reason_to_two_slots(client: TestClient) -> None:
    bad = {
        "base_revision": 0,
        "failure_reasons": ["Grasp missed"],
        "projects": [
            {
                "project_id": "p",
                "name": "P",
                "tasks": [
                    {
                        "task_id": "t",
                        "name": "T",
                        "conditions": [],
                        "failure_shortcuts": {
                            "left": "Grasp missed",
                            "center": "Grasp missed",
                        },
                    }
                ],
            }
        ],
    }
    resp = client.put("/api/v1/plans", json=bad)
    assert resp.status_code == 422
    assert "failure shortcuts" in resp.text


def test_rename_reason_and_shortcut_in_one_put(client: TestClient) -> None:
    # The client-side integrity story: renaming a reason rewrites the slot
    # that referenced it in the SAME catalog replacement.
    client.put("/api/v1/plans", json=SHORTCUTS_CATALOG)
    renamed = {
        "base_revision": 1,
        "failure_reasons": [
            "Grasp failed",
            "Object dropped",
            "Wrong placement",
            "Other",
        ],
        "projects": [
            {
                "project_id": "project-tabletop",
                "name": "Tabletop Manipulation",
                "tasks": [
                    {
                        "task_id": "task-pick-place",
                        "name": "Pick and Place",
                        "conditions": [],
                        "failure_shortcuts": {
                            "left": "Grasp failed",
                            "center": "Object dropped",
                            "right": "Wrong placement",
                        },
                    },
                    {
                        "task_id": "task-stacking",
                        "name": "Stacking",
                        "conditions": [],
                        "failure_shortcuts": {
                            "left": None,
                            "center": None,
                            "right": None,
                        },
                    },
                ],
            }
        ],
    }
    resp = client.put("/api/v1/plans", json=renamed)
    assert resp.status_code == 200, resp.text
    tasks = {t["task_id"]: t for t in resp.json()["projects"][0]["tasks"]}
    assert tasks["task-pick-place"]["failure_shortcuts"]["left"] == "Grasp failed"
