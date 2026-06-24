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
    RecordStartRequest,
    RunState,
    SplitConfig,
)
from rosbag2_recorder.recorder import RecorderSession, run_dir


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

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    # FakeProcess shares our pid; never deliver a real OS signal from a unit test.
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]
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
    assert (rd.parent.stat().st_mode & 0o002)  # world-writable bit set


def test_session_json_metadata_optional(
    settings: Settings, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    """Omitting operator/task writes nulls (still a session.json)."""
    session = _make_session(settings, fake_process, write_metadata)
    session.start(_start_req("run_n"))
    session.stop()
    payload = json.loads(session_path(settings.data_dir, "run_n").read_text())
    assert payload["operator"] is None
    assert payload["task"] is None


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
    assert "--compression-format" in cmd
    assert cmd[cmd.index("--compression-format") + 1] == "zstd"
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
