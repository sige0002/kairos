"""E-39, recorder side: forty start/stop cycles and what they leave running.

Every recording starts a size-watcher thread whenever either cap is configured
— and the wall-clock cap is on by default (600s), so that is every recording on
a shipped installation. A shift is dozens of takes, which is where a missed
teardown shows: not as a failure, but as a recorder that has been up all
afternoon holding forty threads polling captures that finished hours ago.

The counts are read from THIS process before the loop rather than compared
against a constant, so what is asserted is accumulation, whatever else the
suite has running around it.

NOT covered here, deliberately and worth knowing: the per-run stdout/stderr log
**descriptor**. ``_make_session`` stubs the subprocess spawn, and the log file
is opened inside the real spawn — so it is never opened in this suite and a
descriptor count taken here cannot move. Asserting on one would have looked
like coverage of exactly the thing it cannot see.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from kairos_common import Settings
from rosbag2_recorder.models import RunState
from test_recorder import _make_session, _start_req

CYCLES = 40


def test_forty_cycles_leave_no_watcher_threads_behind(
    data_dir: Path, fake_process: type, write_metadata: Callable[..., Path]
) -> None:
    # The shipped default: no byte cap, a 600s wall-clock cap. This is the only
    # configuration that starts a watcher, and it is the normal one.
    settings = Settings(
        data_dir=str(data_dir), max_record_bytes=0, max_record_seconds=600
    )
    session = _make_session(settings, fake_process, write_metadata)

    threads_before = threading.active_count()

    capture_ids: list[str] = []
    for cycle in range(CYCLES):
        started = session.start(_start_req(f"run_{cycle}"))
        assert started.capture_id is not None
        capture_ids.append(started.capture_id)
        session.stop()
        assert session.status().state is RunState.completed
        # The finished process is released each cycle, not at process exit.
        assert session._process is None

    # Forty recordings, forty identities: the recorder mints capture_id (§1)
    # and a fast loop must not hand two takes the same one.
    assert len(set(capture_ids)) == CYCLES
    assert threading.active_count() == threads_before, (
        f"{threading.active_count() - threads_before} threads survived "
        f"{CYCLES} recordings: {sorted(t.name for t in threading.enumerate())}"
    )
