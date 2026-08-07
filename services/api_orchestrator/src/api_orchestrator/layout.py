"""The data directory's shape, and the filesystem invariants that depend on it.

Contract §2. Everything the capture store does to disk goes through here, so
the rules that are easy to violate by accident live in one place:

**objects/, .trash/ and .incoming/ must share a filesystem.** Deletion is a
``rename`` into ``.trash`` (§7 step 3) and an import lands by ``os.replace``
from ``.incoming`` (§2). Both are atomic only within one filesystem; across a
mount boundary ``rename`` fails with ``EXDEV`` and the tempting fix — copy, then
unlink — is not the same operation at all. It is not atomic, it doubles peak
disk usage exactly when the disk is full, and a crash halfway leaves the bytes
in two places with nothing to say which is real. So :func:`check_same_filesystem`
runs at startup and the deletion APIs are *withdrawn* (503) rather than silently
degraded.

**A volume marker proves the disk we are looking at is the disk we indexed.**
An unmounted bind mount presents an empty directory, which is indistinguishable
from "every recording was deleted" to a scan. :func:`read_volume_marker` gives
the reconciler something to compare before and after a pass (§9-3): if the
marker is absent or changed, the pass is discarded rather than applied, because
the alternative is marking a whole catalog ``missing_unmanaged`` on a mount
failure.

**A capture is a directory plus its siblings.** ``objects/<id>.failed.json``
(§3.4) and ``objects/<id>.qos.yaml`` sit *beside* the directory, so anything
that moves or removes a capture has to take them too — a deletion that leaves
the failed-start record behind resurrects the capture on the next rebuild.
"""

from __future__ import annotations

import errno
import logging
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from kairos_common.atomic_io import create_exclusive_json, fsync_dir
from kairos_common.capture_sidecars import (
    FAILED_START_SUFFIX,
    INCOMING_DIRNAME,
    OBJECTS_DIRNAME,
    TRASH_DIRNAME,
    validate_capture_id,
)
from kairos_common.errors import ApiError
from kairos_common.ids import new_instance_id
from kairos_common.time import utc_now_iso8601

logger = logging.getLogger("kairos")

VIEWS_DIRNAME = "views"
REPORT_DIRNAME = "report"
CATALOG_DIRNAME = "catalog"
DB_FILENAME = "kairos.db"

# Identifies the physical volume the data directory lives on. Compared before
# and after every reconciler scan (§9-3).
VOLUME_MARKER_NAME = ".kairos-volume-id"

# Suffixes of files that sit BESIDE objects/<capture_id>/ and belong to the
# same capture. Anything that moves or deletes a capture must take these too.
CAPTURE_SIBLING_SUFFIXES: tuple[str, ...] = (FAILED_START_SUFFIX, ".qos.yaml")

# Parked copies :func:`move_to_trash` creates when two directories claim one
# capture_id. They are still that capture's bytes, so the reaper must remove
# them and its verification must look for them.
DUPLICATE_SUFFIX = ".duplicate-"
DUPLICATE_GLOB = f"{DUPLICATE_SUFFIX}*"

# Names directly under data_dir that kairos owns (§2). An operator or task named
# like one of these would collide with the store's own layout, so the API
# rejects it rather than writing captures into `views/`.
RESERVED_NAMES: frozenset[str] = frozenset(
    {
        OBJECTS_DIRNAME,
        VIEWS_DIRNAME,
        TRASH_DIRNAME,
        INCOMING_DIRNAME,
        REPORT_DIRNAME,
        CATALOG_DIRNAME,
        "lifecycle.jsonl",
        "instance.json",
        DB_FILENAME,
    }
)


@dataclass(frozen=True)
class DataLayout:
    """The data directory's subpaths, resolved once."""

    data_dir: Path

    @property
    def objects(self) -> Path:
        return self.data_dir / OBJECTS_DIRNAME

    @property
    def trash(self) -> Path:
        return self.data_dir / TRASH_DIRNAME

    @property
    def incoming(self) -> Path:
        return self.data_dir / INCOMING_DIRNAME

    @property
    def views(self) -> Path:
        return self.data_dir / VIEWS_DIRNAME

    @property
    def report(self) -> Path:
        return self.data_dir / REPORT_DIRNAME

    @property
    def catalog(self) -> Path:
        return self.data_dir / CATALOG_DIRNAME

    @property
    def db(self) -> Path:
        return self.data_dir / DB_FILENAME

    def capture_dir(self, capture_id: str) -> Path:
        """``objects/<capture_id>`` — validated, so it cannot escape objects/."""
        return self.objects / validate_capture_id(capture_id)

    def trash_dir(self, capture_id: str) -> Path:
        return self.trash / validate_capture_id(capture_id)

    def incoming_dir(self, capture_id: str) -> Path:
        return self.incoming / validate_capture_id(capture_id)

    def report_dir(self, pipeline: str, capture_id: str) -> Path:
        return self.report / pipeline / validate_capture_id(capture_id)

    def ensure_dirs(self) -> None:
        """Create the directories the store writes into.

        ``.trash`` and ``.incoming`` are created here rather than lazily at
        first use: :func:`check_same_filesystem` has to stat them at startup,
        and a check that silently passes because a directory does not exist yet
        is worse than no check.
        """
        for path in (self.objects, self.trash, self.incoming, self.report):
            path.mkdir(parents=True, exist_ok=True)


