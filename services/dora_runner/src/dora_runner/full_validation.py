"""``full_validation`` — the operator-authored bagflow gate.

Where ``fast_validation`` runs one bundled, metadata-only flow, this pipeline
runs whatever the robot declares in ``config/<robot>/flows/<flow>.yml``: decode a
camera once and fan the frames out to blur/brightness/freeze, watch a state
topic's stamp gaps, check every topic's rate. Both execute through the same
machinery (``bagflow_pipeline`` — job layout, cleanup, timeouts, artifacts);
this module contributes only the coverage gate and the report -> summary adapter
(``bagflow_summary``).
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

from kairos_common import ValidationTemplate

from dora_runner.bagflow_pipeline import FlowOutcome, run_bagflow_pipeline
from dora_runner.bagflow_runtime import DoraEndpoint
from dora_runner.bagflow_summary import PIPELINE_ID, summarize


async def run_full_validation(
    *,
    capture_id: str,
    data_dir: Path,
    flow: str,
    endpoint: DoraEndpoint,
    job_name: str,
    template: ValidationTemplate | None = None,
    min_coverage: float = 0.0,
    timeout_s: float | None = None,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Run *flow* over one capture's bag and return the job result dict."""

    def _summarize(outcome: FlowOutcome) -> dict[str, Any]:
        return summarize(
            outcome.report,
            flow=outcome.flow,
            capture_id=outcome.capture_id,
            min_coverage=min_coverage,
            wall_s=outcome.wall_s,
        )

    return await run_bagflow_pipeline(
        pipeline_id=PIPELINE_ID,
        capture_id=capture_id,
        data_dir=data_dir,
        flow=flow,
        endpoint=endpoint,
        job_name=job_name,
        summarize=_summarize,
        template=template,
        timeout_s=timeout_s,
        cancel_event=cancel_event,
    )
