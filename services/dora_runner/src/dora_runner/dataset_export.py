"""``dataset_export`` pipeline: MOVE a finished run into the dataset tree.

Event-driven (button -> job), post-hoc, and run on **finished** runs only: it
MOVES ``recorded/<run_id>`` out of the staging area into
``data/<operator>/<task>/<NNN>/`` (operator/task come from the run's
``session.json``), allocating the next zero-padded index. The recording leaves
``recorded/`` after export (a same-filesystem rename — fast even for large
bags). Export never runs on an in-flight recording (the orchestrator guards:
only completed runs are exported), and the move only ever happens AFTER the
``NNN`` directory is claimed, so an interruption never loses data.

Layout (per plan.md データセット):

    data/<operator>/<task>/001/   <- first export for that operator+task
    data/<operator>/<task>/002/   <- next, …

Each ``NNN`` holds the moved MCAP(s) + sidecars and a ``dataset.json`` summary.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from kairos_common import utc_now_iso8601

from dora_runner.mcap_utils import validate_run_id

# Pipeline identity stamped into the summary (reproducibility contract, shared
# with the other bundled pipelines and the hello_dora plugin example).
PIPELINE_ID = "dataset_export"
PIPELINE_VERSION = "1.0.0"

# Reserved top-level names under data/ an operator/task must not shadow.
_RESERVED = {"recorded", "report", "datasets"}
_DEFAULT_OPERATOR = "unknown_operator"
_DEFAULT_TASK = "unknown_task"
_INDEX_WIDTH = 3
_MAX_INDEX_ATTEMPTS = 10_000


def _sanitize_component(value: str | None, default: str) -> str:
    """Coerce *value* into a safe single path component (slug); else *default*.

    Operator/task are free text that become directory names, so they must not
    contain separators or traversal. We KEEP Unicode word characters (``\\w``)
    so non-ASCII names — e.g. Japanese operator/task — survive instead of being
    flattened to ``unknown_*``; any run of other characters (path separators,
    control chars, punctuation, emoji) collapses to ``_``. Data-safety is
    preserved: ``/``, ``\\``, ``..`` and absolute paths cannot survive
    (separators become ``_``, and ``.``/``..``/empty fall back to *default*).
    """
    slug = re.sub(r"[^\w.-]+", "_", (value or "").strip(), flags=re.UNICODE).strip("._")
    if not slug or slug in {".", ".."}:
        return default
    if slug in _RESERVED:
        return f"{slug}_"
    return slug


def _read_session(run_dir: Path) -> dict[str, Any]:
    """Best-effort read of a run's ``session.json`` (``{}`` on any failure)."""
    try:
        return json.loads((run_dir / "session.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _next_index_dir(parent: Path) -> Path:
    """Atomically create the next ``NNN`` dir under *parent* (001, 002, …).

    Computes the start from existing numeric dirs, then races ``mkdir`` with
    ``exist_ok=False`` so concurrent exports never collide on the same index.
    Claiming the empty ``NNN`` dir first is what makes the subsequent move safe:
    nothing is moved until a destination is reserved.
    """
    parent.mkdir(parents=True, exist_ok=True)
    existing = [
        int(p.name) for p in parent.iterdir() if p.is_dir() and p.name.isdigit()
    ]
    start = (max(existing) + 1) if existing else 1
    for n in range(start, start + _MAX_INDEX_ATTEMPTS):
        candidate = parent / str(n).zfill(_INDEX_WIDTH)
        try:
            candidate.mkdir(exist_ok=False)
            return candidate
        except FileExistsError:
            continue
    raise RuntimeError(f"could not allocate a dataset index under {parent}")


def run_dataset_export(*, run_id: str, data_dir: Path) -> dict[str, Any]:
    """MOVE ``recorded/<run_id>`` into ``data/<operator>/<task>/<NNN>/``.

    Returns the ``{summary, artifacts}`` JobResult shape. Raises
    ``FileNotFoundError`` if the run dir or its MCAP is missing (mapped to a
    failed job by the worker); ``ValueError`` for an unsafe run_id.

    SAFETY: the move only ever happens AFTER ``NNN`` is claimed, and
    ``recorded/<run_id>`` is removed only after its contents have moved, so an
    interruption can never lose data. The orchestrator only ever calls this for
    completed runs, so an active recording is never touched.
    """
    validate_run_id(run_id)
    run_dir = data_dir / "recorded" / run_id
    if not run_dir.is_dir():
        raise FileNotFoundError(f"No recorded run found: {run_dir}")
    mcaps = sorted(run_dir.glob("*.mcap"))
    if not mcaps:
        raise FileNotFoundError(f"No MCAP file found in {run_dir}")

    session = _read_session(run_dir)
    operator = _sanitize_component(session.get("operator"), _DEFAULT_OPERATOR)
    task = _sanitize_component(session.get("task"), _DEFAULT_TASK)

    # Claim the destination FIRST (empty NNN dir); only then move into it.
    dataset_dir = _next_index_dir(data_dir / operator / task)
    moved: list[str] = []
    for child in sorted(run_dir.iterdir()):
        shutil.move(str(child), str(dataset_dir))
        moved.append(child.name)
    # The run dir is now empty; remove it (rmtree as a belt-and-suspenders
    # fallback if anything unexpected remains).
    try:
        run_dir.rmdir()
    except OSError:
        shutil.rmtree(run_dir, ignore_errors=True)
    # Delete the recorder's siblings next to the run dir (they pertain to the
    # now-moved recording and would otherwise leak).
    (data_dir / "recorded" / f"{run_id}.qos.yaml").unlink(missing_ok=True)
    (data_dir / "recorded" / f"{run_id}.failed.json").unlink(missing_ok=True)

    exported_bytes = sum(
        (dataset_dir / name).stat().st_size
        for name in moved
        if (dataset_dir / name).is_file()
    )
    summary: dict[str, Any] = {
        "pipeline": PIPELINE_ID,
        "version": PIPELINE_VERSION,
        "run_id": run_id,
        "operator": operator,
        "task": task,
        "index": dataset_dir.name,
        "dataset_dir": str(dataset_dir),
        "files": moved,
        "bytes": exported_bytes,
        "message_count": session.get("message_count"),
        # Provenance: the recorded topics (names), so dataset.json is a
        # self-contained record without needing the sibling session.json.
        "topics": session.get("topics", []),
        "exported_at": utc_now_iso8601(),
    }
    (dataset_dir / "dataset.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    # Report sidecar so the orchestrator can surface dataset_stats on the run.
    report_dir = data_dir / "report" / "dataset_export" / run_id
    report_dir.mkdir(parents=True, exist_ok=True)
    (report_dir / "summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    return {
        "summary": summary,
        "artifacts": [str(dataset_dir / "dataset.json"), str(dataset_dir)],
    }