def check_same_filesystem(layout: DataLayout) -> str | None:
    """``None`` if objects/, .trash/ and .incoming/ share a device, else why not.

    The returned string is shown to an operator and named in the 503 body, so
    it says which pair disagreed rather than "configuration error".
    """
    try:
        base = layout.objects.stat().st_dev
    except OSError as exc:
        return f"{layout.objects} cannot be inspected: {exc}"
    for name, path in ((".trash", layout.trash), (".incoming", layout.incoming)):
        try:
            dev = path.stat().st_dev
        except OSError as exc:
            return f"{path} cannot be inspected: {exc}"
        if dev != base:
            return (
                f"{name} is on a different filesystem from objects/ "
                f"({path} dev={dev}, {layout.objects} dev={base}). "
                "Deleting would need a copy instead of a rename, which is not "
                "atomic; fix the mounts so they share one volume."
            )
    return None


def ensure_volume_marker(layout: DataLayout) -> str | None:
    """Return this volume's id, creating the marker on first sight.

    ``None`` when the marker can neither be read nor written — which the
    reconciler treats as "do not apply anything", since without a marker it
    cannot tell an empty volume from an unmounted one.
    """
    path = layout.data_dir / VOLUME_MARKER_NAME
    existing = read_volume_marker(layout)
    if existing is not None:
        return existing
    payload = {"volume_id": new_instance_id(), "created_at": utc_now_iso8601()}
    try:
        create_exclusive_json(path, payload)
    except OSError as exc:
        logger.error("could not create the volume marker at %s: %s", path, exc)
        return None
    # Re-read rather than trusting our own payload: another process may have
    # won the exclusive create, and its id is the volume's id.
    return read_volume_marker(layout)


def read_volume_marker(layout: DataLayout) -> str | None:
    """The volume id recorded beside the data, or ``None`` if unreadable.

    ``None`` covers both "the file is gone" and "the file is corrupt", and the
    caller must treat them the same: neither can confirm that the volume in
    front of it is the one the catalog describes.
    """
    import json

    path = layout.data_dir / VOLUME_MARKER_NAME
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    volume_id = data.get("volume_id") if isinstance(data, dict) else None
    return volume_id if isinstance(volume_id, str) and volume_id else None


def capture_siblings(layout: DataLayout, capture_id: str) -> list[Path]:
    """Existing files that sit beside ``objects/<capture_id>/`` and belong to it."""
    validate_capture_id(capture_id)
    return [
        path
        for suffix in CAPTURE_SIBLING_SUFFIXES
        if (path := layout.objects / f"{capture_id}{suffix}").exists()
    ]


def move_to_trash(layout: DataLayout, capture_id: str) -> bool:
    """Rename a capture and its siblings into ``.trash``. ``True`` = something moved.

    Step 3 of §7. ``rename`` is used deliberately and exclusively: it is atomic,
    it succeeds even while another process holds the files open (POSIX), and it
    cannot half-finish. ``EXDEV`` is re-raised rather than falling back to a
    copy — see the module docstring.

    Idempotent: a capture already in ``.trash`` (a crash between step 3 and
    step 4) returns ``False`` and leaves the trashed copy alone, so the resume
    path can call this without checking first.
    """
    source = layout.capture_dir(capture_id)
    target = layout.trash_dir(capture_id)
    layout.trash.mkdir(parents=True, exist_ok=True)

    moved = False
    if source.exists():
        if target.exists():
            # A previous attempt already trashed a copy and then crashed before
            # the directory was gone. Two directories now claim the same id;
            # keep the trashed one (it is the one the tombstone refers to) and
            # park the newcomer beside it rather than merging them blindly.
            salvage = layout.trash / f"{capture_id}{DUPLICATE_SUFFIX}{os.getpid()}"
            logger.warning(
                "both objects/%s and .trash/%s exist; moving the objects/ copy "
                "aside to %s instead of merging",
                capture_id,
                capture_id,
                salvage.name,
            )
            os.rename(source, salvage)
        else:
            os.rename(source, target)
        moved = True

    for sibling in capture_siblings(layout, capture_id):
        destination = layout.trash / sibling.name
        try:
            os.rename(sibling, destination)
            moved = True
        except OSError as exc:
            if exc.errno == errno.EXDEV:
                raise
            logger.warning("could not trash sibling %s: %s", sibling, exc)

    if moved:
        fsync_dir(layout.objects)
        fsync_dir(layout.trash)
    return moved


