"""State machine + recording mechanics, with the subprocess mocked out.

The ``ros2 bag record`` spawn and OS-signal delivery are replaced by the
:func:`_make_session` helper, so the full lifecycle runs without ROS 2. The
``FakeProcess`` class and the rosbag2-metadata writer arrive via the
``fake_process`` / ``write_metadata`` fixtures (see ``conftest.py``).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from kairos_common import ApiError, Compression, Settings
from rosbag2_recorder.manifest import (
    Manifest,
    read_failed_start_record,
    read_manifest,
    session_path,
    write_manifest,
)
from rosbag2_recorder.models import (
    QosProfile,
    RecordArming,
    RecordStartRequest,
    RunState,
    SplitConfig,
)
from rosbag2_recorder.recorder import RecorderSession, run_dir


class _FakeArmedNode:
    """Placeholder for the rclpy Node kept alive across prepare() -> start().

    ``_teardown_armed_rclpy`` calls ``.destroy_node()`` unconditionally, so the
    fake needs that method; nothing else touches the node/clients in tests
    that stub ``_prepare_arm``/``_resume_armed`` (the default in
    :func:`_make_session`).
    """

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

    - ``"record"``    create the run dir + a rosbag2 metadata.yaml, stay alive
                      -> start succeeds, a later stop finalises to ``completed``.
    - ``"no_metadata"`` create the run dir only, stay alive -> start succeeds,
                      but a later stop finds no metadata -> ``failed``.
    - ``"no_dir"``    create nothing, exit immediately -> start failure (the
                      output dir never appears).
    """
    session = RecorderSession(settings, config)
    alive = behavior != "no_dir"

    def fake_spawn(cmd: list[str]) -> Any:
        proc = fake_process(cmd, returncode=returncode, alive=alive)
        if capture is not None:
            capture.append(proc)
        run_id = cmd[cmd.index("--output") + 1].rsplit("/", 1)[-1]
        rd = run_dir(Path(settings.data_dir), run_id)
        if behavior == "record":
            write_metadata(rd)  # also creates the run dir
        elif behavior == "no_metadata":
            rd.mkdir(parents=True, exist_ok=True)  # dir but no metadata
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


def test_full_lifecycle_created_recording_completed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    assert session.status().state is RunState.created

    started = session.start(_start_req())
    assert started.state is RunState.recording
    assert started.run_id == "run_1"
    assert started.started_at  # populated

    # Manifest reflects recording state mid-run.
    assert read_manifest(settings.data_dir, "run_1").state is RunState.recording

    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert stopped.message_count == 42
    assert stopped.bytes == 1024

    final = read_manifest(settings.data_dir, "run_1")
    assert final.state is RunState.completed
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


