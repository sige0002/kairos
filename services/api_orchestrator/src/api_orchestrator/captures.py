"""Capture-level operations: review, delete, archive, and the resume paths.

Contract §4.1 (review), §6 (archive), §7 (delete). Each of the three writes to
the filesystem *and* the database, and each orders those two writes so that a
crash between them leaves a state the next startup can finish rather than a
state nobody can interpret.

**Review saves the sidecar first** (§4.1). ``record.json`` is authoritative for
review state, so writing it before the database CAS means a crash in between
leaves the sidecar *ahead* — the direction rebuild resolves by adopting it. The
reverse order would leave the database claiming a review that no file records,
which rebuild can only report as a warning and never repair.

**Deletion writes the ledger first** (§7 step 1, §9-1). The ledger line is
appended before any byte moves, so the recoverable failure is "the ledger claims
a deletion that has not finished" — which the resume path completes. The other
direction loses the fact that an operator deliberately destroyed data, and a
later transfer would quietly bring it back.

**Archive verifies before it deletes** (§6). Copy, read back, compare, write the
ledger event carrying enough to reconstruct the row, and only then remove the
source — through the same trash pathway as any other deletion, so an archive
that goes wrong at the last step leaves the bytes recoverable in exactly the
place every other failure leaves them.

The per-capture mutex here is deliberately *not* the store's connection lock.
§4.1 requires one capture's read-modify-write to be atomic across a filesystem
write, and taking a global lock across an fsync would serialise every unrelated
request behind one slow disk.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from kairos_common import ApiError, Compression, ledger_v2
from kairos_common.capture_sidecars import (
    TERMINAL_STATES,
    UNFINALIZED_STATES,
    CaptureState,
    ObjectManifestV2,
    RecordV2,
    SidecarStatus,
    read_object_manifest,
    read_record,
    write_record,
)
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import ReplicaState
from kairos_common.time import utc_now_iso8601

from api_orchestrator import fileops
from api_orchestrator import layout as layout_mod
from api_orchestrator.health import StoreHealth
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import (
    ArchivedFile,
    Capture,
    CaptureArchiveResponse,
    CaptureDetail,
    CaptureTopic,
    DeleteKind,
    RetentionCandidate,
    ReviewSaveRequest,
    Split,
    coerce_error,
)
from api_orchestrator.store import CaptureStore

logger = logging.getLogger("kairos")

# Ledger kind per delete intent (§5). Two kinds rather than one with a field:
# a reader scanning history for "what did an operator throw away" must not have
# to parse a payload to find out.
_LEDGER_KIND: dict[str, str] = {
    "discard": "capture_discarded",
    "delete": "capture_deleted",
}

# How many times the reaper retries a trashed capture whose bytes will not go
# away. Bounded because §7 step 5 forbids an unbounded retry loop: after this
# the replica stays ``trashed`` and the condition is surfaced, which is a
# problem an operator can see rather than a background task spinning forever.
MAX_REAP_ATTEMPTS = 3

# How many per-capture mutexes to keep before dropping the idle ones. A capture
# store holds thousands of captures over a deployment's life and a lock object
# is tiny, so this is about not growing without bound rather than about memory
# pressure.
MAX_TRACKED_MUTEXES = 512

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
)


class CaptureService:
    """Review, delete and archive one capture at a time.

    Args:
        store: The v2 catalog.
        layout: Data directory paths.
        health: Process-wide store condition (SUSPECT, delete availability).
        instance_id: This installation's id — replicas are filed under it.
        on_first_review: Awaited after the FIRST review save for a capture.
            Carries the side effects §4.1 moved off the retired
            ``POST /episodes``: the batch counter and the auto-pull. Injected so
            this module does not depend on the importer client.
    """

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        health: StoreHealth,
        *,
        instance_id: str,
        on_first_review: Callable[[Capture], Awaitable[None]] | None = None,
    ) -> None:
        self._store = store
        self._layout = layout
        self._health = health
        self._instance_id = instance_id
        self._on_first_review = on_first_review
        # Per-capture mutexes for §4.1. Created lazily and never evicted while
        # in use; the dict itself is guarded by a plain lock because it is
        # touched from the event loop and from worker threads.
        self._mutexes: dict[str, asyncio.Lock] = {}
        self._mutex_guard = threading.Lock()
        self._reap_attempts: dict[str, int] = {}

    @property
    def layout(self) -> DataLayout:
        return self._layout

    @property
    def instance_id(self) -> str:
        return self._instance_id

    def _mutex(self, capture_id: str) -> asyncio.Lock:
        """This capture's §4.1 mutex, created on first use.

        Idle entries are dropped once the map grows past
        :data:`MAX_TRACKED_MUTEXES`. Evicting only UNLOCKED locks is what makes
        that safe: a held lock stays in the map, so no two callers can ever be
        handed different lock objects for the same capture. The map is otherwise
        unbounded in a long-running process that reviews many captures, and this
        is cheaper than the weak-reference bookkeeping that would be needed to
        make eviction automatic.
        """
        with self._mutex_guard:
            lock = self._mutexes.get(capture_id)
            if lock is None:
                if len(self._mutexes) >= MAX_TRACKED_MUTEXES:
                    self._evict_idle_mutexes()
                lock = asyncio.Lock()
                self._mutexes[capture_id] = lock
            return lock

    def _evict_idle_mutexes(self) -> None:
        """Drop unlocked mutexes. Caller holds ``_mutex_guard``."""
        for capture_id in [
            key for key, lock in self._mutexes.items() if not lock.locked()
        ]:
            del self._mutexes[capture_id]

    # ---- reads -------------------------------------------------------------

    def get(self, capture_id: str) -> Capture:
        """Return a capture or raise a unified 404."""
        _require_capture_id(capture_id)
        capture = self._store.get_capture(capture_id, instance_id=self._instance_id)
        if capture is None:
            raise ApiError(
                status_code=404,
                code="capture_not_found",
                message=f"Capture not found: {capture_id}",
                details={"capture_id": capture_id},
            )
        return capture

    def get_detail(self, capture_id: str) -> CaptureDetail:
        """A capture enriched with its on-disk sidecars and pipeline reports."""
        capture = self.get(capture_id)
        capture_dir = self._layout.capture_dir(capture_id)
        manifest = read_object_manifest(capture_dir)
        record = read_record(capture_dir)
        return CaptureDetail(
            **capture.model_dump(),
            manifest=manifest.manifest.to_json() if manifest.manifest else None,
            record=record.record.to_json() if record.record else None,
            validation=self._report("fast_validation", capture_id),
            loss=self._report("loss_report", capture_id),
        )

    def _report(self, pipeline: str, capture_id: str) -> dict[str, Any] | None:
        return layout_mod.read_json(
            self._layout.report_dir(pipeline, capture_id) / "summary.json"
        )

    def has_report(self, pipeline: str, capture_id: str) -> bool:
        """Whether *pipeline* already produced a report for this capture."""
        return (
            self._layout.report_dir(pipeline, capture_id) / "summary.json"
        ).is_file()

    def list(
        self, limit: int, cursor: str | None = None, **filters: Any
    ) -> tuple[list[Capture], str | None]:
        """One page of captures plus the opaque next cursor."""
        parsed = _parse_cursor(cursor)
        items, next_seq = self._store.list_captures(
            limit, parsed, instance_id=self._instance_id, **filters
        )
        return items, (str(next_seq) if next_seq is not None else None)

    def list_present_terminal(self) -> list[Capture]:
        """Terminal captures whose bytes are on this host (validation targets)."""
        captures = self._store.list_by_states(
            sorted(TERMINAL_STATES), instance_id=self._instance_id
        )
        return [
            c
            for c in captures
            if c.replica is not None
            and c.replica.state
            in (ReplicaState.present_unverified, ReplicaState.present_verified)
        ]

    # ---- manifest reconciliation (§3, §8) ----------------------------------

    def adopt_manifest_facts(self, capture_id: str) -> bool:
        """Copy a terminal manifest's recording facts onto the row. ``True`` = changed.

        ``object_manifest.json`` is authoritative for what was recorded (§3);
        the row is a queryable cache of it. The stop path normally keeps the two
        in step, but it is not the only way a capture reaches a terminal state —
        a recorder killed mid-recording writes its own recovery manifest with
        RE-MEASURED counters, and nothing in the orchestrator was reading them.
        The row then kept the live session's ``bytes: 0`` while 10 MB of robot
        data sat on disk, and every UI surface called it empty. An operator who
        believes that discards it.

        Only a TERMINAL manifest is adopted: until finalise the recorder is
        still sole writer (§3.3), and its in-progress counters are less accurate
        than the ones the live session is reporting to us.

        Deliberately writes only the fields that differ, so a pass over an
        agreeing catalog costs nothing and the return value means "the catalog
        was wrong and is now right" rather than "I ran".
        """
        read = read_object_manifest(self._layout.capture_dir(capture_id))
        if read.status is not SidecarStatus.ok or read.manifest is None:
            return False
        manifest = read.manifest
        if manifest.state not in TERMINAL_STATES:
            return False
        capture = self._store.get_capture(capture_id)
        if capture is None:
            return False

        changes = _manifest_divergence(capture, manifest)
        if not changes:
            return False
        self._store.update_capture(capture_id, **changes)
        logger.info(
            "adopted the manifest's recording facts onto the catalog row",
            extra={"capture_id": capture_id, "fields": sorted(changes)},
        )
        return True

    # ---- review (§4.1) -----------------------------------------------------

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
        async with self._mutex(capture_id):
            capture = self.get(capture_id)
            self._reject_review_on_delete(capture)
            if capture.review_revision != request.base_revision:
                raise _review_conflict(capture, request.base_revision)

            merged = _merge_review(capture, request)
            _derive_quality(capture, request, merged)
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
                updated_at=utc_now_iso8601(),
            )
            capture_dir = self._layout.capture_dir(capture_id)
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
                    _write_record_sidecar,
                    capture_dir,
                    record,
                    allow_create=awaiting_transfer,
                )
            except _CaptureGoneError as exc:
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
            )
            if not applied:
                # Someone else won between our read and our write. The sidecar
                # we already wrote is deliberately NOT rolled back (§4.1-3):
                # rewriting it would race the winner's own sidecar, and a
                # sidecar ahead of the DB is the direction rebuild resolves.
                raise _review_conflict(self.get(capture_id), request.base_revision)

            saved = self.get(capture_id)

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

    # ---- delete (§7) -------------------------------------------------------

    async def delete(
        self, capture_id: str, *, kind: DeleteKind, reason: str | None
    ) -> Capture:
        """Discard or delete a capture through the trash pathway.

        Order is the contract: ledger, then ``delete_pending``, then the rename,
        then the tombstone, then the reaper. Every prefix of that sequence is
        resumable, which is why ``delete_pending`` is written *before* the
        rename — it is a durable marker of intent, not a record of a failure.
        """
        self._require_delete_available()
        async with self._mutex(capture_id):
            capture = self.get(capture_id)
            if capture.state in (CaptureState.discarded, CaptureState.deleted):
                # Already buried. Returning it beats a 404 or a second ledger
                # line for one operator action.
                return capture
            self._reject_active(capture)
            self._reject_leased(capture)
            self._reject_dataset_member(capture)

            self._append_tombstone(capture, kind=kind, reason=reason)
            self._store.update_capture(
                capture_id,
                state=CaptureState.delete_pending,
                deleted_at=utc_now_iso8601(),
                delete_kind=kind,
                delete_reason=reason,
            )
            await asyncio.to_thread(self._finish_delete, capture_id, kind)
            return self.get(capture_id)

    def _finish_delete(self, capture_id: str, kind: DeleteKind) -> None:
        """Steps 3-4: rename into ``.trash`` and confirm the tombstone.

        Idempotent, and called both by :meth:`delete` and by the resume paths.
        The three branches §7 names collapse into one here because
        :func:`layout.move_to_trash` already treats "nothing to move" as a
        successful no-op.
        """
        layout_mod.move_to_trash(self._layout, capture_id)
        final = CaptureState.discarded if kind == "discard" else CaptureState.deleted
        self._store.update_capture(capture_id, state=final)
        self._store.upsert_replica(capture_id, self._instance_id, ReplicaState.trashed)

    def reap(self, capture_id: str) -> bool:
        """Step 5: physically remove a trashed capture, verifying it is gone.

        Returns ``True`` once ``.trash/<capture_id>`` is verifiably absent, at
        which point the replica becomes ``absent_managed``. A capture whose
        bytes survive the removal keeps its ``trashed`` replica and is retried
        up to :data:`MAX_REAP_ATTEMPTS`; past that the condition is logged as a
        warning rather than retried forever (§7 step 5).

        The capture's ``report/<pipeline>/<capture_id>/`` directories go too.
        They are derived data — no ledger event, nothing to recover — but they
        are served by ``GET /api/v1/files``, so a surviving ``video_check`` mp4
        would let an operator watch a recording the UI told them was
        unrecoverable (§12). Their removal deliberately does NOT gate the return
        value: the replica state describes the capture's own bytes, and a report
        that will not delete is a different problem from a capture that will
        not, so conflating them would make one signal answer two questions.
        """
        if self._health.suspect:
            # §9-3: SUSPECT stops the reaper. If the volume is not what we think
            # it is, "delete these bytes" is the last instruction to obey.
            return False
        # Checked BEFORE the removal, not after it. §7 step 5 forbids an
        # unbounded retry loop, and counting attempts only on failure means the
        # reconciler re-walks the same undeletable tree on every pass forever —
        # the bound has to stop the work, not just the logging.
        # Report GC runs OUTSIDE the trash-attempt bound: the cap exists for
        # the capture's own bytes, and a stuck trash purge must not silently
        # stop report cleanup with it. purge_reports is idempotent and warns
        # on its own residue, so re-walking it per pass is the cheap, honest
        # behaviour — the operator's signal persists while the condition does.
        layout_mod.purge_reports(self._layout, capture_id)
        if self._reap_attempts.get(capture_id, 0) >= MAX_REAP_ATTEMPTS:
            return False

        purged = layout_mod.purge_from_trash(self._layout, capture_id)
        if purged:
            self._store.upsert_replica(
                capture_id, self._instance_id, ReplicaState.absent_managed
            )
            self._reap_attempts.pop(capture_id, None)
            return True
        attempts = self._reap_attempts.get(capture_id, 0) + 1
        self._reap_attempts[capture_id] = attempts
        if attempts >= MAX_REAP_ATTEMPTS:
            logger.warning(
                "trashed capture could not be removed after %d attempts; "
                "giving up and leaving the replica as trashed for an operator "
                "to inspect. Remaining: %s",
                attempts,
                [str(p) for p in layout_mod.trash_remnants(self._layout, capture_id)],
                extra={"capture_id": capture_id},
            )
        return False

    def reset_reap_attempts(self, capture_id: str) -> None:
        """Let a capture be reaped again after an operator intervened.

        The attempt bound is per-process and deliberately sticky, so this is the
        seam that clears it — a Repair, or a fresh delete of the same capture,
        means the condition that blocked the removal may be gone.
        """
        self._reap_attempts.pop(capture_id, None)

    async def resume_delete_pending(self) -> int:
        """Finish every ``delete_pending`` row (§7's three idempotent branches).

        Run on every startup, not only after a rebuild: a crash between the
        ledger append and the rename leaves a row here, and until it is
        finished the capture is neither usable nor gone.

        Each capture is finished under its own mutex, the same one a review save
        takes. Without it the resume and an in-flight ``PATCH .../review`` can
        interleave: the review writes ``record.json`` into ``objects/<id>`` just
        after the resume renamed that directory into ``.trash``, recreating the
        tree the deletion was in the middle of removing.
        """
        pending = self._store.list_by_states([CaptureState.delete_pending.value])
        for capture in pending:
            kind: DeleteKind = (
                "discard" if capture.delete_kind == "discard" else "delete"
            )
            async with self._mutex(capture.capture_id):
                await asyncio.to_thread(self._finish_delete, capture.capture_id, kind)
            logger.info(
                "resumed a delete that was interrupted",
                extra={"capture_id": capture.capture_id, "kind": kind},
            )
        return len(pending)

    async def resume_from_ledger(self) -> int:
        """Re-run the deletion for any tombstone whose bytes are still present.

        §7's startup pass. A crash after the ledger append but before the row
        was written leaves no ``delete_pending`` row at all, so scanning the
        database is not enough — the ledger is the only place that remembers the
        operator's intent. Idempotent: a capture already trashed does nothing.

        Held under the per-capture mutex for the same reason as
        :meth:`resume_delete_pending`: a concurrent review must not recreate the
        directory this is removing.
        """
        tombstones = ledger_v2.tombstones(self._layout.data_dir)
        resumed = 0
        for capture_id, event in tombstones.items():
            if not is_uuid7(capture_id):
                continue
            if not self._layout.capture_dir(capture_id).exists():
                continue
            kind: DeleteKind = (
                "discard" if event.get("kind") == "capture_discarded" else "delete"
            )
            reason = event.get("reason")
            async with self._mutex(capture_id):
                # Re-checked inside the mutex: a delete that completed while we
                # waited leaves nothing to resume.
                if not self._layout.capture_dir(capture_id).exists():
                    continue
                existing = self._store.get_capture(capture_id)
                if existing is None:
                    logger.warning(
                        "ledger records a deletion for a capture with no row; "
                        "completing the removal anyway",
                        extra={"capture_id": capture_id},
                    )
                else:
                    self._store.update_capture(
                        capture_id,
                        state=CaptureState.delete_pending,
                        deleted_at=event.get("at") or utc_now_iso8601(),
                        delete_kind=kind,
                        delete_reason=reason if isinstance(reason, str) else None,
                    )
                await asyncio.to_thread(self._finish_delete, capture_id, kind)
            resumed += 1
            logger.info(
                "resumed a deletion from the ledger",
                extra={"capture_id": capture_id, "kind": kind},
            )
        return resumed

    def _append_tombstone(
        self, capture: Capture, *, kind: DeleteKind, reason: str | None
    ) -> None:
        """Step 1: the ledger line, before anything is destroyed.

        Fatal on failure (§5), including out of disk — which is precisely when
        an operator is trying to discard captures to free space, so the append
        goes through the slack-release retry.
        """
        payload: dict[str, Any] = {}
        if reason:
            payload["reason"] = reason
        if capture.run_id:
            payload["run_id"] = capture.run_id
        try:
            ledger_v2.append_with_slack_release(
                self._layout.data_dir,
                _LEDGER_KIND[kind],
                instance_id=self._instance_id,
                capture_id=capture.capture_id,
                payload=payload,
            )
            self.ensure_ledger_slack()
        except OSError as exc:
            raise ApiError(
                status_code=503,
                code="ledger_unwritable",
                message=(
                    "The lifecycle ledger could not be written, so the deletion "
                    f"was not started: {exc}. Nothing was removed."
                ),
                details={"capture_id": capture.capture_id},
            ) from exc

    # ---- archive (§6) ------------------------------------------------------

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
        try:
            ledger_v2.append_with_slack_release(
                self._layout.data_dir,
                "capture_archived",
                instance_id=self._instance_id,
                capture_id=capture_id,
                payload=payload,
            )
        except OSError as exc:
            raise ApiError(
                status_code=503,
                code="ledger_unwritable",
                message=(
                    f"The archive copy at {target} succeeded but could not "
                    f"be recorded in the ledger: {exc}. The source was NOT "
                    "deleted; remove the copy or retry."
                ),
                details={"capture_id": capture_id},
            ) from exc

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

    # ---- retention (§10) ---------------------------------------------------

    def retention_candidates(
        self, retention_days: int, *, now: datetime | None = None
    ) -> tuple[list[RetentionCandidate], int]:
        """Captures the operator may want to reclaim. Advisory only.

        The v1 definition ("a row exists, therefore it was never exported") is
        gone: §6 keeps the row forever, so it would now match everything. A
        candidate is instead a capture that **no dataset cites**, whose review
        left it ``pending`` or ``excluded``, and which is older than
        ``RETENTION_DAYS``. Nothing here deletes; deletion goes through the
        confirmed ``POST /captures/{id}/delete``.
        """
        if retention_days <= 0:
            return [], 0
        cutoff = (now or datetime.now(UTC)) - timedelta(days=retention_days)
        captures = self._store.list_by_states(
            sorted(TERMINAL_STATES), instance_id=self._instance_id
        )
        candidates: list[RetentionCandidate] = []
        total = 0
        for capture in captures:
            if capture.review_status not in ("pending", "excluded"):
                continue
            if self._store.dataset_memberships_for(capture.capture_id):
                continue
            started = _parse_iso8601(capture.started_at)
            if started is None or started >= cutoff:
                continue
            size = layout_mod.dir_bytes(self._layout.capture_dir(capture.capture_id))
            if size is not None:
                total += size
            candidates.append(
                RetentionCandidate(
                    capture_id=capture.capture_id,
                    run_id=capture.run_id,
                    started_at=capture.started_at,
                    bytes=size,
                    state=capture.state,
                    review_status=capture.review_status,
                )
            )
        return candidates, total

    # ---- guards ------------------------------------------------------------

    def ensure_ledger_slack(self) -> bool:
        """Re-reserve the 1 MB ENOSPC slack if it has been spent (§5).

        The slack is a one-shot: ``append_with_slack_release`` deletes it to buy
        the few hundred bytes a tombstone needs on a full disk. Without this the
        FIRST discard on a full disk works and every one after it fails — which
        is precisely backwards, because an operator freeing space discards
        several captures in a row.

        Called after each successful delete and from the reconciler. Returns
        whether the reservation now exists; a failure is logged, not raised, so
        it can never turn a completed deletion into an error.
        """
        try:
            ledger_v2.ensure_slack(self._layout.data_dir)
        except OSError as exc:
            logger.warning(
                "could not re-reserve the ledger slack; the next discard on a "
                "full disk may fail to append: %s",
                exc,
            )
            return False
        return True

    def _membership_blocks(self, dataset_id: str) -> bool:
        """Whether this membership pins the capture's local bytes (§6.1)."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            return True  # an unknown dataset is not a licence to delete
        return not (
            dataset["status"] == "archived" and dataset.get("archive_mode") == "copy"
        )

    def _reject_overlapping_destination(self, target: Path, source: Path) -> None:
        reject_overlapping_destination(target, source, self._layout.data_dir)

    def _require_delete_available(self) -> None:
        if self._health.delete_available:
            return
        raise ApiError(
            status_code=503,
            code="delete_unavailable",
            message=(
                "Deleting is not available on this deployment: "
                f"{self._health.delete_unavailable_reason}"
            ),
        )

    @staticmethod
    def _reject_active(capture: Capture) -> None:
        if capture.state in (CaptureState.recording, CaptureState.stopping):
            raise ApiError(
                status_code=409,
                code="capture_recording",
                message=(
                    f"{capture.capture_id} is still {capture.state}; "
                    "stop the recording first."
                ),
                details={
                    "capture_id": capture.capture_id,
                    "state": str(capture.state),
                },
            )

    def _reject_leased(self, capture: Capture) -> None:
        if not self._store.has_live_lease(capture.capture_id):
            return
        raise ApiError(
            status_code=409,
            code="capture_busy",
            message=(
                f"{capture.lease_owner} is working on {capture.capture_id} "
                f"until {capture.lease_expires_at}; try again after that."
            ),
            details={
                "capture_id": capture.capture_id,
                "lease_owner": capture.lease_owner,
                "lease_expires_at": capture.lease_expires_at,
            },
        )

    def _reject_dataset_member(
        self, capture: Capture, *, except_dataset: str | None = None
    ) -> None:
        """Refuse while any dataset cites this capture (§7).

        ``except_dataset`` is the one scoped relaxation: a dataset archive run
        (§6.x) may remove its OWN members' bytes — that dataset is leaving
        ``views/`` as a whole — but membership of any other dataset still
        refuses. Every HTTP route passes ``None``; only the runner's
        :meth:`archive_member` names its dataset.

        A membership in a COPY-SEALED dataset (archived, mode ``copy``) does
        not block: that dataset is a historical record whose export is already
        complete and verified elsewhere, and letting it pin the local bytes
        forever would make "seal a combined set, keep working" a trap — the
        member set is frozen, so the membership could never be removed to
        unblock the delete.
        """
        memberships = [
            m
            for m in self._store.dataset_memberships_for(capture.capture_id)
            if m.dataset_id != except_dataset and self._membership_blocks(m.dataset_id)
        ]
        if not memberships:
            return
        raise ApiError(
            status_code=400,
            code="capture_in_dataset",
            message=(
                f"{capture.capture_id} belongs to "
                f"{len(memberships)} dataset(s); remove it from them first."
            ),
            details={
                "capture_id": capture.capture_id,
                "dataset_ids": [m.dataset_id for m in memberships],
            },
        )


class _CaptureGoneError(RuntimeError):
    """``objects/<capture_id>`` is absent and must not be recreated."""


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


def _manifest_divergence(
    capture: Capture, manifest: ObjectManifestV2
) -> dict[str, Any]:
    """The recording facts where the row disagrees with a terminal manifest.

    A ``None`` on the manifest is treated as "not measured", never as "zero":
    an older recorder that did not record a message count must not blank a
    count the live session did observe. The exception is ``error``, where the
    manifest saying nothing IS the statement that the recording ended cleanly —
    so a stale sync error on the row is cleared.
    """
    changes: dict[str, Any] = {}
    if str(capture.state) != manifest.state:
        changes["state"] = CaptureState(manifest.state)
    for field, value in (
        ("ended_at", manifest.ended_at),
        ("bytes", manifest.bytes),
        ("message_count", manifest.message_count),
        ("started_at", manifest.started_at),
        ("operator", manifest.operator),
        ("task", manifest.task),
        ("robot", manifest.robot),
    ):
        if value is not None and getattr(capture, field) != value:
            changes[field] = value

    manifest_error = coerce_error(manifest.error)
    if capture.error != manifest_error:
        # Whatever the recorder wrote wins, including nothing at all. The
        # generic "No active recorder session found." the status-poll path
        # leaves behind is exactly the message that should lose to the
        # recorder's own "recorder restarted while the capture was recording".
        #
        # This deliberately also clears a row-side ``manifest_corrupt``: we can
        # only be here because the file on disk read back as a valid TERMINAL
        # manifest (a corrupt one adopts nothing), so the on-disk file is the
        # truth and the HTTP-side complaint was transient. Keeping the stale
        # complaint once the file verifiably reads clean would be the lie.
        changes["error"] = manifest_error

    manifest_topics = [CaptureTopic.model_validate(t) for t in manifest.topics]
    if manifest_topics and capture.topics != manifest_topics:
        changes["topics"] = manifest_topics
    if manifest.compression and str(capture.compression) != manifest.compression:
        changes["compression"] = Compression(manifest.compression)
    if manifest.split and (
        capture.split is None or capture.split.model_dump() != manifest.split
    ):
        changes["split"] = Split.model_validate(manifest.split)
    return changes


def _write_record_sidecar(
    capture_dir: Path, record: RecordV2, *, allow_create: bool
) -> None:
    """Write ``record.json``, creating the capture directory only if allowed.

    A split deployment reviews a capture on the recording PC *before* the bytes
    arrive from the robot — the auto-pull is triggered BY the first review save
    — so "no local copy yet" is a normal state, and for those captures the
    directory is created and later merged by ``transfer.adopt_incoming``.

    ``allow_create=False`` is the delete path's guard. Recreating the directory
    for a capture that is being removed would resurrect a tree the reaper has
    already walked past, and the next rebuild would then report a capture with
    no manifest. The caller decides under the per-capture mutex; this function
    only refuses to be the thing that silently recreates it.
    """
    if not capture_dir.is_dir():
        if not allow_create:
            raise _CaptureGoneError(f"{capture_dir} does not exist")
        capture_dir.mkdir(parents=True, exist_ok=True)
    write_record(capture_dir, record)


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


def _require_capture_id(capture_id: str) -> None:
    """Reject anything that is not a UUIDv7 before it becomes a path segment."""
    if not is_uuid7(capture_id):
        raise ApiError(
            status_code=404,
            code="capture_not_found",
            message=f"Not a capture id: {capture_id}",
            details={"capture_id": capture_id},
        )


def _parse_cursor(cursor: str | None) -> int | None:
    if cursor is None:
        return None
    try:
        return int(cursor)
    except ValueError as exc:
        raise ApiError(
            status_code=400,
            code="invalid_cursor",
            message="cursor must be an opaque token from a prior page.",
        ) from exc


def _parse_iso8601(value: str | None) -> datetime | None:
    """Parse a UTC ISO8601 stamp (``None`` when absent or unparseable)."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed


__all__ = ["MAX_REAP_ATTEMPTS", "CaptureService", "UNFINALIZED_STATES"]
