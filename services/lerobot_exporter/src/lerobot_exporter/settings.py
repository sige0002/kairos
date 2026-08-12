"""Runtime knobs for the exporter, read from ``KAIROS_LEROBOT_*`` env vars.

They follow the in-tree convention for service-specific tuning (dora_runner's
``KAIROS_DORA_MAX_CONCURRENCY`` / ``KAIROS_PLUGINS_DIR``): every value falls
back to a safe default on an unset or unparsable variable, so a typo in the
deployment's env degrades to the documented behaviour instead of refusing to
start.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

# The converter entry point. Overridable so tests can point at a stub and a
# deployment can pin an absolute path inside its image.
BIN_ENV = "KAIROS_LEROBOT_BIN"
DEFAULT_BIN = "rosbag2lerobot"

# --workers passed to `convert`. Conservative by default: the converter's
# per-episode work is ffmpeg-bound and parallel encodes mostly compete for the
# same cores, which is the recorder's drop budget when a recording runs
# alongside an export.
WORKERS_ENV = "KAIROS_LEROBOT_WORKERS"
DEFAULT_WORKERS = 1

# Execution slots. Submission is unbounded (FIFO queue); this bounds how many
# conversions actually run. Default 1 for the same reason as --workers.
MAX_CONCURRENCY_ENV = "KAIROS_LEROBOT_MAX_CONCURRENCY"
DEFAULT_MAX_CONCURRENCY = 1

# GPU encoding opt-in. OFF by default because the converter's NVENC
# auto-detection only asks whether ffmpeg was COMPILED with the encoder — in a
# container without the NVIDIA runtime that answers yes and then ffmpeg dies on
# "Cannot load libcuda.so.1" (found by the first real end-to-end run). CPU
# encoding is deterministic everywhere; set to 1 only on a deployment whose
# exporter container actually has the GPU passed through.
GPU_ENV = "KAIROS_LEROBOT_GPU"
DEFAULT_GPU = False

# How stale the converter's heartbeat may get before the status says `stalled`.
# The export is NOT killed — a slow episode and a wedged one look the same from
# here, and only the operator can tell them apart. 300s rather than something
# tighter because of a documented converter gap: the heartbeat pauses while an
# episode's video is being encoded, so the threshold must outlast a normal
# encode or every long episode would flash a false stall.
STALL_ENV = "KAIROS_LEROBOT_STALL_S"
DEFAULT_STALL_S = 300.0

# Heartbeat/summary polling period while a conversion runs.
POLL_ENV = "KAIROS_LEROBOT_POLL_S"
DEFAULT_POLL_S = 1.0

# Cancel: how long the converter's process group gets to honour SIGTERM before
# SIGKILL. ffmpeg children are why this is a group signal and not a bare kill.
TERM_GRACE_ENV = "KAIROS_LEROBOT_TERM_GRACE_S"
DEFAULT_TERM_GRACE_S = 10.0

# How long to keep reading the converter's output after it exits. Bounded
# because the pipes are INHERITED by whatever the converter spawned: an ffmpeg
# that outlives its parent holds them open, and an unbounded wait would hang
# the export on a process we no longer track.
DRAIN_ENV = "KAIROS_LEROBOT_DRAIN_S"
DEFAULT_DRAIN_S = 5.0


def _env_float(name: str, default: float, *, minimum: float) -> float:
    try:
        return max(minimum, float(os.environ.get(name, "")))
    except ValueError:
        return default


def _env_int(name: str, default: int, *, minimum: int) -> int:
    try:
        return max(minimum, int(os.environ.get(name, "")))
    except ValueError:
        return default


@dataclass(frozen=True)
class ExporterConfig:
    """Resolved runtime knobs for one app instance."""

    bin: str = DEFAULT_BIN
    workers: int = DEFAULT_WORKERS
    max_concurrency: int = DEFAULT_MAX_CONCURRENCY
    gpu: bool = DEFAULT_GPU
    stall_s: float = DEFAULT_STALL_S
    poll_s: float = DEFAULT_POLL_S
    term_grace_s: float = DEFAULT_TERM_GRACE_S
    drain_s: float = DEFAULT_DRAIN_S

    @classmethod
    def from_env(cls) -> ExporterConfig:
        """Build the config from the process environment."""
        return cls(
            bin=os.environ.get(BIN_ENV) or DEFAULT_BIN,
            workers=_env_int(WORKERS_ENV, DEFAULT_WORKERS, minimum=1),
            max_concurrency=_env_int(
                MAX_CONCURRENCY_ENV, DEFAULT_MAX_CONCURRENCY, minimum=1
            ),
            gpu=os.environ.get(GPU_ENV, "").strip() in ("1", "true", "yes"),
            stall_s=_env_float(STALL_ENV, DEFAULT_STALL_S, minimum=1.0),
            # A zero poll period would spin the event loop on stat() calls.
            poll_s=_env_float(POLL_ENV, DEFAULT_POLL_S, minimum=0.01),
            term_grace_s=_env_float(TERM_GRACE_ENV, DEFAULT_TERM_GRACE_S, minimum=0.0),
            drain_s=_env_float(DRAIN_ENV, DEFAULT_DRAIN_S, minimum=0.0),
        )