def trash_remnants(layout: DataLayout, capture_id: str) -> list[Path]:
    """Everything under ``.trash`` that still belongs to this capture.

    The capture directory, its sibling files, **and** any
    ``<capture_id>.duplicate-<pid>`` parking left by :func:`move_to_trash` when
    it found two copies claiming one id. Enumerating them in one place is what
    stops the reaper's verification and its removal from disagreeing: a
    remnant the removal does not delete but the check does not look for would
    let a replica become ``absent_managed`` while its bytes are still on disk.
    """
    validate_capture_id(capture_id)
    remnants = [layout.trash_dir(capture_id)]
    remnants.extend(
        layout.trash / f"{capture_id}{suffix}" for suffix in CAPTURE_SIBLING_SUFFIXES
    )
    try:
        remnants.extend(sorted(layout.trash.glob(f"{capture_id}{DUPLICATE_GLOB}")))
    except OSError:
        pass
    return [path for path in remnants if path.exists()]


def report_remnants(layout: DataLayout, capture_id: str) -> list[Path]:
    """Every ``report/<pipeline>/<capture_id>/`` directory for this capture.

    Enumerated by scanning ``report/`` rather than from a list of known
    pipelines: the registry changes (``dataset_export`` was retired with §6,
    plugins add their own), and a hardcoded list would silently stop cleaning
    up the moment somebody added a pipeline.
    """
    validate_capture_id(capture_id)
    try:
        pipelines = sorted(layout.report.iterdir())
    except OSError:
        return []
    return [
        candidate
        for pipeline in pipelines
        if pipeline.is_dir() and not pipeline.is_symlink()
        if (candidate := pipeline / capture_id).exists()
    ]


def purge_reports(layout: DataLayout, capture_id: str) -> bool:
    """Delete this capture's pipeline reports. ``True`` = nothing is left.

    These are derived artifacts — a validation summary, a ``video_check`` mp4 —
    so there is no ledger event and nothing to recover. But they are **served**
    by ``GET /api/v1/files``, which makes leaving them behind a correctness
    problem rather than untidiness: a discard tells the operator the recording
    is unrecoverable (§12), and a surviving mp4 preview of it makes that untrue.
    """
    for path in report_remnants(layout, capture_id):
        shutil.rmtree(path, ignore_errors=True)
    remaining = report_remnants(layout, capture_id)
    if remaining:
        logger.warning(
            "reports for %s could not be removed: %s",
            capture_id,
            [str(path) for path in remaining],
        )
    return not remaining


def purge_from_trash(layout: DataLayout, capture_id: str) -> bool:
    """Physically remove a trashed capture. ``True`` = nothing is left.

    Step 5 of §7, and the return value is the *verification* that step demands:
    the replica may only become ``absent_managed`` once the bytes are provably
    gone. A partial removal (a permission error on one file) returns ``False``
    so the caller retries under a bound rather than recording a completed
    cleanup that did not happen.

    Both the removal and the verification enumerate through
    :func:`trash_remnants`, so they cannot drift apart — in particular a
    ``.duplicate-<pid>`` parking is removed AND checked, where before it was
    neither.
    """
    for path in trash_remnants(layout, capture_id):
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning("could not remove %s: %s", path, exc)
    return not trash_remnants(layout, capture_id)


def dir_bytes(path: Path) -> int | None:
    """Total size of every file under *path*, or ``None`` if it is not there."""
    if not path.is_dir():
        return None
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file() and not child.is_symlink():
                total += child.stat().st_size
        except OSError:
            continue
    return total


