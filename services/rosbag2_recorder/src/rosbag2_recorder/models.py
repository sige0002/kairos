"""Request/response models and the run state enum for rosbag2_recorder.

The shapes here are the recorder's *internal* API (called by ``api_orchestrator``,
not public). They are pydantic models so the OpenAPI schema is generated and the
``api_orchestrator`` proxy can rely on a fixed contract. See
``docs/specs/ja/rosbag2_recorder.md``.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Annotated, Literal

from kairos_common import ApiError, Compression, Durability, Reliability
from pydantic import BaseModel, Field

# run_id charset guard, per the spec / config.md. Since v2 the run_id is a
# DISPLAY NAME only — ``objects/<capture_id>`` is the path — so this no longer
# guards a directory name. It still guards the value the orchestrator keys its
# UNIQUE column by and shows to operators, which is reason enough to keep it.
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


def validate_run_id(run_id: str) -> str:
    """Return *run_id* if it matches ``^[A-Za-z0-9_-]+$``, else raise 400."""
    if not RUN_ID_PATTERN.match(run_id):
        raise ApiError(
            status_code=400,
            code="invalid_run_id",
            message="run_id must match ^[A-Za-z0-9_-]+$.",
            details={"run_id": run_id},
        )
    return run_id


class RunState(StrEnum):
    """Run lifecycle state (shared vocabulary from config.md).

    The recorder drives a session through
    ``created -> recording -> stopping -> completed`` on the happy path, or to
    ``failed`` on error. ``interrupted`` marks a run that a previous process
    started but never finalized (e.g. the container was restarted mid-record).

    ``armed`` is the two-phase start state: ``POST /record/prepare`` spawned
    the recorder ``--start-paused`` and confirmed subscription matching, but a
    matching ``POST /record/start`` has not (yet) resumed it. Deliberately NOT
    a member of the recorder's "active" set (``_ACTIVE_STATES``): an armed
    session must not 409-block ``start()`` — the whole point is that ``start``
    *consumes* it (or disarms + falls through if it does not match).
    """

    created = "created"
    recording = "recording"
    stopping = "stopping"
    completed = "completed"
    failed = "failed"
    interrupted = "interrupted"
    armed = "armed"


class QosProfile(BaseModel):
    """A DDS QoS profile the recorder can request for a topic.

    Mirrors the override fields in ``recording.yaml`` so the orchestrator (or a
    caller) can pass the same shape. ``depth`` is the KEEP_LAST queue depth.
    """

    reliability: Reliability = Reliability.best_effort
    durability: Durability = Durability.volatile
    depth: Annotated[int, Field(ge=1)] = 10


class SplitConfig(BaseModel):
    """rosbag2 split thresholds. ``None`` on a field disables that split axis."""

    max_size_mb: Annotated[int, Field(ge=1)] | None = None
    max_duration_s: Annotated[int, Field(ge=1)] | None = None


class RecordStartRequest(BaseModel):
    """Body of ``POST /record/start``.

    ``topics`` is either an explicit list or the literal ``"all"`` (expanded to
    the live topic list at start time and frozen into the manifest). ``run_id``
    is allocated by ``api_orchestrator`` and passed in; the recorder validates
    its charset and uses it verbatim as the recording's display name. The
    capture's identity (``capture_id``) is minted by the recorder, not passed in.
    """

    topics: list[str] | Literal["all"]
    run_id: str
    compression: Compression = Compression.none
    split: SplitConfig | None = None
    qos_default: QosProfile | None = None
    qos_overrides: dict[str, QosProfile] | None = None
    # Optional session metadata; written to the capture's object_manifest.json.
    operator: str | None = None
    task: str | None = None
    # Which robot produced this capture. Omitted -> the recorder falls back to
    # its RECORDING_CONFIG ``robot_name``, so a standalone call still names one.
    robot: str | None = None


class TopicEntry(BaseModel):
    """A recorded topic with its resolved type and applied QoS."""

    name: str
    type: str | None = None
    qos: QosProfile | None = None


class RecordArming(BaseModel):
    """Observational state of the ``--start-paused`` readiness gate (OL-①.4).

    While ``recording.start_paused`` is in effect the recorder is
    subscribed-but-paused, waiting for the target topics to appear on the ROS
    graph before it resumes (begins writing). This surfaces what is matched vs
    still-missing and the instant the readiness-timeout auto-resume fires, so the
    UI can show arming progress. Purely observational — it never changes the
    recording behaviour, timing, or QoS. Field names match the frozen frontend
    ``RecordArming`` contract exactly.

    The not-yet-captured targets are split by CAUSE, because the UI states one
    as fact: ``missing_topics`` is "nobody is publishing this" and
    ``unsubscribed_topics`` is "it IS being published, the recorder just has not
    subscribed to it yet". Reporting the second as the first tells the operator a
    live topic is dead (it shows up fine in Monitor) and sends them to fix the
    wrong thing.
    """

    # True while paused and waiting for target topics (pre-resume); the final
    # snapshot (after resume) reports ``False`` with the last matched/missing set.
    active: bool = False
    # Target topics already present on the graph (recorder subscribed).
    matched_topics: list[str] = Field(default_factory=list)
    # Target topics with NO publisher on the graph — genuinely not publishing.
    missing_topics: list[str] = Field(default_factory=list)
    # Target topics that ARE published but the recorder has not subscribed to
    # yet (DDS discovery still catching up). Additive field: an older frontend
    # that does not know it simply shows one fewer category.
    unsubscribed_topics: list[str] = Field(default_factory=list)
    # ISO8601 instant the recorder auto-resumes anyway (readiness timeout).
    resume_at: str | None = None
    # ISO8601 instant an ``armed`` (two-phase ``prepare()``) session auto-
    # disarms if no matching ``start()`` claims it (``recording.
    # prepare_disarm_timeout_s``). A DIFFERENT concept from ``resume_at``
    # (the single-call gate's own readiness-timeout auto-resume deadline):
    # ``None`` unless this snapshot came from an active/former ``prepare()``.
    disarm_at: str | None = None


class RecordPrepareRequest(RecordStartRequest):
    """Body of ``POST /record/prepare``. Same shape as ``RecordStartRequest``.

    ``run_id`` is still allocated by the caller (``api_orchestrator``) and
    supplied here; it becomes the recording's run_id if a later matching
    ``POST /record/start`` claims this armed session (run_id is fixed at
    prepare time — the subprocess is already writing into that output dir).
    """


class RecordPrepareResponse(BaseModel):
    """Body of a successful ``POST /record/prepare`` (201).

    The session is now ``armed``: ``ros2 bag record --start-paused`` has been
    spawned and its subscriptions matched (or the readiness timeout elapsed),
    but it has NOT been resumed. A matching ``POST /record/start`` resumes it
    (near-instant); a non-matching one disarms it and falls back to a full
    synchronous start.
    """

    run_id: str
    # Minted here: the armed session already owns ``objects/<capture_id>/``, and
    # a matching start() commits under this id (the run_id may differ — see
    # ``RecorderSession._armed_matches``).
    capture_id: str
    state: RunState
    arming: RecordArming | None = None
    # ISO8601 instant this armed session auto-disarms if unclaimed. Mirrors
    # ``arming.disarm_at`` at the top level for a caller that only wants the
    # deadline (see ``recording.prepare_disarm_timeout_s``).
    disarm_at: str | None = None


class RecordStartResponse(BaseModel):
    """Body of a successful ``POST /record/start`` (201)."""

    run_id: str
    # The capture's global identity (§1): the orchestrator's PK and the only
    # key that resolves to bytes on disk. ``run_id`` is a display name.
    capture_id: str
    state: RunState
    started_at: str
    # The settled arming snapshot (OL-①.4): /record/start blocks through the
    # --start-paused readiness gate, so its final state is known by the time this
    # 201 returns. Lets the orchestrator pass arming through without a second GET.
    arming: RecordArming | None = None


class RecordStatusResponse(BaseModel):
    """Body of ``GET /record/status``."""

    state: RunState
    run_id: str | None = None
    # The capture this status describes: the armed one while ``armed``, the live
    # one while recording/stopping, the last one afterwards. ``null`` only
    # before this process has recorded anything — a finalised session keeps
    # naming its capture so the stop response identifies what it just finished.
    capture_id: str | None = None
    # The definitive list of captures the recorder is still the sole writer of —
    # armed, recording or stopping. The orchestrator's rebuild uses it as §8
    # rule 1's live-exclusion source and MUST skip every id in it: those
    # directories are mid-flight, and an armed one has no manifest yet at all.
    # Empty once the session is finalised, which is the answer "none are live"
    # — distinct from ``capture_id``, which still names the last capture.
    live_capture_ids: list[str] = Field(default_factory=list)
    # Set only by a ``stop()`` that cancelled an ARMED session: the capture that
    # was thrown away, never recorded and never written to disk. It cannot ride
    # on ``capture_id`` — that names the last *finalised* capture, and a cancel
    # must not overwrite it — but the caller still needs to know which id it
    # asked for is now dead, so it stops waiting for a capture that will never
    # appear. ``null`` on every other stop.
    disarmed_capture_id: str | None = None
    started_at: str | None = None
    message_count: int = 0
    bytes: int = 0
    topics: list[TopicEntry] = Field(default_factory=list)
    # Present once a ``--start-paused`` arming gate has run for this session
    # (``null`` otherwise). The final snapshot persists while ``recording``.
    arming: RecordArming | None = None
    # Recording integrity from rosbag2's in-recorder cache (post-finalise). The
    # cache drops on overflow and reports "Total lost: N"; we surface that count
    # (``null`` = not yet known / unavailable) and a coarse classification:
    # "ok" (no overflow) | "dropped" (cache lost messages) | "failed" | "unknown".
    dropped_messages: int | None = None
    integrity: str = "unknown"
