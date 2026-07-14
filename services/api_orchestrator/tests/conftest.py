"""Shared test fixtures: an in-process fake recorder and a wired app.

The fake recorder is an ``httpx.MockTransport`` that implements just enough of
the recorder's internal API to exercise the orchestrator's run lifecycle
without ROS or a live recorder process. It is a small state machine: ``start``
begins a session and stamps the resolved topics/QoS into the metadata it later
serves; ``stop`` finalizes counters; ``status`` / ``metadata`` reflect state.

Tests can configure failures (e.g. make ``start`` return a recorder error) via
:class:`FakeRecorder` attributes before driving the orchestrator.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from fastapi import FastAPI
from fastapi.testclient import TestClient
from kairos_common import Settings


class FakeRecorder:
    """Minimal in-memory stand-in for the rosbag2_recorder internal API."""

    def __init__(self) -> None:
        self.state: str = "idle"
        self.run_id: str | None = None
        self.started_at: str | None = None
        # Selected topic names (manifest); types resolve only after finalize.
        self.topic_names: list[str] = []
        self.topic_type: str = "sensor_msgs/msg/JointState"
        # Whether the bag has been finalized (post-stop): drives whether
        # rosbag2_metadata + per-topic types are available, like the real recorder.
        self.finalized: bool = False
        # Terminal state the recorder reports after stop (manifest.state). Tests
        # set this to "failed"/"interrupted" to exercise non-completed finalize.
        self.final_state: str = "completed"
        self.final_error: dict[str, Any] | None = None
        # Recording integrity classification reported in the manifest post-stop
        # (ok|dropped|failed|unknown). The stop-time quick check reads this.
        self.integrity: str = "ok"
        # Failure injection knobs for tests.
        self.start_status: int = 201
        self.start_error: dict[str, Any] | None = None
        self.healthz_ok: bool = True
        self.metadata_status: int = 200
        # When set, every request raises a transport-level error (recorder down).
        self.transport_down: bool = False
        # Counters reported after finalize.
        self.message_count: int = 0
        self.bytes: int = 0
        # Optional --start-paused arming snapshot reported on /record/status
        # (OL-①.4). None unless a test opts in.
        self.arming: dict[str, Any] | None = None
        # Record of payloads received (for assertions).
        self.last_start_payload: dict[str, Any] | None = None
        # ---- two-phase start (prepare) knobs ----
        self.prepare_status: int = 201
        self.prepare_error: dict[str, Any] | None = None
        self.prepare_arming: dict[str, Any] = {
            "active": True,
            "matched_topics": [],
            "missing_topics": [],
        }
        self.disarm_at: str | None = "2026-06-24T00:02:00.000Z"
        self.last_prepare_payload: dict[str, Any] | None = None
        self.prepare_call_count: int = 0
        # When set, /record/prepare answers with THIS run_id instead of the
        # payload's — models the recorder extending an already-armed matching
        # session (keep-alive), whose run_id was fixed at first arm time.
        self.prepare_extend_run_id: str | None = None
        self.stop_call_count: int = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        """Dispatch a mocked request to the matching recorder endpoint."""
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
        if path == "/record/metadata":
            return self._metadata()
        return httpx.Response(
            404, json={"error": {"code": "not_found", "message": path}}
        )

    # ---- endpoints --------------------------------------------------------

    def _healthz(self) -> httpx.Response:
        if not self.healthz_ok:
            return httpx.Response(503, json={"status": "down"})
        return httpx.Response(200, json={"status": "ok"})

    def _start(self, request: httpx.Request) -> httpx.Response:
        self.last_start_payload = json.loads(request.content)
        if self.start_error is not None:
            return httpx.Response(self.start_status, json={"error": self.start_error})
        self.run_id = self.last_start_payload["run_id"]
        self.state = "recording"
        self.started_at = "2026-06-24T00:00:00.000Z"
        # Expand the requested topics into the selected set. "all" becomes a
        # fixed discovered set so tests can assert the expansion is synced.
        requested = self.last_start_payload["topics"]
        self.topic_names = (
            ["/joint_states", "/tf"] if requested == "all" else list(requested)
        )
        start_body: dict[str, Any] = {
            "run_id": self.run_id,
            "state": "recording",
            "started_at": self.started_at,
        }
        # The real recorder returns the settled --start-paused arming snapshot in
        # the start body (OL-①.4); mirror that when a test opts in.
        if self.arming is not None:
            start_body["arming"] = self.arming
        return httpx.Response(201, json=start_body)

    def _prepare(self, request: httpx.Request) -> httpx.Response:
        """Fake the recorder's two-phase-start ``/record/prepare``.

        Does not touch ``self.state``/``self.run_id`` (those model the *active
        recording* session and are only set by ``_start``); prepare only stamps
        the payload it was given for later assertions plus a fixed arming/
        disarm_at body, mirroring that the real recorder tracks "armed" as a
        separate thing from "recording".
        """
        self.prepare_call_count += 1
        self.last_prepare_payload = json.loads(request.content)
        if self.prepare_error is not None:
            return httpx.Response(
                self.prepare_status, json={"error": self.prepare_error}
            )
        body = {
            "run_id": self.prepare_extend_run_id or self.last_prepare_payload["run_id"],
            "state": "armed",
            "arming": self.prepare_arming,
            "disarm_at": self.disarm_at,
        }
        return httpx.Response(201, json=body)

    def _stop(self) -> httpx.Response:
        # Idempotent: stopping when idle just returns the current state. On the
        # real recorder the bag is finalized here, so rosbag2_metadata appears.
        # The recorder reports its real terminal state (final_state), which may
        # be failed/interrupted, not necessarily completed.
        self.stop_call_count += 1
        if self.state in ("recording", "stopping"):
            self.state = self.final_state
            self.finalized = True
            self.message_count = 1234
            self.bytes = 567890
        return httpx.Response(200, json={"state": self.state, "run_id": self.run_id})

    def _status(self) -> httpx.Response:
        body: dict[str, Any] = {
            "state": self.state,
            "run_id": self.run_id,
            "started_at": self.started_at,
            "message_count": self.message_count,
            "bytes": self.bytes,
            "topics": list(self.topic_names),
        }
        if self.arming is not None:
            body["arming"] = self.arming
        return httpx.Response(200, json=body)

    def _metadata(self) -> httpx.Response:
        """Return the recorder's real nested metadata shape.

        ``manifest.topics`` carries the selected topics + QoS; the per-topic
        ``type`` is ``null`` until the bag is finalized. ``rosbag2_metadata`` is
        ``null`` until finalize (after stop), then carries ``message_count`` and
        the per-topic types. Total size is the recorder-computed top-level
        ``bytes`` field (rosbag2 ``files[].size`` is unreliable, so it is
        omitted here on purpose).
        """
        if self.metadata_status != 200:
            return httpx.Response(
                self.metadata_status,
                json={"error": {"code": "metadata_error", "message": "boom"}},
            )
        manifest = {
            "run_id": self.run_id,
            # The recorder records its own state/error in the manifest; the
            # orchestrator finalizes the run row from this (not "always done").
            "state": self.state,
            "error": self.final_error if self.finalized else None,
            "topics": [
                {
                    "name": name,
                    # Types are null pre-finalize; filled from rosbag2 after stop.
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
            "ended_at": "2026-06-24T00:05:00.000Z" if self.finalized else None,
            # Recorder integrity classification (post-finalize); "unknown" until
            # the bag is finalized, mirroring the real recorder.
            "integrity": self.integrity if self.finalized else "unknown",
        }
        rosbag2_metadata = None
        if self.finalized:
            rosbag2_metadata = {
                "message_count": self.message_count,
                # files[].size is unreliable (no size), like the real recorder.
                "files": [{"path": f"{self.run_id}_0.mcap"}],
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
                "manifest": manifest,
                "rosbag2_metadata": rosbag2_metadata,
                # Recorder-computed total size (top-level), present after finalize.
                "bytes": self.bytes if self.finalized else None,
            },
        )


@pytest.fixture
def fake_recorder() -> FakeRecorder:
    """A fresh fake recorder per test."""
    return FakeRecorder()


@pytest.fixture
def settings() -> Settings:
    """Settings pointing the recorder client at the mocked transport.

    ``recording_config`` / ``stream_config`` point at paths that do not exist so
    the factory boots with ``default_topics = None`` and an empty stream layout
    regardless of the working directory (the defaults are repo-relative and would
    otherwise be picked up when pytest runs from the repo root).
    """
    return Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
    )


@pytest.fixture
def store() -> RunStore:
    """An in-memory runs store (shared connection) per test."""
    s = RunStore(":memory:")
    yield s
    s.close()


@pytest.fixture
def app(settings: Settings, store: RunStore, fake_recorder: FakeRecorder) -> FastAPI:
    """The wired orchestrator app backed by the in-memory store + fake recorder."""
    client = httpx.AsyncClient(transport=httpx.MockTransport(fake_recorder.handler))
    return create_orchestrator_app(settings, store=store, http_client=client)


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    """A FastAPI TestClient (enters lifespan -> runs startup reconciliation)."""
    with TestClient(app) as test_client:
        yield test_client
