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


class LiveTopic(BaseModel):
    """One ROS 2 topic bridged into the dataflow."""

    name: str
    ros_type: str
    qos: str = "best_effort"
    depth: int = 30
    # Consumers beyond metrics (which always taps every topic).
    probe: bool = False
    webrtc: bool = False
    ai: bool = False

    def model_post_init(self, __context: object) -> None:
        if self.qos not in QOS_VALUES:
            raise ValueError(f"qos must be one of {QOS_VALUES}: {self.qos}")


class LiveManifest(BaseModel):
    """Full topic manifest for one dataflow run."""

    topics: list[LiveTopic] = Field(default_factory=list)
    # Bridge->consumer queue size. Mandatory practice (report §4.3): the dora
    # default queue drops bursty small messages once a slow consumer blocks.
    queue_size: int = 1000

    def topic(self, name: str) -> LiveTopic | None:
        for t in self.topics:
            if t.name == name:
                return t
        return None
