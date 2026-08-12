"""Build the converter's input tree without copying (or touching) a byte.

An export stages ``exports/.staging/<export_id>/<dir>/`` as a REAL directory
holding per-file symlinks back into ``objects/<capture_id>/``. Only the bag
files are linked (``*.mcap`` + ``metadata.yaml``): kairos sidecars are our
bookkeeping, not converter input, and linking them would invite the converter
to interpret them.

``objects/`` is never written to — the projection rule from
``capture_store.md`` §6 (a derived view is generated at the boundary, the live
store stays untouched) is what makes an export safe to run while the same
captures are being labelled or validated.
"""

from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from kairos_common.atomic_io import atomic_write_json
from kairos_common.capture_sidecars import capture_dir
from kairos_common.task_sidecar import TASK_SIDECAR_FILENAME, write_task_sidecar

from lerobot_exporter.models import ExportEpisode
from lerobot_exporter.paths import (
    MANIFEST_EXTRA_FILENAME,
    export_staging_dir,
    staging_root,
)

logger = logging.getLogger("kairos")

BAG_METADATA_FILENAME = "metadata.yaml"


class StagingError(Exception):
    """A capture cannot be staged; the message names it.

    Raised before the converter is spawned, so the export fails with a fact the
    operator can act on ("capture X has no MCAP") instead of the converter's
    view of an empty input directory.
    """


def _symlink(link: Path, target: Path) -> None:
    """Link *link* -> *target* using a RELATIVE target.

    Relative like ``views/`` does it: the same tree then resolves from inside
    the container (``/data/...``) and from the host (``$DATA_DIR/...``), so a
    staging tree that outlives its process is still readable when someone goes
    looking for what an export was fed.
    """
    os.symlink(os.path.relpath(target, start=link.parent), link)


def build_staging(
    data_dir: str | Path, export_id: str, episodes: list[ExportEpisode]
) -> Path:
    """Create the staging tree for *episodes*; return its root.

    Raises :class:`StagingError` naming the first capture whose bytes are not
    where the submitted snapshot said they were.
    """
    root = export_staging_dir(data_dir, export_id)
    # A leftover tree can only be debris from a previous attempt with this
    # export_id; the caller refuses a re-used id, so there is no live job here.
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    for episode in episodes:
        source = capture_dir(data_dir, episode.capture_id)
        if not source.is_dir():
            raise StagingError(
                f"Capture {episode.capture_id} ({episode.dir}) has no local "
                "bytes: its directory is missing."
            )
        mcaps = sorted(p for p in source.glob("*.mcap") if p.is_file())
        if not mcaps:
            raise StagingError(
                f"Capture {episode.capture_id} ({episode.dir}) has no MCAP file."
            )
        metadata = source / BAG_METADATA_FILENAME
        if not metadata.is_file():
            raise StagingError(
                f"Capture {episode.capture_id} ({episode.dir}) has no "
                f"{BAG_METADATA_FILENAME}."
            )
        staged = root / episode.dir
        staged.mkdir()
        for path in (*mcaps, metadata):
            _symlink(staged / path.name, path)
        _stage_task(staged, source, episode.task)
    return root


def _stage_task(staged: Path, source: Path, task: str | None) -> None:
    """Give the episode its ``task.json``: the source's own, or ours, or none.

    A bag that arrived with its own ``task.json`` (an import, or a re-imported
    archive) keeps it — the source file can carry more than kairos models, and
    kairos's own label is recorded in the export's manifest extra either way.
    This is the same collision rule the archive projection follows.
    """
    source_task = source / TASK_SIDECAR_FILENAME
    if source_task.is_file():
        _symlink(staged / TASK_SIDECAR_FILENAME, source_task)
        return
    if task:
        write_task_sidecar(staged, task)


def write_manifest_extra(
    staging: Path, export_id: str, episodes: list[ExportEpisode]
) -> Path:
    """Write the provenance blob the converter merges into ``conversion_log.json``.

    This is the only record that ties an output dataset's episodes back to the
    captures they came from; it lives in the output tree, so it survives without
    a kairos instance to ask.
    """
    payload = {
        "kairos": {
            "export_id": export_id,
            "captures": [
                {
                    "capture_id": episode.capture_id,
                    "dir": episode.dir,
                    "task": episode.task,
                }
                for episode in episodes
            ],
        }
    }
    target = staging / MANIFEST_EXTRA_FILENAME
    atomic_write_json(target, payload)
    return target


def sweep_staging(data_dir: str | Path) -> list[str]:
    """Remove every staging tree at startup; return what was removed.

    No conversion survives a restart (the subprocess died with the process), so
    everything under ``.staging/`` is debris by definition. The per-episode
    trees inside contain only symlinks, so ``shutil.rmtree`` deleting them
    cannot reach recorded bytes — it does not follow the links it deletes.

    The one thing that CAN reach recorded bytes is the staging ROOT itself
    being a symlink: if ``exports/.staging`` pointed at ``objects/`` (a
    relocated or attacker-writable EXPORTS_DIR), following it would iterate
    every capture and rmtree it. So the root is required to be a real
    directory, and every entry is required to resolve back inside it before it
    is touched — a real capture dir reached through a symlinked root fails that
    containment check.
    """
    root = staging_root(data_dir)
    # A symlinked staging root is refused outright — never followed into
    # whatever it points at. is_symlink() is checked before is_dir() because
    # is_dir() follows the link.
    if root.is_symlink() or not root.is_dir():
        return []
    root_real = root.resolve()
    removed: list[str] = []
    for entry in sorted(root.iterdir()):
        try:
            if entry.is_symlink():
                # Unlinking a symlink removes the LINK, never what it points
                # at — safe whatever it targets, so a stray link at a capture
                # is cleaned without ever reaching the capture.
                entry.unlink()
            elif entry.is_dir():
                # A real directory is rmtree'd only once it is proven to live
                # directly under the resolved staging root. This is what stops
                # a deletion from being steered at objects/ (or anywhere else)
                # through a symlinked path component the checks above missed.
                if entry.resolve().parent != root_real:
                    logger.warning(
                        "refusing to remove staging entry that escapes the root: %s",
                        entry,
                    )
                    continue
                shutil.rmtree(entry)
            else:
                entry.unlink()
        except OSError:
            logger.warning("could not remove leftover staging entry: %s", entry)
            continue
        removed.append(entry.name)
    return removed
