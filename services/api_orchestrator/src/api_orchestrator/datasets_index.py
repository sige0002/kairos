"""Root dataset catalog (``data/index.jsonl``) — a derived, rebuildable index.

The exported-dataset tree (``data/<operator>/<task>/<NNN>/`` with its
``dataset.json`` / ``episode.json`` sidecars) is the GROUND TRUTH. This module
maintains a flat JSON-lines catalog beside it so ``GET /api/v1/datasets`` can
answer from one file instead of walking the tree, while staying strictly
derivable: it is appended on export, rewritten on delete, and can be rebuilt
from scratch purely from the on-disk sidecars. If the file is absent or corrupt,
callers FALL BACK to a live tree scan — the index is an optimization, never a
second source of truth (the ML-hearing requirement: sidecars stay canonical).

One line per exported dataset::

    {"operator","task","index","dataset_dir"(relative),"run_id","bytes",
     "message_count","exported_at","topics_hash","topic_count","task_result",
     "quality","review_status","batch_seq","index_in_batch","batch_id",
     "condition","schema_version":1}

(``batch_id`` / ``condition`` are additive, nullable; rows written before they
existed serve ``None`` until a ``POST /datasets/index/rebuild`` heals them from
the sidecars. ``topics_hash`` / ``topic_count`` are additive too, but heal
LAZILY on the first read — see :func:`backfill_topic_signature` — so a legacy
catalog becomes comparable without anyone having to know about the rebuild
endpoint.)

``dataset_dir`` is stored RELATIVE to ``data_dir`` so a moved/restored ``data/``
tree keeps working; the served row reconstructs the absolute path so the
response shape stays identical to the tree scan.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from kairos_common import topic_signature

# Catalog schema generation stamped on each row (and on episode.json). Bump when
# the row shape changes; readers default to 1 when the field is absent.
INDEX_SCHEMA_VERSION = 1

INDEX_FILENAME = "index.jsonl"

# The label subset carried per row (mirrors the dataset list card fields).
# ``batch_id`` + ``condition`` make the catalog the one file a training-set
# assembler needs to include/exclude whole batches or filter by condition —
# ``batch_seq`` alone can't identify a batch (it resets per robot per day).
_EPISODE_KEYS = (
    "task_result",
    "failure_reason",
    "quality",
    "review_status",
    "batch_seq",
    "index_in_batch",
    "batch_id",
    "condition",
)

# Provenance carried per row alongside the labels: the bag's topic signature
# (``kairos_common.bag_metadata``). It answers the question a training-set
# assembler asks before converting anything — "do these episodes share one
# observation/action space?" — without opening a single MCAP. Nullable: an
# export whose ``metadata.yaml`` was unreadable has an honestly UNKNOWN
# signature, which readers must keep out of the comparison rather than treat as
# a set of its own.
_TOPIC_KEYS = ("topics_hash", "topic_count")


def episode_subset(episode: dict[str, Any] | None) -> dict[str, Any]:
    """Flatten the per-row label subset out of an ``episode.json`` payload.

    ``condition`` lives in the sidecar's nested batch context
    (``batch.condition``); rows that already carry it flat (catalog rows, tree
    scans fed back through :func:`rebuild`) pass through unchanged. Absent
    fields stay ``None`` — nothing is fabricated.
    """
    ep = episode or {}
    out = {k: ep.get(k) for k in _EPISODE_KEYS}
    if out.get("condition") is None:
        batch = ep.get("batch")
        if isinstance(batch, dict):
            out["condition"] = batch.get("condition")
    return out


# Serializes catalog writes across FastAPI's thread pool: append and full
# rewrite must not interleave (a torn line would look corrupt and force a
# fallback scan — harmless but avoidable).
_lock = threading.Lock()


def index_path(data_dir: Path) -> Path:
    """Absolute path of the catalog file under *data_dir*."""
    return data_dir / INDEX_FILENAME


def index_row(
    dataset_dir: str | Path,
    meta: dict[str, Any],
    episode: dict[str, Any] | None,
    data_dir: Path,
) -> dict[str, Any] | None:
    """Build one catalog row for an exported dataset.

    ``operator`` / ``task`` / ``index`` are derived from the dataset directory's
    path RELATIVE to ``data_dir`` (the same single source of truth the tree scan
    uses), so a row can never disagree with where the data actually lives.
    Returns ``None`` when the directory is not a ``<operator>/<task>/<index>``
    path under ``data_dir`` (nothing indexable).
    """
    try:
        rel = Path(dataset_dir).resolve().relative_to(Path(data_dir).resolve())
    except ValueError:
        return None
    parts = rel.parts
    if len(parts) != 3:
        return None
    row: dict[str, Any] = {
        "operator": parts[0],
        "task": parts[1],
        "index": parts[2],
        "dataset_dir": str(rel),
        "run_id": meta.get("run_id"),
        "bytes": meta.get("bytes"),
        "message_count": meta.get("message_count"),
        "exported_at": meta.get("exported_at"),
    }
    for key in _TOPIC_KEYS:
        row[key] = meta.get(key)
    row.update(episode_subset(episode))
    row["schema_version"] = INDEX_SCHEMA_VERSION
    return row


def to_list_row(row: dict[str, Any], data_dir: Path) -> dict[str, Any]:
    """Render a catalog row into the ``GET /datasets`` list shape.

    Reconstructs the ABSOLUTE ``dataset_dir`` (join with ``data_dir``) and drops
    ``schema_version`` so the payload is byte-for-byte what the tree scan emits.
    """
    out = {
        "operator": row.get("operator"),
        "task": row.get("task"),
        "index": row.get("index"),
        "dataset_dir": str(data_dir / row.get("dataset_dir", "")),
        "run_id": row.get("run_id"),
        "bytes": row.get("bytes"),
        "message_count": row.get("message_count"),
        "exported_at": row.get("exported_at"),
    }
    for key in (*_TOPIC_KEYS, *_EPISODE_KEYS):
        out[key] = row.get(key)
    return out


def read_rows(data_dir: Path) -> list[dict[str, Any]] | None:
    """Return the catalog rows, or ``None`` to signal a fallback tree scan.

    ``None`` means the file is absent OR corrupt (any unparseable line): the
    caller should scan the tree instead. An empty file is a VALID empty catalog
    (returns ``[]``) — e.g. after the last dataset was deleted.
    """
    path = index_path(data_dir)
    if not path.is_file():
        return None
    rows: list[dict[str, Any]] = []
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if not isinstance(obj, dict):
                    return None
                rows.append(obj)
    except (OSError, ValueError):
        return None
    return rows


def backfill_topic_signature(data_dir: Path, rows: list[dict[str, Any]]) -> int:
    """Fill in the topic signature of rows written before it existed; returns the
    number healed (0 when there was nothing to do).

    LAZY, and paid at most once per row: a row is "already attempted" when the
    ``topics_hash`` KEY is present — including when its value is ``None``. That
    distinction matters, because a dataset whose ``metadata.yaml`` is
    permanently unreadable would otherwise be re-read on every single list
    request. Healed rows are persisted back to the catalog, so the cost is a
    one-time ~5 ms per legacy episode rather than a per-request cost.

    Mutates *rows* in place. Best-effort: an unreadable bag records an honest
    ``None`` (never a fabricated hash, never folded into another row's set), and
    a failed persist just means the work is redone on the next request.
    """
    stale = [r for r in rows if "topics_hash" not in r]
    if not stale:
        return 0
    for row in stale:
        rel = row.get("dataset_dir")
        signature = (
            topic_signature(data_dir / rel) if isinstance(rel, str) and rel else None
        )
        row["topics_hash"] = signature.hash if signature else None
        row["topic_count"] = signature.count if signature else None
    try:
        _atomic_write(index_path(data_dir), rows)
    except OSError:
        pass  # keep serving the healed rows; the catalog heals next time
    return len(stale)


def _dataset_present(data_dir: Path, row: dict[str, Any]) -> bool:
    """Whether the row's dataset directory still exists (its `dataset.json`)."""
    operator, task, index = row.get("operator"), row.get("task"), row.get("index")
    if not (operator and task and index):
        return False
    return (
        Path(data_dir) / str(operator) / str(task) / str(index) / "dataset.json"
    ).is_file()


def list_from_index(data_dir: Path) -> list[dict[str, Any]] | None:
    """Serve the dataset list from the catalog, or ``None`` to fall back.

    Rows are returned in the same ``(operator, task, index)`` order as the tree
    scan so the two paths are indistinguishable to the UI — which is also why
    the topic signature is backfilled here: a catalog written before the field
    existed would otherwise serve ``None`` forever while the fallback scan
    derived it, and the two paths would disagree.
    """
    with _lock:
        rows = read_rows(data_dir)
        if rows is None:
            return None
        # Drop rows whose dataset is no longer on disk. Archiving and deleting
        # both remove the row as a separate step from removing the files, and
        # the orchestrator can die in between — after which the catalog would
        # keep advertising a dataset that has left, and every action offered on
        # it (validate, loss report, archive again) would fail on a missing
        # directory. The tree is the ground truth this module already defers to;
        # this is the same rule applied on read.
        live = [r for r in rows if _dataset_present(data_dir, r)]
        if len(live) != len(rows):
            _atomic_write(index_path(data_dir), live)
            rows = live
        backfill_topic_signature(data_dir, rows)
    out = [to_list_row(r, data_dir) for r in rows]
    out.sort(key=lambda d: (d["operator"], d["task"], d["index"]))
    return out


def append_row(data_dir: Path, row: dict[str, Any]) -> None:
    """Append one dataset row to the catalog (creating the file if needed).

    Best-effort and non-fatal to the export it records: the export already MOVED
    the recording, so a catalog write must never fail the request. A dropped
    append just means a stale catalog until the next rebuild (readers still fall
    back to the scan on corruption). ``row is None`` is a no-op.
    """
    if not row:
        return
    path = index_path(data_dir)
    with _lock:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        except OSError:
            return


def remove_rows(data_dir: Path, match: Callable[[dict[str, Any]], bool]) -> None:
    """Rewrite the catalog without the rows *match* selects (atomic).

    Used on dataset delete. A no-op when the catalog is absent or corrupt (a
    corrupt catalog is not rewritten — it will be regenerated by a rebuild, and
    reads already fall back to the scan). The rewrite is tmp-file + ``os.replace``
    so a crash mid-write never leaves a half-written catalog.
    """
    path = index_path(data_dir)
    with _lock:
        rows = read_rows(data_dir)
        if rows is None:
            return
        kept = [r for r in rows if not match(r)]
        _atomic_write(path, kept)


def rebuild(data_dir: Path, scan_rows: list[dict[str, Any]]) -> int:
    """Regenerate the catalog from freshly scanned tree rows; returns the count.

    *scan_rows* are the tree-scan dicts (absolute ``dataset_dir``); each is
    converted to a catalog row (relative path + ``schema_version``). This is the
    "derive from the sidecars" path: it discards whatever the catalog held and
    writes exactly what the on-disk tree describes.
    """
    rows: list[dict[str, Any]] = []
    for scan in scan_rows:
        row = index_row(
            scan["dataset_dir"],
            {
                "run_id": scan.get("run_id"),
                "bytes": scan.get("bytes"),
                "message_count": scan.get("message_count"),
                "exported_at": scan.get("exported_at"),
                **{k: scan.get(k) for k in _TOPIC_KEYS},
            },
            {k: scan.get(k) for k in _EPISODE_KEYS},
            data_dir,
        )
        if row is not None:
            rows.append(row)
    with _lock:
        _atomic_write(index_path(data_dir), rows)
    return len(rows)


def _atomic_write(path: Path, rows: list[dict[str, Any]]) -> None:
    """Write *rows* as JSON lines to *path* via a temp file + ``os.replace``."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise
