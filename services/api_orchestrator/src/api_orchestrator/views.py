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
import threading
import time
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

# One regeneration at a time, process-wide. Two callers reach this module from
# two DIFFERENT threads: a dataset edit schedules a regeneration that runs via
# ``asyncio.to_thread``, and ``POST /api/v1/views/refresh`` runs one from a
# request handler. So the lock must be a threading one — an ``asyncio.Lock``
# belongs to a single event loop and cannot be taken from a worker thread at
# all, which is where half of this contention lives.
#
# What it protects is the whole build → flip → prune sequence, not any single
# step: each regeneration prunes everything it does not recognise, so two
# overlapping runs delete the generation the other is about to publish, and
# ``_prune`` sorts by an ``st_mtime`` read from paths listed a moment earlier —
# the loser raises ``FileNotFoundError`` out of whichever caller it was.
#
# Reentrant purely as a footgun guard: nothing nests today, and a future caller
# that reaches ``prune_stale`` from inside a regeneration should get a working
# program rather than a deadlock.
_REGENERATION = threading.RLock()


@dataclass(frozen=True)
class ViewsResult:
    """What one regeneration produced."""

    generation: str
    links: int
    datasets: int
    skipped: tuple[str, ...] = ()
    # Datasets whose folder had to be suffixed because another dataset already
    # holds <operator>/<task>/<name>. Reported rather than merely logged: the
    # tree is what an operator's file manager and a training script's glob
    # read, so a folder that is not the name they typed has to be visible.
    renamed: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "generation": self.generation,
            "links": self.links,
            "datasets": self.datasets,
            "skipped": list(self.skipped),
            "renamed": list(self.renamed),
        }


# How long a superseded generation may linger before the reconciler removes it.
# The count-based prune above (KEEP_GENERATIONS) only runs on regeneration, so
# the LAST generation before a quiet period — e.g. the tree as it was before a
# dataset archived — would otherwise sit beside ``views`` indefinitely, full of
# dangling symlinks that read as "an empty folder that will not go away".
# Ten minutes is far beyond any reader's hand-off and far below "operator
# notices debris".
STALE_GENERATION_GRACE_S = 600.0


def prune_stale(
    layout: DataLayout, *, grace_s: float = STALE_GENERATION_GRACE_S
) -> int:
    """Remove superseded generation dirs older than *grace_s*. Returns count.

    Called from the reconciler's periodic pass. Never touches the generation
    the ``views`` symlink currently points to, however old — the current tree
    is not debris.

    Takes the same lock as :func:`regenerate`: reading ``views`` and then
    deleting what it did not name is only safe while nobody is repointing it.
    """
    with _REGENERATION:
        return _prune_stale(layout, grace_s=grace_s)


