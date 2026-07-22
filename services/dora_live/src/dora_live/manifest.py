"""Live manifest: which topics the bridge ingests and who consumes them.

The control sidecar builds a manifest from the robot's live config plus
discovery, generates the dataflow from it (:mod:`dora_live.dataflow_gen`) and
restarts ``dora run`` when the manifest changes. Restart is the only way to
change the topic set: the dataflow graph is static per run (one bridge node
per topic, cell-verified pattern).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

QOS_VALUES = ("reliable", "best_effort")
DURABILITY_VALUES = ("volatile", "transient_local")


class LiveTopic(BaseModel):
    """One ROS 2 topic bridged into the dataflow.

    ``qos``/``durability``/``depth`` are the RESOLVED subscription QoS (live
    config override > recording override > publisher auto-match — see
    :mod:`dora_live.live_config`). ``video`` names the video-lane codec
    (``image``/``ffmpeg``/``raw``) or ``None`` when the topic is not previewed.
    """

    name: str
    ros_type: str
    qos: str = "best_effort"
    durability: str = "volatile"
    depth: int = 30
    video: str | None = None

    def model_post_init(self, __context: object) -> None:
        if self.qos not in QOS_VALUES:
            raise ValueError(f"qos must be one of {QOS_VALUES}: {self.qos}")
        if self.durability not in DURABILITY_VALUES:
            raise ValueError(
                f"durability must be one of {DURABILITY_VALUES}: {self.durability}"
            )


class LaneQueues(BaseModel):
    """Resolved per-consumer queue depths (see live_config.LiveQueuesConfig)."""

    metrics: int = 1000
    probe: int = 4
    webrtc: int = 2
    frames: int = 2


class LiveManifest(BaseModel):
    """Full topic manifest for one dataflow run."""

    topics: list[LiveTopic] = Field(default_factory=list)
    # Metrics-lane depth (legacy field; kept as the queues.metrics fallback).
    # Explicit queues stay mandatory practice (report §4.3): the dora default
    # queue drops bursty small messages once a slow consumer blocks.
    queue_size: int = 1000
    # Per-consumer depths: deep where events are COUNTED (metrics), shallow
    # where only the freshest payload matters (preview lanes).
    queues: LaneQueues = Field(default_factory=LaneQueues)
    # Live-frames lane (frames node): resolved from LIVE_CONFIG. Part of the
    # manifest so a config change restarts the dataflow like any other change.
    frames_enabled: bool = True
    frames_sample_hz: float = 2.0

    def topic(self, name: str) -> LiveTopic | None:
        for t in self.topics:
            if t.name == name:
                return t
        return None
