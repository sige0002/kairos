# SPDX-License-Identifier: Apache-2.0
"""Contract tests for server-side capture search and frozen selections."""

from __future__ import annotations

import threading

from api_orchestrator.models import Capture, CaptureState
from fastapi.testclient import TestClient
from kairos_common import ApiError
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState


def _make_capture(client: TestClient, **changes: object) -> str:
    capture_id = str(changes.pop("capture_id", new_capture_id()))
    defaults: dict[str, object] = {
        "capture_id": capture_id,
        "run_id": f"run_{capture_id}",
        "state": CaptureState.completed,
        "operator": "alice",
        "task": "pick",
        "robot": "robot-a",
        "review_status": "adopted",
        "collection_context": {"condition": "left"},
    }
    defaults.update(changes)
    client.app.state.capture_store.create_capture(Capture(**defaults))  # type: ignore[arg-type]
    client.app.state.capture_store.upsert_replica(
        capture_id, client.app.state.instance_id, ReplicaState.present_unverified
    )
    return capture_id


class TestCaptureSearch:
    def test_searches_and_facets_from_server_rows(self, client: TestClient) -> None:
        wanted = _make_capture(client, operator="Alice", task="Pick")
        _make_capture(client, operator="Alice", task="place")
        _make_capture(client, operator="bob", task="place")

        response = client.post(
            "/api/v1/captures/search",
            json={
                "query": {
                    "predicates": [
                        {"field": "operator", "operator": "equals", "value": "alice"},
                        {"field": "task", "operator": "equals", "value": "pick"},
                    ],
                    "present_on_instance": True,
                },
                "facets": ["task", "operator"],
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert [item["capture_id"] for item in body["items"]] == [wanted]
        assert body["total"] == 1
        assert "topics" not in body["items"][0]
        # A task facet removes only its own predicate, so it truthfully shows
        # the remaining choices under the still-active operator filter.
        assert body["facets"]["task"]["values"] == [
            {"value": "Pick", "count": 1},
            {"value": "place", "count": 1},
        ]

    def test_default_search_hides_tombstones(self, client: TestClient) -> None:
        _make_capture(client, state=CaptureState.deleted)
        visible = _make_capture(client)

        default = client.post("/api/v1/captures/search", json={})
        deleted = client.post(
            "/api/v1/captures/search", json={"query": {"states": ["deleted"]}}
        )

        assert [item["capture_id"] for item in default.json()["items"]] == [visible]
        assert deleted.json()["total"] == 1

    def test_started_range_is_lower_inclusive_upper_exclusive(
        self, client: TestClient
    ) -> None:
        lower = _make_capture(client, started_at="2026-08-01T00:00:00Z")
        same_instant_offset = _make_capture(
            client, started_at="2026-08-01T09:30:00+09:00"
        )
        _make_capture(client, started_at="2026-08-01T01:00:00Z")
        response = client.post(
            "/api/v1/captures/search",
            json={
                "query": {
                    "started_from": "2026-08-01T00:00:00Z",
                    "started_to": "2026-08-01T01:00:00Z",
                }
            },
        )
        naive = client.post(
            "/api/v1/captures/search",
            json={"query": {"started_from": "2026-08-01T00:00:00"}},
        )
        offset = client.post(
            "/api/v1/captures/search",
            json={
                "query": {
                    "started_from": "2026-08-01T09:00:00+09:00",
                    "started_to": "2026-08-01T10:00:00+09:00",
                }
            },
        )

        assert [item["capture_id"] for item in response.json()["items"]] == [
            same_instant_offset,
            lower,
        ]
        assert naive.status_code == 422
        assert [item["capture_id"] for item in offset.json()["items"]] == [
            same_instant_offset,
            lower,
        ]

    def test_context_null_does_not_fall_back_to_batch_condition(
        self, client: TestClient
    ) -> None:
        batch_id = "batch_search"
        from api_orchestrator.models import Batch

        client.app.state.capture_store.create_batch(
            Batch(
                batch_id=batch_id,
                robot="robot-a",
                operator="alice",
                condition="old-batch-condition",
                target_episodes=1,
            )
        )
        _make_capture(client, batch_id=batch_id, collection_context={"condition": None})

        response = client.post(
            "/api/v1/captures/search",
            json={
                "query": {
                    "predicates": [
                        {
                            "field": "condition",
                            "operator": "equals",
                            "value": "old-batch-condition",
                        }
                    ]
                }
            },
        )

        assert response.status_code == 200
        assert response.json()["total"] == 0

    def test_unicode_literal_predicates_and_facet_contract(
        self, client: TestClient
    ) -> None:
        _make_capture(client, operator="\u00c9cole%_\\")

        response = client.post(
            "/api/v1/captures/search",
            json={
                "query": {
                    "predicates": [
                        {
                            "field": "operator",
                            "operator": "contains",
                            "value": "e\u0301cole%_\\",
                        }
                    ]
                },
                "facets": ["capture_id"],
            },
        )

        assert response.status_code == 422
        valid = client.post(
            "/api/v1/captures/search",
            json={
                "query": {
                    "predicates": [
                        {
                            "field": "operator",
                            "operator": "contains",
                            "value": "e\u0301cole%_\\",
                        }
                    ]
                }
            },
        )
        assert valid.status_code == 200
        assert valid.json()["total"] == 1


class TestCaptureSelections:
    def test_selection_excludes_a_capture_created_after_snapshot(
        self, client: TestClient
    ) -> None:
        first = _make_capture(client, operator="alice")
        created = client.post(
            "/api/v1/capture-selections",
            json={
                "query": {
                    "predicates": [
                        {"field": "operator", "operator": "equals", "value": "alice"}
                    ]
                }
            },
        )
        assert created.status_code == 201
        selection_id = created.json()["selection_id"]
        assert created.json()["matched_count"] == 1
        _make_capture(client, operator="alice")

        with client.app.state.capture_store._conn() as conn:  # noqa: SLF001
            items = conn.execute(
                "SELECT capture_id FROM capture_selection_items WHERE selection_id = ?",
                (selection_id,),
            ).fetchall()
        assert [row["capture_id"] for row in items] == [first]
        assert client.app.state.capture_service.selection_capture_ids(selection_id) == [
            first
        ]


class TestDatasetMembershipBulkRuns:
    def test_request_id_is_idempotent_and_background_adds_frozen_items(
        self, client: TestClient
    ) -> None:
        capture_id = _make_capture(client)
        selection_id, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk"}).json()
        payload = {"selection_id": selection_id, "request_id": "request-1"}

        first = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs",
            json=payload,
        )
        second = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs",
            json=payload,
        )

        assert first.status_code == 202
        assert second.status_code == 202
        assert first.json()["run_id"] == second.json()["run_id"]
        detail = client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()
        assert [member["capture_id"] for member in detail["members"]] == [capture_id]
        recipe = detail["selection_recipes"][-1]
        assert recipe["bulk_run_id"] == first.json()["run_id"]
        assert recipe["attempt"] == 1
        assert recipe["cumulative"] is True
        with client.app.state.capture_store._conn() as conn:  # noqa: SLF001
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM dataset_membership_bulk_items "
                    "WHERE run_id = ?",
                    (first.json()["run_id"],),
                ).fetchone()[0]
                == 0
            )

    def test_resume_repairs_membership_ledger_before_marking_existing_success(
        self, client: TestClient
    ) -> None:
        capture_id = _make_capture(client)
        selection_id, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post(
            "/api/v1/datasets", json={"name": "bulk-row-first-crash"}
        ).json()
        store = client.app.state.capture_store
        run = store.create_membership_bulk_run(
            dataset["dataset_id"], selection_id, "row-first-crash"
        )
        # Simulate SIGKILL after the DB row commit and before add_member's
        # lifecycle append.
        member = store.add_dataset_member(dataset["dataset_id"], capture_id)

        client.app.state.dataset_service.run_membership_bulk(run["run_id"])

        completed = store.get_membership_bulk_run(run["run_id"])
        assert completed is not None and completed["state"] == "completed"
        from kairos_common import ledger_v2

        assert any(
            event.get("kind") == "dataset_member_added"
            and event.get("membership_id") == member.membership_id
            and event.get("display_index") == member.display_index
            for event in ledger_v2.dataset_events(
                client.app.state.capture_service._layout.data_dir  # noqa: SLF001
            )
        )

    def test_expired_selection_items_are_collected_after_query_is_copied(
        self, client: TestClient
    ) -> None:
        _make_capture(client)
        store = client.app.state.capture_store
        selection_id, _ = client.app.state.capture_service.create_selection(
            {"states": ["completed"]}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post(
            "/api/v1/datasets", json={"name": "bulk-selection-gc"}
        ).json()
        run = store.create_membership_bulk_run(
            dataset["dataset_id"], selection_id, "selection-gc"
        )
        with store._conn() as conn:  # noqa: SLF001
            conn.execute(
                "UPDATE capture_selections SET expires_at = ? WHERE selection_id = ?",
                ("2000-01-01T00:00:00Z", selection_id),
            )

        client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )

        with store._conn() as conn:  # noqa: SLF001
            assert (
                conn.execute(
                    "SELECT COUNT(*) FROM capture_selection_items "
                    "WHERE selection_id = ?",
                    (selection_id,),
                ).fetchone()[0]
                == 0
            )
        assert store.membership_bulk_query(run["run_id"]) == {"states": ["completed"]}

    def test_receipt_failure_keeps_members_and_can_retry(
        self, client: TestClient, monkeypatch: object
    ) -> None:
        capture_id = _make_capture(client)
        selection_id, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk-receipt"}).json()
        service = client.app.state.dataset_service
        append = service._append  # noqa: SLF001

        def fail_only_receipt(kind: str, *args: object, **kwargs: object) -> None:
            if kind == "dataset_selection_recorded":
                raise ApiError(503, "ledger_unavailable", "receipt append failed")
            append(kind, *args, **kwargs)

        monkeypatch.setattr(service, "_append", fail_only_receipt)
        created = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs",
            json={"selection_id": selection_id, "request_id": "receipt-one"},
        )
        run_id = created.json()["run_id"]
        failed = client.get(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs/{run_id}"
        )
        assert failed.json()["state"] == "failed_receipt"
        assert [
            member["capture_id"]
            for member in client.get(
                f"/api/v1/datasets/{dataset['dataset_id']}"
            ).json()["members"]
        ] == [capture_id]

        monkeypatch.setattr(service, "_append", append)
        retried = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs/"
            f"{run_id}/retry"
        )
        assert retried.status_code == 202
        completed = client.get(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs/{run_id}"
        )
        assert completed.json()["state"] == "completed"
        detail = client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()
        assert len(detail["members"]) == 1
        assert detail["selection_recipes"][-1]["attempt"] == 2

    def test_same_request_id_cannot_change_selection(self, client: TestClient) -> None:
        _make_capture(client)
        first, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        second, _ = client.app.state.capture_service.create_selection(
            {"states": ["completed"]}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk-conflict"}).json()
        base = f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs"
        assert (
            client.post(
                base, json={"selection_id": first, "request_id": "one"}
            ).status_code
            == 202
        )

        conflict = client.post(base, json={"selection_id": second, "request_id": "one"})
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "idempotency_conflict"

    def test_retry_refuses_an_in_progress_run(self, client: TestClient) -> None:
        _make_capture(client)
        selection_id, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk-running"}).json()
        run = client.app.state.capture_store.create_membership_bulk_run(
            dataset["dataset_id"], selection_id, "running-request"
        )
        with client.app.state.capture_store._conn() as conn:  # noqa: SLF001
            conn.execute(
                "UPDATE dataset_membership_bulk_runs SET state = 'running' "
                "WHERE run_id = ?",
                (run["run_id"],),
            )

        response = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs/"
            f"{run['run_id']}/retry"
        )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "bulk_run_not_retryable"

    def test_startup_resume_reclaims_a_running_row(self, client: TestClient) -> None:
        capture_id = _make_capture(client)
        selection_id, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk-resume"}).json()
        run = client.app.state.capture_store.create_membership_bulk_run(
            dataset["dataset_id"], selection_id, "resume-request"
        )
        with client.app.state.capture_store._conn() as conn:  # noqa: SLF001
            conn.execute(
                "UPDATE dataset_membership_bulk_runs SET state = 'running' "
                "WHERE run_id = ?",
                (run["run_id"],),
            )

        client.app.state.dataset_service.resume_pending_membership_bulk_runs()

        resumed = client.get(
            f"/api/v1/datasets/{dataset['dataset_id']}/membership-bulk-runs/"
            f"{run['run_id']}"
        )
        assert resumed.json()["state"] == "completed"
        assert resumed.json()["succeeded"] == 1
        assert (
            client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()["members"][
                0
            ]["capture_id"]
            == capture_id
        )

    def test_stop_releases_pending_work_and_resume_skips_successes(
        self, client: TestClient, monkeypatch: object
    ) -> None:
        first = _make_capture(client)
        second = _make_capture(client)
        selection_id, _ = client.app.state.capture_service.create_selection(
            {}, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk-stop"}).json()
        store = client.app.state.capture_store
        run = store.create_membership_bulk_run(
            dataset["dataset_id"], selection_id, "stop-request"
        )
        service = client.app.state.dataset_service
        first_added = threading.Event()
        release_worker = threading.Event()
        add_member = service.add_member

        def pause_after_first(*args: object, **kwargs: object) -> object:
            member = add_member(*args, **kwargs)
            if not first_added.is_set():
                first_added.set()
                assert release_worker.wait(timeout=2)
            return member

        monkeypatch.setattr(service, "add_member", pause_after_first)
        worker = threading.Thread(
            target=service.run_membership_bulk, args=(run["run_id"],)
        )
        worker.start()
        assert first_added.wait(timeout=2)
        service.request_stop()
        release_worker.set()
        worker.join(timeout=2)

        assert not worker.is_alive()
        assert service.wait_idle(timeout=0.1)
        paused = store.get_membership_bulk_run(run["run_id"])
        assert paused is not None and paused["state"] == "pending"
        assert store.pending_membership_bulk_capture_ids(
            run["run_id"], retry_failed=False
        ) == [second]

        from api_orchestrator.dataset_service import DatasetService

        restarted = DatasetService(
            store,
            client.app.state.capture_service._layout,  # noqa: SLF001
            instance_id=client.app.state.instance_id,
        )
        restarted.resume_pending_membership_bulk_runs()
        finished = store.get_membership_bulk_run(run["run_id"])
        assert finished is not None and finished["state"] == "completed"
        assert [
            member["capture_id"]
            for member in client.get(
                f"/api/v1/datasets/{dataset['dataset_id']}"
            ).json()["members"]
        ] == [first, second]

    def test_startup_records_a_receipt_left_after_membership_commit(
        self, client: TestClient, monkeypatch: object
    ) -> None:
        _make_capture(client, started_at="2026-08-01T00:00:00Z")
        query = {
            "predicates": [
                {"field": "condition", "operator": "equals", "value": "left"}
            ],
            "states": ["completed"],
            "review_statuses": ["adopted"],
            "started_from": "2026-08-01T00:00:00Z",
            "started_to": "2026-08-02T00:00:00Z",
            "present_on_instance": True,
            "exclude_dataset_id": "not-this-dataset",
        }
        selection_id, _ = client.app.state.capture_service.create_selection(
            query, expires_at="2099-01-01T00:00:00Z"
        )
        dataset = client.post("/api/v1/datasets", json={"name": "bulk-crash"}).json()
        store = client.app.state.capture_store
        run = store.create_membership_bulk_run(
            dataset["dataset_id"], selection_id, "crash-receipt"
        )
        service = client.app.state.dataset_service
        monkeypatch.setattr(service, "_record_bulk_receipt", lambda _run: None)
        service.run_membership_bulk(run["run_id"])
        committed = store.get_membership_bulk_run(run["run_id"])
        assert committed is not None and committed["state"] == "completed"
        assert committed["receipt_state"] == "pending"
        # The archive transition may win the small crash/restart window. The
        # public recipe endpoint stays active-only, but its already committed
        # bulk pass must still regain durable provenance on startup.
        with store._conn() as conn:  # noqa: SLF001
            conn.execute(
                "UPDATE datasets SET status = 'archived' WHERE dataset_id = ?",
                (dataset["dataset_id"],),
            )

        from api_orchestrator.dataset_service import DatasetService

        restarted = DatasetService(
            store,
            client.app.state.capture_service._layout,  # noqa: SLF001
            instance_id=client.app.state.instance_id,
        )
        restarted.resume_pending_membership_bulk_runs()
        recovered = store.get_membership_bulk_run(run["run_id"])
        assert recovered is not None and recovered["receipt_state"] == "recorded"
        recipe = client.get(f"/api/v1/datasets/{dataset['dataset_id']}").json()[
            "selection_recipes"
        ][-1]
        assert recipe["selection_query"] == {
            **query,
            "join": "and",
        }