def _prune_stale(layout: DataLayout, *, grace_s: float) -> int:
    views = layout.views
    try:
        current = os.readlink(views) if views.is_symlink() else None
    except OSError:
        current = None
    removed = 0
    now = time.time()
    for entry in layout.data_dir.iterdir():
        if not _GENERATION_RE.match(entry.name) or entry.name == current:
            continue
        try:
            age = now - entry.stat().st_mtime
        except OSError:
            continue
        if age <= grace_s:
            continue
        shutil.rmtree(entry, ignore_errors=True)
        removed += 1
    if removed:
        logger.info("pruned %d stale views generation(s)", removed)
    return removed


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
    ``capture_id``, ``display_index``, ``dataset_name``, ``operator``, ``task``
    and ``dataset_id``. A member whose capture has no local directory is skipped
    and named in the result: a dangling symlink looks to every downstream tool
    like a corrupt dataset, whereas an absent one plus a report is a fact
    somebody can act on.

    **A regeneration always finishes.** Nothing about one member may abandon the
    walk: the flip happens at the end, so an exception partway through leaves
    ``views`` pointing at the generation from *before* the change and every
    later edit hitting the same fault — a tree that silently stops tracking the
    catalog, which is worse than one that reports a problem. So a member that
    cannot be linked is skipped and named, and a dataset that wants a folder
    another dataset already holds is given a suffixed one.

    **One at a time.** Build, flip and prune are one critical section (see
    ``_REGENERATION``): a second regeneration overlapping this one deletes the
    generation this one is about to publish, and the two prunes race each other
    to a ``FileNotFoundError``. Callers wait; nobody interleaves.
    """
    with _REGENERATION:
        return _regenerate(layout, entries)


def _regenerate(layout: DataLayout, entries: list[dict[str, Any]]) -> ViewsResult:
    generation = secrets.token_hex(8)
    staging = layout.data_dir / f"{GENERATION_PREFIX}{generation}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)

    links = 0
    datasets: set[str] = set()
    skipped: list[str] = []
    folders = _FolderNames()
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
        dataset_name = folders.folder_for(entry, operator, task)
        index = int(entry.get("display_index") or 0)

        parent = staging / operator / task / dataset_name
        parent.mkdir(parents=True, exist_ok=True)
        link = parent / f"{index:03d}"
        # Relative, and counted from the link's own depth: the tree must stay
        # valid when the whole data directory is moved or bind-mounted at a
        # different path, which an absolute target would not survive.
        try:
            link.symlink_to(Path("../../../..") / OBJECTS_DIRNAME / capture_id)
        except OSError as exc:
            # Two members cannot share a path once folders are disambiguated
            # (display_index is unique within a dataset), so reaching this is a
            # surprise — and still not a reason to throw the tree away.
            skipped.append(
                f"{capture_id}: could not link at {operator}/{task}/"
                f"{dataset_name}/{index:03d}: {exc}"
            )
            continue
        links += 1
        datasets.add(f"{operator}/{task}/{dataset_name}")

    _flip(layout, staging)
    _prune(layout, keep=generation)
    result = ViewsResult(
        generation=generation,
        links=links,
        datasets=len(datasets),
        skipped=tuple(skipped),
        renamed=tuple(folders.renamed),
    )
    if skipped:
        logger.warning(
            "views regenerated with %d member(s) skipped: %s",
            len(skipped),
            "; ".join(skipped[:5]),
        )
    if folders.renamed:
        logger.warning(
            "views: %d dataset folder(s) renamed to break a collision: %s",
            len(folders.renamed),
            "; ".join(folders.renamed[:5]),
        )
    logger.info("views regenerated", extra={"generation": generation, "links": links})
    return result


class _FolderNames:
    """Picks the dataset folder for each member, one dataset at a time.

    Nothing has ever guaranteed that ``(name, operator, task)`` is unique — the
    labels are free text, ``operator``/``task`` fall back to the *capture's* own
    values when the dataset leaves them unset, and dataset rows come back from a
    ledger that may predate any rule the service enforces now. Two datasets can
    therefore ask for one folder, and the tree cannot hold both: the second
    symlink is the exact path of the first.

    The later dataset gets ``<name>__<dataset_id tail>`` rather than an
    exception. Which one is "later" is decided by the order of *entries*, which
    the store sorts by creation time — so the dataset an operator has been
    globbing keeps its folder, and the suffix does not move between
    regenerations.
    """

    def __init__(self) -> None:
        # (dataset key, operator, task) -> folder. Keyed on the path too,
        # because one dataset with no operator of its own spreads its members
        # across the operators of the captures in it.
        self._assigned: dict[tuple[str, str, str], str] = {}
        # (operator, task, folder) -> the dataset key holding it.
        self._holders: dict[tuple[str, str, str], str] = {}
        self.renamed: list[str] = []

    def folder_for(self, entry: dict[str, Any], operator: str, task: str) -> str:
        name = sanitize_component(entry.get("dataset_name"), "unnamed")
        key = entry.get("dataset_id")
        if not isinstance(key, str) or not key:
            # No identity to tell datasets apart by; treat the name as one.
            key = f"name:{name}"
        assigned = self._assigned.get((key, operator, task))
        if assigned is not None:
            return assigned

        folder = name
        holder = self._holders.get((operator, task, folder))
        if holder is not None and holder != key:
            folder = self._disambiguate(name, key, operator, task)
            self.renamed.append(f"{operator}/{task}/{name} -> {folder} ({key})")
        self._assigned[(key, operator, task)] = folder
        self._holders[(operator, task, folder)] = key
        return folder

    @staticmethod
    def _suffix(key: str) -> str:
        """A short, stable tail of the dataset id, safe as a path component."""
        return sanitize_component(key, "x").replace(".", "_")[-8:] or "x"

    def _disambiguate(self, name: str, key: str, operator: str, task: str) -> str:
        candidate = f"{name}__{self._suffix(key)}"
        attempt = 2
        while (operator, task, candidate) in self._holders:
            candidate = f"{name}__{self._suffix(key)}-{attempt}"
            attempt += 1
        return candidate


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


def _mtime(path: Path) -> float:
    """Modification time, or ``0.0`` for a path that is already gone.

    A generation can disappear between the listing above and this read. The
    lock closes the case where another regeneration is the one deleting it,
    but an operator with ``rm -rf`` is not holding that lock, and a sort key is
    no place to find out the disk moved. Sorting a vanished directory oldest
    puts it first in line for a delete that then finds nothing to do.
    """
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


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
        key=_mtime,
        reverse=True,
    )
    for stale in generations[KEEP_GENERATIONS - 1 :]:
        shutil.rmtree(stale, ignore_errors=True)
