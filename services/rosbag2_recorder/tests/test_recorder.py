# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""State machine + recording mechanics, with the subprocess mocked out.

The ``ros2 bag record`` spawn and OS-signal delivery are replaced by the
:func:`_make_session` helper, so the full lifecycle runs without ROS 2. The
``FakeProcess`` class and the rosbag2-metadata writer arrive via the
``fake_process`` / ``write_metadata`` fixtures (see ``conftest.py``).
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from kairos_common import ApiError, Compression, Settings
from kairos_common.capture_sidecars import (
    ObjectManifestV2,
    capture_dir,
    failed_start_path,
    objects_dir,
    read_object_manifest,
)
from kairos_common.ids import is_uuid7
from kairos_common.instance import read_instance
from rosbag2_recorder.models import (
    QosProfile,
    RecordArming,
    RecordStartRequest,
    RunState,
    SplitConfig,
)
from rosbag2_recorder.recorder import RECORDER_NODE_NAME, RecorderSession


class _FakeArmedNode:
    """Stand-in for the rclpy Node kept alive across prepare() -> start().

    ``_teardown_armed_rclpy`` calls ``.destroy_node()``, and the armed session's
    readiness refresh (``_refresh_arming_locked``) reads the ROS graph through
    this node, so the fake answers both. It defaults to a fully-healthy graph
    (every target published and subscribed by the recorder); a test that wants a
    degraded graph passes explicit ``pubs``/``subs`` maps.
    """

    def __init__(
        self,
        pubs: dict[str, int] | None = None,
        subs: dict[str, list[str]] | None = None,
    ) -> None:
        self._pubs = pubs
        self._subs = subs

    def count_publishers(self, topic: str) -> int:
        return 1 if self._pubs is None else self._pubs.get(topic, 0)

    def get_subscriptions_info_by_topic(self, topic: str) -> list[Any]:
        names = (
            [RECORDER_NODE_NAME] if self._subs is None else self._subs.get(topic, [])
        )
        return [SimpleNamespace(node_name=n) for n in names]

    def get_topic_names_and_types(self) -> list[tuple[str, list[str]]]:
        return [(name, []) for name in (self._pubs or {})]

    def destroy_node(self) -> None:
        pass


def _make_session(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
    *,
    config: Any = None,
    capture: list[Any] | None = None,
    behavior: str = "record",
    returncode: int = 0,
) -> RecorderSession:
    """Build a session whose subprocess spawn + signalling are stubbed.

    *behavior* models what the fake ``ros2 bag record`` does on spawn (it must
    NOT create the --output dir before the real check; the fake mimics ros2
    creating it as proof of a successful start):

    - ``"record"``    create the capture dir + a rosbag2 metadata.yaml, stay
                      alive -> start succeeds, a later stop completes.
    - ``"no_metadata"`` create the capture dir only, stay alive -> start
                      succeeds, but a later stop finds no bag -> ``failed``.
    - ``"no_dir"``    create nothing, exit immediately -> start failure (the
                      output dir never appears).
    """
    session = RecorderSession(settings, config)
    alive = behavior != "no_dir"

    def fake_spawn(cmd: list[str]) -> Any:
        proc = fake_process(cmd, returncode=returncode, alive=alive)
        if capture is not None:
            capture.append(proc)
        out = Path(cmd[cmd.index("--output") + 1])
        if behavior == "record":
            write_metadata(out)  # also creates the capture dir
        elif behavior == "no_metadata":
            out.mkdir(parents=True, exist_ok=True)  # dir but no bag
        return proc

    def fake_prepare_arm(run_id: str, topics: list[str], all_mode: bool) -> Any:
        # Mimic what the real _prepare_arm (via _await_subscription_match)
        # would seed, so prepare()'s response/status carry a realistic arming
        # snapshot without needing ROS.
        session._arming = RecordArming(
            active=True, matched_topics=list(topics), missing_topics=[]
        )
        return (_FakeArmedNode(), object(), object(), False)

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    # FakeProcess shares our pid; never deliver a real OS signal from a unit test
    # (killpg(getpgid(our own pid)) would SIGTERM/SIGINT the test runner itself).
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]
    session._terminate_failed_start = lambda _proc: None  # type: ignore[method-assign]
    # Arming (subscription gate + resume) needs ROS; stub it to a no-op so the
    # state machine runs without ROS. Tests that exercise arming override this.
    session._arm_and_resume = lambda *_a, **_k: None  # type: ignore[method-assign]
    # Two-phase start's rclpy-touching pieces also need ROS; stub them to a
    # matched-but-inert pair so prepare()/the fast start() path run without ROS.
    # Tests that exercise the fast path's failure mode override _resume_armed.
    session._prepare_arm = fake_prepare_arm  # type: ignore[method-assign]
    session._resume_armed = lambda _armed: None  # type: ignore[method-assign]
    return session


def _start_req(
    run_id: str = "run_1",
    topics: Any = None,
    **kw: Any,
) -> RecordStartRequest:
    return RecordStartRequest(
        topics=topics if topics is not None else ["/joint_states"],
        run_id=run_id,
        **kw,
    )


def _manifest(settings: Settings, capture_id: str) -> ObjectManifestV2:
    """Read (and validate) a capture's object_manifest.json, or fail the test."""
    read = read_object_manifest(capture_dir(settings.data_dir, capture_id))
    assert read.ok, f"{read.status}: {read.error}"
    assert read.manifest is not None
    return read.manifest


def _failed_start(settings: Settings, capture_id: str) -> ObjectManifestV2:
    """Read the sibling ``objects/<capture_id>.failed.json``."""
    read = read_object_manifest(failed_start_path(settings.data_dir, capture_id))
    assert read.ok, f"{read.status}: {read.error}"
    assert read.manifest is not None
    return read.manifest


# -- layout + identity --------------------------------------------------------