def digest_input_files(capture_dir: Path) -> list[Path]:
    """The files whose hashes go into the manifest (§3.2), sorted by path.

    ``object_manifest.json`` is excluded because it is the file being written —
    hashing it into itself is not defined. ``record.json`` is excluded because
    it is the one *mutable* sidecar (§4): including it would make the capture
    digest change every time an operator edited a review, which would turn the
    digest from "these bytes are intact" into "nobody has touched anything",
    and make every replica comparison fail after a routine edit.
    """
    from kairos_common.capture_sidecars import (
        OBJECT_MANIFEST_FILENAME,
        RECORD_FILENAME,
    )

    excluded = {OBJECT_MANIFEST_FILENAME, RECORD_FILENAME}
    files: list[Path] = []
    for child in sorted(capture_dir.rglob("*")):
        if child.is_symlink() or not child.is_file():
            continue
        relative = child.relative_to(capture_dir)
        if str(relative) in excluded:
            continue
        if child.name.startswith(".") and child.name.endswith(".tmp"):
            # An atomic write in flight. Hashing it would seal a temp file into
            # the manifest as capture content.
            continue
        files.append(child)
    return files


# NAME_MAX: the longest single directory entry every filesystem kairos targets
# will accept, in bytes. Both a dataset's labels and a recording's
# operator/task become one such entry under ``views/`` — the dataset's directly,
# the recording's through ``COALESCE(d.operator, c.operator)`` when a dataset
# leaves them unset — so one budget covers both.
MAX_LABEL_BYTES = 255

# Exactly ``views._UNSAFE``: the characters that cannot survive as a single path
# component. Restated rather than imported because views.py imports from here.
_UNSAFE_LABEL = re.compile(r"[/\\\x00-\x1f\x7f]")


def reject_unusable_labels(**labels: str | None) -> None:
    """Refuse a label that cannot be a directory entry (§6).

    A limit the filesystem states in BYTES, which is why a character cap does
    not express it: 200 emoji are 800 bytes and 200 kanji are 600.

    Lives here rather than beside either caller because there are two of them
    and they are the two ends of the same path: a dataset's own labels, and the
    recording labels a dataset inherits when it sets none. Capping only the
    first left the tree reachable through the second.

    This is the door, not the only defence: ``views.regenerate`` still skips a
    member it cannot place, because manifests rebuilt from an older
    installation were never asked.
    """
    for field, value in labels.items():
        if value is None:
            continue
        size = len(value.encode("utf-8"))
        if size <= MAX_LABEL_BYTES:
            continue
        raise ApiError(
            status_code=400,
            code="label_too_long",
            message=(
                f"{field} is {size} bytes; it becomes a folder name under "
                f"views/ and cannot exceed {MAX_LABEL_BYTES} bytes. Note that "
                "this is a byte count: accented, kanji and emoji characters "
                "each take several."
            ),
            details={"field": field, "bytes": size, "limit": MAX_LABEL_BYTES},
        )


def reject_unsafe_labels(**labels: str | None) -> None:
    """Refuse a capture label that could not be a single path component (§4.3).

    Stricter than :func:`reject_unusable_labels`, and deliberately so. A dataset
    label reaches ``views/`` through ``sanitize_component``, which rewrites the
    awkward characters and is pinned by tests — that behaviour predates this and
    is not changed here. A capture label is a NEW door onto the same tree
    (``list_view_entries`` falls back to the capture's operator/task when the
    dataset sets none), and for a new door refusing beats rewriting: the operator
    typed the value and is present to be told, rather than discovering later that
    their ``a/b`` became ``a_b`` in a path somebody else is globbing.

    Rejects the separators, the control characters and the two dot names — the
    same set ``sanitize_component`` treats as unusable, reported instead of
    rewritten. Empty and whitespace-only are left to the caller: they mean
    "clear", which is spelled by ``null``.
    """
    for field, value in labels.items():
        if value is None:
            continue
        bad = _UNSAFE_LABEL.search(value)
        if bad is not None:
            raise ApiError(
                status_code=400,
                code="unsafe_label",
                message=(
                    f"{field} contains {bad.group()!r}, which cannot appear in a "
                    "folder name under views/. Separators and control characters "
                    "are refused here rather than silently rewritten."
                ),
                details={"field": field},
            )
        if value.strip() in (".", ".."):
            raise ApiError(
                status_code=400,
                code="unsafe_label",
                message=(
                    f"{field} cannot be {value.strip()!r}: as a folder name that "
                    "is a reference to another directory, not a name."
                ),
                details={"field": field},
            )


def is_reserved_name(name: str) -> bool:
    """Whether *name* collides with a directory kairos owns under data_dir."""
    return name in RESERVED_NAMES


def read_json(path: Path) -> dict[str, Any] | None:
    """Best-effort read of a JSON sidecar (``None`` on any failure)."""
    import json

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None
