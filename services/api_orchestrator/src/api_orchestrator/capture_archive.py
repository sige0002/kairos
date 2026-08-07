"""§6: archiving a capture out of the store, verified, before the source goes.

**Archive verifies before it deletes.** Copy, read back, compare, write the
ledger event carrying enough to reconstruct the row, and only then remove the
source — through the same trash pathway as any other deletion, so an archive
that goes wrong at the last step leaves the bytes recoverable in exactly the
place every other failure leaves them.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kairos_common import ApiError
from kairos_common.rebuild import ReplicaState
from kairos_common.time import utc_now_iso8601

from api_orchestrator import fileops
from api_orchestrator import layout as layout_mod
from api_orchestrator.ledger_guard import append_or_503
from api_orchestrator.models import ArchivedFile, Capture, CaptureArchiveResponse

if TYPE_CHECKING:
    from api_orchestrator.layout import DataLayout
    from api_orchestrator.store import CaptureStore

logger = logging.getLogger("kairos")


class CaptureArchiveMixin:
    """The §6 archive pathway, mixed into ``CaptureService``.

    Not usable on its own. The host supplies the collaborators annotated below,
    plus ``get()``, ``_mutex()`` and the guards every mutating path runs first
    (``_require_delete_available``, ``_reject_active``, ``_reject_leased``,
    ``_reject_dataset_member``, ``_reject_overlapping_destination``).
    """

    _store: CaptureStore
    _layout: DataLayout
    _instance_id: str

    async def archive(
        self,
        capture_id: str,
        *,
        destination: Path,
        operator: str | None = None,
        reason: str | None = None,
    ) -> CaptureArchiveResponse:
        """Copy a capture out, verify it, record it, then delete the source.

        The destination has already been validated against
        ``KAIROS_ARCHIVE_ROOTS`` by the caller. The source removal reuses the
        ordinary trash pathway rather than an ``rmtree`` of its own: an archive
        interrupted after the ledger event resumes through exactly the same code
        as an interrupted discard.
        """
        self._require_delete_available()
        async with self._mutex(capture_id):
            capture = self.get(capture_id)
            self._reject_active(capture)
            self._reject_leased(capture)
            self._reject_dataset_member(capture)
            response = await self._archive_into(
                capture, destination / capture_id, operator=operator, reason=reason
            )

        logger.info(
            "capture archived",
            extra={
                "capture_id": capture_id,
                "destination": response.destination,
                "bytes": response.bytes,
            },
        )
        return response

    async def archive_member(
        self,
        capture_id: str,
        *,
        dataset_id: str,
        membership_id: str,
        display_index: int,
        target: Path,
        progress: Callable[[int], None] | None = None,
    ) -> CaptureArchiveResponse:
        """Archive one member of the dataset being archived (§6.x).

        Internal to the dataset archive runner — no route reaches this. The
        one guard it relaxes is its own dataset's membership: the §7 member
        guard exists so a deletion cannot leave a dataset citing missing
        bytes, and the run this call belongs to is retiring that dataset from
        ``views/`` as a whole. Membership of any OTHER dataset still refuses.

        ``target`` is the member's ``<dataset_dir>/<NNN>`` directory, named by
        the runner: the display_index is dataset identity, and only the run
        knows it.
        """
        self._require_delete_available()
        async with self._mutex(capture_id):
            capture = self.get(capture_id)
            self._reject_active(capture)
            self._reject_leased(capture)
            self._reject_dataset_member(capture, except_dataset=dataset_id)
            response = await self._archive_into(
                capture,
                target,
                extra_payload={
                    "dataset_id": dataset_id,
                    "membership_id": membership_id,
                    "display_index": display_index,
                },
                progress=progress,
            )

        logger.info(
            "dataset member archived",
            extra={
                "capture_id": capture_id,
                "dataset_id": dataset_id,
                "display_index": display_index,
                "destination": response.destination,
                "bytes": response.bytes,
            },
        )
        return response

    async def copy_out(
        self,
        capture_id: str,
        *,
        target: Path,
        progress: Callable[[int], None] | None = None,
    ) -> fileops.CopyResult:
        """Copy a capture's bytes to *target*, verified — and change NOTHING.

        The §6.1 copy-mode member step. No ledger event, no row update, no
        trash: the capture has not gone anywhere, so there is nothing to
        record about it — the dataset manifest and the run's seal carry the
        export's own audit trail. Under the mutex so a concurrent review save
        cannot be read half-written into the copy.
        """
        async with self._mutex(capture_id):
            capture = self.get(capture_id)
            self._reject_active(capture)
            return await self._copy_to_target(capture, target, progress=progress)

    async def _archive_into(
        self,
        capture: Capture,
        target: Path,
        *,
        operator: str | None = None,
        reason: str | None = None,
        extra_payload: dict[str, Any] | None = None,
        progress: Callable[[int], None] | None = None,
    ) -> CaptureArchiveResponse:
        """copy → verify → ledger → row → trash, under the caller's mutex.

        The §9-1 order in one place so the per-capture and per-member archives
        cannot drift: the ledger line precedes the source deletion, and a
        failure after the copy leaves the source untouched.
        """
        capture_id = capture.capture_id
        result = await self._copy_to_target(capture, target, progress=progress)

        # rev.2.1: carry enough for a rebuild to reconstruct the row after
        # the sidecars are gone. Without these the capture would come back
        # from a rebuild as a bare id with no operator, task or size.
        payload: dict[str, Any] = {"destination": str(target)}
        for key, value in (
            ("run_id", capture.run_id),
            ("operator", operator or capture.operator),
            ("task", capture.task),
            ("bytes", capture.bytes if capture.bytes is not None else result.bytes),
            ("message_count", capture.message_count),
        ):
            if value is not None:
                payload[key] = value
        if reason:
            payload["reason"] = reason
        if extra_payload:
            payload.update(extra_payload)
        # The per-file hashes we just computed while copying. Recording them
        # is what lets the LEDGER ALONE audit the archive: the manifest is
        # deleted with the source moments from now, so without this the
        # event can say "4 GB went to /mnt/nas" and nothing that would let
        # anyone check the copy years later.
        if result.entries:
            payload["files"] = result.entries
        append_or_503(
            self._layout.data_dir,
            "capture_archived",
            instance_id=self._instance_id,
            capture_id=capture_id,
            payload=payload,
            failure=lambda exc: (
                f"The archive copy at {target} succeeded but could not "
                f"be recorded in the ledger: {exc}. The source was NOT "
                "deleted; remove the copy or retry."
            ),
            details={"capture_id": capture_id},
        )

        self.finish_archived_member(capture_id, destination=str(target))
        await asyncio.to_thread(layout_mod.move_to_trash, self._layout, capture_id)
        self._store.upsert_replica(capture_id, self._instance_id, ReplicaState.trashed)

        return CaptureArchiveResponse(
            capture_id=capture_id,
            destination=str(target),
            bytes=result.bytes,
            file_count=result.files,
            files=[ArchivedFile.model_validate(entry) for entry in result.entries],
        )

    async def _copy_to_target(
        self,
        capture: Capture,
        target: Path,
        *,
        progress: Callable[[int], None] | None = None,
    ) -> fileops.CopyResult:
        """The verified copy both archive modes share: presence check, overlap
        check, copy with the error vocabulary the routes promise."""
        capture_id = capture.capture_id
        source = self._layout.capture_dir(capture_id)
        if not source.is_dir():
            raise ApiError(
                status_code=409,
                code="capture_not_present",
                message=(
                    f"{capture_id} has no local copy to archive "
                    f"({source} does not exist)."
                ),
                details={"capture_id": capture_id},
            )

        self._reject_overlapping_destination(target, source)
        try:
            return await asyncio.to_thread(
                fileops.copy_tree_verified, source, target, progress=progress
            )
        except fileops.DestinationNotEmptyError as exc:
            raise ApiError(
                status_code=409,
                code="destination_not_empty",
                message=(
                    f"{target} already contains files — refusing to archive "
                    "into it. Choose another path, or clear it if it is the "
                    "debris of a failed archive."
                ),
                details={"capture_id": capture_id, "destination": str(target)},
            ) from exc
        except (OSError, fileops.VerificationError) as exc:
            raise ApiError(
                status_code=500,
                code="archive_copy_failed",
                message=(
                    f"Archiving {capture_id} to {target} failed: {exc}. "
                    "The recording is untouched."
                ),
                details={"capture_id": capture_id, "destination": str(target)},
            ) from exc

    def finish_archived_member(self, capture_id: str, *, destination: str) -> None:
        """Mark the row archived — split out so a resume that finds the ledger
        line already written (a crash between append and row update) can finish
        exactly this step without re-copying anything."""
        self._store.update_capture(
            capture_id,
            archived_at=utc_now_iso8601(),
            archive_destination=destination,
        )


def reject_overlapping_destination(target: Path, source: Path, data_dir: Path) -> None:
    """Refuse an archive destination that overlaps our own data (§6).

    This is a *different* question from the ``KAIROS_ARCHIVE_ROOTS``
    allow-list, and passing that list is not evidence about this one. The
    allow-list says where writing is PERMITTED; this says the two paths must
    not be the same bytes. Set ``KAIROS_ARCHIVE_ROOTS=/data`` — which is a
    perfectly reasonable thing for an operator to do — and the allow-list
    happily authorises archiving ``objects/<id>`` into the data directory,
    after which the source deletion removes the verified copy along with the
    original and the API reports success with nothing left.

    Resolved through ``realpath`` on both sides so a symlink cannot disguise
    the overlap, and containment is checked in BOTH directions: a
    destination inside the data directory is the obvious case, and a data
    directory inside the destination is the same disaster from the other
    end.

    Module-level because two callers ask it: the per-capture archive checks
    ``<destination>/<capture_id>``, and the dataset archive preflight checks
    the whole resolved dataset directory before any member moves.
    """
    real_target = _real_path(target)
    real_source = _real_path(source)
    real_data = _real_path(data_dir)
    pairs = [(real_data, "data_dir")]
    if real_source != real_data:
        # The dataset preflight has no single capture to name and passes the
        # data_dir as both; naming it twice would produce the wrong label.
        pairs.insert(0, (real_source, "the capture"))
    for other, label in pairs:
        if _overlaps(real_target, other):
            raise ApiError(
                status_code=400,
                code="destination_inside_data_dir",
                message=(
                    f"The archive destination overlaps {label} "
                    f"({real_target} vs {other}). Archiving there would "
                    "delete the copy along with the original."
                ),
                details={
                    "destination": str(real_target),
                    "data_dir": str(real_data),
                },
            )


def _real_path(path: Path) -> Path:
    """``realpath`` of *path*, resolving symlinks in its existing ancestors.

    The archive destination normally does not exist yet, so the part that CAN
    be spoofed is the part that already does — that is where a planted symlink
    would live. Resolve the deepest existing ancestor and re-attach the tail.
    """
    existing = path
    while not existing.exists() and existing != existing.parent:
        existing = existing.parent
    real_existing = Path(os.path.realpath(existing))
    try:
        tail = path.relative_to(existing)
    except ValueError:  # pragma: no cover - path is its own ancestor
        return real_existing
    return real_existing if str(tail) == "." else real_existing / tail


def _overlaps(a: Path, b: Path) -> bool:
    """Whether either path contains the other, or they are the same."""
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


__all__ = ["CaptureArchiveMixin", "reject_overlapping_destination"]