def test_capture_is_written_under_objects_by_capture_id(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The recording's path is objects/<capture_id>/, not recorded/<run_id>/."""
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    started = session.start(_start_req("run_layout"))

    capture_id = started.capture_id
    assert capture_id is not None and is_uuid7(capture_id)
    expected = objects_dir(settings.data_dir) / capture_id
    assert expected.is_dir()
    assert captured[0].cmd[captured[0].cmd.index("--output") + 1] == str(expected)
    # The pre-v2 tree is gone entirely.
    assert not (Path(settings.data_dir) / "recorded").exists()
    # run_id survives as a display name on the capture, not as a path.
    assert _manifest(settings, capture_id).run_id == "run_layout"


def test_capture_ids_are_unique_per_start(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Two recordings never share an id — not even under the same run_id."""
    session = _make_session(settings, fake_process, write_metadata)
    first = session.start(_start_req("run_same")).capture_id
    session.stop()
    second = session.start(_start_req("run_same")).capture_id
    session.stop()
    assert first != second
    assert {p.name for p in objects_dir(settings.data_dir).iterdir() if p.is_dir()} == {
        first,
        second,
    }


def test_source_instance_id_is_the_installations_own(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Every manifest carries this data_dir's instance id, minted once (§1)."""
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req()).capture_id
    assert capture_id is not None
    session.stop()

    info = read_instance(settings.data_dir)
    assert info is not None
    assert _manifest(settings, capture_id).source_instance_id == info.instance_id

    # A second session on the same data_dir must NOT re-mint the identity: it is
    # what replica rows are keyed by, and a new one would orphan every manifest.
    second = _make_session(settings, fake_process, write_metadata)
    assert second._instance_id == info.instance_id


def test_store_roots_are_created_host_writable(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The recorder (root) relaxes every root uid 1000 has to write to (§2).

    The orchestrator renames captures into ``.trash`` on delete and stages
    imports in ``.incoming`` before moving them into ``objects``; a root-owned
    one of those fails at runtime, on the operator's action, rather than here.
    Creating all three together is also what makes them same-filesystem by
    construction, which those renames require.
    """
    session = _make_session(settings, fake_process, write_metadata)
    session.ensure_ready()

    root = Path(settings.data_dir)
    for store_root in (objects_dir(root), root / ".trash", root / ".incoming"):
        assert store_root.is_dir(), store_root
        assert (store_root.stat().st_mode & 0o777) == 0o777, store_root
    # Same filesystem, so the renames those roots exist for cannot EXDEV.
    devices = {
        p.stat().st_dev
        for p in (objects_dir(root), root / ".trash", root / ".incoming")
    }
    assert len(devices) == 1


def test_capture_dir_is_host_writable(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The capture dir is chmod'd world-writable so the host/UI can remove it."""
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_p")).capture_id
    assert capture_id is not None
    cd = capture_dir(settings.data_dir, capture_id)
    assert (cd.stat().st_mode & 0o777) == 0o777


def test_sibling_files_are_named_by_capture_id(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """qos / storage-config siblings sit beside the capture dir, keyed by its id.

    They must be siblings, never inside: ``ros2 bag record`` refuses a
    pre-existing ``--output``, so nothing may create the capture dir first.
    """
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    seen: dict[str, Path] = {}

    def watching_spawn(cmd: list[str]) -> Any:
        out = Path(cmd[cmd.index("--output") + 1])
        assert not out.exists(), "capture dir must not exist before ros2 bag record"
        for flag in ("--qos-profile-overrides-path", "--storage-config-file"):
            path = Path(cmd[cmd.index(flag) + 1])
            assert path.exists()
            assert path.parent == out.parent
            assert path.name.startswith(out.name)
            seen[flag] = path
        write_metadata(out)
        return fake_process(cmd, alive=True)

    session._spawn_process = watching_spawn  # type: ignore[method-assign]
    started = session.start(
        _start_req(
            "run_sib",
            topics=["/cam"],
            compression=Compression.zstd,
            qos_overrides={"/cam": QosProfile(depth=1)},
        )
    )
    capture_id = started.capture_id
    assert seen["--qos-profile-overrides-path"].name == f"{capture_id}.qos.yaml"
    assert seen["--storage-config-file"].name == f"{capture_id}.mcap-storage.yaml"

    # Both are cleaned up on stop; only the capture dir remains under objects/.
    session.stop()
    assert not seen["--qos-profile-overrides-path"].exists()
    assert not seen["--storage-config-file"].exists()


# -- object_manifest.json v2 --------------------------------------------------


def test_manifest_v2_replaces_manifest_and_session_json(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """One sidecar holds what manifest.json and session.json used to split."""
    session = _make_session(settings, fake_process, write_metadata)
    started = session.start(
        _start_req("run_one", operator="yuki", task="pick-and-place", robot="hsr")
    )
    capture_id = started.capture_id
    assert capture_id is not None
    session.stop()

    cd = capture_dir(settings.data_dir, capture_id)
    names = {p.name for p in cd.iterdir()}
    assert "object_manifest.json" in names
    assert "manifest.json" not in names
    assert "session.json" not in names

    manifest = _manifest(settings, capture_id)
    # The operator/task half of the old session.json...
    assert manifest.operator == "yuki"
    assert manifest.task == "pick-and-place"
    assert manifest.robot == "hsr"
    # ...and the audit half of the old manifest.json.
    assert manifest.state == "completed"
    assert manifest.message_count == 42
    assert manifest.bytes == 1024
    assert [t["name"] for t in manifest.topics] == ["/joint_states"]


def test_manifest_written_at_start_stop_and_finalise(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Each write point leaves the manifest describing the state it is in."""
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_points")).capture_id
    assert capture_id is not None

    mid_run = _manifest(settings, capture_id)
    assert mid_run.state == "recording"
    assert mid_run.ended_at is None

    stopping: list[str] = []
    session._signal_and_wait = lambda _p: stopping.append(  # type: ignore[method-assign]
        _manifest(settings, capture_id).state
    )
    session.stop()
    # The transition to `stopping` is durable BEFORE the SIGINT flush, so a
    # crash during the flush is recoverable as an unfinalized capture.
    assert stopping == ["stopping"]

    final = _manifest(settings, capture_id)
    assert final.state == "completed"
    assert final.ended_at is not None


def test_finalised_manifest_leaves_the_digest_to_the_orchestrator(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Finalise hands off with digest_state=pending and no hashes (§3.3).

    Claiming a digest the recorder never computed would let a replica be
    promoted to verified against a value nothing checked.
    """
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_digest")).capture_id
    assert capture_id is not None
    session.stop()

    manifest = _manifest(settings, capture_id)
    assert manifest.digest_state == "pending"
    assert manifest.files is None
    assert manifest.manifest_digest is None
    assert manifest.schema_version == 2


def test_manifest_preserves_compression_split_and_integrity(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(
        _start_req(
            "run_fields",
            compression=Compression.zstd,
            split=SplitConfig(max_size_mb=100, max_duration_s=60),
        )
    ).capture_id
    assert capture_id is not None
    session.stop()

    manifest = _manifest(settings, capture_id)
    assert manifest.compression == "zstd"
    assert manifest.split == {"max_size_mb": 100, "max_duration_s": 60}
    assert manifest.integrity == "unknown"  # no log to scan under a fake spawn
    assert manifest.dropped_messages is None


def test_manifest_metadata_defaults_to_unknown_placeholders(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Omitted/blank operator+task become placeholders, never null.

    Null operator/task has its own meaning in §3.3 — the capture was imported,
    not recorded here — so a recorded capture must not borrow that spelling.
    """
    session = _make_session(settings, fake_process, write_metadata)
    started = session.start(_start_req("run_blank", operator="  ", task=""))
    capture_id = started.capture_id
    assert capture_id is not None
    session.stop()

    manifest = _manifest(settings, capture_id)
    assert manifest.operator == "unknown_operator"
    assert manifest.task == "unknown_task"
    assert manifest.imported_from is None


def test_robot_falls_back_to_the_recording_config(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A start that names no robot inherits the recorder's configured one."""
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(robot_name="hsr", recording=RecordingTuning(start_delay_s=0))
    session = _make_session(settings, fake_process, write_metadata, config=cfg)
    capture_id = session.start(_start_req("run_robot")).capture_id
    assert capture_id is not None
    assert _manifest(settings, capture_id).robot == "hsr"


# -- failed starts (§3.4) -----------------------------------------------------


def test_failed_start_writes_a_sibling_marker_not_a_capture_dir(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A start that made no bag leaves objects/<id>.failed.json and no dir.

    §2's invariant is that a directory under objects/ means bytes were written;
    a failed start that created one would look like a recording to every scan.
    """
    session = _make_session(
        settings, fake_process, write_metadata, behavior="no_dir", returncode=1
    )
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_fail", topics=["/totally_different"]))

    assert exc.value.status_code == 507
    assert exc.value.code == "record_start_failed"
    capture_id = exc.value.details["capture_id"]
    assert is_uuid7(capture_id)
    assert not capture_dir(settings.data_dir, capture_id).exists()

    marker = _failed_start(settings, capture_id)
    assert marker.state == "failed"
    assert marker.run_id == "run_fail"
    assert marker.error is not None
    assert [t["name"] for t in marker.topics] == ["/totally_different"]
    # The session itself stays idle.
    assert session.status().state is RunState.created


def test_failed_prepare_is_not_filed_as_a_capture(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """S2-7: a failed pre-arm probe answers 507 but mints no failed capture.

    prepare() is the console's background keep-alive, repeated every 30 s. A
    persistent arm blocker (topic mismatch, disk full) used to deposit
    objects/<id>.failed.json — and, through the orchestrator, a failed row —
    per attempt: an unbounded pile of "Not usable" captures nobody asked to
    create, while the screen showed nothing. The failure now lives in the
    response (the console surfaces it) and the log; only an operator start()
    files.
    """
    session = _make_session(
        settings, fake_process, write_metadata, behavior="no_dir", returncode=1
    )
    with pytest.raises(ApiError) as exc:
        session.prepare(_start_req("run_prearm_fail"))

    assert exc.value.status_code == 507
    capture_id = exc.value.details["capture_id"]
    assert is_uuid7(capture_id)
    # Nothing under objects/ carries this id: no dir, no .failed.json, and no
    # leftover .qos.yaml / storage-config siblings either.
    objects_root = Path(settings.data_dir) / "objects"
    assert list(objects_root.glob(f"{capture_id}*")) == []
    assert session.status().state is RunState.created


def test_failed_start_write_error_is_surfaced_in_the_response(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A marker that could not be written is reported, never swallowed (§3.4).

    The caller is the only party that will ever learn this start left no trace
    on disk, so the failure has to reach the error response.
    """
    import rosbag2_recorder.recorder as rec

    session = _make_session(
        settings, fake_process, write_metadata, behavior="no_dir", returncode=1
    )

    def boom(*_a: Any, **_k: Any) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(rec, "write_failed_start", boom)
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_nospace"))

    assert exc.value.code == "record_start_failed"
    assert "No space left on device" in exc.value.details["failed_start_record_error"]
    assert not failed_start_path(
        settings.data_dir, exc.value.details["capture_id"]
    ).exists()


def test_failed_start_after_completed_run_keeps_previous_status(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A failed start must not corrupt the previous capture's status.

    self._topics is staged and only committed on success, so a failed attempt's
    topics never leak into /record/status (which still reports the prior
    capture_id/run_id/state).
    """
    session = _make_session(settings, fake_process, write_metadata)
    good = session.start(_start_req("run_ok", topics=["/joint_states"])).capture_id
    session.stop()
    assert session.status().state is RunState.completed

    def failing_spawn(cmd: list[str]) -> Any:
        return fake_process(cmd, returncode=1, alive=False)

    session._spawn_process = failing_spawn  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_bad", topics=["/totally_different"]))
    bad = exc.value.details["capture_id"]

    st = session.status()
    assert st.run_id == "run_ok"
    assert st.capture_id == good
    assert st.state is RunState.completed
    assert [t.name for t in st.topics] == ["/joint_states"]
    assert bad != good
    assert [t["name"] for t in _failed_start(settings, bad).topics] == [
        "/totally_different"
    ]


def test_start_failure_when_process_hangs_without_dir(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    # Process stays ALIVE but never creates the output dir -> must be a start
    # failure (not success), and must not leave a capture dir behind.
    import rosbag2_recorder.recorder as rec

    # Make the wait short so the test is fast.
    monkeypatch.setattr(rec, "START_DIR_TIMEOUT_S", 0.05)
    session = RecorderSession(settings, None)
    terminated: list[Any] = []

    def fake_spawn(cmd: list[str]) -> Any:
        # Alive, but creates NO dir and no metadata.
        return fake_process(cmd, alive=True)

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    session._terminate_failed_start = lambda proc: terminated.append(proc)  # type: ignore[method-assign]

    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_hang"))
    assert exc.value.status_code == 507
    assert exc.value.code == "record_start_failed"
    # The stuck process was asked to terminate, the session is idle, no capture.
    assert terminated, "a hung start process must be terminated"
    assert session.status().state is RunState.created
    assert not capture_dir(settings.data_dir, exc.value.details["capture_id"]).exists()


def test_failed_start_removes_a_directory_created_as_we_gave_up(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A dir appearing right as the start times out must not survive the failure.

    ``ros2 bag record`` can create its output directory in the instant between
    the readiness check giving up and the process being killed. Leaving it would
    put a directory AND a .failed.json under the same capture_id — §3.4 says a
    failed start is the marker and nothing else, and the pair makes every scan
    report a contradiction (rebuild warns and trusts the directory).
    """
    session = _make_session(settings, fake_process, write_metadata)
    late: dict[str, str] = {}

    def dir_appears_after_giving_up(capture_id: str, _process: Any) -> bool:
        late["capture_id"] = capture_id
        capture_dir(settings.data_dir, capture_id).mkdir(parents=True, exist_ok=True)
        return False

    session._await_started = dir_appears_after_giving_up  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_late_dir"))

    capture_id = exc.value.details["capture_id"]
    assert capture_id == late["capture_id"]
    assert not capture_dir(settings.data_dir, capture_id).exists()
    assert _failed_start(settings, capture_id).state == "failed"


def test_undeletable_capture_dir_is_reported_not_ignored(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Residue from a failed cleanup is logged, never swallowed.

    A directory left under objects/ with no manifest breaks §2's invariant, and
    the next startup has to guess what it was. Silent ignore_errors would make
    that guess arrive with no record of why it was needed.
    """
    import rosbag2_recorder.recorder as rec

    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(_start_req("run_stuck"))
    monkeypatch.setattr(rec.shutil, "rmtree", lambda *a, **k: None)

    with caplog.at_level("WARNING", logger="kairos.rosbag2_recorder"):
        session.stop()  # disarms

    assert capture_dir(settings.data_dir, prepared.capture_id).exists()
    assert any(
        "abandoned capture directory" in r.message and r.levelname == "WARNING"
        for r in caplog.records
    )


# -- live capture visibility (§8 rule 1) --------------------------------------


def test_status_reports_the_live_capture_id(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The rebuild asks the recorder what it is holding; it must answer."""
    session = _make_session(settings, fake_process, write_metadata)
    assert session.status().live_capture_ids == []

    started = session.start(_start_req("run_live"))
    live = session.status()
    assert live.capture_id == started.capture_id
    assert live.live_capture_ids == [started.capture_id]

    session.stop()
    done = session.status()
    # Finalised: still reported as this session's capture, but no longer LIVE —
    # the rebuild may now adopt it, and the digest job may hash it.
    assert done.capture_id == started.capture_id
    assert done.live_capture_ids == []


def test_status_reports_an_armed_capture_as_live(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """An armed capture has a directory but no manifest yet — the worst case.

    A rebuild that did not skip it would find a directory with no
    object_manifest.json and either invent a row or warn about a capture that
    is about to become perfectly normal.
    """
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(_start_req("run_armed_live"))
    cd = capture_dir(settings.data_dir, prepared.capture_id)
    assert cd.is_dir()
    assert not (cd / "object_manifest.json").exists()

    status = session.status()
    assert status.state is RunState.armed
    assert status.capture_id == prepared.capture_id
    assert status.live_capture_ids == [prepared.capture_id]


# -- crash recovery (§3.3) ----------------------------------------------------


def _plant(
    settings: Settings,
    state: str,
    *,
    with_bag: bool = True,
    digest_state: str = "pending",
    files: Any = None,
    manifest_digest: str | None = None,
) -> str:
    """Write a capture directory on disk as a previous process would have left it."""
    from kairos_common.capture_sidecars import write_object_manifest
    from kairos_common.ids import new_capture_id, new_instance_id

    capture_id = new_capture_id()
    cd = capture_dir(settings.data_dir, capture_id)
    cd.mkdir(parents=True, exist_ok=True)
    if with_bag:
        (cd / f"{capture_id}_0.mcap").write_bytes(b"\x00" * 16)
        (cd / "metadata.yaml").write_text("rosbag2_bagfile_information: {}\n")
    write_object_manifest(
        cd,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=new_instance_id(),
            run_id="run_planted",
            state=state,
            started_at="2026-08-02T00:00:00.000Z",
            digest_state=digest_state,
            files=files,
            manifest_digest=manifest_digest,
        ),
    )
    return capture_id


def test_reconcile_marks_unfinalized_captures_interrupted(
    settings: Settings,
) -> None:
    recording = _plant(settings, "recording")
    stopping = _plant(settings, "stopping")

    RecorderSession(settings, None).reconcile_on_startup()

    for capture_id in (recording, stopping):
        manifest = _manifest(settings, capture_id)
        assert manifest.state == "interrupted"
        assert manifest.ended_at is not None
        assert manifest.error is not None
        assert manifest.digest_state == "pending"


def test_reconcile_marks_a_bagless_capture_failed(settings: Settings) -> None:
    """No metadata.yaml and no .mcap: the process wrote nothing to salvage.

    The same discriminator finalise and the rebuild use (§8 rule 2), so the
    three never disagree about one directory.
    """
    empty = _plant(settings, "recording", with_bag=False)
    RecorderSession(settings, None).reconcile_on_startup()
    assert _manifest(settings, empty).state == "failed"


def test_reconcile_never_touches_a_finalised_capture(settings: Settings) -> None:
    """After finalise the digest job owns the manifest — a rewrite would race it.

    A completed capture whose digest has already been sealed must come through
    startup byte-identical: re-writing it would drop files/manifest_digest and
    silently demote a verified replica.
    """
    from kairos_common.capture_sidecars import ManifestFile

    sealed_files = (ManifestFile(path="bag_0.mcap", size=16, sha256="a" * 64),)
    completed = _plant(
        settings,
        "completed",
        digest_state="complete",
        files=sealed_files,
        manifest_digest="sha256:" + "b" * 64,
    )
    interrupted = _plant(settings, "interrupted")
    failed = _plant(settings, "failed", with_bag=False)

    before = {
        capture_id: (
            capture_dir(settings.data_dir, capture_id) / "object_manifest.json"
        ).read_bytes()
        for capture_id in (completed, interrupted, failed)
    }
    RecorderSession(settings, None).reconcile_on_startup()
    for capture_id, raw in before.items():
        path = capture_dir(settings.data_dir, capture_id) / "object_manifest.json"
        assert path.read_bytes() == raw, f"{capture_id} was rewritten"


def test_reconcile_leaves_a_corrupt_manifest_alone(settings: Settings) -> None:
    """Unreadable is not absent (§8 rule 4): report it, never repair it."""
    capture_id = _plant(settings, "recording")
    path = capture_dir(settings.data_dir, capture_id) / "object_manifest.json"
    path.write_bytes(b"")  # the signature of a crash between rename and writeback

    RecorderSession(settings, None).reconcile_on_startup()
    assert path.read_bytes() == b""


def test_reconcile_ignores_directories_that_are_not_captures(
    settings: Settings,
) -> None:
    """Only UUIDv7 names are captures; anything else under objects/ is not ours."""
    stray = objects_dir(settings.data_dir) / "recorded"
    stray.mkdir(parents=True)
    (stray / "object_manifest.json").write_text("{}")

    RecorderSession(settings, None).reconcile_on_startup()
    assert (stray / "object_manifest.json").read_text() == "{}"


def test_reconcile_archives_the_leftover_recorder_log(settings: Settings) -> None:
    """A crash leaves the log a sibling; recovery files it with the capture."""
    from rosbag2_recorder.recorder import _recorder_log_path

    capture_id = _plant(settings, "recording")
    log = _recorder_log_path(objects_dir(settings.data_dir), capture_id)
    log.write_text("Total lost: 3\n")

    RecorderSession(settings, None).reconcile_on_startup()
    assert not log.exists()
    assert (
        capture_dir(settings.data_dir, capture_id) / "recorder.log"
    ).read_text() == "Total lost: 3\n"


def test_reconcile_rescans_counters_instead_of_trusting_the_manifest(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Recovery re-measures the bag; the start-time numbers describe nothing.

    The manifest a crashed recording left behind was written in its first
    second. Carrying those counters forward would file an hour of recording as
    the few kilobytes that existed when it began, and would never read the drop
    count the process reported on its way down.
    """
    from rosbag2_recorder.recorder import _recorder_log_path

    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_grew")).capture_id
    assert capture_id is not None
    assert _manifest(settings, capture_id).bytes == 1024  # start-time snapshot

    # The bag grows after that write, as a real recording's would, and rosbag2
    # reports cache drops into the sibling log on its way down.
    cd = capture_dir(settings.data_dir, capture_id)
    write_metadata(cd, message_count=999, size_bytes=5_000_000)
    _recorder_log_path(objects_dir(settings.data_dir), capture_id).write_text(
        "Cache buffers lost messages per topic:\n\t/a: 7\nTotal lost: 7\n"
    )

    RecorderSession(settings, None).reconcile_on_startup()

    recovered = _manifest(settings, capture_id)
    assert recovered.state == "interrupted"
    assert recovered.bytes == 5_000_000
    assert recovered.message_count == 999
    # Read from the ARCHIVED copy — the sibling is gone by the time we scan.
    assert recovered.dropped_messages == 7


def test_reconcile_is_idempotent(settings: Settings) -> None:
    """A second startup must not rewrite what the first one recovered.

    Recovery moves a capture to a terminal state, at which point the digest job
    owns it (§3.3); a restart loop that kept rewriting would race that job
    forever.
    """
    capture_id = _plant(settings, "recording")
    RecorderSession(settings, None).reconcile_on_startup()
    path = capture_dir(settings.data_dir, capture_id) / "object_manifest.json"
    first = path.read_bytes()

    RecorderSession(settings, None).reconcile_on_startup()
    assert path.read_bytes() == first


def test_reconcile_does_not_follow_a_symlink(settings: Settings) -> None:
    """A symlink under objects/ is never followed, let alone written through.

    Nothing kairos writes there is a link; one that appears could point at
    another capture's directory — or outside the store entirely — and following
    it would let a manifest rewrite land wherever it aimed.
    """
    real = _plant(settings, "recording")
    from kairos_common.ids import new_capture_id

    link = objects_dir(settings.data_dir) / new_capture_id()
    link.symlink_to(capture_dir(settings.data_dir, real))
    before = (
        capture_dir(settings.data_dir, real) / "object_manifest.json"
    ).read_bytes()

    RecorderSession(settings, None).reconcile_on_startup()

    # The link is untouched and the target was recovered exactly once — through
    # its own directory entry, not through the link.
    assert link.is_symlink()
    after = (capture_dir(settings.data_dir, real) / "object_manifest.json").read_bytes()
    assert after != before  # the real directory WAS recovered
    assert _manifest(settings, real).state == "interrupted"


def test_reconcile_leaves_a_manifest_naming_another_capture_alone(
    settings: Settings,
) -> None:
    """A manifest whose capture_id is not its directory's is not ours to fix.

    Rewriting it would stamp this directory's id onto whatever that other
    capture actually is, inventing an identity nothing on disk supports.
    """
    from kairos_common.capture_sidecars import write_object_manifest
    from kairos_common.ids import new_capture_id, new_instance_id

    capture_id = new_capture_id()
    cd = capture_dir(settings.data_dir, capture_id)
    cd.mkdir(parents=True)
    (cd / f"{capture_id}_0.mcap").write_bytes(b"\x00" * 16)
    write_object_manifest(
        cd,
        ObjectManifestV2(
            capture_id=new_capture_id(),  # names a DIFFERENT capture
            source_instance_id=new_instance_id(),
            run_id="run_confused",
            state="recording",
            started_at="2026-08-02T00:00:00.000Z",
        ),
    )
    before = (cd / "object_manifest.json").read_bytes()

    RecorderSession(settings, None).reconcile_on_startup()
    assert (cd / "object_manifest.json").read_bytes() == before


def _plant_orphan(settings: Settings, *, bag: str) -> str:
    """A capture directory with NO manifest, as a crash mid-arm/start leaves it.

    *bag* selects what the dead process managed to write: ``"recorded"`` for a
    real bag, ``"empty"`` for the 0-byte storage file a paused recorder creates
    the instant it starts.
    """
    from kairos_common.ids import new_capture_id
    from rosbag2_recorder.recorder import _recorder_log_path

    capture_id = new_capture_id()
    cd = capture_dir(settings.data_dir, capture_id)
    cd.mkdir(parents=True)
    if bag == "recorded":
        (cd / f"{capture_id}_0.mcap").write_bytes(b"\x00" * 2048)
        (cd / "metadata.yaml").write_text(
            "rosbag2_bagfile_information:\n"
            "  message_count: 17\n"
            "  topics_with_message_count:\n"
            "  - topic_metadata:\n"
            "      name: /joint_states\n"
            "      type: sensor_msgs/msg/JointState\n"
            "    message_count: 17\n"
        )
    else:
        (cd / f"{capture_id}_0.mcap").write_bytes(b"")
    _recorder_log_path(objects_dir(settings.data_dir), capture_id).write_text(
        "Total lost: 4\n"
    )
    (objects_dir(settings.data_dir) / f"{capture_id}.qos.yaml").write_text("{}\n")
    return capture_id


def test_reconcile_adopts_a_manifestless_capture_that_holds_a_bag(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Bytes with no manifest are recovered, not discarded.

    Only this recorder can have made the directory — imports arrive atomically
    from .incoming/ — so it is an arm or start that died before its first
    manifest write. Throwing away a real recording for want of its sidecar is
    not a call recovery gets to make.
    """
    from kairos_common import RecordingConfig, RecordingTuning

    capture_id = _plant_orphan(settings, bag="recorded")
    cfg = RecordingConfig(robot_name="hsr", recording=RecordingTuning(start_delay_s=0))

    _make_session(
        settings, fake_process, write_metadata, config=cfg
    ).reconcile_on_startup()

    manifest = _manifest(settings, capture_id)
    assert manifest.state == "interrupted"
    assert manifest.capture_id == capture_id
    # run_id is display-only (§1), so synthesizing one is safe and necessary.
    assert manifest.run_id.startswith("run_recovered_")
    assert manifest.digest_state == "pending"
    assert manifest.files is None
    # Measured, not invented.
    assert manifest.bytes == 2048
    assert manifest.message_count == 17
    assert manifest.dropped_messages == 4
    assert [t["name"] for t in manifest.topics] == ["/joint_states"]
    # Unknowable metadata uses the SAME placeholders a live start writes, never
    # null: null operator/task is §3.3's import-only spelling, and a capture
    # recovered here was recorded locally. The robot comes from the recorder's
    # own config, which is the only thing that still knows it.
    assert manifest.operator == "unknown_operator"
    assert manifest.task == "unknown_task"
    assert manifest.robot == "hsr"
    assert manifest.imported_from is None
    assert manifest.error is not None
    # The log is filed with the capture and the dir is host-writable.
    cd = capture_dir(settings.data_dir, capture_id)
    assert (cd / "recorder.log").exists()
    assert (cd.stat().st_mode & 0o777) == 0o777


def test_reconcile_removes_a_manifestless_capture_with_no_bag(
    settings: Settings,
) -> None:
    """A crash while armed leaves a 0-byte bag; that is a cancel, not a capture.

    A paused ``ros2 bag record`` opens its storage file immediately, so the
    directory looks occupied while holding nothing. Adopting it would publish
    an empty capture with synthesized metadata for an operator to puzzle over;
    §2's invariant is restored by removing it instead, and — like any disarm —
    no failed-start marker is written.
    """
    from rosbag2_recorder.recorder import _recorder_log_path

    capture_id = _plant_orphan(settings, bag="empty")

    RecorderSession(settings, None).reconcile_on_startup()

    assert not capture_dir(settings.data_dir, capture_id).exists()
    assert not _recorder_log_path(objects_dir(settings.data_dir), capture_id).exists()
    assert not (objects_dir(settings.data_dir) / f"{capture_id}.qos.yaml").exists()
    assert not failed_start_path(settings.data_dir, capture_id).exists()


def test_reconcile_does_not_claim_a_removal_that_failed(
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """When the delete fails, recovery must not also report success.

    Two log lines saying the directory was removed and that it could not be
    removed are worse than either alone: whoever reads them during an incident
    has to guess which one is true.
    """
    import rosbag2_recorder.recorder as rec

    capture_id = _plant_orphan(settings, bag="empty")
    monkeypatch.setattr(rec.shutil, "rmtree", lambda *a, **k: None)

    with caplog.at_level("WARNING", logger="kairos.rosbag2_recorder"):
        RecorderSession(settings, None).reconcile_on_startup()

    assert capture_dir(settings.data_dir, capture_id).exists()
    messages = [r.message for r in caplog.records]
    assert any("could not fully remove" in m for m in messages)
    assert not any("removed an empty capture directory" in m for m in messages)


# -- lifecycle ----------------------------------------------------------------


def test_full_lifecycle_created_recording_completed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    assert session.status().state is RunState.created

    started = session.start(_start_req())
    assert started.state is RunState.recording
    assert started.run_id == "run_1"
    assert started.started_at  # populated
    capture_id = started.capture_id
    assert capture_id is not None

    assert _manifest(settings, capture_id).state == "recording"

    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert stopped.message_count == 42
    assert stopped.bytes == 1024

    final = _manifest(settings, capture_id)
    assert final.state == "completed"
    assert final.ended_at is not None
    # Stop-time verification counters are finalised into the manifest (OL-①.5).
    assert final.message_count == 42
    assert final.bytes == 1024


def test_post_discovery_delay_applied(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """_apply_post_discovery_delay sleeps recording.post_discovery_delay_s."""
    from unittest.mock import patch

    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(
        robot_name="t", recording=RecordingTuning(post_discovery_delay_s=0.3)
    )
    session = _make_session(settings, fake_process, write_metadata, config=cfg)
    with patch("rosbag2_recorder.recorder.time.sleep") as sleep:
        session._apply_post_discovery_delay()
    sleep.assert_called_once_with(0.3)


def test_finalise_interrupted_when_mcap_missing(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """metadata present but no MCAP data on disk -> interrupted, not completed.

    A bag exists (metadata.yaml), so the capture is salvageable enough to keep
    and hash — it just did not finish (OL-①.3 verification, §8 rule 2).
    """
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_m")).capture_id
    assert capture_id is not None
    for mcap in capture_dir(settings.data_dir, capture_id).glob("*.mcap"):
        mcap.unlink()

    stopped = session.stop()
    assert stopped.state is RunState.interrupted
    final = _manifest(settings, capture_id)
    assert final.state == "interrupted"
    assert final.error and "MCAP" in final.error


def test_finalise_failed_when_nothing_was_written(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """An output dir with neither metadata.yaml nor an MCAP is a failure."""
    session = _make_session(
        settings, fake_process, write_metadata, behavior="no_metadata", returncode=1
    )
    capture_id = session.start(_start_req("run_x")).capture_id
    assert capture_id is not None
    stopped = session.stop()

    assert stopped.state is RunState.failed
    manifest = _manifest(settings, capture_id)
    assert manifest.state == "failed"
    assert manifest.error is not None
    assert manifest.integrity == "failed"


def test_abnormal_returncode_with_data_is_interrupted(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # metadata.yaml present but the process died abnormally (e.g. SIGTERM/-15,
    # disk-full crash): a stale/partial bag must NOT be reported completed —
    # but the bytes are real, so it is interrupted rather than failed.
    session = _make_session(
        settings, fake_process, write_metadata, behavior="record", returncode=-15
    )
    capture_id = session.start(_start_req("run_abn")).capture_id
    assert capture_id is not None
    stopped = session.stop()
    assert stopped.state is RunState.interrupted

    manifest = _manifest(settings, capture_id)
    assert manifest.state == "interrupted"
    assert manifest.error is not None
    # Topics are still synced from metadata for the audit record.
    assert manifest.topics


def test_clean_sigint_returncodes_complete(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # 0, 130, and -SIGINT all count as a clean stop (with metadata present).
    import signal

    for i, rc in enumerate((0, 130, -int(signal.SIGINT))):
        session = _make_session(
            settings, fake_process, write_metadata, behavior="record", returncode=rc
        )
        session.start(_start_req(f"run_clean_{i}"))
        stopped = session.stop()
        assert stopped.state is RunState.completed, f"rc={rc} should complete"


def test_multi_start_while_recording_is_409(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_1"))
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_2"))
    assert exc.value.status_code == 409
    assert exc.value.code == "already_recording"


def test_can_start_again_after_stop(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_1"))
    session.stop()
    again = session.start(_start_req("run_2"))
    assert again.state is RunState.recording
    assert again.run_id == "run_2"


def test_stop_when_idle_is_noop(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    status = session.stop()  # never started
    assert status.state is RunState.created
    assert status.capture_id is None


def test_invalid_run_id_is_400(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("../escape"))
    assert exc.value.status_code == 400
    # Rejected before anything is minted or written.
    assert not objects_dir(settings.data_dir).exists()


def test_insufficient_space_is_507(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    import rosbag2_recorder.recorder as rec

    class _Usage:
        free = 1  # far below MIN_FREE_BYTES

    monkeypatch.setattr(rec.shutil, "disk_usage", lambda _p: _Usage())
    with pytest.raises(ApiError) as exc:
        session.start(_start_req())
    assert exc.value.status_code == 507
    assert exc.value.code == "insufficient_space"
    # The gate measures the objects root, which is where the bag would land.
    assert exc.value.details["free_bytes"] == 1


def test_data_not_writable_is_507(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    import rosbag2_recorder.recorder as rec

    monkeypatch.setattr(rec.os, "access", lambda _p, _m: False)
    with pytest.raises(ApiError) as exc:
        session.start(_start_req())
    assert exc.value.status_code == 507
    assert exc.value.code == "data_not_writable"
    assert exc.value.details["path"].endswith("/objects")


# -- command construction -----------------------------------------------------


def test_command_has_storage_output_and_topics(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    started = session.start(_start_req("run_cmd"))
    cmd = captured[0].cmd
    assert cmd[:3] == ["ros2", "bag", "record"]
    assert "--storage" in cmd and cmd[cmd.index("--storage") + 1] == "mcap"
    out = cmd[cmd.index("--output") + 1]
    assert out.endswith(f"/objects/{started.capture_id}")
    assert "/joint_states" in cmd


def test_command_includes_start_paused_when_enabled(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """--start-paused is added only when recording.start_paused is enabled."""
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_paused=True))
    cap: list[Any] = []
    _make_session(
        settings, fake_process, write_metadata, config=cfg, capture=cap
    ).start(_start_req("run_sp"))
    assert "--start-paused" in cap[0].cmd

    # No config -> not paused (the old immediate-record behavior).
    cap2: list[Any] = []
    _make_session(settings, fake_process, write_metadata, capture=cap2).start(
        _start_req("run_np")
    )
    assert "--start-paused" not in cap2[0].cmd


def test_command_all_uses_all_flag(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    session.start(RecordStartRequest(topics="all", run_id="run_all"))
    assert "--all" in captured[0].cmd


def test_command_compression_and_split_flags(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    session.start(
        _start_req(
            "run_cs",
            compression=Compression.zstd,
            split=SplitConfig(max_size_mb=100, max_duration_s=60),
        )
    )
    cmd = captured[0].cmd
    # zstd uses MCAP-native chunk compression via --storage-config-file (NOT the
    # rosbag2 file-level --compression-mode/format, which would emit an
    # unreadable .mcap.zstd). Output stays a normal <capture_id>_0.mcap.
    assert "--compression-format" not in cmd
    assert "--compression-mode" not in cmd
    assert "--storage-config-file" in cmd
    storage_cfg = Path(cmd[cmd.index("--storage-config-file") + 1])
    body = storage_cfg.read_text()
    assert "compression: Zstd" in body
    assert "compressionLevel: Fastest" in body
    assert "noChunkCRC: true" in body
    # 100 MB -> bytes
    assert cmd[cmd.index("--max-bag-size") + 1] == str(100 * 1024 * 1024)
    assert cmd[cmd.index("--max-bag-duration") + 1] == "60"


def test_command_passes_qos_overrides_path(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    req = RecordStartRequest(
        topics=["/cam"],
        run_id="run_qos",
        qos_overrides={"/cam": QosProfile(depth=1)},
    )
    session.start(req)
    cmd = captured[0].cmd
    assert "--qos-profile-overrides-path" in cmd
    qos_file = Path(cmd[cmd.index("--qos-profile-overrides-path") + 1])
    assert qos_file.exists()


def test_no_qos_flag_when_no_overrides(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    # No config, no overrides -> follow publisher QoS, no override file/flag.
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    session.start(_start_req("run_noqos"))
    assert "--qos-profile-overrides-path" not in captured[0].cmd


def test_all_topics_backfilled_from_metadata(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = RecorderSession(settings, None)

    def fake_spawn(cmd: list[str]) -> Any:
        write_metadata(
            Path(cmd[cmd.index("--output") + 1]),
            topics=[
                ("/joint_states", "sensor_msgs/msg/JointState"),
                ("/tf", "tf2_msgs/msg/TFMessage"),
            ],
        )
        return fake_process(cmd)

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]
    session.start(RecordStartRequest(topics="all", run_id="run_all"))
    stopped = session.stop()
    names = {t.name for t in stopped.topics}
    assert names == {"/joint_states", "/tf"}


# -- metadata endpoint / counters ---------------------------------------------


def test_get_metadata_404_before_any_run(settings: Settings) -> None:
    session = RecorderSession(settings, None)
    with pytest.raises(ApiError) as exc:
        session.get_metadata()
    assert exc.value.status_code == 404
    assert exc.value.code == "no_recording"


def test_get_metadata_corrupt_manifest_is_500_not_404(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A manifest that cannot be read must not be reported as "no such capture"."""
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_corrupt")).capture_id
    assert capture_id is not None
    session.stop()
    (capture_dir(settings.data_dir, capture_id) / "object_manifest.json").write_bytes(
        b"{ not json"
    )

    with pytest.raises(ApiError) as exc:
        session.get_metadata()
    assert exc.value.status_code == 500
    assert exc.value.code == "manifest_corrupt"


def test_bytes_is_stat_of_recorded_files(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # bytes must be the real on-disk total of the capture's *.mcap files (rosbag2
    # metadata files[].size is absent), summed across split parts.
    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_bytes")).capture_id
    assert capture_id is not None
    cd = capture_dir(settings.data_dir, capture_id)
    # The fake spawn wrote <capture_id>_0.mcap (1024 bytes); add a split part.
    (cd / f"{capture_id}_1.mcap").write_bytes(b"\x00" * 2048)

    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert stopped.bytes == 1024 + 2048  # actual file sizes, not metadata

    # The metadata endpoint exposes the same total at the top level.
    meta = session.get_metadata()
    assert meta["bytes"] == 1024 + 2048
    assert meta["capture_id"] == capture_id
    assert meta["run_id"] == "run_bytes"
    assert meta["manifest"]["capture_id"] == capture_id
    # And rosbag2 metadata genuinely lacks a per-file size (the bug we fixed).
    files = meta["rosbag2_metadata"]["files"]
    assert all("size" not in f for f in files)


# -- auto-stop watchers -------------------------------------------------------


def test_max_record_bytes_auto_stops(
    monkeypatch: pytest.MonkeyPatch,
    data_dir: Path,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    # MAX_RECORD_BYTES > 0: the size watcher auto-stops the run when exceeded.
    import rosbag2_recorder.recorder as rec

    monkeypatch.setattr(rec, "SIZE_POLL_S", 0.02)  # poll fast for the test
    settings = Settings(data_dir=str(data_dir), max_record_bytes=512)
    # The fake bag is 1024 bytes > 512, so the first poll trips the limit.
    session = _make_session(settings, fake_process, write_metadata)

    capture_id = session.start(_start_req("run_cap")).capture_id
    assert capture_id is not None
    # Wait for the watcher to observe the size and auto-stop.
    deadline = time.monotonic() + 5.0
    # `stopping` is normal progress, not the end (the S2-2 lesson): the
    # watcher's stop flips recording -> stopping -> completed, and asserting
    # right at the first non-recording read raced the finalise.
    while (
        session.status().state in (RunState.recording, RunState.stopping)
        and time.monotonic() < deadline
    ):
        time.sleep(0.02)

    assert session.status().state is RunState.completed
    manifest = _manifest(settings, capture_id)
    assert manifest.state == "completed"
    assert manifest.error is not None and "MAX_RECORD_BYTES" in manifest.error


def test_max_record_seconds_auto_stops(
    monkeypatch: pytest.MonkeyPatch,
    data_dir: Path,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    # MAX_RECORD_SECONDS > 0: the wall-clock backstop auto-stops a recording
    # nobody stops (the zombie-recording guard — persona review R2 / D-9①).
    import rosbag2_recorder.recorder as rec

    monkeypatch.setattr(rec, "SIZE_POLL_S", 0.02)  # poll fast for the test
    settings = Settings(
        data_dir=str(data_dir), max_record_bytes=0, max_record_seconds=1
    )
    session = _make_session(settings, fake_process, write_metadata)

    capture_id = session.start(_start_req("run_timecap")).capture_id
    assert capture_id is not None
    deadline = time.monotonic() + 5.0
    # `stopping` is normal progress, not the end (the S2-2 lesson): the
    # watcher's stop flips recording -> stopping -> completed, and asserting
    # right at the first non-recording read raced the finalise.
    while (
        session.status().state in (RunState.recording, RunState.stopping)
        and time.monotonic() < deadline
    ):
        time.sleep(0.02)

    assert session.status().state is RunState.completed
    manifest = _manifest(settings, capture_id)
    assert manifest.state == "completed"
    assert manifest.error is not None and "MAX_RECORD_SECONDS" in manifest.error


def test_both_caps_zero_disable_watcher(
    data_dir: Path, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # Both limits 0 disable the watcher: no auto-stop, no background thread.
    # (The duration cap DEFAULTS to 600s, so disabling is now explicit.)
    settings = Settings(
        data_dir=str(data_dir), max_record_bytes=0, max_record_seconds=0
    )
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_nowatch"))
    assert session._size_watcher is None  # type: ignore[attr-defined]
    assert session.status().state is RunState.recording
    session.stop()


# -- concurrency + timestamps -------------------------------------------------


def test_concurrent_double_stop_keeps_completed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A second stop racing the first must NOT re-finalise (REC-M1).

    With the record routes offloaded to a thread pool (REC-H1) two stops — or the
    size-watcher stop vs a user stop — can run at once. The entry guard gates on
    ``recording`` so exactly one caller transitions to ``stopping`` and finalises;
    a clean ``completed`` run must not be flipped to ``interrupted`` by a second
    finalise that sees ``returncode=None``.
    """
    import threading

    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_race")).capture_id
    assert capture_id is not None

    # Park the winning stop inside _signal_and_wait (outside the lock) so the
    # loser races it while the session sits in ``stopping``.
    entered = threading.Event()
    release = threading.Event()
    finalise_calls = 0
    orig_finalise = session._finalise

    def counting_finalise(ended_at: str | None = None) -> None:
        nonlocal finalise_calls
        finalise_calls += 1
        orig_finalise(ended_at)

    def blocking_signal(_proc: Any) -> None:
        entered.set()
        release.wait(5.0)

    session._finalise = counting_finalise  # type: ignore[method-assign]
    session._signal_and_wait = blocking_signal  # type: ignore[method-assign]

    winner_state: list[RunState] = []

    def winner() -> None:
        winner_state.append(session.stop().state)

    thread = threading.Thread(target=winner)
    thread.start()
    assert entered.wait(5.0)  # winner is parked in _signal_and_wait (stopping)

    # Loser stop while the winner holds the session in ``stopping``: the guard
    # returns the current status without re-signalling or re-finalising.
    loser = session.stop()
    assert loser.state is RunState.stopping
    assert loser.live_capture_ids == [capture_id]  # still the recorder's to write

    release.set()
    thread.join(5.0)

    assert winner_state == [RunState.completed]
    assert finalise_calls == 1  # finalise ran exactly once
    manifest = _manifest(settings, capture_id)
    assert manifest.state == "completed"
    assert manifest.integrity != "failed"


def test_started_at_stamped_at_capture_start_not_pre_spawn(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    """``started_at`` is stamped when capture actually begins, not pre-spawn.

    The first clock read in ``start()`` is the pre-spawn attempt stamp (kept
    for the failure records); the session/manifest stamp must be a LATER read,
    taken once the bag process is confirmed up (and, when armed, resumed) — the
    elapsed timer and the manifest measure the bag, not the start overhead.
    """
    import rosbag2_recorder.recorder as rec

    stamps: list[str] = []

    def fake_now() -> str:
        stamps.append(f"2026-01-01T00:00:0{len(stamps)}Z")
        return stamps[-1]

    monkeypatch.setattr(rec, "utc_now_iso8601", fake_now)
    session = _make_session(settings, fake_process, write_metadata)
    started = session.start(_start_req())
    assert started.capture_id is not None

    assert started.started_at in stamps
    assert started.started_at > stamps[0]  # strictly after the pre-spawn stamp
    # The manifest carries the same capture-start stamp.
    assert _manifest(settings, started.capture_id).started_at == started.started_at


def test_ended_at_stamped_at_stop_decision_not_after_flush(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    """``ended_at`` marks the operator's stop, not the end of the SIGINT flush.

    rosbag2 keeps draining its cache after SIGINT (seconds under load, longer
    on SIGTERM escalation); stamping ended_at after that wait made
    ``ended_at - started_at`` read longer than the session the UI timer showed.
    The stamp must be taken BEFORE ``_signal_and_wait`` runs.
    """
    import rosbag2_recorder.recorder as rec

    events: list[str] = []

    def fake_now() -> str:
        events.append(f"2026-01-01T00:00:{len(events):02d}Z")
        return events[-1]

    monkeypatch.setattr(rec, "utc_now_iso8601", fake_now)
    session = _make_session(settings, fake_process, write_metadata)
    # Mark when the (stubbed) SIGINT + wait happens relative to the clock reads.
    session._signal_and_wait = lambda _proc: events.append("FLUSH")  # type: ignore[method-assign]

    capture_id = session.start(_start_req()).capture_id
    assert capture_id is not None
    stopped = session.stop()
    assert stopped.state is RunState.completed

    ended_at = _manifest(settings, capture_id).ended_at
    assert ended_at in events
    assert events.index(ended_at) < events.index("FLUSH")


def test_start_delay_honoured_from_config(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    # _apply_start_delay sleeps recording.start_delay_s when a config provides it.
    from kairos_common import RecordingConfig, RecordingTuning

    slept: list[float] = []
    import rosbag2_recorder.recorder as rec

    monkeypatch.setattr(rec.time, "sleep", lambda s: slept.append(s))

    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_delay_s=1.5))
    RecorderSession(settings, cfg)._apply_start_delay()
    assert slept == [1.5]

    # No config -> no delay.
    slept.clear()
    RecorderSession(settings, None)._apply_start_delay()
    assert slept == []


# -- arming gate --------------------------------------------------------------


def test_arm_failure_fails_the_start_and_cleans_up(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A+B fail-safe: if arming/resume fails, the start fails (no silent paused
    recorder) and the half-created capture dir is removed."""
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_paused=True))
    session = _make_session(settings, fake_process, write_metadata, config=cfg)

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("resume service missing")

    session._arm_and_resume = boom  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_arm"))

    assert exc.value.code == "record_arm_failed"
    assert session.status().state is RunState.created  # not recording
    capture_id = exc.value.details["capture_id"]
    assert not capture_dir(settings.data_dir, capture_id).exists()  # cleaned up
    assert _failed_start(settings, capture_id).state == "failed"


def test_arming_snapshot_starts_none_and_resets(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Without --start-paused there is no arming gate: status.arming stays None.

    The default stubbed ``_arm_and_resume`` never runs (no start_paused config),
    so a plain recording exposes ``arming=None`` (OL-①.4 is opt-in)."""
    session = _make_session(settings, fake_process, write_metadata)
    assert session.status().arming is None
    session.start(_start_req("run_noarm"))
    assert session.status().arming is None


class _FakeRclpy:
    @staticmethod
    def spin_once(node: Any, timeout_sec: float) -> None:
        pass


def test_await_subscribed_splits_matched_unsubscribed_and_missing(
    settings: Settings,
) -> None:
    """The readiness poll refreshes the arming snapshot, split by CAUSE.

    Pure-logic: drive ``_await_recorder_subscribed`` with a fake ROS node so the
    rclpy graph queries are deterministic (no ROS needed)."""
    session = RecorderSession(settings, None)
    session._arming = RecordArming(active=True, unsubscribed_topics=["/a", "/b", "/c"])
    # /a: published + recorder subscribed -> matched.
    # /b: published, recorder not subscribed yet -> unsubscribed (NOT "missing":
    #     it is live, and the operator can see it in Monitor).
    # /c: no publisher at all -> missing.
    node = _FakeArmedNode(
        pubs={"/a": 1, "/b": 1, "/c": 0},
        subs={"/a": [RECORDER_NODE_NAME], "/b": [], "/c": []},
    )
    # timeout=0 -> one poll, then the deadline check resumes (still pending).
    session._await_recorder_subscribed(
        _FakeRclpy(), node, ["/a", "/b", "/c"], False, 0.0
    )
    assert session._arming is not None
    assert session._arming.matched_topics == ["/a"]
    assert session._arming.unsubscribed_topics == ["/b"]
    assert session._arming.missing_topics == ["/c"]


def test_arming_snapshot_surfaced_on_status_after_start_paused(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """With start_paused, the (final) arming snapshot is exposed on status.

    The real ``_arm_and_resume`` needs ROS, so we substitute a stub that writes
    the snapshot the gate would produce; the test asserts it flows through to
    ``GET /record/status`` (the matched/missing fields + resolved ``active``)."""
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_paused=True))
    session = _make_session(settings, fake_process, write_metadata, config=cfg)

    def fake_arm(run_id: str, topics: list[str], all_mode: bool) -> None:
        session._arming = RecordArming(
            active=False,
            matched_topics=list(topics),
            missing_topics=[],
            resume_at="2026-06-27T00:00:00.000Z",
        )

    session._arm_and_resume = fake_arm  # type: ignore[method-assign]
    session.start(_start_req("run_armed", topics=["/joint_states"]))

    st = session.status()
    assert st.arming is not None
    assert st.arming.active is False
    assert st.arming.matched_topics == ["/joint_states"]
    assert st.arming.missing_topics == []
    assert st.arming.resume_at == "2026-06-27T00:00:00.000Z"


def test_arming_snapshot_dropped_on_arm_failure(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A failed arm leaves no stale arming snapshot on the idle session."""
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_paused=True))
    session = _make_session(settings, fake_process, write_metadata, config=cfg)

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("resume service missing")

    session._arm_and_resume = boom  # type: ignore[method-assign]
    with pytest.raises(ApiError):
        session.start(_start_req("run_armfail"))
    assert session.status().arming is None


# -- recording integrity: cache tuning + cache-overflow drop detection -------


def _cfg_cache(mb: int) -> Any:
    from kairos_common import RecordingConfig, RecordingTuning

    return RecordingConfig(
        robot_name="t", recording=RecordingTuning(max_cache_size_mb=mb)
    )


def test_build_command_adds_max_cache_size_and_disable_keyboard(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """--max-cache-size (bytes) when configured; keyboard controls always off."""
    from kairos_common.ids import new_capture_id

    session = _make_session(
        settings, fake_process, write_metadata, config=_cfg_cache(512)
    )
    cmd = session._build_command(
        new_capture_id(), ["/a"], _start_req("run_c"), None, None
    )
    assert "--disable-keyboard-controls" in cmd
    assert cmd[cmd.index("--max-cache-size") + 1] == str(512 * 1024 * 1024)


def test_build_command_omits_cache_when_zero(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """max_cache_size_mb=0 (and no config) omits the flag -> rosbag2 default."""
    from kairos_common.ids import new_capture_id

    s0 = _make_session(settings, fake_process, write_metadata, config=_cfg_cache(0))
    cmd0 = s0._build_command(new_capture_id(), ["/a"], _start_req("r"), None, None)
    assert "--max-cache-size" not in cmd0
    assert "--disable-keyboard-controls" in cmd0  # always, even with no cache

    s1 = _make_session(settings, fake_process, write_metadata)  # no config at all
    cmd1 = s1._build_command(new_capture_id(), ["/a"], _start_req("r"), None, None)
    assert "--max-cache-size" not in cmd1
    assert "--disable-keyboard-controls" in cmd1


def test_scan_dropped_messages_parses_total_lost(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """_scan_dropped_messages reads rosbag2's 'Total lost: N' from the run log."""
    from kairos_common.ids import new_capture_id
    from rosbag2_recorder.recorder import _recorder_log_path

    session = _make_session(settings, fake_process, write_metadata)
    root = session._objects_root()
    root.mkdir(parents=True, exist_ok=True)
    capture_id = new_capture_id()
    log = _recorder_log_path(root, capture_id)
    log.write_text(
        "[INFO] Recording...\n[WARN] Cache buffers lost messages per topic: \n"
        "\t/exp/seq: 7\nTotal lost: 7\n"
    )
    assert session._scan_dropped_messages(capture_id) == 7  # overflow reported
    log.write_text("[INFO] Recording...\n[INFO] Recording stopped\n")
    assert session._scan_dropped_messages(capture_id) == 0  # present, no overflow
    assert session._scan_dropped_messages(new_capture_id()) is None  # unknown


def test_classify_integrity(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    session._state = RunState.completed
    session._dropped_messages = 0
    assert session._classify_integrity() == "ok"
    session._dropped_messages = 5
    assert session._classify_integrity() == "dropped"
    session._dropped_messages = None
    assert session._classify_integrity() == "unknown"
    session._dropped_messages = 0
    for state in (RunState.failed, RunState.interrupted):
        session._state = state
        assert session._classify_integrity() == "failed"


def test_integrity_dropped_surfaced_in_status_and_manifest(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A completed run whose log reports cache drops -> integrity 'dropped'."""
    from rosbag2_recorder.recorder import _recorder_log_path

    session = _make_session(settings, fake_process, write_metadata)
    capture_id = session.start(_start_req("run_x")).capture_id
    assert capture_id is not None
    # The fake spawn does not write a log; simulate rosbag2 reporting an overflow.
    _recorder_log_path(session._objects_root(), capture_id).write_text(
        "Cache buffers lost messages per topic: \n\t/a: 12\nTotal lost: 12\n"
    )
    stopped = session.stop()
    assert stopped.state is RunState.completed  # data on disk, clean exit
    assert stopped.dropped_messages == 12
    assert stopped.integrity == "dropped"  # ...but incomplete
    final = _manifest(settings, capture_id)
    assert final.dropped_messages == 12
    assert final.integrity == "dropped"
    # The captured log is archived into the capture for audit.
    assert (capture_dir(settings.data_dir, capture_id) / "recorder.log").exists()


def test_cache_ram_preflight_rejects_when_insufficient(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A large cache with too little free RAM -> 507 insufficient_memory at start."""
    session = _make_session(
        settings, fake_process, write_metadata, config=_cfg_cache(2048)
    )
    monkeypatch.setattr(session, "_available_ram_bytes", lambda: 100 * 1024 * 1024)
    with pytest.raises(ApiError) as ei:
        session.start(_start_req("run_oom"))
    assert ei.value.status_code == 507
    assert ei.value.code == "insufficient_memory"


def test_cache_ram_preflight_passes_when_ram_unknown(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If free RAM can't be read, don't block the start (best-effort preflight)."""
    session = _make_session(
        settings, fake_process, write_metadata, config=_cfg_cache(2048)
    )
    monkeypatch.setattr(session, "_available_ram_bytes", lambda: None)
    started = session.start(_start_req("run_ok"))
    assert started.state is RunState.recording


# -- two-phase start (prepare -> resume) -------------------------------------


def test_prepare_then_start_fast_path_resumes_without_respawn(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A matching start() after prepare() is just a resume: no re-spawn."""
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    resume_calls: list[Any] = []
    session._resume_armed = lambda armed: resume_calls.append(armed)  # type: ignore[method-assign]

    prepared = session.prepare(_start_req("run_p", topics=["/joint_states"]))
    assert prepared.state is RunState.armed
    assert prepared.run_id == "run_p"
    assert is_uuid7(prepared.capture_id)
    assert prepared.arming is not None
    assert prepared.disarm_at is not None
    assert len(captured) == 1  # spawned once, by prepare()

    status = session.status()
    assert status.state is RunState.armed
    assert status.run_id == "run_p"

    started = session.start(_start_req("run_p", topics=["/joint_states"]))
    assert started.state is RunState.recording
    assert started.run_id == "run_p"
    # The capture_id was fixed at prepare: the paused subprocess is already
    # writing into objects/<capture_id>/, so start() cannot mint a new one.
    assert started.capture_id == prepared.capture_id
    assert len(captured) == 1  # start() did NOT spawn a second process
    assert len(resume_calls) == 1  # resumed exactly once, via the held clients

    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert _manifest(settings, prepared.capture_id).state == "completed"


def test_prepare_then_start_fast_path_matches_on_all_topics(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """topics="all" at prepare matches topics="all" at start (both normalise to
    the "all" sentinel, never to an equivalent explicit list)."""
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    prepared = session.prepare(RecordStartRequest(topics="all", run_id="run_all_p"))
    started = session.start(RecordStartRequest(topics="all", run_id="run_all_s"))
    assert started.state is RunState.recording
    assert started.run_id == "run_all_p"  # armed run_id, fixed at prepare time
    assert started.capture_id == prepared.capture_id
    assert len(captured) == 1  # fast path: no second spawn


def test_start_uses_armed_ids_even_if_request_run_id_differs(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """run_id and capture_id are both fixed at prepare time (the subprocess
    already opened that --output dir); a start() whose OTHER fields match
    commits under them, even if the request names a different run_id."""
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(_start_req("run_armed_id", topics=["/joint_states"]))
    started = session.start(_start_req("run_requested_id", topics=["/joint_states"]))
    assert started.run_id == "run_armed_id"
    assert started.capture_id == prepared.capture_id
    assert session.status().run_id == "run_armed_id"


def test_operator_task_come_from_start_request_not_prepare(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """operator/task are metadata only; the fast path uses the START request's
    values, not the (possibly placeholder) values passed to prepare()."""
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(
        _start_req("run_meta", operator="prep_operator", task="prep_task")
    )
    session.start(_start_req("run_meta", operator="real_operator", task="real_task"))

    manifest = _manifest(settings, prepared.capture_id)
    assert manifest.operator == "real_operator"
    assert manifest.task == "real_task"


def _armed_with_late_topic(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> tuple[RecorderSession, _FakeArmedNode]:
    """Arm a session whose ``/late`` target had no publisher at prepare time."""
    graph = _FakeArmedNode(
        pubs={"/joint_states": 1, "/late": 0},
        subs={"/joint_states": [RECORDER_NODE_NAME], "/late": []},
    )
    session = _make_session(settings, fake_process, write_metadata)

    def prepare_arm(run_id: str, topics: list[str], all_mode: bool) -> Any:
        session._await_subscription_match(graph, _FakeRclpy(), topics, all_mode, 0.0)
        return (graph, object(), object(), False)

    session._prepare_arm = prepare_arm  # type: ignore[method-assign]
    prepared = session.prepare(
        _start_req("run_late", topics=["/joint_states", "/late"])
    )
    assert prepared.arming is not None
    assert prepared.arming.missing_topics == ["/late"]
    return session, graph


def test_armed_status_re_reads_readiness_instead_of_the_first_arm_snapshot(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A target that comes up AFTER prepare stops being reported as missing.

    Regression: the snapshot was frozen at the first prepare, so a topic that
    was down then — and live seconds later — was still reported "not publishing"
    for as long as the session stayed armed (the console's pre-arm keep-alive
    holds it armed indefinitely), while Monitor showed it at full rate.
    """
    session, graph = _armed_with_late_topic(settings, fake_process, write_metadata)

    graph._pubs["/late"] = 1  # the publisher appears
    graph._subs["/late"] = [RECORDER_NODE_NAME]  # ...and the recorder subscribes

    arming = session.status().arming
    assert arming is not None
    assert arming.missing_topics == []
    assert arming.unsubscribed_topics == []
    assert set(arming.matched_topics) == {"/joint_states", "/late"}


def test_keepalive_re_prepare_re_reads_readiness(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A matching re-prepare reuses the subprocess but NOT the stale snapshot."""
    session, graph = _armed_with_late_topic(settings, fake_process, write_metadata)

    graph._pubs["/late"] = 1
    graph._subs["/late"] = [RECORDER_NODE_NAME]

    extended = session.prepare(
        _start_req("run_other", topics=["/joint_states", "/late"])
    )
    assert extended.run_id == "run_late"  # keep-alive: same armed session
    assert extended.arming is not None
    assert extended.arming.missing_topics == []
    assert set(extended.arming.matched_topics) == {"/joint_states", "/late"}


def test_fast_start_freezes_readiness_at_resume_not_at_prepare(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The snapshot the recording is judged by is start-time, not prepare-time."""
    session, graph = _armed_with_late_topic(settings, fake_process, write_metadata)

    graph._pubs["/late"] = 1
    graph._subs["/late"] = [RECORDER_NODE_NAME]

    started = session.start(_start_req("run_late", topics=["/joint_states", "/late"]))
    assert started.state is RunState.recording
    assert started.arming is not None
    assert started.arming.missing_topics == []
    assert started.arming.active is False


def test_armed_status_reports_a_target_that_really_has_no_publisher(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The refresh must not paper over a genuinely absent target."""
    session, _graph = _armed_with_late_topic(settings, fake_process, write_metadata)

    arming = session.status().arming
    assert arming is not None
    assert arming.missing_topics == ["/late"]
    assert arming.matched_topics == ["/joint_states"]


def test_status_shape_while_armed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(
        _start_req("run_status", topics=["/joint_states", "/tf"])
    )
    assert prepared.state is RunState.armed
    assert prepared.arming is not None
    assert prepared.disarm_at is not None

    status = session.status()
    assert status.state is RunState.armed
    assert status.run_id == "run_status"
    assert status.capture_id == prepared.capture_id
    assert status.started_at is None
    assert status.message_count == 0
    assert status.bytes == 0
    assert {t.name for t in status.topics} == {"/joint_states", "/tf"}
    assert status.arming is not None
    assert status.arming.disarm_at is not None
    assert status.dropped_messages is None
    assert status.integrity == "unknown"


def test_prepare_while_recording_is_409(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_rec"))
    with pytest.raises(ApiError) as exc:
        session.prepare(_start_req("run_prep"))
    assert exc.value.status_code == 409
    assert exc.value.code == "already_recording"


def test_mismatching_re_prepare_disarms_old_and_arms_new(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A re-prepare whose spawn-affecting fields DIFFER is last-wins: the old
    armed session is torn down and a new one is spawned under a new id."""
    session = _make_session(settings, fake_process, write_metadata)
    first = session.prepare(_start_req("run_first", topics=["/joint_states"]))
    assert session.status().run_id == "run_first"

    second = session.prepare(_start_req("run_second", topics=["/joint_states", "/tf"]))
    status = session.status()
    assert status.state is RunState.armed
    assert status.run_id == "run_second"
    assert second.capture_id != first.capture_id
    assert not capture_dir(settings.data_dir, first.capture_id).exists()
    assert capture_dir(settings.data_dir, second.capture_id).exists()


def test_matching_re_prepare_extends_without_respawn(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A re-prepare whose spawn-affecting fields MATCH the armed session is a
    keep-alive: the deadline moves, the ids and subprocess stay (no churn)."""
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    first = session.prepare(_start_req("run_keep", topics=["/joint_states"]))
    assert len(captured) == 1

    # Same spawn-affecting fields (metadata may differ) -> extend, not respawn.
    second = session.prepare(
        _start_req("run_other_id", topics=["/joint_states"], operator="someone")
    )
    assert second.state is RunState.armed
    assert second.run_id == "run_keep"  # the armed session's id, not the new one
    assert second.capture_id == first.capture_id
    assert second.disarm_at is not None
    assert first.disarm_at is not None
    assert second.disarm_at >= first.disarm_at  # deadline extended (ISO sorts)
    assert len(captured) == 1  # NOT respawned
    assert capture_dir(settings.data_dir, first.capture_id).exists()

    # The extended session is still claimable by a matching start().
    started = session.start(_start_req("run_started", topics=["/joint_states"]))
    assert started.state is RunState.recording
    assert started.run_id == "run_keep"
    assert started.capture_id == first.capture_id
    assert len(captured) == 1


def test_stale_disarm_timer_is_a_noop_after_extend(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The extend ABA race: an old timer callback that already fired (but was
    blocked on the lock while the session was extended) must not disarm the
    extended session — extend bumps the generation exactly for this."""
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(_start_req("run_ext", topics=["/joint_states"]))
    old_generation = session._armed.generation  # type: ignore[union-attr]

    session.prepare(_start_req("run_ext2", topics=["/joint_states"]))  # extend
    session._on_disarm_timer(old_generation)  # stale callback

    status = session.status()
    assert status.state is RunState.armed
    assert status.run_id == "run_ext"
    assert capture_dir(settings.data_dir, prepared.capture_id).exists()


def test_stop_while_armed_disarms(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(_start_req("run_arm_stop"))
    assert session.status().state is RunState.armed

    stopped = session.stop()
    assert stopped.state is RunState.created  # reverted to the pre-arm state
    assert not capture_dir(settings.data_dir, prepared.capture_id).exists()
    assert session._armed is None  # type: ignore[attr-defined]
    # The abandoned capture_id leaves no trace: nothing ever committed under it,
    # so it is not a failed start either.
    assert not failed_start_path(settings.data_dir, prepared.capture_id).exists()
    assert stopped.live_capture_ids == []


def test_stop_while_armed_restores_previous_completed_status(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Disarming must not erase visibility of a genuinely-completed prior run."""
    session = _make_session(settings, fake_process, write_metadata)
    done = session.start(_start_req("run_done")).capture_id
    session.stop()
    assert session.status().state is RunState.completed

    session.prepare(_start_req("run_arm_after"))
    assert session.status().state is RunState.armed
    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert stopped.run_id == "run_done"
    assert stopped.capture_id == done


def test_start_with_mismatched_armed_session_falls_back(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    prepared = session.prepare(_start_req("run_armed_topics", topics=["/joint_states"]))
    assert session.status().state is RunState.armed

    # A start() with a DIFFERENT topic list does not match -> disarm + the
    # full synchronous path (a fresh spawn, and a fresh capture_id).
    started = session.start(_start_req("run_full", topics=["/other_topic"]))
    assert started.state is RunState.recording
    assert started.run_id == "run_full"
    assert started.capture_id != prepared.capture_id
    assert [t.name for t in started.topics] == ["/other_topic"]
    # The old armed capture's dir was cleaned up (disarmed, not committed).
    assert not capture_dir(settings.data_dir, prepared.capture_id).exists()
    # Two spawns happened: one for prepare() (discarded), one for the full start.
    assert len(captured) == 2


def _arm_during_start_delay(
    session: RecorderSession, request: RecordStartRequest
) -> dict[str, Any]:
    """Make ``start()``'s start_delay window arm a session, once.

    Models the ordinary console sequence: it pre-arms, and the operator presses
    start a moment later — while the start is still inside its ramp-up sleep,
    which runs outside the lock precisely so prepare() can proceed. Driving it
    from the delay hook makes that interleaving deterministic instead of timing
    dependent. The re-entry guard matters: ``prepare()`` applies the same delay,
    so an unguarded hook would recurse forever.
    """
    box: dict[str, Any] = {}

    def hook() -> None:
        if box:
            return
        box["armed"] = None  # claim the slot before re-entering prepare()
        box["armed"] = session.prepare(request)

    session._apply_start_delay = hook  # type: ignore[method-assign]
    return box


def test_start_claims_a_session_armed_during_the_start_delay(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A matching arm landing mid-start is consumed, not raced.

    Regression: start() checked for an armed session only in its FIRST lock
    block, before the ramp-up sleep. An arm arriving during that sleep was
    invisible to the second block, so start() spawned a second
    ``ros2 bag record`` over the same topics and orphaned the armed one — its
    directory absent from live_capture_ids, its auto-disarm timer a no-op
    because the state was no longer ``armed``, and nothing left that could ever
    clean it up.
    """
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    box = _arm_during_start_delay(
        session, _start_req("run_armed", topics=["/joint_states"])
    )

    started = session.start(_start_req("run_started", topics=["/joint_states"]))
    prepared = box["armed"]

    # The armed session was CLAIMED: same capture, one subprocess, nothing left
    # armed behind the recording.
    assert started.state is RunState.recording
    assert started.capture_id == prepared.capture_id
    assert started.run_id == "run_armed"  # ids are fixed at prepare time
    assert len(captured) == 1
    assert session._armed is None  # type: ignore[attr-defined]

    live = session.status()
    assert live.live_capture_ids == [prepared.capture_id]
    # Exactly one capture directory exists, and it is the armed one.
    dirs = {p.name for p in objects_dir(settings.data_dir).iterdir() if p.is_dir()}
    assert dirs == {prepared.capture_id}


def test_start_disarms_a_mismatched_session_armed_during_the_start_delay(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A non-matching arm landing mid-start is torn down, not left running."""
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    box = _arm_during_start_delay(session, _start_req("run_armed", topics=["/other"]))

    started = session.start(_start_req("run_started", topics=["/joint_states"]))
    prepared = box["armed"]

    assert started.state is RunState.recording
    assert started.capture_id != prepared.capture_id
    assert [t.name for t in started.topics] == ["/joint_states"]
    assert session._armed is None  # type: ignore[attr-defined]
    # The mismatched arm's directory is gone; only the real recording remains.
    assert not capture_dir(settings.data_dir, prepared.capture_id).exists()
    dirs = {p.name for p in objects_dir(settings.data_dir).iterdir() if p.is_dir()}
    assert dirs == {started.capture_id}


def test_stop_while_armed_names_the_cancelled_capture(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A cancel reports which capture died, without disturbing capture_id.

    The caller is holding the id prepare() gave it; without this it has no way
    to learn that id is now dead, and ``capture_id`` cannot carry the news
    because it reverts to the last finalised capture.
    """
    session = _make_session(settings, fake_process, write_metadata)
    finished = session.start(_start_req("run_done")).capture_id
    session.stop()
    prepared = session.prepare(_start_req("run_cancelled"))

    stopped = session.stop()
    assert stopped.disarmed_capture_id == prepared.capture_id
    assert stopped.capture_id == finished  # untouched by the cancel
    assert stopped.live_capture_ids == []
    # Only a cancel sets it: an ordinary stop leaves it null.
    session.start(_start_req("run_again"))
    assert session.stop().disarmed_capture_id is None


def test_resume_failure_during_fast_start_fails_safely(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A+B fail-safe applies to the fast path too: if resume fails/doesn't
    confirm, the start fails (507) rather than leaving a paused recorder."""
    session = _make_session(settings, fake_process, write_metadata)
    prepared = session.prepare(_start_req("run_resume_fail"))

    def boom(_armed: Any) -> None:
        raise RuntimeError("resume did not confirm")

    session._resume_armed = boom  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_resume_fail"))
    assert exc.value.status_code == 507
    assert exc.value.code == "record_arm_failed"
    assert exc.value.details["capture_id"] == prepared.capture_id

    # No leaked paused recorder: state reverted, capture dir gone, failure
    # recorded under the id the capture would have had.
    assert session.status().state is RunState.created
    assert not capture_dir(settings.data_dir, prepared.capture_id).exists()
    assert _failed_start(settings, prepared.capture_id).state == "failed"


def test_auto_disarm_fires_and_cleans_up_capture_dir(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(
        robot_name="t",
        recording=RecordingTuning(start_delay_s=0, prepare_disarm_timeout_s=0.05),
    )
    session = _make_session(settings, fake_process, write_metadata, config=cfg)
    prepared = session.prepare(_start_req("run_auto"))
    assert prepared.state is RunState.armed

    deadline = time.monotonic() + 5.0
    while session.status().state is RunState.armed and time.monotonic() < deadline:
        time.sleep(0.02)

    status = session.status()
    assert status.state is RunState.created  # reverted to the pre-arm state
    assert not capture_dir(settings.data_dir, prepared.capture_id).exists()


def test_stale_disarm_timer_is_a_noop_after_reprepare(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The ABA race: disarm -> re-prepare between the timer firing and its
    callback acquiring the lock must not tear down the NEW armed session."""
    session = _make_session(settings, fake_process, write_metadata)
    old = session.prepare(_start_req("run_old"))
    old_armed = session._armed  # type: ignore[attr-defined]
    assert old_armed is not None
    old_generation = old_armed.generation

    # Disarm the old session directly (as stop()/a mismatch would), then arm
    # a new one, BEFORE the stale timer callback runs.
    session._disarm_locked()  # type: ignore[attr-defined]
    new_prepared = session.prepare(_start_req("run_new"))
    assert new_prepared.state is RunState.armed
    new_armed = session._armed  # type: ignore[attr-defined]
    assert new_armed is not None
    assert new_armed.generation != old_generation

    # Fire the STALE timer callback (captured the OLD generation) directly.
    session._on_disarm_timer(old_generation)  # type: ignore[attr-defined]

    # The new armed session must be entirely unaffected.
    assert session._armed is new_armed  # type: ignore[attr-defined]
    assert session.status().state is RunState.armed
    assert session.status().run_id == "run_new"
    assert capture_dir(settings.data_dir, new_prepared.capture_id).exists()
    assert not capture_dir(settings.data_dir, old.capture_id).exists()
