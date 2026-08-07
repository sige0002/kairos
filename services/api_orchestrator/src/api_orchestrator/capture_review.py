"""§4.1: saving an operator's review — the sidecar first, then the database.

**Review saves the sidecar first.** ``record.json`` is authoritative for review
state, so writing it before the database CAS means a crash in between leaves the
sidecar *ahead* — the direction rebuild resolves by adopting it. The reverse
order would leave the database claiming a review that no file records, which
rebuild can only report as a warning and never repair.

Writing first is only safe if the write cannot overwrite a decision somebody
else already committed, so the sidecar write is **itself a compare-and-swap**:
it refuses unless ``record.json`` still holds the revision the caller built on,
and a save that loses the database CAS anyway restamps the file from the winning
row. Without both, two orchestrators can leave the REFUSED decision as the last
file on disk while the database holds the accepted one — and since §8 rebuilds
the index from the sidecars, dropping ``kairos.db`` would then reinstate the
decision the API answered 409 to.

The two functions that do those writes live in :mod:`api_orchestrator.captures`
alongside the rest of the ``record.json`` contract, and are reached from here
through that module's namespace — see :meth:`CaptureReviewMixin.save_review`.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from kairos_common import ApiError
from kairos_common.capture_sidecars import (
    LABEL_FIELDS,
    CaptureState,
    RecordV2,
    read_object_manifest,
    read_record,
)
from kairos_common.time import utc_now_iso8601

from api_orchestrator.layout import reject_unsafe_labels, reject_unusable_labels
from api_orchestrator.models import Capture, ReviewSaveRequest

if TYPE_CHECKING:
    from api_orchestrator.layout import DataLayout
    from api_orchestrator.store import CaptureStore

logger = logging.getLogger("kairos")

# The review fields a save may carry. Anything else on the request model is
# envelope (base_revision), never persisted as review state.
_REVIEW_FIELDS: tuple[str, ...] = (
    "task_result",
    "failure_reason",
    "quality",
    "quality_source",
    "review_status",
    "batch_id",
    "index_in_batch",
    *LABEL_FIELDS,
)

# The labels that are path components under views/ (§6). ``robot`` is not one:
# it is carried on the row and shown in the UI, but the tree groups by operator
# and task only, so editing it changes nothing on disk.
_VIEWS_LABELS: tuple[str, ...] = ("operator", "task")


class CaptureReviewMixin:
    """The §4.1 review save, mixed into ``CaptureService``.

    Not usable on its own. The host supplies the collaborators annotated below,
    plus ``get()`` (the read that 404s) and ``_mutex()`` (the §4.1 per-capture
    lock, shared with the delete and archive paths).
    """

    _store: CaptureStore
    _layout: DataLayout
    _on_first_review: Callable[[Capture], Awaitable[None]] | None
    _on_views_change: Callable[[], None] | None

    def _schedule_views_refresh(self, capture_id: str) -> None:
        """Ask for a views regeneration; never let one fail the save."""
        if self._on_views_change is None:
            return
        try:
            self._on_views_change()
        except Exception:  # noqa: BLE001 - a stale tree is not a failed review
            logger.warning(
                "could not schedule a views refresh after a label edit",
                extra={"capture_id": capture_id},
                exc_info=True,
            )

    async def save_review(
        self, capture_id: str, request: ReviewSaveRequest, *, system: bool = False
    ) -> Capture:
        """Save an operator's review: sidecar first, then a database CAS.

        The whole of steps 1-3 runs under this capture's mutex, so a second
        request for the same capture waits rather than interleaving its sidecar
        write with ours. Raises 409 on a revision mismatch (before or after the
        sidecar write), 500 if the sidecar cannot be written — with the database
        untouched, which is the safe direction.

        *system* marks a write the orchestrator itself originated (the
        quick_check quality re-derivation). It takes exactly the same path and
        advances the same revision: a client that then gets a 409 is seeing
        correct behaviour, not a bug.
        """
        # The ``record.json`` writers are reached through the ``captures``
        # module namespace rather than bound by an import at the top of this
        # one. Resolving them per call is what lets a caller substitute the
        # writer to hold a save inside the window between its revision check
        # and its sidecar write — the interleaving this compare-and-swap exists
        # to arbitrate, and the only way to exercise it without scheduling luck.
        from api_orchestrator import captures

        _reject_bad_labels(request)
        capture_dir = self._layout.capture_dir(capture_id)

        async with self._mutex(capture_id):
            capture = self.get(capture_id)
            self._reject_review_on_delete(capture)
            capture = self._adopt_sidecar_if_ahead(capture)
            if capture.review_revision != request.base_revision:
                raise _review_conflict(capture, request.base_revision)

            merged = _merge_review(capture, request)
            _derive_quality(capture, request, merged)
            # Read under the mutex, like everything else this save decides from:
            # the overrides already on disk are what an unsupplied label keeps,
            # and the manifest is what a cleared one falls back to.
            labels, label_values = _merge_labels(
                request,
                current=read_record(capture_dir).record,
                manifest_labels=_manifest_labels(capture_dir),
            )
            merged.update(label_values)
            revision = request.base_revision + 1
            record = RecordV2(
                capture_id=capture_id,
                revision=revision,
                review_status=merged["review_status"] or "pending",
                task_result=merged["task_result"],
                failure_reason=merged["failure_reason"],
                quality=merged["quality"],
                quality_source=merged["quality_source"],
                batch_id=merged["batch_id"],
                index_in_batch=merged["index_in_batch"],
                labels=labels,
                updated_at=utc_now_iso8601(),
            )
            # Creating objects/<id> is legitimate ONLY for a capture whose bytes
            # have not arrived yet (the split-deploy review-then-pull flow).
            # Anything the delete path has touched must never be recreated here,
            # even though the state check above already refused it: the two
            # together are what make this safe under the mutex.
            awaiting_transfer = (
                capture.delete_kind is None and capture.deleted_at is None
            )
            try:
                await asyncio.to_thread(
                    captures._write_record_sidecar,
                    capture_dir,
                    record,
                    allow_create=awaiting_transfer,
                    base_revision=request.base_revision,
                )
            except captures._SidecarRaceError as exc:
                # Another orchestrator committed its review between our read and
                # our write. Refusing here is the whole point of the guard: the
                # loser's values are dropped rather than written over a decision
                # that has already been acknowledged to somebody. Same 409 the
                # database CAS would have produced, one step earlier and without
                # a clobber in between.
                logger.info(
                    "review sidecar write refused: record.json moved on",
                    extra={
                        "capture_id": capture_id,
                        "on_disk_revision": exc.on_disk_revision,
                        "base_revision": request.base_revision,
                    },
                )
                raise _review_conflict(
                    self._adopt_sidecar_if_ahead(self.get(capture_id)),
                    request.base_revision,
                ) from exc
            except captures._CaptureGoneError as exc:
                raise ApiError(
                    status_code=409,
                    code="capture_not_present",
                    message=(
                        f"{capture_id} has no local copy and is not awaiting "
                        f"one, so its review cannot be saved: {exc}"
                    ),
                    details={"capture_id": capture_id},
                ) from exc
            except OSError as exc:
                # Nothing has touched the database, so the capture is exactly as
                # it was and the client may retry with the same base_revision.
                logger.error(
                    "review sidecar write failed",
                    extra={"capture_id": capture_id, "error": str(exc)},
                )
                raise ApiError(
                    status_code=500,
                    code="review_sidecar_write_failed",
                    message=(
                        f"Could not write record.json for {capture_id}: {exc}. "
                        "Nothing was saved; retry once the disk is writable."
                    ),
                    details={"capture_id": capture_id},
                ) from exc

            applied = self._store.save_review_cas(
                capture_id,
                base_revision=request.base_revision,
                fields={name: merged[name] for name in _REVIEW_FIELDS},
                renumber_index=_offers_an_index(request, merged),
            )
            if not applied:
                # Someone else won between our sidecar write and this CAS — the
                # guard above narrows that window but cannot close it, since
                # read-then-write across two processes is not atomic. The
                # database is the arbiter, so the file it disagrees with is
                # ours: restamp it from the winning row. Leaving our values
                # there would make §8's rebuild reinstate the decision this
                # request is about to be told was refused.
                winner = self.get(capture_id)
                await asyncio.to_thread(
                    captures._restore_record_from_row,
                    capture_dir,
                    winner,
                    wrote_revision=revision,
                )
                raise _review_conflict(winner, request.base_revision)

            saved = self.get(capture_id)
            if saved.index_in_batch != merged["index_in_batch"]:
                # The hint collided and the store issued a different number.
                # record.json still carries the hint, and §8 rebuilds the
                # catalog from it — so a file left unamended puts the duplicate
                # back the first time somebody deletes kairos.db. Same revision,
                # so this is the same save finishing rather than a new one.
                await asyncio.to_thread(
                    captures._restore_record_from_row,
                    capture_dir,
                    saved,
                    wrote_revision=revision,
                )

        if any(
            getattr(saved, name) != getattr(capture, name) for name in _VIEWS_LABELS
        ):
            # views/ groups by operator/task, falling back to the CAPTURE's when
            # its dataset names neither — so an edit that skipped this would
            # leave the tree filed under the label the capture used to have,
            # with nothing to say the two had diverged. Best-effort and outside
            # the mutex, like every other regeneration trigger: the save is
            # already committed, and a tree that could not be rebuilt is a
            # ``POST /api/v1/views/refresh`` away, not a failed request.
            self._schedule_views_refresh(capture_id)

        if request.base_revision == 0 and self._on_first_review is not None:
            # Outside the mutex: the first-review side effects (batch counter,
            # auto-pull) talk to other services and must not hold a capture's
            # lock while they do.
            await self._on_first_review(saved)
        if system:
            logger.info(
                "system review write applied",
                extra={"capture_id": capture_id, "revision": saved.review_revision},
            )
        return saved

    def _adopt_sidecar_if_ahead(self, capture: Capture) -> Capture:
        """Catch the row up to ``record.json`` when the file is ahead (§4.1-4).

        The row can legitimately lag the file: a crash between the sidecar write
        and the CAS leaves exactly that, and so does another orchestrator's save
        that this process has not read yet. §8 already resolves it in the
        sidecar's favour at rebuild time — doing the same here, per capture,
        keeps the guarded write from wedging. Without it a lagging row would
        make every subsequent save send a ``base_revision`` the file has already
        passed, and the guard would refuse all of them forever.

        The client still gets a 409 on this attempt, but now with the revision
        that actually exists, so a reload-and-retry succeeds.
        """
        on_disk = read_record(self._layout.capture_dir(capture.capture_id)).record
        if on_disk is None or on_disk.revision <= capture.review_revision:
            return capture
        logger.info(
            "adopting a record.json that is ahead of the catalog row",
            extra={
                "capture_id": capture.capture_id,
                "row_revision": capture.review_revision,
                "sidecar_revision": on_disk.revision,
            },
        )
        return self._store.update_capture(
            capture.capture_id,
            review_revision=on_disk.revision,
            review_status=on_disk.review_status,
            task_result=on_disk.task_result,
            failure_reason=on_disk.failure_reason,
            quality=on_disk.quality,
            quality_source=on_disk.quality_source,
            batch_id=on_disk.batch_id,
            index_in_batch=on_disk.index_in_batch,
        )

    @staticmethod
    def _reject_review_on_delete(capture: Capture) -> None:
        """Refuse to review a capture that is being, or has been, deleted.

        ``delete_pending`` is included deliberately. It is the window between
        the ledger append and the rename (§7 steps 2-3), and a review accepted
        inside it would write ``record.json`` into a directory that is about to
        move to ``.trash`` — or, worse, recreate ``objects/<capture_id>/`` after
        the move, leaving a phantom the next scan has to explain and the reaper
        will never touch. The operator's delete already won; the review loses.
        """
        if capture.state not in (
            CaptureState.delete_pending,
            CaptureState.discarded,
            CaptureState.deleted,
        ):
            return
        pending = capture.state == CaptureState.delete_pending
        raise ApiError(
            status_code=409,
            code="capture_deleting" if pending else "capture_deleted",
            message=(
                f"{capture.capture_id} is being "
                f"{capture.delete_kind or 'delete'}d; its review can no longer "
                "be changed."
                if pending
                else (
                    f"{capture.capture_id} was "
                    f"{capture.delete_kind or 'deleted'}"
                    f"{f' on {capture.deleted_at}' if capture.deleted_at else ''}; "
                    "its review can no longer be changed."
                )
            ),
            details={
                "capture_id": capture.capture_id,
                "state": str(capture.state),
            },
        )


def _merge_review(capture: Capture, request: ReviewSaveRequest) -> dict[str, Any]:
    """Apply a patch to the capture's current review values.

    An omitted field keeps its current value; a field explicitly set to ``null``
    clears it. ``model_fields_set`` is what distinguishes the two — treating
    ``None`` as "not supplied" would make it impossible to ever clear a
    failure_reason once one had been recorded.
    """
    supplied = request.model_fields_set
    return {
        name: (getattr(request, name) if name in supplied else getattr(capture, name))
        for name in _REVIEW_FIELDS
    }


def _merge_labels(
    request: ReviewSaveRequest,
    *,
    current: RecordV2 | None,
    manifest_labels: Mapping[str, str | None],
) -> tuple[dict[str, str], dict[str, str | None]]:
    """Work out the §4.3 overrides to store and the values the row should show.

    Returns ``(labels, effective)``. *labels* is the block written to
    ``record.json`` and holds ONLY overrides — an unsupplied field keeps
    whatever override it already had, and a cleared one loses its key rather
    than gaining a null, so the file has one spelling of "not overridden".

    *effective* is what the row displays, which is where clearing gets its
    meaning: the value falls back to *manifest_labels*, the recorder's own
    account. On an imported bag that is null again, which is the honest answer —
    nobody recorded an operator, so removing the human's guess leaves nothing.

    An empty or whitespace-only string is treated as a clear. A label that is
    blank is not a label, and storing one would put an override on the capture
    that renders as nothing and hides the manifest's value behind it.
    """
    supplied = request.model_fields_set
    labels: dict[str, str] = dict(current.labels) if current is not None else {}
    effective: dict[str, str | None] = {}
    for name in LABEL_FIELDS:
        if name not in supplied:
            continue
        raw = getattr(request, name)
        value = raw.strip() if isinstance(raw, str) else None
        if not value:
            labels.pop(name, None)
            effective[name] = manifest_labels.get(name)
        else:
            labels[name] = value
            effective[name] = value
    return labels, effective


def _manifest_labels(capture_dir: Path) -> dict[str, str | None]:
    """What the recorder sealed for the three label fields (§3).

    An unreadable or absent manifest yields nulls rather than raising: the
    capture may be awaiting its bytes (the split-deploy review-then-pull flow),
    and a label edit must not depend on them having arrived.
    """
    manifest = read_object_manifest(capture_dir).manifest
    if manifest is None:
        return dict.fromkeys(LABEL_FIELDS)
    return {name: getattr(manifest, name) for name in LABEL_FIELDS}


def _reject_bad_labels(request: ReviewSaveRequest) -> None:
    """Validate only the labels this request actually supplied."""
    supplied = {
        name: getattr(request, name)
        for name in LABEL_FIELDS
        if name in request.model_fields_set
    }
    if not supplied:
        return
    reject_unsafe_labels(**supplied)
    reject_unusable_labels(**supplied)


def _offers_an_index(request: ReviewSaveRequest, merged: dict[str, Any]) -> bool:
    """Whether this save is CLAIMING a number, rather than carrying one.

    Only a request that explicitly sends ``index_in_batch`` alongside a batch is
    offering a hint the store may overrule. Two cases are deliberately left out:

    * a save that omits the field. Review's edits are exactly that — they patch
      a failure_reason or a verdict, and the merge carries the existing number
      through untouched. Re-resolving it there would let an unrelated edit
      renumber an episode an operator is looking at, and would rewrite legacy
      rows that have held a duplicate since before this rule existed.
    * a number with no batch to be a number IN. Nothing collides, and there is
      no roster to allocate from.
    """
    return (
        "index_in_batch" in request.model_fields_set
        and merged["index_in_batch"] is not None
        and merged["batch_id"] is not None
    )


def _derive_quality(
    capture: Capture, request: ReviewSaveRequest, merged: dict[str, Any]
) -> None:
    """Fill in an omitted ``quality`` from the capture's settled quick check.

    The operator's Save sends no ``quality`` unless they overrode it, so the
    default comes from the orchestrator's own stop-time verdict — one place
    derives it, rather than every client re-deriving it from the same data and
    disagreeing. An explicit value is the operator's call and passes through
    untouched.

    With no settled verdict to read (an old capture, or a settlement that has
    not landed yet) the fallback is ``needs_review``: we cannot vouch for the
    data, and silently passing it as good is the one wrong answer. The
    ``quick_check`` source is what later lets
    :meth:`RecordService.reconcile_quality` correct this value once the real
    verdict arrives — an ``operator`` source is never touched.
    """
    if "quality" in request.model_fields_set and request.quality is not None:
        return
    if merged["quality"] is not None and request.base_revision > 0:
        # Not the first save and no new value supplied: keep what is there.
        return
    verdict = capture.quick_check.verdict.quality if capture.quick_check else None
    merged["quality"] = verdict or "needs_review"
    merged["quality_source"] = "quick_check"


def _review_conflict(capture: Capture, base_revision: int) -> ApiError:
    return ApiError(
        status_code=409,
        code="review_conflict",
        message=(
            f"This review was edited elsewhere (revision "
            f"{capture.review_revision}, you sent {base_revision}). "
            "Reload the capture and apply your change again."
        ),
        details={
            "capture_id": capture.capture_id,
            "current_revision": capture.review_revision,
            "base_revision": base_revision,
        },
    )


__all__ = ["CaptureReviewMixin"]
