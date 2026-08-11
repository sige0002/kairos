"""Bringing a capture's bytes into ``objects/`` — imports and robot pulls.

Contract §2's invariant and §10.6. Anything arriving from outside — an operator
importing a bag, the importer sidecar pulling a finished capture off the robot —
lands in ``.incoming/<capture_id>`` and is moved into place with a single
``os.replace``. Until that instant nothing under ``objects/`` describes the
capture, so §2's rule holds: an incomplete directory under ``objects/`` can only
ever be a live recording.

**One complication is real and worth the code.** In a split deployment the
operator reviews a capture on the recording PC *before* its bytes arrive — the
auto-pull is triggered by the first review save — so ``objects/<capture_id>/``
may already exist holding nothing but ``record.json``. ``os.replace`` refuses a
non-empty destination directory, and blowing the destination away would destroy
the review. :func:`adopt_incoming` therefore folds any existing sidecars into
the staging directory first, and only then does the atomic move.
"""

from __future__ import annotations

import errno
import logging
import os
import shutil
from pathlib import Path

from kairos_common.atomic_io import fsync_dir
from kairos_common.capture_sidecars import (
    RECORD_FILENAME,
    SidecarStatus,
    read_record,
    validate_capture_id,
)

from api_orchestrator.layout import DataLayout

logger = logging.getLogger("kairos")

# Files that may legitimately be sitting in objects/<capture_id>/ before the
# bytes arrive. Anything else there means the destination is a real capture and
# the arrival is a conflict, not a completion.
_PRE_ARRIVAL_FILES: frozenset[str] = frozenset({RECORD_FILENAME})


class ArrivalConflictError(RuntimeError):
    """``objects/<capture_id>`` already holds a real capture."""


def adopt_incoming(layout: DataLayout, capture_id: str) -> Path:
    """Move ``.incoming/<capture_id>`` into ``objects/`` atomically.

    Returns the final path. Raises :class:`ArrivalConflictError` when the
    destination already holds a complete capture — overwriting it would replace
    bytes somebody already has with bytes we have not compared against them.
    """
    validate_capture_id(capture_id)
    staging = layout.incoming_dir(capture_id)
    final = layout.capture_dir(capture_id)
    if not staging.is_dir():
        raise FileNotFoundError(f"nothing staged at {staging}")

    if final.exists():
        _fold_pre_arrival_sidecars(final, staging, capture_id)

    layout.objects.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(staging, final)
    except OSError as exc:
        if exc.errno == errno.EXDEV:
            raise ArrivalConflictError(
                f".incoming and objects/ are on different filesystems, so "
                f"{capture_id} cannot be moved into place atomically"
            ) from exc
        raise
    fsync_dir(layout.objects)
    logger.info("capture arrived", extra={"capture_id": capture_id})
    return final


def _fold_pre_arrival_sidecars(final: Path, staging: Path, capture_id: str) -> None:
    """Merge a pre-arrival ``record.json`` into staging, then clear the target.

    The review was written before the bytes arrived (a split deployment reviews
    first and pulls second), so a local ``record.json`` with no capture around
    it is normal here. Which copy survives is decided by **revision** (§4.1-4),
    not by which side we happen to be standing on: revision is the only ordering
    the review protocol defines, and "whatever arrived last wins" would silently
    undo an operator's edit whenever a transfer overtook it.
    """
    entries = {child.name for child in final.iterdir()}
    unexpected = entries - _PRE_ARRIVAL_FILES
    if unexpected:
        raise ArrivalConflictError(
            f"objects/{capture_id} already exists and holds {sorted(unexpected)}; "
            "refusing to replace a capture that is already here"
        )
    if RECORD_FILENAME in entries:
        _merge_record(final, staging, capture_id)
    for name in sorted(entries):
        (final / name).unlink(missing_ok=True)
    final.rmdir()


def _merge_record(final: Path, staging: Path, capture_id: str) -> None:
    """Leave the winning ``record.json`` in *staging*, by revision (§4.1-4).

    Higher revision wins. On a tie the two are compared: identical content is
    not a conflict at all (the same review reached both sides), and differing
    content keeps the **local** copy — this host is where the operator is, and a
    warning is the right answer to a genuine divergence rather than a silent
    choice either way.

    An unreadable sidecar counts as revision -1, so a corrupt file never
    overwrites a readable one. The corrupt copy is not preserved: the readable
    review is the one worth keeping, and the loss is reported.
    """
    local = read_record(final)
    incoming = read_record(staging)
    local_revision = local.record.revision if local.record else -1
    incoming_revision = incoming.record.revision if incoming.record else -1

    if local.status is SidecarStatus.corrupt:
        logger.warning(
            "the local record.json is unreadable (%s); keeping the transferred "
            "review instead",
            local.error,
            extra={"capture_id": capture_id},
        )
    if incoming_revision > local_revision:
        return  # staging already holds the winner
    if local_revision > incoming_revision:
        logger.info(
            "keeping the local review (revision %d) over the transferred one "
            "(revision %d)",
            local_revision,
            incoming_revision,
            extra={"capture_id": capture_id},
        )
        shutil.copy2(final / RECORD_FILENAME, staging / RECORD_FILENAME)
        return

    # Equal revisions — including the both-unreadable case, where -1 == -1 and
    # keeping the local file at least preserves the evidence.
    if not (staging / RECORD_FILENAME).exists():
        shutil.copy2(final / RECORD_FILENAME, staging / RECORD_FILENAME)
        return
    # Identical bytes mean the same save reached both sides; not a conflict.
    if (final / RECORD_FILENAME).read_bytes() == (
        staging / RECORD_FILENAME
    ).read_bytes():
        return
    logger.warning(
        "two different reviews share revision %d; keeping the local one. This "
        "means a review was saved on both hosts without going through §4.1's "
        "compare-and-swap, so one edit is being dropped",
        local_revision,
        extra={"capture_id": capture_id},
    )
    shutil.copy2(final / RECORD_FILENAME, staging / RECORD_FILENAME)
