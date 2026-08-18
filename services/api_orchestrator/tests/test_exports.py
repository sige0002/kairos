# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""LeRobot export endpoints (§6.2): snapshot, leases, proxy, ledger record.

The exporter itself is faked at the HTTP boundary — these tests are about the
orchestrator's half: what it refuses, what it snapshots, which leases it holds,
and what it writes to the ledger when it first sees success.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings, ledger_v2
from kairos_common.capture_sidecars import RecordV2, write_record
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState

EXPORTER_PORT = 8040


class FakeExporter:
    """HTTP stand-in for lerobot_exporter: profiles, intake, scripted status."""

    def __init__(self) -> None:
        self.present = True
        self.profiles: list[dict[str, Any]] = []
        self.received: dict[str, dict[str, Any]] = {}
        self.status: dict[str, dict[str, Any]] = {}
        self.canceled: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if not self.present:
            raise httpx.ConnectError("no exporter on this deployment")
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/profiles":
            return httpx.Response(200, json={"profiles": self.profiles})
        if path == "/exports" and request.method == "POST":
            payload = json.loads(request.content)
            export_id = payload["export_id"]
            self.received[export_id] = payload
            self.status.setdefault(
                export_id,
                {
                    "state": "queued",
                    "queue_position": 0,
                    "done": 0,
                    "failed": 0,
                    "total": len(payload["episodes"]),
                },
            )
            return httpx.Response(202, json={"export_id": export_id})
        if path.startswith("/exports/") and path.endswith("/cancel"):
            export_id = path.split("/")[2]
            self.canceled.append(export_id)
            body = self.status.get(export_id)
            if body is not None:
                body["state"] = "canceled"
            return httpx.Response(200, json={"state": "canceled"})
        if path.startswith("/exports/"):
            export_id = path.split("/")[2]
            body = self.status.get(export_id)
            if body is None:
                return httpx.Response(
                    404, json={"error": {"code": "export_not_found", "message": path}}
                )
            return httpx.Response(200, json=body)
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": path}}
        )


def _client(
    data_dir: Path, fake_recorder: FakeRecorder, exporter: FakeExporter
) -> TestClient:
    settings = Settings(
        data_dir=str(data_dir),
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
    )

    def route(request: httpx.Request) -> httpx.Response:
        if request.url.port == EXPORTER_PORT:
            return exporter.handler(request)
        return fake_recorder.handler(request)

    app = create_orchestrator_app(
        settings,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(route)),
    )
    return TestClient(app)


def _profile(tmp_path: Path, **overrides: Any) -> dict[str, Any]:
    path = tmp_path / "full.yaml"
    if not path.exists():
        path.write_text("robot_type: hsr\nfps: 30\ntask: OVERRIDDEN_PER_EXPORT\n")
    profile = {
        "name": "full",
        "path": str(path),
        "source": "committed",
        "valid": True,
        "errors": [],
        "topics": [],
        "fps": 30,
    }
    profile.update(overrides)
    return profile


def _seed(
    client: TestClient,
    layout: DataLayout,
    *,
    task: str | None = "pick",
    operator: str | None = "alice",
    review_status: str = "pending",
    state: CaptureState = CaptureState.completed,
    manifest_topics: list[str] | None = None,
) -> str:
    store = client.app.state.capture_store
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"payload" * 10)
    if manifest_topics is not None:
        (capture_dir / "object_manifest.json").write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "capture_id": capture_id,
                    "source_instance_id": "inst",
                    "run_id": f"run_{capture_id}",
                    "state": "completed",
                    "started_at": "2026-08-01T00:00:00.000Z",
                    "task": task,
                    "topics": [{"name": name} for name in manifest_topics],
                }
            ),
            encoding="utf-8",
        )
    store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id}",
            state=state,
            operator=operator,
            task=task,
            review_status=review_status,  # type: ignore[arg-type]
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    store.upsert_replica(
        capture_id,
        client.app.state.instance_id,
        ReplicaState.present_unverified,
        path=str(capture_dir),
    )
    return capture_id


