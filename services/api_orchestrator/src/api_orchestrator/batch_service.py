"""Collect batches: database rows plus ledger events (§8).

A batch's row used to be the only record it ever existed. It has no sidecar —
the recordings carry ``batch_id`` and ``index_in_batch`` in theirs and nothing
else — so "delete kairos.db and restart", which `capture_store.md` promises is
always safe, silently lost every batch while the recordings came back still
naming one. That made batches an undocumented exception to the store's central
invariant, and it let a NEW batch minted in the same second inherit a dead
one's id.

So a batch is now a lifecycle fact in the ledger, like a dataset. **Three event
kinds, because what a batch IS and what happens to it later are different
facts**: ``batch_created`` (the creation facts, including the daily number that
was allocated), ``batch_updated`` (the complete label set after each edit, so
replay order alone reconstructs it) and ``batch_ended`` (status, reason, when).

**``batch_created`` deliberately carries no status.** Every batch is ``active``
when it is created, so a status field there would say nothing on the way in and
would be believed on the way out — reconstructing a finished batch as an open
one, which is a new wrong answer rather than a fix.

**Row first, then the ledger**, the same ordering (and rollback) as adding a
dataset member: the row is where uniqueness is enforced, so it has to be
claimed before the event describing it can be honest.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from kairos_common import ApiError, ledger_v2

from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Batch
from api_orchestrator.store import BatchExistsError, CaptureStore

logger = logging.getLogger("kairos")

# Fields an edit may change. Every one of them is written on every
# ``batch_updated`` event, complete rather than as a diff: a replay then needs
# only the last one, and a lost line cannot leave a half-applied edit.
EDITABLE_FIELDS = ("project", "task", "condition", "target_episodes")


@dataclass(frozen=True)
class BatchReplayReport:
    """What one batch replay rebuilt, and what an operator has to be told."""

    restored: int
    warnings: tuple[str, ...] = ()


class BatchService:
    """Create, edit and end batches; rebuild them all from history."""

    def __init__(
        self, store: CaptureStore, layout: DataLayout, *, instance_id: str
    ) -> None:
        self._store = store
        self._layout = layout
        self._instance_id = instance_id

    # ---- writes ------------------------------------------------------------

    def create(self, batch: Batch) -> Batch:
        """Insert a batch and record it. Raises :class:`BatchExistsError`.

        The caller owns id allocation and its retry, because "that id is taken"
        is answered by the store — including by a recording that still names an
        id whose batch a rebuild could not restore.
        """
        created = self._store.create_batch(batch)
        payload: dict[str, Any] = {
            "batch_id": created.batch_id,
            "batch_seq": created.batch_seq,
            "project": created.project,
            "task": created.task,
            "target_episodes": created.target_episodes,
            "created_at": created.created_at,
        }
        for key, value in (
            ("robot", created.robot),
            ("condition", created.condition),
            ("operator", created.operator),
        ):
            if value is not None:
                payload[key] = value
        try:
            self._append("batch_created", payload)
        except ApiError:
            # Undo the row: an unrecorded batch would come back as nothing on
            # the next rebuild while its id stayed taken, which is the state
            # this whole change exists to remove.
            self._store.delete_batch(created.batch_id)
            raise
        return created

    def update(self, batch_id: str, fields: dict[str, Any]) -> Batch:
        """Apply an edit and record it. Raises ``KeyError`` if it is gone.

        An edit that ends the batch writes ``batch_ended`` as well as (or
        instead of) ``batch_updated``: they answer different questions and a
        replay applies them in order.
        """
        updated = self._store.update_batch(batch_id, **fields)
        if any(field in fields for field in EDITABLE_FIELDS):
            self._append(
                "batch_updated",
                {
                    "batch_id": batch_id,
                    "project": updated.project,
                    "task": updated.task,
                    "condition": updated.condition,
                    "target_episodes": updated.target_episodes,
                },
            )
        if "status" in fields:
            self._append(
                "batch_ended",
                {
                    "batch_id": batch_id,
                    "status": str(updated.status),
                    "ended_reason": updated.ended_reason,
                    "ended_at": updated.ended_at,
                },
            )
        return updated

    # ---- rebuild (§8) ------------------------------------------------------

    def restore_from_ledger(self) -> BatchReplayReport:
        """Rebuild every batch by replaying the ledger.

        Idempotent by construction, which is the E-29 lesson applied: every
        value written here is read from an event rather than computed from the
        row it is about to touch, so a second pass over the same ledger lands
        on the same numbers. ``KAIROS_REBUILD=1`` replays onto a live database,
        and a ``batch_seq`` re-allocated per pass would climb on every one.

        A ledger with no batch events rebuilds nothing and raises nothing:
        every installation older than this event takes exactly that path, and
        the batches it cannot restore are reported by the orphan check instead.

        Every batch that IS restored comes back with ``episodes_recorded`` at
        zero, because that counter counts review saves — events, not facts —
        and the ledger records facts. The right call for the ledger, and the
        wrong thing to leave silent: an operator watching `12 / 30` become
        `0 / 30` needs the reason on screen, not in a spec. Hence the warning.
        """
        restored: list[str] = []
        collisions: list[str] = []
        for event in ledger_v2.batch_events(self._layout.data_dir):
            batch_id = event.get("batch_id")
            if not isinstance(batch_id, str) or not batch_id:
                continue
            kind = event.get("kind")
            if kind == "batch_created":
                batch = _batch_from_event(batch_id, event)
                if self._store.restore_batch(batch):
                    restored.append(batch_id)
                else:
                    collisions.extend(self._compare_existing(batch))
            elif kind == "batch_updated":
                self._apply(batch_id, dict(_editable_from_event(event)))
            elif kind == "batch_ended":
                self._apply(
                    batch_id,
                    {
                        "status": event.get("status"),
                        "ended_reason": event.get("ended_reason"),
                        "ended_at": event.get("ended_at"),
                    },
                )
        return BatchReplayReport(
            restored=len(restored),
            warnings=_counter_warning(restored) + tuple(collisions),
        )

    def _compare_existing(self, batch: Batch) -> list[str]:
        """Whether a row that was already there is the SAME batch.

        ``restore_batch`` ignores an insert whose id is taken, which is right
        for a replay running twice over one ledger — the row is the same batch
        and re-writing it would be busywork. It is NOT right if two
        ``batch_created`` lines share an id and describe different batches:
        the second would vanish with nothing said. No live path can produce
        that (the id guard refuses a taken id), so this is here to make a
        future bug visible rather than to handle a case that exists.
        """
        existing = self._store.get_batch(batch.batch_id)
        if existing is None:
            return []
        differing = [
            field
            for field in ("project", "task", "created_at", "batch_seq")
            if getattr(existing, field) != getattr(batch, field)
        ]
        if not differing:
            return []
        return [
            f"two batch_created lines share the id {batch.batch_id} and "
            f"disagree about {', '.join(differing)}; only the first was "
            "rebuilt, so one batch is missing from the catalog"
        ]

    def _apply(self, batch_id: str, fields: dict[str, Any]) -> None:
        """Apply a replayed edit, skipping a batch whose creation line is lost."""
        usable = {k: v for k, v in fields.items() if v is not None}
        if not usable:
            return
        try:
            self._store.update_batch(batch_id, **usable)
        except KeyError:
            # The creation line never made it (a truncated head). Inventing the
            # batch from an edit would give it a number nobody allocated, so
            # the edit is dropped and the recordings that name it are reported
            # as orphaned — the same answer an older ledger gets.
            logger.warning(
                "batch event names a batch with no creation line; skipped",
                extra={"batch_id": batch_id},
            )

    # ---- helpers -----------------------------------------------------------

    def _append(self, kind: str, payload: dict[str, Any]) -> None:
        try:
            ledger_v2.append_with_slack_release(
                self._layout.data_dir,
                kind,
                instance_id=self._instance_id,
                payload={k: v for k, v in payload.items() if v is not None},
            )
        except OSError as exc:
            raise ApiError(
                status_code=503,
                code="ledger_unwritable",
                message=(
                    f"The lifecycle ledger could not be written ({exc}), so the "
                    "batch change was not applied. A batch that is not in the "
                    "ledger does not survive a rebuild, and its id stays taken."
                ),
            ) from exc


def _counter_warning(restored: list[str]) -> tuple[str, ...]:
    """Say that the restored batches came back without their episode counts."""
    if not restored:
        return ()
    shown = ", ".join(restored[:5])
    if len(restored) > 5:
        shown += f", and {len(restored) - 5} more"
    return (
        f"{len(restored)} batch(es) were rebuilt from the ledger and their "
        f"recorded-episode counters start again at 0 ({shown}). That count is "
        "not in the ledger — it counts review saves rather than facts — so a "
        "batch's 'N / target' can read lower than before this rebuild.",
    )


def _editable_from_event(event: dict[str, Any]) -> dict[str, Any]:
    return {field: event.get(field) for field in EDITABLE_FIELDS}


def _batch_from_event(batch_id: str, event: dict[str, Any]) -> Batch:
    """A creation event back into a row. Status is always the opening one."""
    target = event.get("target_episodes")
    seq = event.get("batch_seq")
    return Batch(
        batch_id=batch_id,
        robot=_opt_str(event.get("robot")),
        project=str(event.get("project") or ""),
        task=str(event.get("task") or ""),
        condition=_opt_str(event.get("condition")),
        operator=_opt_str(event.get("operator")),
        target_episodes=target if isinstance(target, int) else 30,
        status="active",
        created_at=_opt_str(event.get("created_at")) or _opt_str(event.get("at")),
        batch_seq=seq if isinstance(seq, int) else None,
    )


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


__all__ = ["BatchExistsError", "BatchService"]
