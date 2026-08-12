# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""§7: discarding and deleting a capture, and the resume paths that finish one.

**Deletion writes the ledger first** (§7 step 1, §9-1). The ledger line is
appended before any byte moves, so the recoverable failure is "the ledger claims
a deletion that has not finished" — which the resume path completes. The other
direction loses the fact that an operator deliberately destroyed data, and a
later transfer would quietly bring it back.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Any

from kairos_common import ledger_v2
from kairos_common.capture_sidecars import CaptureState
from kairos_common.ids import is_uuid7
from kairos_common.rebuild import ReplicaState
from kairos_common.time import utc_now_iso8601

from api_orchestrator import layout as layout_mod
from api_orchestrator.ledger_guard import append_or_503
from api_orchestrator.models import Capture, DeleteKind

if TYPE_CHECKING:
    from api_orchestrator.health import StoreHealth
    from api_orchestrator.layout import DataLayout
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


class CaptureDeletionMixin:
    """The §7 delete pathway, mixed into ``CaptureService``.

    Not usable on its own. The host supplies the collaborators annotated below,
    plus ``get()``, ``_mutex()``, ``ensure_ledger_slack()`` and the guards every
    mutating path runs first (``_require_delete_available``, ``_reject_active``,
    ``_reject_leased``, ``_reject_dataset_member``).
    """

    _store: CaptureStore
    _layout: DataLayout
    _health: StoreHealth
    _instance_id: str
    _reap_attempts: dict[str, int]

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
        append_or_503(
            self._layout.data_dir,
            _LEDGER_KIND[kind],
            instance_id=self._instance_id,
            capture_id=capture.capture_id,
            payload=payload,
            failure=lambda exc: (
                "The lifecycle ledger could not be written, so the deletion "
                f"was not started: {exc}. Nothing was removed."
            ),
            details={"capture_id": capture.capture_id},
        )
        # Outside the guard on purpose: it never raises OSError (it logs and
        # returns False), so it was only ever inside the old try by proximity.
        self.ensure_ledger_slack()


__all__ = ["MAX_REAP_ATTEMPTS", "CaptureDeletionMixin"]
