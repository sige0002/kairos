"""Recording integrity: what the in-recorder cache dropped, and how to file it.

Split out of :mod:`rosbag2_recorder.recorder` unchanged. These are pure
functions over the recorder's captured log and the session's terminal state;
:class:`~rosbag2_recorder.recorder.RecorderSession` keeps the thin methods that
resolve the log locations and hands the paths in, so this module never needs to
know how a capture directory is laid out.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable
from pathlib import Path

from rosbag2_recorder.models import RunState

# Deliberately the same logger the recorder itself uses: these lines are the
# recorder's voice during finalise, and splitting the module must not split the
# log stream an operator greps during an incident.
logger = logging.getLogger("kairos.rosbag2_recorder")

# Terminal states that mean the recording did not end the way it was asked to.
_BROKEN_STATES = frozenset({RunState.failed, RunState.interrupted})

# rosbag2's in-recorder MessageCache logs the messages it dropped on cache
# overflow at shutdown (MessageCache::log_dropped, WARN to stderr):
#   "Cache buffers lost messages per topic:\n\t<topic>: <n>\nTotal lost: <N>"
# Scanning the captured log for the total turns a silent in-recorder drop into a
# visible integrity signal (OpenLUTRA does not surface this at all).
_TOTAL_LOST_RE = re.compile(r"Total lost:\s*(\d+)")


def scan_dropped_messages(locations: Iterable[Path]) -> int | None:
    """Messages the in-recorder cache dropped this run, from the captured log.

    rosbag2 logs ``Total lost: N`` once at shutdown when its MessageCache
    overflowed. Returns that N, ``0`` when the log exists with no such line
    (no overflow), or ``None`` when the log is unavailable/unreadable (drop
    count unknown — e.g. a stubbed spawn in unit tests).

    *locations* is tried in order, because the two callers see different
    ones: finalise scans before :func:`archive_log` moves the sibling in,
    while crash recovery scans a capture whose log was archived first. A
    single hard-coded location would silently report "unknown" for one of
    them, which reads as "no overflow was detectable" rather than "nobody
    looked in the right place".
    """
    for path in locations:
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        # One report per run (at shutdown); take the last match to be safe.
        matches = _TOTAL_LOST_RE.findall(text)
        return int(matches[-1]) if matches else 0
    return None


def classify_integrity(state: RunState, dropped_messages: int | None) -> str:
    """Classify recording integrity from state + cache-drop count.

    ``failed`` whenever the recording did not end cleanly — a capture that
    was interrupted is missing whatever the operator meant to record after
    the crash, which the drop count cannot describe. Otherwise ``unknown``
    when the drop count could not be determined, ``dropped`` when the cache
    lost >0 messages, and ``ok`` when a readable log reported no overflow.
    """
    if state in _BROKEN_STATES:
        return "failed"
    if dropped_messages is None:
        return "unknown"
    return "dropped" if dropped_messages > 0 else "ok"


def archive_log(src: Path, dst: Path, capture_id: str) -> None:
    """Move the sibling recorder log into the capture dir (best-effort).

    Done at finalise — while the recorder is still the capture's sole writer
    (§3.3). Adding a file after the digest job has sealed ``files`` would
    make the sealed digest describe a directory that no longer matches, so
    this must never run over a capture the recorder has already handed off.
    A missing sibling (stubbed spawn) is a no-op.
    """
    try:
        if src.exists():
            src.replace(dst)
    except OSError:
        logger.warning("could not archive recorder log for %s", capture_id)
