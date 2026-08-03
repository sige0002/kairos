"""Logical datasets: database rows plus ledger events, and nothing on disk.

Contract §6. A dataset used to be a directory tree that recordings were *moved*
into, which made "which dataset is this episode in" a question about the
filesystem and made an interrupted export lose data outright. Now a dataset is a
row, a membership is a row, and the browsable ``views/`` tree is generated from
both (see ``views.py``).

**Every dataset fact is also a ledger event, and the append is fatal.** That is
not bookkeeping: ``display_index`` must never be reused after a member is
removed (§6), and the only durable record that number 3 was once issued is the
``dataset_member_added`` line — the member row itself is gone. So a failed
append fails the request, and :func:`restore_from_ledger` can rebuild both the
memberships and the high-water mark from history alone.

**The ordering differs by direction, on purpose.** Adding writes the row first
(the row is where uniqueness is enforced, and a number allocated but never used
is harmless because numbers are never reused anyway) and rolls it back if the
append fails. Removing and deleting write the ledger first, because after those
the row is gone and there is nothing left to write the event from.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from kairos_common import ApiError, ledger_v2
from kairos_common.ids import new_dataset_id
from kairos_common.time import utc_now_iso8601

from api_orchestrator.layout import DataLayout, is_reserved_name
from api_orchestrator.models import (
    Dataset,
    DatasetDetail,
    DatasetMember,
    DatasetUpdateRequest,
)
from api_orchestrator.store import CaptureStore, DatasetMemberExistsError

logger = logging.getLogger("kairos")


class DatasetService:
    """Create datasets, move captures in and out, and rebuild both from history.

    Every mutation that changes what ``views/`` should contain schedules a
    regeneration. The frontend does not own that: a browsable tree that only
    matches the catalog when somebody remembered to press refresh is a tree
    nobody can trust, and the regeneration is a symlink flip cheap enough to
    run on each change (§6).
    """

    def __init__(
        self,
        store: CaptureStore,
        layout: DataLayout,
        *,
        instance_id: str,
        on_change: Callable[[], None] | None = None,
    ) -> None:
        self._store = store
        self._layout = layout
        self._instance_id = instance_id
        self._on_change = on_change

    def _views_changed(self) -> None:
        """Signal that the generated tree is now stale.

        Best-effort and never fatal: the dataset change is already committed to
        the database and the ledger, and failing the request because a symlink
        tree could not be rebuilt would refuse an operation that actually
        succeeded. ``POST /api/v1/views/refresh`` remains the manual repair.
        """
        if self._on_change is None:
            return
        try:
            self._on_change()
        except Exception:  # noqa: BLE001 - a stale views tree is not a failure
            logger.warning("could not schedule a views refresh", exc_info=True)

    # ---- reads -------------------------------------------------------------

    def list(self) -> list[Dataset]:
        return [_dataset(row) for row in self._store.list_datasets()]

    def get(self, dataset_id: str) -> DatasetDetail:
        row = self._store.get_dataset(dataset_id)
        if row is None:
            raise _not_found(dataset_id)
        members = self._store.list_dataset_members(dataset_id)
        return DatasetDetail(
            **_dataset(row, member_count=len(members)).model_dump(),
            members=members,
        )

    # ---- writes ------------------------------------------------------------

    def create(self, *, name: str, operator: str | None, task: str | None) -> Dataset:
        """Create a dataset. The ledger event is written after the row."""
        self._reject_reserved(operator, task, name)
        dataset_id = new_dataset_id()
        created_at = utc_now_iso8601()
        self._store.create_dataset(
            dataset_id,
            name=name,
            operator=operator,
            task=task,
            created_at=created_at,
        )
        try:
            self._append(
                "dataset_created",
                {
                    "dataset_id": dataset_id,
                    "name": name,
                    "operator": operator,
                    "task": task,
                },
            )
        except ApiError:
            self._store.delete_dataset(dataset_id)
            raise
        self._views_changed()
        return Dataset(
            dataset_id=dataset_id,
            name=name,
            operator=operator,
            task=task,
            created_at=created_at,
        )

    def update(self, dataset_id: str, request: DatasetUpdateRequest) -> Dataset:
        """Edit the three labels (§6). The identity is dataset_id; names move.

        Active datasets only: an archived dataset's labels are baked into the
        folder its archive run wrote, and editing the record out from under
        the folder would make the two disagree about what left.
        """
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise _not_found(dataset_id)
        self._require_active(dataset)
        supplied = request.model_fields_set
        name = request.name if "name" in supplied else dataset["name"]
        if not name or not str(name).strip():
            raise ApiError(
                status_code=400,
                code="invalid_name",
                message="A dataset cannot lose its name; give it a new one.",
                details={"dataset_id": dataset_id},
            )
        operator = request.operator if "operator" in supplied else dataset["operator"]
        task = request.task if "task" in supplied else dataset["task"]
        self._reject_reserved(operator, task, name)

        changed = (name, operator, task) != (
            dataset["name"],
            dataset["operator"],
            dataset["task"],
        )
        if changed:
            # Row first, rollback on append failure — the add-side ordering:
            # nothing is destroyed by a rename, and the ledger line is what
            # makes it survive a rebuild.
            self._store.update_dataset_labels(
                dataset_id, name=name, operator=operator, task=task
            )
            try:
                self._append(
                    "dataset_updated",
                    {
                        "dataset_id": dataset_id,
                        "name": name,
                        "operator": operator,
                        "task": task,
                    },
                )
            except ApiError:
                self._store.update_dataset_labels(
                    dataset_id,
                    name=dataset["name"],
                    operator=dataset["operator"],
                    task=dataset["task"],
                )
                raise
            # The labels are the views path: <operator>/<task>/<name>/NNN.
            self._views_changed()
        row = self._store.get_dataset(dataset_id)
        assert row is not None
        members = self._store.list_dataset_members(dataset_id)
        return _dataset(row, member_count=len(members))

    def delete(self, dataset_id: str) -> None:
        """Delete a dataset and its memberships. No capture is touched."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise _not_found(dataset_id)
        if dataset["status"] == "archiving":
            raise ApiError(
                status_code=409,
                code="dataset_archiving",
                message=(
                    "This dataset is being archived; let the run finish or "
                    "resume it. Deleting the record mid-run would orphan the "
                    "copy in progress."
                ),
                details={"dataset_id": dataset_id},
            )
        if dataset["status"] == "archived":
            # The row is the queryable cache of the ledger's migration log —
            # the same "rows are never deleted" principle capture tombstones
            # follow. Delete it and "where did this dataset go" has no answer
            # short of replaying the ledger by hand.
            raise ApiError(
                status_code=409,
                code="dataset_archived",
                message=(
                    "This dataset was archived to "
                    f"{dataset.get('archive_destination') or 'an external folder'}; "
                    "its record is what remembers that and is kept."
                ),
                details={
                    "dataset_id": dataset_id,
                    "archive_destination": dataset.get("archive_destination"),
                },
            )
        # Ledger first: after the row is gone there is nothing left to describe
        # the deletion from.
        self._append("dataset_deleted", {"dataset_id": dataset_id})
        self._store.delete_dataset(dataset_id)
        self._views_changed()

    def add_member(self, dataset_id: str, capture_id: str) -> DatasetMember:
        """Add a capture to a dataset, allocating the next unused number."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise _not_found(dataset_id)
        self._require_active(dataset)
        capture = self._store.get_capture(capture_id)
        if capture is None:
            raise ApiError(
                status_code=404,
                code="capture_not_found",
                message=f"Capture not found: {capture_id}",
                details={"capture_id": capture_id},
            )
        if capture.archived_at is not None:
            # Its bytes left this machine. A membership would put a permanent
            # hole in views/ via the regenerator's missing-source skip.
            raise ApiError(
                status_code=409,
                code="capture_archived",
                message=(
                    f"{capture_id} was archived to "
                    f"{capture.archive_destination or 'an external folder'} "
                    "and has no local bytes to include."
                ),
                details={
                    "capture_id": capture_id,
                    "archive_destination": capture.archive_destination,
                },
            )
        for membership in self._store.dataset_memberships_for(capture_id):
            other = self._store.get_dataset(membership.dataset_id)
            if other is not None and other["status"] != "active":
                # The other dataset's archive run is going to move (or already
                # moved) this capture's bytes away; a new membership would cite
                # bytes that are leaving — the very dangling reference the §7
                # member guard exists to prevent.
                raise ApiError(
                    status_code=409,
                    code="capture_archiving",
                    message=(
                        f"{capture_id} belongs to dataset "
                        f"{other.get('name') or membership.dataset_id}, which is "
                        f"{other['status']}; its bytes are leaving this machine."
                    ),
                    details={
                        "capture_id": capture_id,
                        "dataset_id": membership.dataset_id,
                        "status": other["status"],
                    },
                )
        try:
            member = self._store.add_dataset_member(dataset_id, capture_id)
        except DatasetMemberExistsError as exc:
            raise ApiError(
                status_code=409,
                code="dataset_member_exists",
                message=f"{capture_id} is already in this dataset.",
                details={"dataset_id": dataset_id, "capture_id": capture_id},
            ) from exc
        try:
            self._append(
                "dataset_member_added",
                {
                    "dataset_id": dataset_id,
                    "membership_id": member.membership_id,
                    "display_index": member.display_index,
                    "operator": dataset.get("operator"),
                    "task": dataset.get("task"),
                    "dataset_name": dataset.get("name"),
                },
                # The envelope's own field, not the payload: the ledger reserves
                # capture_id so no caller can write a second, disagreeing copy
                # of it beside the one every reader looks at.
                capture_id=capture_id,
            )
        except ApiError:
            # Undo the membership, but NOT the high-water mark: the number was
            # issued, and re-issuing it after a failure is exactly the reuse
            # §6 forbids.
            self._store.remove_dataset_member(dataset_id, member.membership_id)
            raise
        self._views_changed()
        return member

    def remove_member(self, dataset_id: str, membership_id: str) -> None:
        """Remove one member. Its display_index stays retired forever."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise _not_found(dataset_id)
        self._require_active(dataset)
        member = self._store.get_dataset_member(membership_id)
        if member is None or member.dataset_id != dataset_id:
            raise ApiError(
                status_code=404,
                code="dataset_member_not_found",
                message=f"No member {membership_id} in dataset {dataset_id}.",
                details={"dataset_id": dataset_id, "membership_id": membership_id},
            )
        self._append(
            "dataset_member_removed",
            {"dataset_id": dataset_id, "membership_id": membership_id},
        )
        self._store.remove_dataset_member(dataset_id, membership_id)
        self._views_changed()

    # ---- rebuild (§8) ------------------------------------------------------

    def restore_from_ledger(self) -> dict[str, int]:
        """Rebuild datasets and memberships by replaying the ledger.

        Order is the whole value here: ``member_added`` followed by
        ``member_removed`` for the same number is what says that number is
        *retired* rather than free, and a set-based reconstruction would lose
        exactly that distinction.
        """
        counts = {
            "datasets": 0,
            "members": 0,
            "removed": 0,
            "deleted": 0,
            "archiving": 0,
            "archived": 0,
        }
        for event in ledger_v2.dataset_events(self._layout.data_dir):
            kind = event.get("kind")
            dataset_id = event.get("dataset_id")
            if not isinstance(dataset_id, str) or not dataset_id:
                continue
            if kind == "dataset_created":
                if self._store.get_dataset(dataset_id) is None:
                    self._store.create_dataset(
                        dataset_id,
                        name=str(event.get("name") or dataset_id),
                        operator=_opt_str(event.get("operator")),
                        task=_opt_str(event.get("task")),
                        created_at=_opt_str(event.get("at")),
                    )
                    counts["datasets"] += 1
            elif kind == "dataset_updated":
                name = event.get("name")
                if isinstance(name, str) and name:
                    if self._store.get_dataset(dataset_id) is None:
                        # A rename whose dataset_created line sits in a lost
                        # ledger head — the full label set it carries is enough
                        # to re-create the row (same rescue as memberships).
                        self._store.create_dataset(
                            dataset_id,
                            name=name,
                            operator=_opt_str(event.get("operator")),
                            task=_opt_str(event.get("task")),
                            created_at=_opt_str(event.get("at")),
                        )
                    else:
                        self._store.update_dataset_labels(
                            dataset_id,
                            name=name,
                            operator=_opt_str(event.get("operator")),
                            task=_opt_str(event.get("task")),
                        )
            elif kind == "dataset_member_added":
                counts["members"] += self._replay_member_added(dataset_id, event)
            elif kind == "dataset_member_removed":
                membership_id = event.get("membership_id")
                if isinstance(membership_id, str):
                    if self._store.remove_dataset_member(dataset_id, membership_id):
                        counts["removed"] += 1
            elif kind == "dataset_deleted":
                if self._store.delete_dataset(dataset_id):
                    counts["deleted"] += 1
            elif kind == "dataset_archive_started":
                counts["archiving"] += self._replay_archive_started(dataset_id, event)
            elif kind == "dataset_archived":
                self._ensure_dataset_row(dataset_id, event)
                self._store.mark_dataset_archived(
                    dataset_id, at=_opt_str(event.get("at"))
                )
                counts["archived"] += 1
        return counts

    def _replay_archive_started(self, dataset_id: str, event: dict[str, Any]) -> int:
        """Replay one frozen archive start (§6.x).

        A run that never reached its seal comes back as ``archiving`` — the
        operator resumes it, nobody restarts it from scratch. The event is
        self-contained enough to rebuild the row and every member, because
        after the archive the members' bytes are gone and their
        ``dataset_member_added`` lines may sit in a lost ledger head.
        """
        destination = event.get("destination")
        if not isinstance(destination, str) or not destination:
            return 0
        self._ensure_dataset_row(dataset_id, event)
        members = event.get("members")
        for entry in members if isinstance(members, list) else []:
            if not isinstance(entry, dict):
                continue
            self._replay_member_added(
                dataset_id,
                {
                    "membership_id": entry.get("membership_id"),
                    "capture_id": entry.get("capture_id"),
                    "display_index": entry.get("display_index"),
                    "dataset_name": event.get("dataset_name"),
                    "operator": event.get("operator"),
                    "task": event.get("task"),
                    "at": event.get("at"),
                },
            )
        self._store.mark_dataset_archiving(
            dataset_id, destination=destination, at=_opt_str(event.get("at"))
        )
        return 1

    def _ensure_dataset_row(self, dataset_id: str, event: dict[str, Any]) -> None:
        """Create the row an archive event implies, if nothing else did."""
        if self._store.get_dataset(dataset_id) is not None:
            return
        self._store.create_dataset(
            dataset_id,
            name=str(event.get("dataset_name") or dataset_id),
            operator=_opt_str(event.get("operator")),
            task=_opt_str(event.get("task")),
            created_at=_opt_str(event.get("at")),
        )

    def _replay_member_added(self, dataset_id: str, event: dict[str, Any]) -> int:
        membership_id = event.get("membership_id")
        capture_id = event.get("capture_id")
        display_index = event.get("display_index")
        if not isinstance(membership_id, str) or not isinstance(capture_id, str):
            return 0
        if not isinstance(display_index, int) or isinstance(display_index, bool):
            return 0
        if self._store.get_dataset(dataset_id) is None:
            # A membership whose dataset_created line is missing (a truncated
            # ledger tail). Recreate the dataset from what the membership event
            # carries rather than dropping the member.
            self._store.create_dataset(
                dataset_id,
                name=str(event.get("dataset_name") or dataset_id),
                operator=_opt_str(event.get("operator")),
                task=_opt_str(event.get("task")),
                created_at=_opt_str(event.get("at")),
            )
        # Raise the watermark even if the insert below fails: the number was
        # issued once and must never be issued again.
        self._store.set_display_index_high_water(dataset_id, display_index)
        try:
            self._store.add_dataset_member(
                dataset_id,
                capture_id,
                membership_id=membership_id,
                display_index=display_index,
            )
        except DatasetMemberExistsError:
            return 0
        return 1

    # ---- helpers -----------------------------------------------------------

    def _append(
        self, kind: str, payload: dict[str, Any], *, capture_id: str | None = None
    ) -> None:
        """Append a dataset event; every kind is fatal on failure (§5)."""
        try:
            ledger_v2.append_with_slack_release(
                self._layout.data_dir,
                kind,
                instance_id=self._instance_id,
                capture_id=capture_id,
                payload={k: v for k, v in payload.items() if v is not None},
            )
        except OSError as exc:
            raise ApiError(
                status_code=503,
                code="ledger_unwritable",
                message=(
                    f"The lifecycle ledger could not be written ({exc}), so the "
                    "dataset change was not applied. Datasets are recoverable "
                    "only from this file, so it is not safe to proceed without it."
                ),
            ) from exc

    @staticmethod
    def _require_active(dataset: dict[str, Any]) -> None:
        """Refuse membership changes on a dataset that is not active (§6.x).

        The archive run's resume path replays the member set frozen in the
        ``dataset_archive_started`` event; a membership added or removed while
        the run is out copying would silently diverge from that freeze.
        """
        if dataset["status"] == "active":
            return
        raise ApiError(
            status_code=409,
            code="dataset_not_active",
            message=(
                f"Dataset {dataset.get('name') or dataset['dataset_id']} is "
                f"{dataset['status']}; its member set is frozen."
            ),
            details={
                "dataset_id": dataset["dataset_id"],
                "status": dataset["status"],
            },
        )

    @staticmethod
    def _reject_reserved(*names: str | None) -> None:
        """Refuse names that collide with the store's own layout (§2)."""
        for name in names:
            if name and is_reserved_name(name):
                raise ApiError(
                    status_code=400,
                    code="reserved_name",
                    message=(
                        f"{name!r} is a directory kairos owns under the data "
                        "root; pick a different name."
                    ),
                    details={"name": name},
                )


def _dataset(row: dict[str, Any], *, member_count: int | None = None) -> Dataset:
    return Dataset(
        dataset_id=row["dataset_id"],
        name=row["name"],
        operator=row["operator"],
        task=row["task"],
        status=row["status"],
        created_at=row["created_at"],
        member_count=(
            member_count if member_count is not None else row.get("member_count", 0)
        ),
        archive_destination=row.get("archive_destination"),
        archive_started_at=row.get("archive_started_at"),
        archived_at=row.get("archived_at"),
    )


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _not_found(dataset_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="dataset_not_found",
        message=f"Dataset not found: {dataset_id}",
        details={"dataset_id": dataset_id},
    )
