# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Stop-path hardening: the recorder must never leave a bag process writing.

Both cases here end the same way if left unfixed — the recorder reports the
capture as terminal while the recording is, in fact, still live or still
un-endable:

* a ``ros2 bag record`` that ignores SIGINT *and* SIGTERM used to be logged
  about and then abandoned, still holding (and appending to) the MCAP;
* a session left in ``recording`` with no subprocess handle made ``stop()`` a
  permanent no-op, which the console surfaces as an endless
  ``stop_not_confirmed`` because the status it re-reads is still active.

The SIGKILL test drives a REAL child process: the thing under test is the OS
signal path, so a fake would prove nothing. The child is put in its own session
so the process-group signals can never reach the test runner.
"""

from __future__ import annotations

import signal
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from kairos_common import Settings
from kairos_common.capture_sidecars import capture_dir, read_object_manifest
from rosbag2_recorder.models import RecordStartRequest, RunState
from rosbag2_recorder.recorder import RecorderSession

# A child that refuses both catchable stop signals, then sleeps. It announces
# itself only AFTER the handlers are installed: signalled any earlier the
# default SIGINT disposition would kill it, and the test would pass green
# without ever reaching the escalation it exists to prove.
_STUBBORN_CHILD = """
import signal, sys, time
signal.signal(signal.SIGINT, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
sys.stdout.write("ready\\n")
sys.stdout.flush()
time.sleep(300)
"""


def test_signal_and_wait_escalates_to_sigkill(
    monkeypatch: pytest.MonkeyPatch, settings: Settings
) -> None:
    """A bag process that ignores SIGINT and SIGTERM is still killed."""
    import rosbag2_recorder.recorder as rec

    # Two escalation waits at the real 30s would make this test unusable.
    monkeypatch.setattr(rec, "STOP_TIMEOUT_S", 0.3)

    child = subprocess.Popen(
        [sys.executable, "-c", _STUBBORN_CHILD],
        start_new_session=True,  # own process group: killpg cannot reach pytest
        stdout=subprocess.PIPE,
    )
    try:
        assert child.stdout is not None
        assert child.stdout.readline().strip() == b"ready"

        RecorderSession(settings, None)._signal_and_wait(child)

        assert child.poll() is not None, "the recorder left the process running"
        assert child.returncode == -signal.SIGKILL
    finally:
        if child.poll() is None:  # never leak a child, however the test ends
            child.kill()
            child.wait(timeout=5)
        if child.stdout is not None:
            child.stdout.close()


def test_escalation_order_is_sigint_then_sigterm_then_sigkill(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, fake_process: type
) -> None:
    """The full ladder, fake-driven: two survived waits → INT, TERM, KILL.

    The real-child test above proves the OS half; this proves the ORDER and
    the per-stage waits, which it cannot (a real child that ignores both
    signals dies at the first SIGKILL with no way to observe the sequence).
    Possible at all only because FakeProcess.wait can now express a delayed
    exit (`wait_timeouts`) instead of always exiting on the first wait.
    """
    import rosbag2_recorder.recorder as rec

    sent: list[int] = []
    monkeypatch.setattr(rec.os, "getpgid", lambda pid: 424242)
    monkeypatch.setattr(rec.os, "killpg", lambda pgid, sig: sent.append(sig))
    proc = fake_process(["ros2", "bag", "record"], wait_timeouts=2)

    RecorderSession(settings, None)._signal_and_wait(proc)

    assert sent == [signal.SIGINT, signal.SIGTERM, signal.SIGKILL]
    # Three waits ran (one per stage) and the third reaped the process.
    assert proc.wait_calls == 3
    assert proc.poll() is not None


def test_a_flush_that_survives_one_wait_needs_no_escalation(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, fake_process: type
) -> None:
    """Delayed SUCCESS: a slow flush that exits within the SIGINT budget must
    end with exactly one signal — escalating into a healthy drain would kill
    the very flush the wait exists to protect."""
    import rosbag2_recorder.recorder as rec

    sent: list[int] = []
    monkeypatch.setattr(rec.os, "getpgid", lambda pid: 424242)
    monkeypatch.setattr(rec.os, "killpg", lambda pgid, sig: sent.append(sig))
    proc = fake_process(["ros2", "bag", "record"], wait_timeouts=0)

    RecorderSession(settings, None)._signal_and_wait(proc)

    assert sent == [signal.SIGINT]
    assert proc.poll() is not None


def test_sigterm_wait_reports_confirmed_reap(
    monkeypatch: pytest.MonkeyPatch, settings: Settings, fake_process: type
) -> None:
    """A child collected after SIGTERM is safe to finalize synchronously."""
    import rosbag2_recorder.recorder as rec

    sent: list[int] = []
    monkeypatch.setattr(rec.os, "getpgid", lambda _pid: 424242)
    monkeypatch.setattr(rec.os, "killpg", lambda _pgid, sig: sent.append(sig))
    proc = fake_process(["ros2", "bag", "record"], wait_timeouts=1)

    reaped = RecorderSession(settings, None)._signal_and_wait(proc)

    assert reaped is True
    assert sent == [signal.SIGINT, signal.SIGTERM]
    assert proc.poll() is not None


def test_unreaped_writer_keeps_lease_until_background_reap(
    monkeypatch: pytest.MonkeyPatch,
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> None:
    """A bounded-stop timeout must not publish a terminal capture."""

    class DeferredReapProcess(fake_process):
        def __init__(self, cmd: list[str]) -> None:
            super().__init__(cmd)
            self.reap_entered = threading.Event()
            self.allow_reap = threading.Event()

        def wait(self, timeout: float | None = None) -> int:
            self.wait_calls += 1
            if timeout is not None:
                raise subprocess.TimeoutExpired(self.cmd, timeout)
            assert timeout is None
            self.reap_entered.set()
            assert self.allow_reap.wait(5.0)
            self._alive = False
            return self.returncode

    process: DeferredReapProcess | None = None
    session = RecorderSession(settings, None)
    sent: list[int] = []
    monkeypatch.setattr("rosbag2_recorder.recorder.os.getpgid", lambda _pid: 424242)
    monkeypatch.setattr(
        "rosbag2_recorder.recorder.os.killpg",
        lambda _pgid, sent_signal: sent.append(sent_signal),
    )

    def fake_spawn(cmd: list[str]) -> DeferredReapProcess:
        nonlocal process
        process = DeferredReapProcess(cmd)
        write_metadata(Path(cmd[cmd.index("--output") + 1]))
        return process

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    session.start(RecordStartRequest(run_id="run_unreaped", topics=["/joint_states"]))
    capture_id = session.status().capture_id
    assert capture_id is not None

    stopped = session.stop()

    assert process is not None
    assert process.reap_entered.wait(5.0)
    assert sent == [signal.SIGINT, signal.SIGTERM, signal.SIGKILL]
    assert process.wait_calls == 4  # three bounded waits, then the blocking reap
    assert stopped.state is RunState.stopping
    assert session.status().state is RunState.stopping
    assert session.status().live_capture_ids == [capture_id]
    assert session._process is process
    manifest = read_object_manifest(capture_dir(settings.data_dir, capture_id)).manifest
    assert manifest is not None
    assert manifest.state == "stopping"

    process.allow_reap.set()
    assert session._reaper_thread is not None
    session._reaper_thread.join(timeout=5.0)
    assert not session._reaper_thread.is_alive()

    assert session.status().state is RunState.completed
    assert session.status().live_capture_ids == []
    terminal = read_object_manifest(capture_dir(settings.data_dir, capture_id)).manifest
    assert terminal is not None
    assert terminal.state == "completed"


def _recording_session(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
) -> RecorderSession:
    """A session that really ran ``start()``, with the OS-touching seams stubbed."""
    session = RecorderSession(settings, None)

    def fake_spawn(cmd: list[str]) -> Any:
        proc = fake_process(cmd)
        write_metadata(Path(cmd[cmd.index("--output") + 1]))  # also makes the dir
        return proc

    session._spawn_process = fake_spawn  # type: ignore[method-assign]
    # FakeProcess reports OUR pid, so a real signal would hit the test runner.
    session._signal_and_wait = lambda _proc: None  # type: ignore[method-assign]
    session.start(RecordStartRequest(run_id="run_wedge", topics=["/joint_states"]))
    return session


def test_stop_releases_a_session_that_lost_its_process(
    settings: Settings,
    fake_process: type,
    write_metadata: Callable[..., Path],
    caplog: pytest.LogCaptureFixture,
) -> None:
    """``recording`` with no subprocess must not make stop() a permanent no-op.

    This is the wedge behind the endless ``stop_not_confirmed``: the console
    re-reads status after every stop, finds an active state again, and can only
    offer Retry. The session has to reach a terminal state from disk facts.
    """
    session = _recording_session(settings, fake_process, write_metadata)
    capture_id = session.status().capture_id
    assert capture_id is not None

    # The wedge: the state claims a live recording, the handle is gone.
    session._process = None
    assert session.status().state is RunState.recording

    with caplog.at_level("ERROR"):
        stopped = session.stop()

    # A bag is on disk, so the capture is salvageable -> interrupted, not failed.
    assert stopped.state is RunState.interrupted
    # ...and it STAYS terminal for every later reader. Both of these returned
    # `recording` forever before the fix.
    assert session.status().state is RunState.interrupted
    assert session.stop().state is RunState.interrupted  # still idempotent

    # The invariant violation is reported, not silently repaired.
    assert "no subprocess handle" in caplog.text

    # The manifest agrees with the API, and the capture is closed out.
    manifest = read_object_manifest(capture_dir(settings.data_dir, capture_id)).manifest
    assert manifest is not None
    assert manifest.state == "interrupted"
    assert manifest.ended_at is not None
