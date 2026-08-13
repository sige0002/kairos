# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Shared fixtures: an in-process fake recorder and a wired v2 app.

The fake recorder is an ``httpx.MockTransport`` implementing just enough of the
recorder's internal API to exercise the capture lifecycle without ROS. Under v2
it also does what the real recorder does on disk: it **mints a capture_id** and
writes ``objects/<capture_id>/object_manifest.json``, because the orchestrator's
rebuild, digest and reconciler all read that file rather than asking over HTTP.
A fake that only answered HTTP would let every filesystem rule pass untested.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.store import CaptureStore
from fastapi import FastAPI
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.capture_sidecars import (
    OBJECT_MANIFEST_FILENAME,
    ObjectManifestV2,
    write_object_manifest,
)
from kairos_common.ids import new_capture_id

INSTANCE_PLACEHOLDER = "00000000-0000-4000-8000-000000000000"


class FakeRecorder:
    """In-memory stand-in for rosbag2_recorder, with the sidecars it writes."""

    def __init__(self, data_dir: Path) -> None:
        self.layout = DataLayout(data_dir=data_dir)
        self.state: str = "idle"
        self.run_id: str | None = None
        self.capture_id: str | None = None
        self.started_at: str | None = None
        self.topic_names: list[str] = []
        self.topic_type: str = "sensor_msgs/msg/JointState"
        # Stamped from the start request's optional `robot` (§10) so the
        # manifest — not the orchestrator's row — is authoritative for it.
        self.robot: str | None = None
        self.finalized: bool = False
        # Terminal state the recorder reports after stop; tests set this to
        # "failed"/"interrupted" to exercise a non-completed finalize.
        self.final_state: str = "completed"
        self.final_error: str | None = None
        self.integrity: str = "ok"
        # Failure injection.
        self.start_status: int = 201
        self.start_error: dict[str, Any] | None = None
        self.healthz_ok: bool = True
        self.metadata_status: int = 200
        self.transport_down: bool = False
        # Drop the live_capture_ids array from status/stop, modelling an old or
        # broken recorder. §10 rev.2.4 says a caller must read that as
        # UNREACHABLE, never as "nothing is live".
        self.omit_live_capture_ids: bool = False
        # Serve GET /record/metadata as the recorder's 500 manifest_corrupt.
        # Deliberately independent of ``sidecar_corrupt`` below: the two model
        # different faults, and which one a test picks decides whether the
        # complaint is permanent or transient (see that knob).
        self.manifest_corrupt: bool = False
        # Write objects/<capture_id>/object_manifest.json as bytes that do not
        # parse, which is the fault ``manifest_corrupt`` REPORTS: the recorder's
        # 500 says it could not read that file, and it is the same file the
        # orchestrator's digest and reconciler read.
        #
        # Setting only ``manifest_corrupt`` therefore models the narrower case —
        # the recorder read the file mid-write and the copy on disk is fine —
        # where the complaint is stale the moment anything re-reads it cleanly
        # (captures.py ``_manifest_divergence``). Setting both models a file
        # that really is unreadable, where adoption refuses and the complaint
        # stands. Both are real; a test must say which one it means.
        self.sidecar_corrupt: bool = False
        # The recorder is killed the instant it has answered /record/stop, so
        # every later call raises. Deliberately INDEPENDENT of what it wrote to
        # disk: "died and sealed" and "died without sealing" are different
        # facts about the recording, and the orchestrator's answer must come
        # from the sidecar rather than from whether the process is still there.
        self.die_after_stop: bool = False
        # Answer /record/stop but write no terminal manifest — killed between
        # acknowledging and finalising.
        self.seal_on_stop: bool = True
        # Answer /record/stop with ``stopping`` and KEEP flushing: the recorder
        # seals and reports ``final_state`` only after this many further status
        # reads (delayed success — the finaliser still writing after the stop
        # response). ``None`` (default) seals at stop; a huge number models a
        # recorder that never settles. This is the poll-count seam: tests drive
        # slowness by counting reads, never by sleeping.
        self.settle_after_status_polls: int | None = None
        self._polls_until_settle: int | None = None
        # Whether the fake writes objects/<capture_id>/ on start. Off lets a
        # test drive the API without any bytes on disk.
        self.writes_sidecars: bool = True
        self.message_count: int = 0
        self.bytes: int = 0
        # Shape of the bag written at stop. The default is a comfortably normal
        # take; a test that wants the accidental-double-click case sets
        # ``bag_duration_s`` below the quick check's minimum.
        self.bag_duration_s: float = 10.0
        self.bag_messages: int = 300
        self.arming: dict[str, Any] | None = None
        self.last_start_payload: dict[str, Any] | None = None
        # ---- prepare knobs ----
        self.prepare_status: int = 201
        self.prepare_error: dict[str, Any] | None = None
        self.prepare_arming: dict[str, Any] = {
            "active": True,
            "matched_topics": [],
            "missing_topics": [],
        }
        self.disarm_at: str | None = "2026-08-01T00:02:00.000Z"
        self.last_prepare_payload: dict[str, Any] | None = None
        self.prepare_call_count: int = 0
        self.prepared_capture_id: str | None = None
        # The armed session's run_id, which is what /record/status reports while
        # armed (see _status) — not the previous session's.
        self.prepared_run_id: str | None = None
        # Models the recorder extending an already-armed matching session, whose
        # ids were fixed at first arm time.
        self.prepare_extend_run_id: str | None = None
        self.stop_call_count: int = 0

    # ---- dispatch ----------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.transport_down:
            raise httpx.ConnectError("recorder unreachable")
        path = request.url.path
        if path == "/healthz":
            return self._healthz()
        if path == "/record/prepare" and request.method == "POST":
            return self._prepare(request)
        if path == "/record/start" and request.method == "POST":
            return self._start(request)
        if path == "/record/stop" and request.method == "POST":
            return self._stop()
        if path == "/record/status":
            return self._status()
        if path == "/record/preflight":
            return httpx.Response(200, json={"ready": True})
        if path == "/record/metadata":
            return self._metadata()
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": path}}
        )

    # ---- endpoints ---------------------------------------------------------

    def _healthz(self) -> httpx.Response:
        if not self.healthz_ok:
            return httpx.Response(503, json={"status": "down"})
        return httpx.Response(200, json={"status": "ok"})

    def _prepare(self, request: httpx.Request) -> httpx.Response:
        self.prepare_call_count += 1
        self.last_prepare_payload = json.loads(request.content)
        if self.prepare_error is not None:
            return httpx.Response(
                self.prepare_status, json={"error": self.prepare_error}
            )
        self.prepared_capture_id = self.prepared_capture_id or new_capture_id()
        self.prepared_run_id = (
            self.prepare_extend_run_id or self.last_prepare_payload["run_id"]
        )
        # An armed session already owns objects/<id>/ with no manifest in it, so
        # it counts as live (§10) — a rebuild that missed it would see a
        # manifest-less directory and report an orphan.
        self.state = "armed"
        return httpx.Response(
            201,
            json={
                "run_id": self.prepare_extend_run_id
                or self.last_prepare_payload["run_id"],
                "capture_id": self.prepared_capture_id,
                "state": "armed",
                "arming": self.prepare_arming,
                "disarm_at": self.disarm_at,
            },
        )

    def _start(self, request: httpx.Request) -> httpx.Response:
        self.last_start_payload = json.loads(request.content)
        if self.start_error is not None:
            return httpx.Response(self.start_status, json={"error": self.start_error})
        self.run_id = self.last_start_payload["run_id"]
        # A matching start resumes the armed session and keeps its capture_id; a
        # non-matching one disarms it and mints a fresh id, which is what the
        # real recorder does and what makes the "prepare mismatch" case testable.
        self.capture_id = (
            self.prepared_capture_id
            if self._matches_prepared(self.last_start_payload)
            else new_capture_id()
        )
        self.prepared_capture_id = None
        self.prepared_run_id = None
        self.state = "recording"
        self.robot = self.last_start_payload.get("robot")
        self.started_at = "2026-08-01T00:00:00.000Z"
        self.finalized = False
        requested = self.last_start_payload["topics"]
        self.topic_names = (
            ["/joint_states", "/tf"] if requested == "all" else list(requested)
        )
        if self.writes_sidecars:
            self._write_manifest("recording")
        body: dict[str, Any] = {
            "run_id": self.run_id,
            "capture_id": self.capture_id,
            "state": "recording",
            "started_at": self.started_at,
        }
        if self.arming is not None:
            body["arming"] = self.arming
        return httpx.Response(201, json=body)

    def _matches_prepared(self, start_payload: dict[str, Any]) -> bool:
        """Whether a start request matches the outstanding armed session.

        Compares what actually determines the recording — topics, compression,
        split, QoS — and ignores operator/task, mirroring the orchestrator's own
        match key.
        """
        if self.prepared_capture_id is None or self.last_prepare_payload is None:
            return False
        keys = ("topics", "compression", "split", "qos_default", "qos_overrides")
        return all(
            self.last_prepare_payload.get(k) == start_payload.get(k) for k in keys
        )

    def _stop(self) -> httpx.Response:
        self.stop_call_count += 1
        disarmed: str | None = None
        if self.state == "armed":
            # Stopping an armed-but-never-started session cancels the arm; §10
            # rev.2.4 names the cancelled capture so the caller need not guess.
            disarmed = self.prepared_capture_id
            self.prepared_capture_id = None
            self.prepared_run_id = None
            self.state = "idle"
        if self.state in ("recording", "stopping"):
            if self.settle_after_status_polls is not None:
                # Still flushing: the stop is acknowledged but not finished.
                self.state = "stopping"
                self._polls_until_settle = self.settle_after_status_polls
            else:
                self._finalize()
        body: dict[str, Any] = {
            "state": self.state,
            "run_id": self.run_id,
            "capture_id": self.capture_id,
            **self._live_ids_field(),
        }
        if disarmed is not None:
            body["disarmed_capture_id"] = disarmed
        if self.die_after_stop:
            self.transport_down = True
        return httpx.Response(200, json=body)

    def _finalize(self) -> None:
        """Seal the session: terminal state, counters, bag + manifest on disk."""
        self.state = self.final_state
        self.finalized = True
        self.message_count = 1234
        self.bytes = 567890
        if self.writes_sidecars and self.seal_on_stop:
            self._write_bag()
            self._write_manifest(self.final_state)
        self._polls_until_settle = None

    def _status(self) -> httpx.Response:
        # A deferred settle (settle_after_status_polls) counts down HERE: the
        # flush outlives the stop response, and each status read is one tick of
        # the caller's confirmation poll.
        if self.state == "stopping" and self._polls_until_settle is not None:
            if self._polls_until_settle <= 0:
                self._finalize()
            else:
                self._polls_until_settle -= 1
        armed = self.state == "armed" and self.prepared_capture_id is not None
        body: dict[str, Any] = {
            "state": self.state,
            # The real recorder keeps reporting the LAST session's ids after it
            # stops, which is how the orchestrator correlates an auto-stop it
            # never asked for. Consumers that need "is this live" must read
            # ``state``, not the presence of an id.
            #
            # WHILE ARMED it reports the ARMED session's ids instead (recorder
            # `_status_locked`: "report the ARMED run/capture/topics, not the
            # previous session's"). Nothing is committed for an armed session,
            # so a fake that named the previous capture here made reconciliation
            # believe the recorder still held a capture it had already finished.
            "run_id": self.prepared_run_id if armed else self.run_id,
            "capture_id": self.prepared_capture_id if armed else self.capture_id,
            **self._live_ids_field(),
            "started_at": self.started_at,
            "message_count": self.message_count,
            "bytes": self.bytes,
            "topics": list(self.topic_names),
        }
        if self.arming is not None:
            body["arming"] = self.arming
        return httpx.Response(200, json=body)

    def _live_ids_field(self) -> dict[str, Any]:
        """``live_capture_ids`` per §10 — the ONLY liveness signal.

        Non-empty exactly while armed, recording or stopping (an armed prepare
        counts); empty otherwise. The singular ``capture_id`` deliberately keeps
        naming the last capture after it finishes, which is why it must never be
        consulted for liveness.
        """
        if self.omit_live_capture_ids:
            return {}
        live: list[str] = []
        if self.state == "armed" and self.prepared_capture_id:
            live.append(self.prepared_capture_id)
        elif self.state in ("recording", "stopping") and self.capture_id:
            live.append(self.capture_id)
        return {"live_capture_ids": live}

    def _metadata(self) -> httpx.Response:
        if self.manifest_corrupt:
            # §10: corrupt manifest is a 500 with its own code, NOT a 404 —
            # "unparseable" and "absent" are different answers.
            return httpx.Response(
                500,
                json={
                    "error": {
                        "code": "manifest_corrupt",
                        "message": "object_manifest.json could not be parsed",
                        "details": {"capture_id": self.capture_id},
                    }
                },
            )
        if self.metadata_status != 200:
            return httpx.Response(
                self.metadata_status,
                json={"error": {"code": "metadata_error", "message": "boom"}},
            )
        manifest = {
            "run_id": self.run_id,
            "capture_id": self.capture_id,
            "state": self.state,
            "robot": self.robot,
            "error": self.final_error if self.finalized else None,
            "topics": [
                {
                    "name": name,
                    # Types are null pre-finalize; filled from rosbag2 after.
                    "type": self.topic_type if self.finalized else None,
                    "qos": {
                        "reliability": "reliable",
                        "durability": "volatile",
                        "depth": 10,
                    },
                }
                for name in self.topic_names
            ],
            "compression": "none",
            "split": None,
            "ended_at": "2026-08-01T00:05:00.000Z" if self.finalized else None,
            "integrity": self.integrity if self.finalized else "unknown",
            "digest_state": "pending",
        }
        rosbag2_metadata = None
        if self.finalized and self.topic_names:
            rosbag2_metadata = {
                "message_count": self.message_count,
                "files": [{"path": f"{self.capture_id}_0.mcap"}],
                "topics_with_message_count": [
                    {
                        "topic_metadata": {"name": name, "type": self.topic_type},
                        "message_count": self.message_count // len(self.topic_names),
                    }
                    for name in self.topic_names
                ],
            }
        return httpx.Response(
            200,
            json={
                "run_id": self.run_id,
                "capture_id": self.capture_id,
                "manifest": manifest,
                "rosbag2_metadata": rosbag2_metadata,
                "bytes": self.bytes if self.finalized else None,
            },
        )

    # ---- disk --------------------------------------------------------------

    def _write_manifest(self, state: str) -> None:
        """Write the manifest the orchestrator actually reads (§3)."""
        assert self.capture_id is not None
        if self.sidecar_corrupt:
            capture_dir = self.layout.capture_dir(self.capture_id)
            capture_dir.mkdir(parents=True, exist_ok=True)
            # Truncated mid-write, which is how this happens for real: a power
            # cut between open() and the rename. Not empty and not absent —
            # §3.3 treats "unparseable" and "missing" as different answers.
            (capture_dir / OBJECT_MANIFEST_FILENAME).write_text(
                '{"schema_version": 2, "capture_id": "'
            )
            return
        write_object_manifest(
            self.layout.capture_dir(self.capture_id),
            ObjectManifestV2(
                capture_id=self.capture_id,
                source_instance_id=self._instance_id(),
                run_id=self.run_id or "run_unknown",
                state=state,
                started_at=self.started_at or "2026-08-01T00:00:00.000Z",
                ended_at="2026-08-01T00:05:00.000Z" if self.finalized else None,
                operator=(self.last_start_payload or {}).get("operator"),
                task=(self.last_start_payload or {}).get("task"),
                robot=self.robot,
                topics=tuple(
                    {"name": name, "type": self.topic_type, "qos": None}
                    for name in self.topic_names
                ),
                message_count=self.message_count if self.finalized else None,
                bytes=self.bytes if self.finalized else None,
                integrity=self.integrity if self.finalized else "unknown",
                error=self.final_error if self.finalized else None,
            ),
        )

    def _write_bag(self) -> None:
        """A real, readable MCAP — not a byte string that resembles one.

        The stop-time quick check reads this bag's summary section to build
        Layer 1: per-topic counts and, since the minimum-duration criterion, the
        recorded duration. A fake that only *looks* like an MCAP leaves that
        whole layer untested — every stop would report "summary unavailable",
        and no test could tell a healthy recording from a 90ms double-click.
        """
        from mcap.writer import Writer

        assert self.capture_id is not None
        capture_dir = self.layout.capture_dir(self.capture_id)
        capture_dir.mkdir(parents=True, exist_ok=True)
        (capture_dir / "metadata.yaml").write_text(
            "rosbag2_bagfile_information:\n  version: 9\n", encoding="utf-8"
        )
        # rosbag2 derives the inner filename from the output directory, which
        # is objects/<capture_id> — so the bag is capture-named, not run-named.
        bag = capture_dir / f"{self.capture_id}_0.mcap"
        topics = self.topic_names or ["/joint_states"]
        per_topic = max(self.bag_messages // len(topics), 1)
        span_ns = int(self.bag_duration_s * 1e9)
        # Wall-clock nanoseconds, like a real rosbag2 bag. Starting at 0 would
        # be unrepresentative in a way that has already hidden one bug (a
        # falsy-zero check in the summary reader).
        base_ns = 1_754_000_000_000_000_000
        # Spread the messages across the span so the summary's time bounds are
        # the duration the test asked for. Divide by per_topic-1, not per_topic:
        # the LAST message must land at exactly base+span, or every realised
        # duration is (per_topic-1)/per_topic of what the test requested.
        step_ns = max(span_ns // max(per_topic - 1, 1), 1)
        with bag.open("wb") as handle:
            writer = Writer(handle)
            writer.start()
            for topic in topics:
                schema = writer.register_schema(
                    name=self.topic_type, encoding="ros2msg", data=b"x"
                )
                channel = writer.register_channel(
                    topic=topic, message_encoding="cdr", schema_id=schema
                )
                for index in range(per_topic):
                    stamp = base_ns + index * step_ns
                    writer.add_message(
                        channel_id=channel,
                        log_time=stamp,
                        publish_time=stamp,
                        data=b"\x00",
                    )
            writer.finish()

    def _instance_id(self) -> str:
        instance = self.layout.data_dir / "instance.json"
        try:
            return json.loads(instance.read_text())["instance_id"]
        except (OSError, ValueError, KeyError):
            return INSTANCE_PLACEHOLDER


@pytest.fixture(autouse=True)
def _no_data_dir_in_the_repo() -> Iterator[None]:
    """Fail any test that builds an app without a temporary ``data_dir``.

    ``Settings.data_dir`` defaults to ``./data``, and the v2 factory creates the
    whole layout eagerly (objects/, .trash/, instance.json, the volume marker).
    A test that forgets to override it therefore writes into the working tree
    and — worse — shares one instance identity and one catalog with every other
    test that forgot. Catching it here turns a confusing cross-test interaction
    into a named failure at the point of the omission.
    """
    stray = Path("data")
    existed = stray.exists()
    yield
    if not existed and stray.exists():
        shutil.rmtree(stray, ignore_errors=True)
        pytest.fail(
            "this test created ./data in the working tree: pass "
            "Settings(data_dir=str(tmp_path / 'data')) when building the app"
        )


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """A per-test data root. Every capture-store path hangs off this."""
    root = tmp_path / "data"
    root.mkdir()
    return root


@pytest.fixture
def layout(data_dir: Path) -> DataLayout:
    return DataLayout(data_dir=data_dir)


@pytest.fixture
def instance_id(data_dir: Path) -> str:
    """This data root's installation id, minted now if it does not exist yet.

    A test that seeds replica rows before the app starts must file them under
    the id the app will adopt — replicas are keyed by instance, so a made-up id
    produces rows the running service cannot see.
    """
    from kairos_common.instance import load_or_create_instance

    return load_or_create_instance(data_dir).instance_id


class FakeImporter:
    """The importer sidecar, which exists only in a split (recording-PC) deploy.

    Absent by default: a single-host deployment runs no importer container, and
    the orchestrator must report the transfer channel as unavailable rather than
    mistaking some other service's ``/healthz`` for one.
    """

    def __init__(self) -> None:
        self.present: bool = False
        self.pulled: list[str | None] = []
        self.pull_bodies: list[dict[str, object]] = []
        # capture_id -> per-pull state (the sidecar's S3-1 failure channel);
        # tests seed it to model a pull that failed after its 202.
        self.pull_states: dict[str, dict[str, object]] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        if not self.present:
            raise httpx.ConnectError("no importer on this deployment")
        if request.url.path == "/healthz":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/pull" and request.method == "POST":
            body = json.loads(request.content or b"{}")
            # Mirror the real sidecar's strictness: an empty body is a 400,
            # never a sweep (deploy/sync/importer_httpd.parse_pull_body).
            if "capture_id" not in body and body.get("all") is not True:
                return httpx.Response(
                    400,
                    json={"error": {"code": "bad_request", "message": "capture_id"}},
                )
            self.pull_bodies.append(body)
            self.pulled.append(body.get("capture_id"))
            return httpx.Response(202, json={"queued": True})
        if request.url.path.startswith("/pull/") and request.method == "GET":
            capture_id = request.url.path[len("/pull/") :]
            state = self.pull_states.get(capture_id)
            if state is None:
                return httpx.Response(
                    404, json={"error": "no pull is known for this capture"}
                )
            return httpx.Response(200, json={"capture_id": capture_id, **state})
        return httpx.Response(404, json={"error": {"code": "nf", "message": "?"}})


@pytest.fixture
def fake_recorder(data_dir: Path) -> FakeRecorder:
    """A fresh fake recorder, writing into this test's data root."""
    return FakeRecorder(data_dir)


@pytest.fixture
def fake_importer() -> FakeImporter:
    return FakeImporter()


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    """Settings pointing at the temporary data root and no config files.

    The config paths are deliberately nonexistent so the factory boots with no
    ``default_topics`` and an empty stream layout regardless of the working
    directory (the repo-relative defaults would otherwise be picked up when
    pytest runs from the repo root).
    """
    return Settings(
        data_dir=str(data_dir),
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
    )


@pytest.fixture
def store(settings: Settings, data_dir: Path) -> Iterator[CaptureStore]:
    """The catalog for this test, on the same data root as the app."""
    s = CaptureStore(data_dir / "kairos.db", data_dir=data_dir)
    yield s
    s.close()


@pytest.fixture
def app(
    settings: Settings, fake_recorder: FakeRecorder, fake_importer: FakeImporter
) -> FastAPI:
    """The wired v2 app backed by a temporary data root and the fakes.

    Requests are dispatched by PORT, because the orchestrator talks to five
    downstreams over one client and a single catch-all handler would make the
    importer look present on a deployment that has none.
    """

    def dispatch(request: httpx.Request) -> httpx.Response:
        if request.url.port == settings.importer_port:
            return fake_importer.handler(request)
        return fake_recorder.handler(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(dispatch))
    return create_orchestrator_app(settings, http_client=client)


@pytest.fixture
def client(app: FastAPI) -> Iterator[TestClient]:
    """A TestClient (entering lifespan runs bootstrap + startup reconcile)."""
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def digests_stay_queued(app: FastAPI) -> list[str]:
    """Record what ``stop`` handed to the digest instead of running it.

    ``RecordService.stop`` ends by calling ``DigestJob.schedule``, which creates
    a task on the app's own loop and returns. Under ``TestClient`` that loop
    keeps turning in a portal thread, so the digest runs CONCURRENTLY with
    whatever the test does next — and a digest is not a read: sealing the
    manifest ends in ``adopt_manifest_facts``, which rewrites the row from the
    file on disk, ``error`` included. A test whose subject IS that error field
    was therefore racing a background writer for it.

    Opting in here keeps the trigger and drops the work: the queued capture ids
    are returned for inspection, and the digest runs only where the test asks
    for it, through ``run_digests``. Deliberately not autouse — several tests
    depend on the real background digest, and which of the two behaviours a
    test pins should be visible in its signature.
    """
    queued: list[str] = []
    app.state.digest_job.schedule = queued.append
    return queued


def run_digests(client: TestClient, *, attempts: int = 100) -> int:
    """Settle every queued digest, then return how many this call completed.

    Two digests can be in flight at once here, and only in a test: the one
    ``stop`` queued on the app's own loop (which the TestClient portal keeps
    running in a background thread) and this one, on a fresh loop. Whichever
    takes the capture's lease first wins, and the other correctly finds nothing
    to do — so a single pass can legitimately return 0 while the work is still
    happening on the other loop.

    Polling the QUEUE rather than the return value is what makes this
    deterministic: the loop ends when no capture still needs a digest, whoever
    got there. A capture that can never be digested (the recorder is holding
    it) keeps the queue non-empty, so the attempt bound is the escape.
    """
    import asyncio
    import time

    job = client.app.state.digest_job
    completed = 0
    for _ in range(attempts):
        completed += asyncio.run(job.run_pending())
        unverified = _unverified_captures(client)
        if not unverified:
            break
        if not any(
            client.app.state.capture_store.has_live_lease(capture_id)
            for capture_id in unverified
        ):
            # Nothing is in flight on the other loop and our own pass declined
            # to act, so the queue is stuck on a guard (the recorder holds it,
            # the store is SUSPECT, the manifest is corrupt). Waiting longer
            # would only be slow.
            break
        time.sleep(0.01)
    return completed


def _unverified_captures(client: TestClient) -> list[str]:
    """Terminal captures whose local copy is still unverified — LEASE AND ALL.

    Deliberately not ``captures_needing_digest``: that is the work *queue* and
    excludes leased rows, so a digest running on the app's loop would make the
    queue look empty and let a test assert before it finished.
    """
    rows = client.app.state.capture_store.execute_read(
        """
        SELECT c.capture_id FROM captures c
        JOIN replicas r ON r.capture_id = c.capture_id
        WHERE r.instance_id = ?
          AND r.state = 'present_unverified'
          AND c.state IN ('completed', 'interrupted', 'failed')
        """,
        (client.app.state.instance_id,),
    )
    return [row["capture_id"] for row in rows]


def settle_views(client: TestClient, *, attempts: int = 200) -> None:
    """Wait for the background views regeneration to finish.

    The refresher runs on the app's own loop, which the TestClient portal keeps
    turning in a background thread — so this polls rather than awaiting. A
    second ``asyncio.run`` cannot await a task belonging to another loop, and
    the tree is the thing under test anyway, not the task object.
    """
    import time

    refresher = client.app.state.views_refresher
    for _ in range(attempts):
        task = refresher._task
        if not refresher._pending and (task is None or task.done()):
            return
        time.sleep(0.01)


def reconcile(client: TestClient) -> object:
    """Run one reconciliation pass synchronously and return its result."""
    import asyncio

    return asyncio.run(client.app.state.reconciler.run_once())
