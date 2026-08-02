"""BUG-D: a cancelled job's state must not be clobbered by the worker.

The worker re-checks `canceled` under `store.lock` before writing `running` or
any terminal state, so cancellation that races the worker stays canceled.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

from dora_runner.main import _execute_job
from dora_runner.store import JobRecord, RunnerStore
from kairos_common import JobState
from kairos_common.ids import new_capture_id

# A capture_id is a UUIDv7 everywhere it is used as a key or path segment (§1).
CAPTURE_ID = new_capture_id()


def test_execute_job_skips_a_precanceled_job() -> None:
    """A job cancelled before the worker starts is left canceled (not run)."""
    store = RunnerStore()
    job = JobRecord(
        job_id="j1",
        capture_id=CAPTURE_ID,
        pipeline="fast_validation",
        params={},
    )
    job.state = JobState.canceled  # cancelled between create and worker start

    asyncio.run(_execute_job(job, store, Path("/nonexistent")))

    # The worker returned immediately: no running/succeeded/failed transition,
    # and no result was written.
    assert job.state is JobState.canceled
    assert job.result is None
