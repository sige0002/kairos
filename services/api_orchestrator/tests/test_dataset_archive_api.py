"""Archive + delete bookkeeping on the orchestrator side.

Archiving is the one operation that removes data from this machine on purpose,
so the API contract is: refuse anything outside the allow-list BEFORE a job
exists, hand back a job id instead of blocking on a multi-GB copy, and record
the departure in the lifecycle ledger only once the copy actually succeeded.
Delete gets the same ledger treatment, in the opposite order — see the comments
in the router for why the two differ.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings, lifecycle_ledger, topic_signature


def _make_dataset(data_dir: Path, operator: str, task: str, index: str) -> Path:
    dataset_dir = data_dir / operator / task / index
    dataset_dir.mkdir(parents=True)
    (dataset_dir / f"run_{index}_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"y" * 512)
    (dataset_dir / "metadata.yaml").write_text(
        "rosbag2_bagfile_information:\n"
        "  topics_with_message_count:\n"
        "    - topic_metadata: {name: /hsrb/joint_states,"
        " type: sensor_msgs/msg/JointState}\n"
        "      message_count: 12\n",
        encoding="utf-8",
    )
    (dataset_dir / "dataset.json").write_text(
        json.dumps(
            {
                "run_id": f"run_{index}",
                "bytes": 520,
                "message_count": 12,
                "exported_at": "2026-07-26T00:00:00.000Z",
            }
        ),
        encoding="utf-8",
    )
    return dataset_dir


class FakeArchiver:
    """dora_runner stand-in that performs the real copy+delete for the job."""

    def __init__(self, data_dir: Path, *, fail: bool = False) -> None:
        self._data_dir = data_dir
        self._fail = fail
        self._jobs: dict[str, dict] = {}
        self._n = 0
        self.created: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/jobs" and request.method == "POST":
            body = json.loads(request.content)
            self.created.append(body)
            self._n += 1
            job_id = f"job_{self._n}"
            state = "failed" if self._fail else "succeeded"
            if not self._fail:
                self._run(body["params"])
            self._jobs[job_id] = {
                "job_id": job_id,
                "run_id": body.get("run_id", ""),
                "pipeline": body["pipeline"],
                "state": state,
                "progress": 1.0,
                "logs_tail": [],
            }
            return httpx.Response(201, json={"job_id": job_id})
        if path.endswith("/status"):
            return httpx.Response(200, json=self._jobs[path.rsplit("/", 2)[1]])
        if path.endswith("/result"):
            return httpx.Response(200, json={"summary": {}, "artifacts": []})
        return httpx.Response(404, json={"error": {"code": "nf", "message": path}})

    def _run(self, params: dict) -> None:
        """Mirror dora_runner's dataset_archive contract: copy out, RECORD the
        departure, remove the source, then prune the emptied husks.

        The ledger append belongs to the deleting process and happens before the
        removal — mirrored here because a stand-in that records afterwards would
        pass while the real ordering could still lose the record to a restart.
        """
        import json as _json
        import shutil

        source = self._data_dir / params["dataset_dir"]
        target = Path(params["destination"])
        target.mkdir(parents=True, exist_ok=True)
        for child in sorted(source.iterdir()):
            shutil.copy2(child, target / child.name)
        try:
            meta = _json.loads((source / "dataset.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        signature = topic_signature(source)
        lifecycle_ledger.append(
            self._data_dir,
            lifecycle_ledger.LedgerEntry(
                event="archived",
                operator=source.parent.parent.name,
                task=source.parent.name,
                index=source.name,
                run_id=meta.get("run_id"),
                destination=str(target),
                reason=params.get("reason"),
                topics_hash=(signature.hash if signature else meta.get("topics_hash")),
                topic_count=(signature.count if signature else meta.get("topic_count")),
            ),
        )
        shutil.rmtree(source)
        for parent in (source.parent, source.parent.parent):
            try:
                parent.rmdir()
            except OSError:
                break


def _build(tmp_path: Path, store, fake_recorder, archiver, *, roots: str = ""):
    settings = Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        data_dir=str(tmp_path / "data"),
        recorded_dir=str(tmp_path / "data" / "recorded"),
        archive_roots=roots,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.dora_runner_port:
            return archiver.handler(request)
        return fake_recorder.handler(request)

    return create_orchestrator_app(
        settings,
        store=store,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


# ---- capability advertising ------------------------------------------------


def test_archive_is_advertised_as_off_when_unconfigured(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    app = _build(tmp_path, store, fake_recorder, FakeArchiver(tmp_path / "data"))
    with TestClient(app) as client:
        body = client.get("/api/v1/datasets/archive/config").json()
    assert body == {"enabled": False, "roots": []}


def test_archive_config_lists_the_configured_roots(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    nas = tmp_path / "nas"
    app = _build(
        tmp_path, store, fake_recorder, FakeArchiver(tmp_path / "data"), roots=str(nas)
    )
    with TestClient(app) as client:
        body = client.get("/api/v1/datasets/archive/config").json()
    assert body == {"enabled": True, "roots": [str(nas)]}


# ---- refusals happen BEFORE a job exists -----------------------------------


def test_archiving_is_refused_when_unconfigured_and_starts_no_job(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    archiver = FakeArchiver(data_dir)
    app = _build(tmp_path, store, fake_recorder, archiver)

    with TestClient(app) as client:
        res = client.post(
            "/api/v1/datasets/yuki/pick/001/archive",
            json={"destination": str(tmp_path / "anywhere")},
        )

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "archive_not_configured"
    assert archiver.created == []  # nothing was ever started
    assert source.is_dir()


def test_a_destination_outside_the_roots_is_refused_and_starts_no_job(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    archiver = FakeArchiver(data_dir)
    app = _build(tmp_path, store, fake_recorder, archiver, roots=str(tmp_path / "nas"))

    with TestClient(app) as client:
        res = client.post(
            "/api/v1/datasets/yuki/pick/001/archive",
            json={"destination": str(tmp_path / "elsewhere" / "ep")},
        )

    assert res.status_code == 400
    assert res.json()["error"]["code"] == "destination_not_allowed"
    assert archiver.created == []
    assert source.is_dir()
    assert lifecycle_ledger.read_all(data_dir) == []


def test_archiving_an_unknown_dataset_is_a_404(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    (tmp_path / "data").mkdir()
    archiver = FakeArchiver(tmp_path / "data")
    app = _build(tmp_path, store, fake_recorder, archiver, roots=str(tmp_path / "nas"))
    with TestClient(app) as client:
        res = client.post(
            "/api/v1/datasets/yuki/pick/001/archive",
            json={"destination": str(tmp_path / "nas" / "ep")},
        )
    assert res.status_code == 404
    assert archiver.created == []


# ---- the happy path --------------------------------------------------------


def test_archive_returns_202_with_a_job_and_records_the_departure(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    nas = tmp_path / "nas"
    archiver = FakeArchiver(data_dir)
    app = _build(tmp_path, store, fake_recorder, archiver, roots=str(nas))
    destination = nas / "yuki" / "pick" / "001"

    with TestClient(app) as client:
        res = client.post(
            "/api/v1/datasets/yuki/pick/001/archive",
            json={"destination": str(destination), "reason": "moved to the NAS"},
        )
        # 202 + a job to poll: the request never waits for the copy.
        assert res.status_code == 202
        payload = res.json()
        assert payload["job_id"] == "job_1"
        assert payload["destination"] == str(destination)
        # Background bookkeeping has run by now (TestClient drains it).
        listed = client.get("/api/v1/datasets").json()["datasets"]

    # The bytes are at the destination and gone from the catalog tree.
    assert (destination / "run_001_0.mcap").is_file()
    assert not (data_dir / "yuki").exists()
    # It has left the Datasets tab — the requirement.
    assert listed == []

    # …and the departure is answerable from the ledger alone.
    entries = lifecycle_ledger.read_all(data_dir)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["event"] == "archived"
    assert entry["destination"] == str(destination)
    assert entry["reason"] == "moved to the NAS"
    assert entry["run_id"] == "run_001"
    # Provenance carried forward: which embodiment this was.
    assert isinstance(entry["topics_hash"], str) and entry["topics_hash"]
    assert entry["topic_count"] == 1
    # The allow-list travels with the job so the runner enforces it too.
    assert archiver.created[0]["params"]["archive_roots"] == str(nas)
    assert archiver.created[0]["pipeline"] == "dataset_archive"


def test_the_retired_index_is_recorded_so_it_is_never_reissued(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "003")
    nas = tmp_path / "nas"
    app = _build(tmp_path, store, fake_recorder, FakeArchiver(data_dir), roots=str(nas))

    with TestClient(app) as client:
        client.post(
            "/api/v1/datasets/yuki/pick/003/archive",
            json={"destination": str(nas / "ep003")},
        )

    assert lifecycle_ledger.retired_indices(data_dir, "yuki", "pick") == {3}


def test_a_failed_archive_leaves_the_dataset_in_the_catalog(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    """No ledger entry, no dropped row — the dataset never left."""
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    nas = tmp_path / "nas"
    archiver = FakeArchiver(data_dir, fail=True)
    app = _build(tmp_path, store, fake_recorder, archiver, roots=str(nas))

    with TestClient(app) as client:
        res = client.post(
            "/api/v1/datasets/yuki/pick/001/archive",
            json={"destination": str(nas / "ep")},
        )
        assert res.status_code == 202  # the job was started…
        listed = client.get("/api/v1/datasets").json()["datasets"]

    # …but it failed, so nothing was recorded and nothing was removed.
    assert source.is_dir()
    assert lifecycle_ledger.read_all(data_dir) == []
    assert [d["index"] for d in listed] == ["001"]


# ---- delete now leaves a trace too -----------------------------------------


def test_delete_records_the_departure_with_its_reason(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "002")
    app = _build(tmp_path, store, fake_recorder, FakeArchiver(data_dir))

    with TestClient(app) as client:
        res = client.delete("/api/v1/datasets/yuki/pick/002?reason=operator%20error")

    assert res.status_code == 204
    assert not source.exists()
    entries = lifecycle_ledger.read_all(data_dir)
    assert len(entries) == 1
    assert entries[0]["event"] == "deleted"
    assert entries[0]["reason"] == "operator error"
    assert entries[0]["index"] == "002"
    assert "destination" not in entries[0]  # nothing to point at
    assert lifecycle_ledger.retired_indices(data_dir, "yuki", "pick") == {2}


def test_delete_without_a_reason_still_records_the_departure(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder
) -> None:
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    app = _build(tmp_path, store, fake_recorder, FakeArchiver(data_dir))

    with TestClient(app) as client:
        assert client.delete("/api/v1/datasets/yuki/pick/001").status_code == 204

    entries = lifecycle_ledger.read_all(data_dir)
    assert len(entries) == 1
    assert entries[0]["event"] == "deleted"
    assert "reason" not in entries[0]


def test_a_ledger_that_cannot_be_written_aborts_the_delete(
    tmp_path: Path, store: RunStore, fake_recorder: FakeRecorder, monkeypatch
) -> None:
    """Nothing is destroyed if the departure cannot be recorded."""
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    app = _build(tmp_path, store, fake_recorder, FakeArchiver(data_dir))

    def boom(*_args, **_kwargs):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(lifecycle_ledger, "append", boom)

    with TestClient(app) as client:
        res = client.delete("/api/v1/datasets/yuki/pick/001")

    assert res.status_code == 500
    assert res.json()["error"]["code"] == "ledger_write_failed"
    assert source.is_dir()  # the data is still there
