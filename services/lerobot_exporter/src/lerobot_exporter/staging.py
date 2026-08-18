# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
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
import stat
from pathlib import Path

from kairos_common.atomic_io import atomic_write_json
from kairos_common.capture_sidecars import capture_dir
from kairos_common.task_sidecar import TASK_SIDECAR_FILENAME, write_task_sidecar

from lerobot_exporter.models import ExportEpisode
from lerobot_exporter.paths import (
    MANIFEST_EXTRA_FILENAME,
    export_staging_dir,
    exports_dir,
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


def _rmtree_at(dir_fd: int, name: str) -> None:
    """Recursively remove *name* under *dir_fd*, NEVER following a symlink.

    Every step is relative to a directory file descriptor, and each directory
    is descended into only after ``lstat`` proves it is a real directory
    (opened with ``O_NOFOLLOW``), so no symlink anywhere in the tree can
    redirect a removal outside it. A symlink entry is unlinked (the link, not
    its target); a real subdirectory is emptied then ``rmdir``'d.
    """
    try:
        info = os.lstat(name, dir_fd=dir_fd)
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode):
        # A symlink or a plain file — unlink removes the entry itself.
        os.unlink(name, dir_fd=dir_fd)
        return
    child_fd = os.open(
        name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd
    )
    try:
        for entry in os.listdir(child_fd):
            _rmtree_at(child_fd, entry)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=dir_fd)


def _open_staging_root_nofollow(data_dir: str | Path) -> int | None:
    """A fd on the real staging root, or ``None`` when it must not be touched.

    ``O_NOFOLLOW`` is the whole point: if ``.staging`` has become a symlink
    (an attacker swapping it at ``objects/`` DURING an export — the guard at
    build time only checked the path, and a removal minutes later re-resolves
    it), the open fails rather than following it, and once open the fd pins the
    real directory's inode so a later swap cannot redirect removals through it.
    """
    root = staging_root(data_dir)
    try:
        return os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError:
        # ELOOP (now a symlink) or similar: refuse to remove through it.
        logger.warning(
            "refusing to remove staging: root is not a real directory (%s)", root
        )
        return None


def _remove_child_nofollow(parent: Path, child: str) -> None:
    """Remove *child* under *parent*, pinning *parent* by an ``O_NOFOLLOW`` fd.

    Both the staging removal and the output removal run long after their
    directory was checked, so either parent (``.staging`` or ``exports/``) being
    swapped to a symlink between the check and the removal would otherwise steer
    an rmtree at ``objects/``. Opening the parent with ``O_NOFOLLOW`` fails on a
    symlinked parent, and once open the fd pins the real inode, so the removal
    reaches only what genuinely lives under it.
    """
    try:
        parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return
    except OSError:
        logger.warning(
            "refusing to remove %s: %s is not a real directory", child, parent
        )
        return
    try:
        _rmtree_at(parent_fd, child)
    except OSError as exc:
        # Best-effort, like shutil.rmtree(ignore_errors=True) was: this runs in
        # the worker's `finally` and on the failure/cancel paths, where a raise
        # would REPLACE the real terminal state — flipping a succeeded or
        # canceled export to `failed` and, via _run's except handler, deleting a
        # good output tree — over debris the next run overwrites anyway. Left
        # debris only ever costs a `destination_not_empty` on an identical
        # retry, which is recoverable and named.
        logger.warning("could not fully remove %s under %s: %s", child, parent, exc)
    finally:
        os.close(parent_fd)


def remove_export_staging(data_dir: str | Path, export_id: str) -> None:
    """Remove ``exports/.staging/<export_id>`` without following a symlink.

    The removal runs after the whole conversion, so a build-time path check is
    a TOCTOU: a ``.staging`` swapped to a symlink at ``objects/`` mid-export
    would be followed here and delete the capture whose UUID equals the
    caller-controlled ``export_id``, silently, with the export still reporting
    success. See :func:`_remove_child_nofollow` for how the fd pin closes it.
    """
    _remove_child_nofollow(staging_root(data_dir), export_id)


def remove_output_dir(data_dir: str | Path, output_name: str) -> None:
    """Remove ``exports/<output_name>`` without following a symlinked parent.

    The partial-output twin of :func:`remove_export_staging`: it runs on the
    failure and cancel paths after the converter ran, so an ``exports/`` swapped
    to a symlink at ``objects/`` mid-export would otherwise be followed here.
    """
    _remove_child_nofollow(exports_dir(data_dir), output_name)


def guarded_export_staging_dir(data_dir: str | Path, export_id: str) -> Path:
    """``exports/.staging/<export_id>`` — refusing any path that could escape it.

    The ``rmtree`` + ``mkdir`` below run on this path on EVERY submit, and
    ``export_id`` comes from the (unauthenticated, host-network) request body.
    If ``.staging`` were a symlink at ``objects/`` — a relocated or
    attacker-writable EXPORTS_DIR — following it would delete the capture named
    by ``export_id``. So a symlinked staging root, a symlinked per-export path,
    or a per-export dir that does not resolve directly under the real root is
    refused before anything is removed. (``sweep_staging`` guards the same way
    at startup; this is the write-path twin it was missing.)

    The registry resolves the staging path THROUGH this function before the
    ``try`` whose ``finally`` removes it, so the removal can never run against
    an unguarded path — the removal is the second rmtree that reaches the same
    tree, and it must be as guarded as the build.
    """
    root = staging_root(data_dir)
    if root.is_symlink():
        raise StagingError(
            f"refusing to stage under a symlinked staging root ({root}); it "
            "must be a real directory inside the data volume."
        )
    target = export_staging_dir(data_dir, export_id)
    if target.is_symlink():
        raise StagingError(f"refusing to stage into a symlinked path ({target}).")
    if target.exists() and target.resolve().parent != root.resolve():
        raise StagingError(
            f"refusing to stage into {target}: it escapes the staging root."
        )
    return target


def build_staging(
    data_dir: str | Path, export_id: str, episodes: list[ExportEpisode]
) -> Path:
    """Create the staging tree for *episodes*; return its root.

    Raises :class:`StagingError` naming the first capture whose bytes are not
    where the submitted snapshot said they were.
    """
    root = guarded_export_staging_dir(data_dir, export_id)
    # A leftover tree can only be debris from a previous attempt with this
    # export_id; the caller refuses a re-used id, so there is no live job here.
    # Removed fd-relative (never following a symlinked root), same as the
    # removal the registry runs when the export ends.
    remove_export_staging(data_dir, export_id)
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
    everything under ``.staging/`` is debris by definition. Removal goes through
    the same fd-relative path as the runtime removal: the root is opened with
    ``O_NOFOLLOW`` (a symlinked ``.staging``, e.g. a relocated or
    attacker-writable EXPORTS_DIR pointed at ``objects/``, fails the open rather
    than being followed and iterated), and each entry is removed fd-relative so
    no symlink anywhere in the tree can steer a deletion at recorded bytes.
    """
    root_fd = _open_staging_root_nofollow(data_dir)
    if root_fd is None:
        return []
    removed: list[str] = []
    try:
        for name in sorted(os.listdir(root_fd)):
            try:
                _rmtree_at(root_fd, name)
            except OSError:
                logger.warning("could not remove leftover staging entry: %s", name)
                continue
            removed.append(name)
    finally:
        os.close(root_fd)
    return removed