def test_finalise_fails_when_mcap_missing(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """metadata present but no MCAP data on disk -> failed (OL-①.3 verification)."""
    from rosbag2_recorder.manifest import run_dir

    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_m"))
    # Delete the bag's MCAP so finalise sees metadata but no flushed data.
    for mcap in run_dir(settings.data_dir, "run_m").glob("*.mcap"):
        mcap.unlink()
    stopped = session.stop()
    assert stopped.state is RunState.failed
    final = read_manifest(settings.data_dir, "run_m")
    assert final.state is RunState.failed
    assert final.error and "MCAP" in final.error


def test_session_json_written_beside_mcap(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """operator/task + lifecycle are written to session.json in the run dir."""
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_s", operator="yuki", task="pick-and-place"))

    path = session_path(settings.data_dir, "run_s")
    assert path.exists()  # beside the MCAP, not in a separate folder
    started = json.loads(path.read_text())
    assert started["operator"] == "yuki"
    assert started["task"] == "pick-and-place"
    assert started["state"] == "recording"
    assert started["topics"] == ["/joint_states"]

    session.stop()
    final = json.loads(path.read_text())
    assert final["state"] == "completed"
    assert final["operator"] == "yuki"
    assert final["message_count"] == 42
    assert final["ended_at"] is not None


def test_run_dir_is_host_writable(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The run dir is chmod'd world-writable so the host/UI can delete it."""
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_p"))
    rd = run_dir(Path(settings.data_dir), "run_p")
    assert (rd.stat().st_mode & 0o777) == 0o777
    # The recorded root is relaxed too (so the run dir itself can be removed).
    assert rd.parent.stat().st_mode & 0o002  # world-writable bit set


def test_session_json_metadata_defaults_to_unknown(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Omitting operator/task falls back to the unknown_* placeholders (REC-M2).

    A standalone recorder call has no orchestrator to normalize the metadata, so
    the recorder itself must default it — otherwise session.json carries nulls
    that make the dataset path data/<operator>/<task> unkeyable.
    """
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_n"))
    session.stop()
    payload = json.loads(session_path(settings.data_dir, "run_n").read_text())
    assert payload["operator"] == "unknown_operator"
    assert payload["task"] == "unknown_task"


def test_session_json_blank_metadata_defaults_to_unknown(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Empty/whitespace operator/task are coerced to the placeholders too."""
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_blank", operator="  ", task=""))
    session.stop()
    payload = json.loads(session_path(settings.data_dir, "run_blank").read_text())
    assert payload["operator"] == "unknown_operator"
    assert payload["task"] == "unknown_task"


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


def test_invalid_run_id_is_400(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("../escape"))
    assert exc.value.status_code == 400


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


def test_finalise_without_metadata_is_failed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # Process starts (output dir created) but no metadata.yaml -> stop fails.
    session = _make_session(
        settings, fake_process, write_metadata, behavior="no_metadata", returncode=1
    )
    session.start(_start_req("run_x"))
    stopped = session.stop()
    assert stopped.state is RunState.failed

    manifest = read_manifest(settings.data_dir, "run_x")
    assert manifest.state is RunState.failed
    assert manifest.error is not None


def test_abnormal_returncode_with_metadata_is_failed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # metadata.yaml present but the process died abnormally (e.g. SIGTERM/-15,
    # disk-full crash): a stale/partial bag must NOT be reported completed.
    session = _make_session(
        settings, fake_process, write_metadata, behavior="record", returncode=-15
    )
    session.start(_start_req("run_abn"))
    stopped = session.stop()
    assert stopped.state is RunState.failed

    manifest = read_manifest(settings.data_dir, "run_abn")
    assert manifest.state is RunState.failed
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
        run_id = f"run_clean_{i}"
        session.start(_start_req(run_id))
        stopped = session.stop()
        assert stopped.state is RunState.completed, f"rc={rc} should complete"


def test_start_failure_when_output_dir_never_appears(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # ros2 bag record exits before creating --output (e.g. it refused a
    # pre-existing dir) -> start must fail (507), not report "recording".
    session = _make_session(
        settings, fake_process, write_metadata, behavior="no_dir", returncode=1
    )
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_fail"))
    assert exc.value.status_code == 507
    assert exc.value.code == "record_start_failed"
    # The session stays idle.
    assert session.status().state is RunState.created
    # A failed START must NOT create a spurious recording run dir...
    assert not run_dir(Path(settings.data_dir), "run_fail").exists()
    # ...the failure is recorded in the sibling failed-start record instead.
    failed = read_failed_start_record(settings.data_dir, "run_fail")
    assert failed.state is RunState.failed
    assert failed.error is not None


def test_start_failure_when_process_hangs_without_dir(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    # Process stays ALIVE but never creates the output dir -> must be a start
    # failure (not success), and must not leave a run dir behind.
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
    # The stuck process was asked to terminate, the session is idle, no run dir.
    assert terminated, "a hung start process must be terminated"
    assert session.status().state is RunState.created
    assert not run_dir(Path(settings.data_dir), "run_hang").exists()


def test_failed_start_after_completed_run_keeps_previous_status(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """BUG-A regression: a failed start must not corrupt the previous run's
    status. self._topics is staged and only committed on success, so a failed
    attempt's topics never leak into /record/status (which still reports the
    prior run_id/state)."""
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_ok", topics=["/joint_states"]))
    session.stop()
    assert session.status().state is RunState.completed

    # A second start with DIFFERENT topics that fails (process exits, no dir).
    def failing_spawn(cmd: list[str]) -> Any:
        return fake_process(cmd, returncode=1, alive=False)

    session._spawn_process = failing_spawn  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_bad", topics=["/totally_different"]))
    assert exc.value.code == "record_start_failed"

    # Status still reflects the previous completed run, NOT the failed topics.
    st = session.status()
    assert st.run_id == "run_ok"
    assert st.state is RunState.completed
    assert [t.name for t in st.topics] == ["/joint_states"]
    # The failed attempt's own topics live in its failed-start record.
    failed = read_failed_start_record(settings.data_dir, "run_bad")
    assert [t.name for t in failed.topics] == ["/totally_different"]


def test_output_dir_absent_at_spawn_and_qos_outside_run_dir(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # Regression: nothing may create the ros2 --output dir before spawn, and the
    # QoS overrides file must live OUTSIDE that dir (ros2 bag record refuses a
    # pre-existing --output). Use a config so a QoS file is actually written.
    from kairos_common import (
        Durability,
        RecordingConfig,
        RecordingTuning,
        Reliability,
        TopicQosOverride,
    )

    config = RecordingConfig(
        robot_name="hsr",
        topic_qos_overrides=[
            TopicQosOverride(
                pattern="*",
                reliability=Reliability.best_effort,
                durability=Durability.volatile,
                depth=1,
            )
        ],
        recording=RecordingTuning(start_delay_s=0),  # no ramp-up wait in tests
    )
    session = RecorderSession(settings, config)

    seen: dict[str, Any] = {}

    def asserting_spawn(cmd: list[str]) -> Any:
        run_id = cmd[cmd.index("--output") + 1].rsplit("/", 1)[-1]
        rd = run_dir(Path(settings.data_dir), run_id)
        # The run dir must not exist at the instant of spawn...
        assert not rd.exists(), "run dir must not exist before ros2 bag record"
        # ...but the QoS file (passed via --qos-profile-overrides-path) must,
        # and it must be outside the run dir.
        qos_path = Path(cmd[cmd.index("--qos-profile-overrides-path") + 1])
        assert qos_path.exists()
        assert rd not in qos_path.parents
        seen["qos_path"] = qos_path
        # Now mimic ros2 creating the dir + metadata (successful start).
        write_metadata(rd)
        return fake_process(cmd, alive=True)

    session._spawn_process = asserting_spawn  # type: ignore[method-assign]
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]

    session.start(_start_req("run_reg", topics=["/cam"]))
    assert seen["qos_path"].name == "run_reg.qos.yaml"
    # On stop the sibling QoS file is cleaned up.
    session.stop()
    assert not seen["qos_path"].exists()


def test_command_has_storage_output_and_topics(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    session.start(_start_req("run_cmd"))
    cmd = captured[0].cmd
    assert cmd[:3] == ["ros2", "bag", "record"]
    assert "--storage" in cmd and cmd[cmd.index("--storage") + 1] == "mcap"
    out = cmd[cmd.index("--output") + 1]
    assert out.endswith("/recorded/run_cmd")
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


def test_arm_failure_fails_the_start_and_cleans_up(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A+B fail-safe: if arming/resume fails, the start fails (no silent paused
    recorder) and the half-created run dir is removed."""
    from kairos_common import RecordingConfig, RecordingTuning

    cfg = RecordingConfig(robot_name="t", recording=RecordingTuning(start_paused=True))
    session = _make_session(settings, fake_process, write_metadata, config=cfg)

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("resume service missing")

    session._arm_and_resume = boom  # type: ignore[method-assign]
    # The fake process shares our pid; never let the real terminate killpg the
    # test's own process group.
    session._terminate_failed_start = lambda _p: None  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_arm"))

    assert exc.value.code == "record_arm_failed"
    assert session.status().state is RunState.created  # not recording
    assert not run_dir(Path(settings.data_dir), "run_arm").exists()  # cleaned up


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


def test_await_subscribed_populates_arming_matched_missing(
    settings: Settings,
) -> None:
    """The readiness poll refreshes matched vs missing on the arming snapshot.

    Pure-logic: drive ``_await_recorder_subscribed`` with a fake ROS node so the
    rclpy graph queries are deterministic (no ROS needed)."""
    from types import SimpleNamespace

    from rosbag2_recorder.models import RecordArming
    from rosbag2_recorder.recorder import RECORDER_NODE_NAME

    class _FakeNode:
        def __init__(self, pubs: dict[str, int], subs: dict[str, list[str]]) -> None:
            self._pubs = pubs
            self._subs = subs

        def count_publishers(self, topic: str) -> int:
            return self._pubs.get(topic, 0)

        def get_subscriptions_info_by_topic(self, topic: str) -> list[Any]:
            return [SimpleNamespace(node_name=n) for n in self._subs.get(topic, [])]

    class _FakeRclpy:
        @staticmethod
        def spin_once(node: Any, timeout_sec: float) -> None:
            pass

    session = RecorderSession(settings, None)
    session._arming = RecordArming(active=True, missing_topics=["/a", "/b"])
    # /a has a publisher AND the recorder subscribed; /b has a publisher but the
    # recorder has not subscribed yet -> still missing.
    node = _FakeNode(
        pubs={"/a": 1, "/b": 1},
        subs={"/a": [RECORDER_NODE_NAME], "/b": []},
    )
    # timeout=0 -> one poll, then the deadline check resumes (still pending /b).
    session._await_recorder_subscribed(_FakeRclpy(), node, ["/a", "/b"], False, 0.0)
    assert session._arming is not None
    assert session._arming.matched_topics == ["/a"]
    assert session._arming.missing_topics == ["/b"]


def test_arming_snapshot_surfaced_on_status_after_start_paused(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """With start_paused, the (final) arming snapshot is exposed on status.

    The real ``_arm_and_resume`` needs ROS, so we substitute a stub that writes
    the snapshot the gate would produce; the test asserts it flows through to
    ``GET /record/status`` (the matched/missing fields + resolved ``active``)."""
    from kairos_common import RecordingConfig, RecordingTuning
    from rosbag2_recorder.models import RecordArming

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
    session._terminate_failed_start = lambda _p: None  # type: ignore[method-assign]
    with pytest.raises(ApiError):
        session.start(_start_req("run_armfail"))
    assert session.status().arming is None


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
    # unreadable .mcap.zstd). Output stays a normal <run>_0.mcap.
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
        rd = run_dir(Path(settings.data_dir), "run_all")
        write_metadata(
            rd,
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


def test_reconcile_marks_interrupted(settings: Settings) -> None:
    write_manifest(
        settings.data_dir,
        Manifest(run_id="orphan", state=RunState.recording, started_at="t0"),
    )
    write_manifest(
        settings.data_dir,
        Manifest(run_id="done", state=RunState.completed, started_at="t0"),
    )
    RecorderSession(settings, None).reconcile_on_startup()
    assert read_manifest(settings.data_dir, "orphan").state is RunState.interrupted
    # A completed run is untouched.
    assert read_manifest(settings.data_dir, "done").state is RunState.completed


def test_get_metadata_404_before_any_run(settings: Settings) -> None:
    session = RecorderSession(settings, None)
    with pytest.raises(ApiError) as exc:
        session.get_metadata()
    assert exc.value.status_code == 404


def test_bytes_is_stat_of_recorded_files(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # bytes must be the real on-disk total of the run's *.mcap files (rosbag2
    # metadata files[].size is absent), summed across split parts.
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_bytes"))
    rd = run_dir(Path(settings.data_dir), "run_bytes")
    # The fake spawn wrote run_bytes_0.mcap (1024 bytes); add a split part.
    (rd / "run_bytes_1.mcap").write_bytes(b"\x00" * 2048)

    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert stopped.bytes == 1024 + 2048  # actual file sizes, not metadata

    # The metadata endpoint exposes the same total at the top level.
    meta = session.get_metadata()
    assert meta["bytes"] == 1024 + 2048
    # And rosbag2 metadata genuinely lacks a per-file size (the bug we fixed).
    files = meta["rosbag2_metadata"]["files"]
    assert all("size" not in f for f in files)


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

    session.start(_start_req("run_cap"))
    # Wait for the watcher to observe the size and auto-stop.
    deadline = time.monotonic() + 5.0
    while session.status().state is RunState.recording and time.monotonic() < deadline:
        time.sleep(0.02)

    status = session.status()
    assert status.state is RunState.completed
    manifest = read_manifest(settings.data_dir, "run_cap")
    assert manifest.state is RunState.completed
    assert manifest.error is not None and "MAX_RECORD_BYTES" in manifest.error


def test_max_record_bytes_zero_disables_watcher(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # Default (0) disables the watcher: no auto-stop, no background thread.
    assert settings.max_record_bytes == 0
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_nowatch"))
    assert session._size_watcher is None  # type: ignore[attr-defined]
    assert session.status().state is RunState.recording
    session.stop()


def test_concurrent_double_stop_keeps_completed(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A second stop racing the first must NOT re-finalise (REC-M1).

    With the record routes offloaded to a thread pool (REC-H1) two stops — or the
    size-watcher stop vs a user stop — can run at once. The entry guard gates on
    ``recording`` so exactly one caller transitions to ``stopping`` and finalises;
    a clean ``completed`` run must not be flipped to ``failed`` by a second
    finalise that sees ``returncode=None``.
    """
    import threading

    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_race"))

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

    release.set()
    thread.join(5.0)

    assert winner_state == [RunState.completed]
    assert finalise_calls == 1  # finalise ran exactly once
    manifest = read_manifest(settings.data_dir, "run_race")
    assert manifest.state is RunState.completed
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

    assert started.started_at in stamps
    assert started.started_at > stamps[0]  # strictly after the pre-spawn stamp
    # The manifest carries the same capture-start stamp.
    assert read_manifest(settings.data_dir, "run_1").started_at == started.started_at


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

    session.start(_start_req())
    stopped = session.stop()
    assert stopped.state is RunState.completed

    ended_at = read_manifest(settings.data_dir, "run_1").ended_at
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
    session = _make_session(
        settings, fake_process, write_metadata, config=_cfg_cache(512)
    )
    cmd = session._build_command("run_c", ["/a"], _start_req("run_c"), None, None)
    assert "--disable-keyboard-controls" in cmd
    assert cmd[cmd.index("--max-cache-size") + 1] == str(512 * 1024 * 1024)


def test_build_command_omits_cache_when_zero(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """max_cache_size_mb=0 (and no config) omits the flag -> rosbag2 default."""
    s0 = _make_session(settings, fake_process, write_metadata, config=_cfg_cache(0))
    cmd0 = s0._build_command("r", ["/a"], _start_req("r"), None, None)
    assert "--max-cache-size" not in cmd0
    assert "--disable-keyboard-controls" in cmd0  # always, even with no cache

    s1 = _make_session(settings, fake_process, write_metadata)  # no config at all
    cmd1 = s1._build_command("r", ["/a"], _start_req("r"), None, None)
    assert "--max-cache-size" not in cmd1
    assert "--disable-keyboard-controls" in cmd1


def test_scan_dropped_messages_parses_total_lost(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """_scan_dropped_messages reads rosbag2's 'Total lost: N' from the run log."""
    from rosbag2_recorder.recorder import _recorder_log_path

    session = _make_session(settings, fake_process, write_metadata)
    root = session._recorded_root()
    root.mkdir(parents=True, exist_ok=True)
    log = _recorder_log_path(root, "run_d")
    log.write_text(
        "[INFO] Recording...\n[WARN] Cache buffers lost messages per topic: \n"
        "\t/exp/seq: 7\nTotal lost: 7\n"
    )
    assert session._scan_dropped_messages("run_d") == 7  # overflow reported
    log.write_text("[INFO] Recording...\n[INFO] Recording stopped\n")
    assert session._scan_dropped_messages("run_d") == 0  # log present, no overflow
    assert session._scan_dropped_messages("run_missing") is None  # no log -> unknown


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
    session._state = RunState.failed
    session._dropped_messages = 0
    assert session._classify_integrity() == "failed"


def test_integrity_dropped_surfaced_in_status_and_manifest(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A completed run whose log reports cache drops -> integrity 'dropped'."""
    from rosbag2_recorder.recorder import _recorder_log_path

    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_x"))
    # The fake spawn does not write a log; simulate rosbag2 reporting an overflow.
    _recorder_log_path(session._recorded_root(), "run_x").write_text(
        "Cache buffers lost messages per topic: \n\t/a: 12\nTotal lost: 12\n"
    )
    stopped = session.stop()
    assert stopped.state is RunState.completed  # data on disk, clean exit
    assert stopped.dropped_messages == 12
    assert stopped.integrity == "dropped"  # ...but incomplete
    final = read_manifest(settings.data_dir, "run_x")
    assert final.dropped_messages == 12
    assert final.integrity == "dropped"
    # The captured log is archived beside the bag for audit.
    assert (run_dir(settings.data_dir, "run_x") / "recorder.log").exists()


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
    assert prepared.arming is not None
    assert prepared.disarm_at is not None
    assert len(captured) == 1  # spawned once, by prepare()

    status = session.status()
    assert status.state is RunState.armed
    assert status.run_id == "run_p"

    started = session.start(_start_req("run_p", topics=["/joint_states"]))
    assert started.state is RunState.recording
    assert started.run_id == "run_p"
    assert len(captured) == 1  # start() did NOT spawn a second process
    assert len(resume_calls) == 1  # resumed exactly once, via the held clients

    stopped = session.stop()
    assert stopped.state is RunState.completed


def test_prepare_then_start_fast_path_matches_on_all_topics(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """topics="all" at prepare matches topics="all" at start (both normalise to
    the "all" sentinel, never to an equivalent explicit list)."""
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    session.prepare(RecordStartRequest(topics="all", run_id="run_all_p"))
    started = session.start(RecordStartRequest(topics="all", run_id="run_all_s"))
    assert started.state is RunState.recording
    assert started.run_id == "run_all_p"  # armed run_id, fixed at prepare time
    assert len(captured) == 1  # fast path: no second spawn


def test_start_uses_armed_run_id_even_if_request_run_id_differs(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """run_id is fixed at prepare time (the subprocess already opened that
    --output dir); a start() whose OTHER fields match commits under the
    ARMED run_id, even if the request itself names a different run_id."""
    session = _make_session(settings, fake_process, write_metadata)
    session.prepare(_start_req("run_armed_id", topics=["/joint_states"]))
    started = session.start(_start_req("run_requested_id", topics=["/joint_states"]))
    assert started.run_id == "run_armed_id"
    assert session.status().run_id == "run_armed_id"


def test_operator_task_come_from_start_request_not_prepare(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """operator/task are metadata only; the fast path uses the START request's
    values, not the (possibly placeholder) values passed to prepare()."""
    session = _make_session(settings, fake_process, write_metadata)
    session.prepare(_start_req("run_meta", operator="prep_operator", task="prep_task"))
    session.start(_start_req("run_meta", operator="real_operator", task="real_task"))

    payload = json.loads(session_path(settings.data_dir, "run_meta").read_text())
    assert payload["operator"] == "real_operator"
    assert payload["task"] == "real_task"


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


def test_prepare_while_already_armed_disarms_old_and_arms_new(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    session.prepare(_start_req("run_first"))
    assert session.status().run_id == "run_first"

    session.prepare(_start_req("run_second"))
    status = session.status()
    assert status.state is RunState.armed
    assert status.run_id == "run_second"
    assert not run_dir(Path(settings.data_dir), "run_first").exists()
    assert run_dir(Path(settings.data_dir), "run_second").exists()


def test_stop_while_armed_disarms(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    session = _make_session(settings, fake_process, write_metadata)
    session.prepare(_start_req("run_arm_stop"))
    assert session.status().state is RunState.armed

    stopped = session.stop()
    assert stopped.state is RunState.created  # reverted to the pre-arm state
    assert not run_dir(Path(settings.data_dir), "run_arm_stop").exists()
    assert session._armed is None  # type: ignore[attr-defined]


def test_stop_while_armed_restores_previous_completed_status(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Disarming must not erase visibility of a genuinely-completed prior run."""
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_done"))
    session.stop()
    assert session.status().state is RunState.completed

    session.prepare(_start_req("run_arm_after"))
    assert session.status().state is RunState.armed
    stopped = session.stop()
    assert stopped.state is RunState.completed
    assert stopped.run_id == "run_done"


def test_start_with_mismatched_armed_session_falls_back(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    captured: list[Any] = []
    session = _make_session(settings, fake_process, write_metadata, capture=captured)
    session.prepare(_start_req("run_armed_topics", topics=["/joint_states"]))
    assert session.status().state is RunState.armed

    # A start() with a DIFFERENT topic list does not match -> disarm + the
    # full synchronous path (a fresh spawn for the new topic selection).
    started = session.start(_start_req("run_full", topics=["/other_topic"]))
    assert started.state is RunState.recording
    assert started.run_id == "run_full"
    assert [t.name for t in started.topics] == ["/other_topic"]
    # The old armed run's dir was cleaned up (disarmed, not committed).
    assert not run_dir(Path(settings.data_dir), "run_armed_topics").exists()
    # Two spawns happened: one for prepare() (discarded), one for the full start.
    assert len(captured) == 2


def test_resume_failure_during_fast_start_fails_safely(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """A+B fail-safe applies to the fast path too: if resume fails/doesn't
    confirm, the start fails (507) rather than leaving a paused recorder."""
    from rosbag2_recorder.manifest import read_failed_start_record

    session = _make_session(settings, fake_process, write_metadata)
    session.prepare(_start_req("run_resume_fail"))

    def boom(_armed: Any) -> None:
        raise RuntimeError("resume did not confirm")

    session._resume_armed = boom  # type: ignore[method-assign]
    with pytest.raises(ApiError) as exc:
        session.start(_start_req("run_resume_fail"))
    assert exc.value.status_code == 507
    assert exc.value.code == "record_arm_failed"

    # No leaked paused recorder: state reverted, run dir gone, failure recorded.
    assert session.status().state is RunState.created
    assert not run_dir(Path(settings.data_dir), "run_resume_fail").exists()
    failed = read_failed_start_record(settings.data_dir, "run_resume_fail")
    assert failed.state is RunState.failed


def test_auto_disarm_fires_and_cleans_up_run_dir(
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
    assert not run_dir(Path(settings.data_dir), "run_auto").exists()


def test_stale_disarm_timer_is_a_noop_after_reprepare(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """The ABA race: disarm -> re-prepare between the timer firing and its
    callback acquiring the lock must not tear down the NEW armed session."""
    session = _make_session(settings, fake_process, write_metadata)
    session.prepare(_start_req("run_old"))
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
    assert run_dir(Path(settings.data_dir), "run_new").exists()
    assert not run_dir(Path(settings.data_dir), "run_old").exists()  # disarmed earlier
