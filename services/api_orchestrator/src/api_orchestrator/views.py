"""The generated ``views/`` tree: a browsable shape over logical datasets.

Contract §6. Datasets are rows plus ledger events; nothing is moved on disk. But
an operator with a file manager, a training script with a glob, and every tool
that predates kairos all want ``<operator>/<task>/<dataset>/001`` — so that shape
is *generated* as symlinks into ``objects/`` and can be thrown away and rebuilt
at any time.

**Regeneration is a symlink flip, never an in-place edit.** The whole tree is
built under ``views.<generation>/`` and then ``views`` — itself a symlink — is
atomically repointed with ``os.replace``. Rewriting in place would leave the
tree half-built for as long as the walk took, and a reader that arrived in that
window would see a dataset that is missing episodes rather than one that is
briefly older. There is no moment at which ``views`` does not resolve.

**Only committed membership rows are read** (§6). Generating from anything else
would publish a dataset arrangement that no transaction has agreed to.

**The orchestrator is the sole owner.** dora_runner asks for a regeneration; it
does not write here. Two writers flipping the same symlink would each prune the
other's generation out from under a reader.
"""

from __future__ import annotations

import logging
import os
import re
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kairos_common.atomic_io import fsync_dir
from kairos_common.capture_sidecars import OBJECTS_DIRNAME, validate_capture_id

from api_orchestrator.layout import VIEWS_DIRNAME, DataLayout

logger = logging.getLogger("kairos")

# Generation directories are siblings of the `views` symlink.
GENERATION_PREFIX = f"{VIEWS_DIRNAME}."
_GENERATION_RE = re.compile(rf"^{re.escape(GENERATION_PREFIX)}[0-9a-f]{{16}}$")

# How many superseded generations to keep. Old generations are not deleted
# immediately: a reader that resolved `views` a moment before the flip is still
# walking the previous tree, and removing it under them would turn a stale
# listing into an I/O error. Two is enough for that hand-off and bounded enough
# that a busy day does not accumulate hundreds.
KEEP_GENERATIONS = 2

# Characters that cannot appear in a generated path component. Operator, task
# and dataset names come from operators, so they are sanitized rather than
# trusted: a name containing a slash would otherwise silently create an extra
# directory level, and one containing ".." would escape views/ entirely.
_UNSAFE = re.compile(r"[/\\\x00]")


@dataclass(frozen=True)
class ViewsResult:
    """What one regeneration produced."""

    generation: str
    links: int
    datasets: int
    skipped: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "generation": self.generation,
            "links": self.links,
            "datasets": self.datasets,
            "skipped": list(self.skipped),
        }


def sanitize_component(value: str | None, fallback: str) -> str:
    """One safe path component from an operator-supplied name."""
    text = (value or "").strip()
    text = _UNSAFE.sub("_", text)
    if text in ("", ".", ".."):
        return fallback
    return text


def regenerate(layout: DataLayout, entries: list[dict[str, Any]]) -> ViewsResult:
    """Build a fresh views tree from *entries* and flip ``views`` onto it.

    *entries* are committed ``dataset_members`` rows joined to their dataset —
    ``capture_id``, ``display_index``, ``dataset_name``, ``operator``, ``task``.
    A member whose capture has no local directory is skipped and named in the
    result: a dangling symlink looks to every downstream tool like a corrupt
    dataset, whereas an absent one plus a report is a fact somebody can act on.
    """
    generation = secrets.token_hex(8)
    staging = layout.data_dir / f"{GENERATION_PREFIX}{generation}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)

    links = 0
    datasets: set[str] = set()
    skipped: list[str] = []
    for entry in entries:
        capture_id = entry.get("capture_id")
        if not isinstance(capture_id, str):
            continue
        try:
            validate_capture_id(capture_id)
        except ValueError:
            skipped.append(f"{capture_id}: not a capture id")
            continue
        if not layout.capture_dir(capture_id).is_dir():
            skipped.append(f"{capture_id}: no local copy to link to")
            continue

        operator = sanitize_component(entry.get("operator"), "unknown_operator")
        task = sanitize_component(entry.get("task"), "unknown_task")
        dataset_name = sanitize_component(entry.get("dataset_name"), "unnamed")
        index = int(entry.get("display_index") or 0)

        parent = staging / operator / task / dataset_name
        parent.mkdir(parents=True, exist_ok=True)
        link = parent / f"{index:03d}"
        # Relative, and counted from the link's own depth: the tree must stay
        # valid when the whole data directory is moved or bind-mounted at a
        # different path, which an absolute target would not survive.
        link.symlink_to(Path("../../../..") / OBJECTS_DIRNAME / capture_id)
        links += 1
        datasets.add(f"{operator}/{task}/{dataset_name}")

    _flip(layout, staging)
    _prune(layout, keep=generation)
    result = ViewsResult(
        generation=generation,
        links=links,
        datasets=len(datasets),
        skipped=tuple(skipped),
    )
    if skipped:
        logger.warning(
            "views regenerated with %d member(s) skipped: %s",
            len(skipped),
            "; ".join(skipped[:5]),
        )
    logger.info("views regenerated", extra={"generation": generation, "links": links})
    return result


def _flip(layout: DataLayout, staging: Path) -> None:
    """Atomically repoint ``views`` at *staging*.

    ``os.replace`` needs an existing name to replace, and a symlink cannot be
    created over one — so a uniquely named temp symlink is created first and
    renamed onto ``views``. That rename is the only moment anything changes,
    and it is atomic.
    """
    views = layout.views
    if views.exists() and not views.is_symlink():
        # A pre-v2 real directory. There is nothing in it worth keeping — the
        # tree is generated — and leaving it would make every future flip fail.
        logger.warning("replacing the pre-v2 views/ directory with a symlink")
        shutil.rmtree(views, ignore_errors=True)

    temp = layout.data_dir / f".{VIEWS_DIRNAME}.{os.getpid()}-{secrets.token_hex(4)}"
    temp.unlink(missing_ok=True)
    temp.symlink_to(staging.name)
    os.replace(temp, views)
    fsync_dir(layout.data_dir)


def _prune(layout: DataLayout, *, keep: str) -> None:
    """Delete superseded generations, keeping the newest few."""
    generations = sorted(
        (
            path
            for path in layout.data_dir.iterdir()
            if path.is_dir()
            and not path.is_symlink()
            and _GENERATION_RE.match(path.name)
            and path.name != f"{GENERATION_PREFIX}{keep}"
        ),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for stale in generations[KEEP_GENERATIONS - 1 :]:
        shutil.rmtree(stale, ignore_errors=True)
