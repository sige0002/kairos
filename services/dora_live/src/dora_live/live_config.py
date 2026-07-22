"""LIVE_CONFIG — which topics the live (dora) lanes ingest, and how.

Separate from RECORDING_CONFIG by design: the recorder's topic set is the
canonical-data decision, the live set is an operator-UX decision, and coupling
them forces one to distort the other. The file is optional and every field has
a robot-independent default, so a new robot needs NO live config to work:

- ``topics: null``  -> inherit the recording ``default_topics`` (zero-config).
- per-topic QoS     -> ``qos_overrides`` here, else the recording config's
  ``topic_qos_overrides``, else auto-match against the offered publisher QoS
  (the same :func:`kairos_common.monitoring.resolve_subscription_qos` the
  monitor uses — no second implementation).
- video lane        -> resolved from the ros type (CompressedImage -> cv2,
  FFMPEGPacket -> PyAV/ffmpeg); ``video`` rules override per glob pattern,
  including opting raw ``sensor_msgs/Image`` in (off by default: >55 MB/s raw
  camera flows enter the RustDDS fragmentation-loss regime — bench-measured).
"""

from __future__ import annotations

import logging
from fnmatch import fnmatch
from pathlib import Path
from typing import Literal

import yaml
from kairos_common import RecordingConfig
from kairos_common.monitoring import resolve_subscription_qos
from kairos_common.monitoring.models import QosInfo
from kairos_common.recording_config import TopicQosOverride
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger("kairos.dora_live")

# Video-lane codecs: how the WebRTC node turns a topic's payload into frames.
#   image  = sensor_msgs/CompressedImage (JPEG/PNG via cv2.imdecode)
#   ffmpeg = ffmpeg_image_transport FFMPEGPacket (H.264/HEVC/... via PyAV)
#   raw    = sensor_msgs/Image (numpy reshape; explicit opt-in only)
#   off    = exclude the topic from the video lane
VideoCodec = Literal["image", "ffmpeg", "raw", "off"]

_FFMPEG_PACKET_TYPES = {"FFMPEGPacket"}
_COMPRESSED_IMAGE_TYPES = {"CompressedImage"}
_RAW_IMAGE_TYPES = {"Image"}


class LiveVideoRule(BaseModel):
    """One video-lane rule: topics matching *pattern* use *codec*."""

    model_config = ConfigDict(extra="forbid")

    pattern: str
    codec: VideoCodec


class LiveVideoDefaults(BaseModel):
    """Server-side stream defaults when the client omits a quality hint.

    The decode/encode budget lever: without a resolution cap every preview
    stream decodes AND encodes at the camera's native size — on HD cameras
    that (not transport) dominates the webrtc node's CPU.
    """

    model_config = ConfigDict(extra="forbid")

    max_fps: int = Field(default=15, ge=1, le=60)
    max_width: int | None = Field(default=None, ge=16, le=7680)
    max_height: int | None = Field(default=None, ge=16, le=4320)


class LiveQueuesConfig(BaseModel):
    """Per-consumer dataflow queue depths.

    One size never fit all: metrics COUNTS arrivals (a dropped event is a
    mis-measured Hz — keep it deep), while the preview lanes are latest-wins
    (a queued stale camera frame is pure decode waste and, at depth 1000,
    ~33 s of latency + pinned shared memory once the consumer falls behind —
    the field incident behind the choppy-preview report).
    """

    model_config = ConfigDict(extra="forbid")

    # None = inherit the top-level queue_size (back-compat).
    metrics: int | None = Field(default=None, ge=1)
    probe: int = Field(default=4, ge=1)
    webrtc: int = Field(default=2, ge=1)
    frames: int = Field(default=2, ge=1)


class LiveFramesConfig(BaseModel):
    """Live-frames lane knobs (see :mod:`dora_live.frames_lane`).

    The lane forwards already-compressed video-lane payloads (``image`` as-is,
    ``ffmpeg`` keyframes only; ``raw`` never) at ``sample_hz`` per topic, for
    LAN consumers to pull via ``GET /live/frames``.
    """

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    sample_hz: float = Field(default=2.0, gt=0)


class LiveConfig(BaseModel):
    """Parsed LIVE_CONFIG (``config/<robot>/live/default.yaml``)."""

    model_config = ConfigDict(extra="forbid")

    # None = inherit the recording config's default_topics (the zero-config
    # path for a new robot). An explicit list fully replaces it.
    topics: list[str] | None = None
    # Live-only additions on top of the base set (e.g. a diagnostics topic
    # that is monitored but deliberately not recorded).
    extra_topics: list[str] = Field(default_factory=list)
    # Glob patterns removed from the final set (e.g. drop a raw camera the
    # recorder captures but the live lanes must not pull through the bridge).
    exclude: list[str] = Field(default_factory=list)
    # First match wins; falls back to the recording config's
    # topic_qos_overrides, then publisher auto-match.
    qos_overrides: list[TopicQosOverride] = Field(default_factory=list)
    # First match wins; unmatched topics resolve by ros type.
    video: list[LiveVideoRule] = Field(default_factory=list)
    # Applied when a /stream/start omits max_fps / max_width / max_height.
    video_defaults: LiveVideoDefaults = Field(default_factory=LiveVideoDefaults)
    # Live-frames lane (decimated compressed payloads for LAN pull).
    frames: LiveFramesConfig = Field(default_factory=LiveFramesConfig)
    # Per-consumer queue depths (see LiveQueuesConfig).
    queues: LiveQueuesConfig = Field(default_factory=LiveQueuesConfig)
    # Metrics-lane queue depth (legacy name; queues.metrics overrides).
    queue_size: int = Field(default=1000, ge=1)


def load_live_config(path: str | Path | None) -> LiveConfig:
    """Load LIVE_CONFIG, tolerating absence (all-default = inherit recording).

    A malformed file raises (fail loud at startup — a typo silently reverting
    the whole live lane to defaults would be an honesty violation).
    """
    if not path:
        return LiveConfig()
    p = Path(path)
    if not p.is_file():
        logger.info("live config absent (%s); inheriting recording topics", p)
        return LiveConfig()
    data = yaml.safe_load(p.read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"live config must be a mapping: {p}")
    return LiveConfig.model_validate(data)


def resolve_live_topics(
    live: LiveConfig, recording: RecordingConfig | None
) -> list[str]:
    """Final live allowlist: (topics or recording default) + extra - exclude."""
    if live.topics is not None:
        base = list(live.topics)
    elif recording is not None:
        base = list(recording.default_topics)
    else:
        base = []
    merged: list[str] = []
    for name in [*base, *live.extra_topics]:
        if name not in merged:
            merged.append(name)
    return [
        name for name in merged if not any(fnmatch(name, pat) for pat in live.exclude)
    ]


def resolve_topic_qos(
    topic: str,
    publishers: list[QosInfo],
    live: LiveConfig,
    recording: RecordingConfig | None,
    *,
    default_depth: int = 30,
) -> QosInfo:
    """Per-topic subscription QoS: live override > recording override > auto.

    The auto path (and the recording-override path) is the monitor's own
    :func:`resolve_subscription_qos` — one QoS brain for the whole stack.
    """
    for override in live.qos_overrides:
        if fnmatch(topic, override.pattern):
            return QosInfo(
                reliability=override.reliability.value,
                durability=override.durability.value,
                depth=override.depth,
            )
    return resolve_subscription_qos(
        topic, publishers, recording, default_depth=default_depth
    )


def resolve_video_codec(topic: str, ros_type: str, live: LiveConfig) -> str | None:
    """Video-lane codec for *topic*, or ``None`` (not on the video lane).

    Config rules win (first match); the type-driven default keeps new robots
    zero-config: any CompressedImage topic previews via cv2, any FFMPEGPacket
    topic via PyAV. Raw ``sensor_msgs/Image`` never joins by default (RustDDS
    fragmentation-loss regime above ~55 MB/s) — an explicit ``raw`` rule is
    the operator's informed opt-in.
    """
    for rule in live.video:
        if fnmatch(topic, rule.pattern):
            if rule.codec == "off":
                return None
            if rule.codec == "raw" and _type_leaf(ros_type) not in _RAW_IMAGE_TYPES:
                logger.warning(
                    "video rule %r wants raw but %s is %s; skipping",
                    rule.pattern,
                    topic,
                    ros_type,
                )
                return None
            return rule.codec
    leaf = _type_leaf(ros_type)
    if leaf in _COMPRESSED_IMAGE_TYPES:
        return "image"
    if leaf in _FFMPEG_PACKET_TYPES:
        return "ffmpeg"
    return None


def _type_leaf(ros_type: str) -> str:
    return ros_type.rsplit("/", 1)[-1]