def _dataset(
    client: TestClient,
    capture_ids: list[str],
    *,
    name: str = "ds",
    operator: str | None = "alice",
    task: str | None = "pick",
) -> str:
    dataset = client.post(
        "/api/v1/datasets", json={"name": name, "operator": operator, "task": task}
    ).json()
    for capture_id in capture_ids:
        response = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/members",
            json={"capture_id": capture_id},
        )
        assert response.status_code in (200, 201), response.text
    return dataset["dataset_id"]


class TestExportsConfig:
    def test_no_exporter_means_disabled_not_an_error(
        self, data_dir: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.present = False
        with _client(data_dir, fake_recorder, exporter) as client:
            body = client.get("/api/v1/exports/config").json()
        assert body == {
            "enabled": False,
            "profiles": [],
            "validator_unavailable": None,
        }

    def test_profiles_enable_the_gate(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            body = client.get("/api/v1/exports/config").json()
        assert body["enabled"] is True
        assert body["profiles"][0]["name"] == "full"


class TestPreflight:
    def test_reports_name_counts_tasks_and_coverage(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [
            _profile(tmp_path, topics=["/joint_states", "/camera/rgb"])
        ]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            ok = _seed(client, layout, manifest_topics=["/joint_states", "/camera/rgb"])
            gap = _seed(client, layout, manifest_topics=["/joint_states"])
            no_manifest = _seed(client, layout)
            dataset_id = _dataset(client, [ok, gap, no_manifest])
            body = client.get(
                f"/api/v1/datasets/{dataset_id}/export/preflight",
                params={"profile": "full", "memo": "beta1"},
            ).json()

        assert body["output_name"] == "alice_full_beta1"
        assert body["output"] == "exports/alice_full_beta1"
        assert body["member_total"] == 3
        assert body["included"] == 3
        assert body["tasks"] == {"labeled": 3, "unlabeled": 0, "values": {"pick": 3}}
        assert body["missing_topics"] == [
            {"capture_id": gap, "topics": ["/camera/rgb"]}
        ]
        assert body["coverage_unknown"] == [no_manifest]

    def test_mixed_operators_get_the_fixed_segment(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            a = _seed(client, layout, operator="alice")
            b = _seed(client, layout, operator="bob")
            dataset_id = _dataset(client, [a, b], operator=None)
            body = client.get(
                f"/api/v1/datasets/{dataset_id}/export/preflight",
                params={"profile": "full"},
            ).json()
        # The name keeps its three-segment structure: dropping a leading
        # segment would make `arm_only_beta1` unreadable, so operator
        # disagreement is spelled with the fixed word `mixed`.
        assert body["output_name"] == "mixed_full"

    def test_unknown_profile_is_a_404(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            dataset_id = _dataset(client, [_seed(client, layout)])
            response = client.get(
                f"/api/v1/datasets/{dataset_id}/export/preflight",
                params={"profile": "nope"},
            )
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "profile_not_found"


class TestSubmit:
    def test_happy_path_snapshots_and_leases(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            first = _seed(client, layout)
            second = _seed(client, layout)
            dataset_id = _dataset(client, [first, second])

            response = client.post(
                f"/api/v1/datasets/{dataset_id}/export",
                json={"profile": "full", "memo": "beta1"},
            )
            assert response.status_code == 202, response.text
            body = response.json()
            assert body["output"] == "exports/alice_full_beta1"
            assert body["included"] == 2

            sent = exporter.received[body["export_id"]]
            assert sent["output_name"] == "alice_full_beta1"
            assert [e["dir"] for e in sent["episodes"]] == ["001", "002"]
            assert {e["task"] for e in sent["episodes"]} == {"pick"}
            # Every episode is labeled, so the YAML's placeholder task must not
            # be resurrected through a needless fallback.
            assert sent["task_fallback"] is None

            owner = f"export:{body['export_id']}"
            assert store.holds_lease(first, owner)
            assert store.holds_lease(second, owner)

    def test_the_reservation_closes_the_concurrent_submit_window(self) -> None:
        # The submit path has awaits between "is one running?" and "remember
        # this one", so two concurrent requests for one dataset could both
        # start, the second orphaning the first. reserve() is the synchronous
        # gate that makes the second lose — the first claim stands until put()
        # commits or release() rolls back.
        from api_orchestrator.routers.exports import ExportRecord, ExportRegistry

        registry = ExportRegistry()
        assert registry.reserve("ds") is True
        # A second submission, arriving while the first is still mid-flight
        # (reserved but not yet a record), is refused.
        assert registry.reserve("ds") is False
        # A different dataset is unaffected.
        assert registry.reserve("other") is True

        # Commit the first: the reservation becomes a live record, and a new
        # submission is still refused (now because it is active, not reserved).
        record = ExportRecord(
            export_id="e1",
            dataset_id="ds",
            output_name="n",
            profile={},
            config_sha256=None,
            captures=[{"capture_id": "c", "dir": "001", "task": None}],
        )
        registry.put(record)
        assert registry.reserve("ds") is False

        # A failed submission releases, freeing the dataset for a retry.
        registry.release("other")
        assert registry.reserve("other") is True

    def test_a_second_export_for_the_same_dataset_is_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            dataset_id = _dataset(client, [_seed(client, layout)])
            other = _dataset(client, [_seed(client, layout)], name="ds2")
            first = client.post(
                f"/api/v1/datasets/{dataset_id}/export", json={"profile": "full"}
            )
            assert first.status_code == 202
            again = client.post(
                f"/api/v1/datasets/{dataset_id}/export",
                json={"profile": "full", "memo": "x"},
            )
            assert again.status_code == 409
            assert again.json()["error"]["code"] == "export_in_progress"
            # A DIFFERENT dataset queues freely — the refusal is per dataset,
            # not a global single-flight.
            second = client.post(
                f"/api/v1/datasets/{other}/export",
                json={"profile": "full", "memo": "y"},
            )
            assert second.status_code == 202

    def test_existing_output_is_refused_up_front(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            dataset_id = _dataset(client, [_seed(client, layout)])
            occupied = layout.data_dir / "exports" / "alice_full"
            occupied.mkdir(parents=True)
            (occupied / "meta.json").write_text("{}", encoding="utf-8")
            response = client.post(
                f"/api/v1/datasets/{dataset_id}/export", json={"profile": "full"}
            )
        assert response.status_code == 409
        assert response.json()["error"]["code"] == "destination_not_empty"

    def test_unlabeled_captures_without_fallback_are_refused(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            unlabeled = _seed(client, layout, task=None)
            dataset_id = _dataset(client, [unlabeled], task=None)
            response = client.post(
                f"/api/v1/datasets/{dataset_id}/export", json={"profile": "full"}
            )
            assert response.status_code == 400
            assert response.json()["error"]["code"] == "task_required"
            # The dialog's fallback unblocks it.
            retry = client.post(
                f"/api/v1/datasets/{dataset_id}/export",
                json={"profile": "full", "task_fallback": "sweep"},
            )
            assert retry.status_code == 202
            sent = exporter.received[retry.json()["export_id"]]
            assert sent["task_fallback"] == "sweep"
            assert sent["episodes"][0]["task"] is None

    def test_excluded_and_recording_members_are_dropped(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            good = _seed(client, layout)
            excluded = _seed(client, layout, review_status="excluded")
            recording = _seed(client, layout, state=CaptureState.recording)
            dataset_id = _dataset(client, [good, excluded, recording])
            response = client.post(
                f"/api/v1/datasets/{dataset_id}/export", json={"profile": "full"}
            )
            assert response.status_code == 202
            body = response.json()
            assert body["included"] == 1
            assert body["dropped"]["excluded"] == [excluded]
            assert body["dropped"]["recording"] == [recording]
            sent = exporter.received[body["export_id"]]
            assert [e["capture_id"] for e in sent["episodes"]] == [good]

    def test_the_sidecar_label_beats_the_row_cache(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            layout = client.app.state.data_layout
            capture_id = _seed(client, layout, task="stale_row_value")
            write_record(
                layout.capture_dir(capture_id),
                RecordV2(
                    capture_id=capture_id,
                    revision=1,
                    labels={"task": "edited_after_recording"},
                ),
            )
            dataset_id = _dataset(client, [capture_id])
            response = client.post(
                f"/api/v1/datasets/{dataset_id}/export", json={"profile": "full"}
            )
            sent = exporter.received[response.json()["export_id"]]
        assert sent["episodes"][0]["task"] == "edited_after_recording"


class TestStatus:
    def _submitted(
        self, client: TestClient, exporter: FakeExporter, tmp_path: Path
    ) -> tuple[str, str, list[str]]:
        layout = client.app.state.data_layout
        captures = [_seed(client, layout), _seed(client, layout)]
        dataset_id = _dataset(client, captures)
        body = client.post(
            f"/api/v1/datasets/{dataset_id}/export", json={"profile": "full"}
        ).json()
        return dataset_id, body["export_id"], captures

    def test_success_is_recorded_once_and_releases_the_leases(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            store = client.app.state.capture_store
            dataset_id, export_id, captures = self._submitted(
                client, exporter, tmp_path
            )
            owner = f"export:{export_id}"

            exporter.status[export_id] = {
                "state": "running",
                "done": 1,
                "failed": 0,
                "total": 2,
                "current_episode_pct": 0.5,
            }
            running = client.get(f"/api/v1/datasets/{dataset_id}/export").json()
            assert running["state"] == "running"
            assert running["current_episode_pct"] == 0.5
            assert all(store.holds_lease(c, owner) for c in captures)

            exporter.status[export_id] = {
                "state": "complete",
                "done": 2,
                "failed": 0,
                "total": 2,
            }
            done = client.get(f"/api/v1/datasets/{dataset_id}/export").json()
            assert done["state"] == "complete"
            assert not any(store.holds_lease(c, owner) for c in captures)
            # Poll again: the record must not double.
            client.get(f"/api/v1/datasets/{dataset_id}/export")

        events = [
            e for e in ledger_v2.read_all(data_dir) if e["kind"] == "dataset_exported"
        ]
        assert len(events) == 1
        event = events[0]
        assert event["dataset_id"] == dataset_id
        assert event["export_id"] == export_id
        assert event["output"] == "exports/alice_full"
        assert [c["capture_id"] for c in event["captures"]] == captures
        assert event["config_sha256"] is not None
        assert event["done"] == 2 and event["total"] == 2

    def test_an_exporter_that_forgot_the_run_reads_as_failed(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            store = client.app.state.capture_store
            dataset_id, export_id, captures = self._submitted(
                client, exporter, tmp_path
            )
            del exporter.status[export_id]
            body = client.get(f"/api/v1/datasets/{dataset_id}/export").json()
            assert body["state"] == "failed"
            assert "restarted" in body["message"]
            owner = f"export:{export_id}"
            assert not any(store.holds_lease(c, owner) for c in captures)
        assert not [
            e for e in ledger_v2.read_all(data_dir) if e["kind"] == "dataset_exported"
        ]

    def test_cancel_proxies_and_reports(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        exporter.profiles = [_profile(tmp_path)]
        with _client(data_dir, fake_recorder, exporter) as client:
            dataset_id, export_id, _ = self._submitted(client, exporter, tmp_path)
            body = client.post(f"/api/v1/datasets/{dataset_id}/export/cancel").json()
            assert body["state"] == "canceled"
            assert exporter.canceled == [export_id]

    def test_unknown_dataset_export_is_a_404(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        exporter = FakeExporter()
        with _client(data_dir, fake_recorder, exporter) as client:
            response = client.get("/api/v1/datasets/nope/export")
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "export_not_found"
