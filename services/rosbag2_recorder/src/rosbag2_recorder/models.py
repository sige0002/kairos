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

from kairos_common import Compression, Durability, Reliability
from pydantic import BaseModel, Field

# run_id charset guard (path-traversal prevention), per the spec / config.md.
RUN_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")


class RunState(StrEnum):
    """Run lifecycle state (shared vocabulary from config.md).

    The recorder drives a session through
    ``created -> recording -> stopping -> completed`` on the happy path, or to
    ``failed`` on error. ``interrupted`` marks a run that a previous process
    started but never finalized (e.g. the container was restarted mid-record).
    """

    created = "created"
    recording = "recording"
    stopping = "stopping"
    completed = "completed"
    failed = "failed"
    interrupted = "interrupted"


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
    its charset and uses it verbatim.
    """

    topics: list[str] | Literal["all"]
    run_id: str
    compression: Compression = Compression.none
    split: SplitConfig | None = None
    qos_default: QosProfile | None = None
    qos_overrides: dict[str, QosProfile] | None = None
    # Optional session metadata; written to the run's session.json sidecar.
    operator: str | None = None
    task: str | None = None


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
    """

    # True while paused and waiting for target topics (pre-resume); the final
    # snapshot (after resume) reports ``False`` with the last matched/missing set.
    active: bool = False
    # Target topics already present on the graph (recorder subscribed).
    matched_topics: list[str] = Field(default_factory=list)
    # Target topics still missing (recorder waiting on these).
    missing_topics: list[str] = Field(default_factory=list)
    # ISO8601 instant the recorder auto-resumes anyway (readiness timeout).
    resume_at: str | None = None


class RecordStartResponse(BaseModel):
    """Body of a successful ``POST /record/start`` (201)."""

    run_id: str
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
    started_at: str | None = None
    message_count: int = 0
    bytes: int = 0
    topics: list[TopicEntry] = Field(default_factory=list)
    # Present once a ``--start-paused`` arming gate has run for this session
    # (``null`` otherwise). The final snapshot persists while ``recording``.
    arming: RecordArming | None = None
