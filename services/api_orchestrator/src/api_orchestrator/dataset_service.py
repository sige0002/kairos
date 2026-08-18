# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
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

import json
import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from kairos_common import ApiError, ledger_v2
from kairos_common.ids import new_dataset_id
from kairos_common.time import utc_now_iso8601

from api_orchestrator import layout as layout_mod
from api_orchestrator.layout import (
    DataLayout,
    is_reserved_name,
    reject_unusable_labels,
)
from api_orchestrator.ledger_guard import append_or_503
from api_orchestrator.models import (
    Dataset,
    DatasetDetail,
    DatasetMember,
    DatasetMembershipBulkFailure,
    DatasetMembershipBulkRun,
    DatasetSelectionRecipe,
    DatasetSelectionRecipeCreateRequest,
    DatasetUpdateRequest,
)
from api_orchestrator.store import (
    CaptureStore,
    DatasetMemberExistsError,
    DatasetNotActiveError,
)
from api_orchestrator.verdict import (
    GATING_PIPELINES,
    Verdict,
    blocks_adoption,
    verdict_of,
)

logger = logging.getLogger("kairos")


@dataclass(frozen=True)
class DatasetReplayReport:
    """What one ledger replay rebuilt, and what it needs someone to see.

    ``warnings`` are for an operator, not a log file: the replay can rebuild
    history the live code would now refuse to create — two datasets archived
    into one folder is the case that exists — and only the caller knows where
    such a thing should surface.
    """

    counts: dict[str, int]
    warnings: tuple[str, ...] = ()


@dataclass
class _NumberFloor:
    """One dataset's watermark evidence, gathered during a single replay.

    :attr:`value` is the lowest watermark the ledger can justify: the highest
    number it saw issued, plus one for each member line whose number was
    unreadable. Numbers are handed out as watermark + 1, so an unreadable line
    consumed exactly one — which one is not recoverable, and stepping over it
    leaves a gap rather than selling a live member's number twice. A line that
    was a reclaim (the same recording taking its old number back) consumed
    nothing, so counting it can leave a spare gap; that is the conservative
    direction and the only one available without knowing which it was.

    Both terms come from the ledger rather than from the row, which is what
    lets the same replay run twice over a live database — ``KAIROS_REBUILD=1``
    does exactly that — without the mark creeping upward on each pass.
    """

    highest: int = 0
    unreadable: int = 0

    @property
    def value(self) -> int:
        return self.highest + self.unreadable


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
        self._bulk_guard = threading.Lock()
        self._bulk_idle = threading.Condition(self._bulk_guard)
        self._bulk_running: set[str] = set()
        self._bulk_resuming = 0
        # Clear on construction: a newly started API process may resume
        # durable work. Shutdown sets this cooperatively before waiting.
        self._bulk_stop = threading.Event()

    def _verdict_of(self, capture_id: str) -> Verdict:
        """Read the gating pipelines' reports and fold them (see verdict.py).

        Reads the same files CaptureService serves, rather than taking a
        dependency on it: the reports are plain JSON on disk and the whole
        point of deriving the verdict is that there is only one place it can
        come from.
        """
        return verdict_of(
            {
                pipeline: layout_mod.read_json(
                    self._layout.report_dir(pipeline, capture_id) / "summary.json"
                )
                for pipeline in GATING_PIPELINES
            }
        )

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
        reject_unusable_labels(name=name, operator=operator, task=task)
        self._reject_duplicate_labels(name=name, operator=operator, task=task)
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
        reject_unusable_labels(name=name, operator=operator, task=task)
        self._reject_duplicate_labels(
            name=name, operator=operator, task=task, exclude=dataset_id
        )

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

    def record_selection(
        self,
        dataset_id: str,
        request: DatasetSelectionRecipeCreateRequest,
        *,
        allow_inactive: bool = False,
    ) -> DatasetSelectionRecipe:
        """Persist one completed filtered Bulk Add run without changing members."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise _not_found(dataset_id)
        if not allow_inactive:
            self._require_active(dataset)
        recipe = DatasetSelectionRecipe(
            **request.model_dump(),
            recipe_id=str(uuid4()),
            recorded_at=utc_now_iso8601(),
        )
        if not self._store.append_dataset_selection_recipe(
            dataset_id, recipe.model_dump(mode="json")
        ):
            raise _not_found(dataset_id)
        try:
            self._append(
                "dataset_selection_recorded",
                {
                    "dataset_id": dataset_id,
                    "dataset_name": dataset["name"],
                    "name": dataset["name"],
                    "operator": dataset["operator"],
                    "task": dataset["task"],
                    "recipe": recipe.model_dump(mode="json"),
                },
            )
        except ApiError:
            self._store.remove_dataset_selection_recipe(dataset_id, recipe.recipe_id)
            raise
        return recipe

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

    def add_member(
        self,
        dataset_id: str,
        capture_id: str,
        *,
        refresh_views: bool = True,
        reclaim_index: int | None = None,
        reclaim_index_known: bool = False,
    ) -> DatasetMember:
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
        # The validation gate (v1: fast_validation). A capture the validators
        # called broken may not silently become training data — but the refusal
        # is overridable, because the operator sometimes knows better than the
        # check. What is NOT allowed is letting it through with no record.
        verdict = self._verdict_of(capture_id)
        if blocks_adoption(verdict, capture.validation_override):
            raise ApiError(
                status_code=409,
                code="validation_failed",
                message=(
                    f"{capture_id} did not pass validation. Override it with a "
                    "reason if you want it in a dataset anyway."
                ),
                details={"capture_id": capture_id, "verdict": str(verdict)},
            )
        for membership in self._store.dataset_memberships_for(capture_id):
            other = self._store.get_dataset(membership.dataset_id)
            if (
                other is not None
                and other["status"] != "active"
                and other.get("archive_mode") != "copy"
            ):
                # The other dataset's MOVE run is going to take (or already
                # took) this capture's bytes away; a new membership would cite
                # bytes that are leaving — the very dangling reference the §7
                # member guard exists to prevent. A copy run is no such thing:
                # it seals a record and the bytes stay, so its members remain
                # free to join new datasets.
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
            member = self._store.add_dataset_member(
                dataset_id,
                capture_id,
                display_index=(
                    reclaim_index
                    if reclaim_index_known
                    else self._reclaimable_index(dataset_id, capture_id)
                ),
            )
        except DatasetNotActiveError as exc:
            raise ApiError(
                status_code=409,
                code="dataset_not_active",
                message="The dataset became frozen before this member was added.",
                details={"dataset_id": dataset_id, "status": exc.status},
            ) from exc
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
            current = self._store.get_dataset(dataset_id)
            if current is not None and current["status"] == "active":
                self._store.remove_dataset_member(dataset_id, member.membership_id)
            raise
        if refresh_views:
            self._views_changed()
        return member

    def start_membership_bulk_run(
        self, dataset_id: str, *, selection_id: str, request_id: str
    ) -> DatasetMembershipBulkRun:
        """Create an idempotent run whose items are frozen selection IDs."""
        dataset = self._store.get_dataset(dataset_id)
        if dataset is None:
            raise _not_found(dataset_id)
        self._require_active(dataset)
        try:
            row = self._store.create_membership_bulk_run(
                dataset_id, selection_id, request_id
            )
        except ValueError as exc:
            raise ApiError(
                status_code=409,
                code="idempotency_conflict",
                message="request_id was already used for another selection.",
                details={"request_id": request_id},
            ) from exc
        except KeyError as exc:
            raise ApiError(
                status_code=409,
                code="capture_selection_expired",
                message="This capture selection expired; search again before adding.",
                details={"selection_id": selection_id},
            ) from exc
        return self._bulk_run_model(row)

    def run_membership_bulk(self, run_id: str, *, retry_failed: bool = False) -> None:
        """Process frozen IDs one by one through the normal member gate.

        The normal ``add_member`` path remains the authority for validation,
        ledger append and display-index rules. A partial run is deliberate: its
        successful rows are durable and retry only revisits refused IDs.
        """
        with self._bulk_idle:
            if run_id in self._bulk_running:
                return
            self._bulk_running.add(run_id)
        claimed = False
        try:
            if self._bulk_stop.is_set():
                return
            if not self._store.claim_membership_bulk_run(run_id):
                return
            claimed = True
            run = self._store.get_membership_bulk_run(run_id)
            if run is None:
                return
            changed = False
            capture_ids = self._store.pending_membership_bulk_capture_ids(
                run_id, retry_failed=retry_failed
            )
            # Looking up a reclaimed index by rescanning lifecycle.jsonl for
            # every capture turns a 100k bulk run into quadratic I/O. Read the
            # ledger once for this frozen pass; an absent key deliberately
            # means "allocate a fresh number" and must not trigger another
            # scan in add_member.
            reclaimed = self._reclaimable_indexes(str(run["dataset_id"]), capture_ids)
            for capture_id in capture_ids:
                if self._bulk_stop.is_set():
                    # Do not turn unvisited rows into failures. Their pending
                    # state and the released run make them restart-safe.
                    if changed:
                        self._views_changed()
                    self._store.release_membership_bulk_run(run_id)
                    claimed = False
                    return
                try:
                    self.add_member(
                        str(run["dataset_id"]),
                        capture_id,
                        refresh_views=False,
                        reclaim_index=reclaimed.get(capture_id),
                        reclaim_index_known=True,
                    )
                except ApiError as exc:
                    if exc.code == "dataset_member_exists":
                        # The process may have died after add_member committed
                        # its ledger line but before this work-item receipt was
                        # marked. The selected desired state is already true;
                        # classify the retry as success rather than inventing a
                        # partial failure for a member that is visibly present.
                        try:
                            self._ensure_bulk_member_ledger(
                                str(run["dataset_id"]), capture_id
                            )
                        except ApiError as repair_error:
                            self._store.mark_membership_bulk_item(
                                run_id,
                                capture_id,
                                success=False,
                                code=repair_error.code,
                                message=repair_error.message,
                            )
                        else:
                            self._store.mark_membership_bulk_item(
                                run_id, capture_id, success=True
                            )
                            changed = True
                    else:
                        self._store.mark_membership_bulk_item(
                            run_id,
                            capture_id,
                            success=False,
                            code=exc.code,
                            message=exc.message,
                        )
                else:
                    self._store.mark_membership_bulk_item(
                        run_id, capture_id, success=True
                    )
                    changed = True
            if changed:
                self._views_changed()
            finished = self._store.finish_membership_bulk_run(run_id)
            if finished is not None:
                self._record_bulk_receipt(finished)
        except Exception:  # noqa: BLE001 - preserve a retryable durable queue
            logger.exception(
                "membership bulk worker interrupted", extra={"run_id": run_id}
            )
            self._store.release_membership_bulk_run(run_id)
            claimed = False
        finally:
            if claimed:
                # A stop can arrive after the final item but before receipt
                # bookkeeping. Returning the durable claim is safer than
                # letting a closing process retain a running row.
                self._store.release_membership_bulk_run(run_id)
            with self._bulk_idle:
                self._bulk_running.discard(run_id)
                self._bulk_idle.notify_all()

    def resume_pending_membership_bulk_runs(self) -> None:
        """Continue work rows that survived a normal API-process restart."""
        with self._bulk_idle:
            self._bulk_resuming += 1
        try:
            if self._bulk_stop.is_set():
                return
            self._store.reset_running_membership_bulk_runs()
            for run_id in self._store.pending_membership_bulk_runs():
                if self._bulk_stop.is_set():
                    return
                self.run_membership_bulk(run_id)
            # `finish_membership_bulk_run` and receipt append are intentionally
            # separate durable steps: memberships must survive a receipt I/O
            # failure. Close the crash window by replaying only that second
            # step; never re-add successful members during startup recovery.
            for run in self._store.membership_bulk_runs_needing_receipt():
                if self._bulk_stop.is_set():
                    return
                self._record_bulk_receipt(run)
        finally:
            with self._bulk_idle:
                self._bulk_resuming -= 1
                self._bulk_idle.notify_all()

    def request_stop(self) -> None:
        """Ask background and resume workers to stop between member writes."""
        self._bulk_stop.set()

    def wait_idle(self, timeout: float | None = None) -> bool:
        """Wait until every request/resume worker has released its DB claim."""
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._bulk_idle:
            while self._bulk_running or self._bulk_resuming:
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return False
                self._bulk_idle.wait(remaining)
        return True

    def get_membership_bulk_run(
        self, dataset_id: str, run_id: str
    ) -> DatasetMembershipBulkRun:
        run = self._store.get_membership_bulk_run(run_id)
        if run is None or run["dataset_id"] != dataset_id:
            raise ApiError(
                status_code=404,
                code="dataset_bulk_run_not_found",
                message=f"No membership bulk run {run_id} for this dataset.",
                details={"dataset_id": dataset_id, "run_id": run_id},
            )
        return self._bulk_run_model(run)

    def retry_membership_bulk_run(
        self, dataset_id: str, run_id: str
    ) -> DatasetMembershipBulkRun:
        run = self.get_membership_bulk_run(dataset_id, run_id)
        if run.state == "completed":
            return run
        row = self._store.requeue_failed_membership_bulk_run(run_id)
        if row is None:
            raise ApiError(
                status_code=409,
                code="bulk_run_not_retryable",
                message="This membership bulk run is already being processed.",
                details={"dataset_id": dataset_id, "run_id": run_id},
            )
        return self._bulk_run_model(row)

    def _bulk_run_model(self, row: dict[str, Any]) -> DatasetMembershipBulkRun:
        failures = [
            DatasetMembershipBulkFailure(**failure)
            for failure in self._store.membership_bulk_failures(str(row["run_id"]))
        ]
        pending = max(
            0, int(row["matched_count"]) - int(row["succeeded"]) - int(row["failed"])
        )
        return DatasetMembershipBulkRun(
            run_id=str(row["run_id"]),
            dataset_id=str(row["dataset_id"]),
            selection_id=str(row["selection_id"]),
            state=str(row["state"]),
            matched_count=int(row["matched_count"]),
            attempted=int(row["attempted"]),
            succeeded=int(row["succeeded"]),
            failed=int(row["failed"]),
            pending=pending,
            failures=failures,
        )

    def _record_bulk_receipt(self, run: dict[str, Any]) -> None:
        """Persist one deduplicated, cumulative receipt for a completed pass."""
        if run.get("receipt_state") == "recorded":
            return
        dataset = self._store.get_dataset(str(run["dataset_id"]))
        existing = next(
            (
                recipe
                for recipe in _selection_recipes(dataset or {})
                if recipe.get("bulk_run_id") == run["run_id"]
                and recipe.get("attempt") == run["attempt"]
            ),
            None,
        )
        if existing is not None:
            try:
                events = ledger_v2.dataset_events(self._layout.data_dir)
                recorded = any(
                    event.get("kind") == "dataset_selection_recorded"
                    and event.get("dataset_id") == run["dataset_id"]
                    and isinstance(event.get("recipe"), dict)
                    and event["recipe"].get("bulk_run_id") == run["run_id"]
                    and event["recipe"].get("attempt") == run["attempt"]
                    for event in events
                )
                if not recorded:
                    assert dataset is not None
                    self._append(
                        "dataset_selection_recorded",
                        {
                            "dataset_id": run["dataset_id"],
                            "dataset_name": dataset["name"],
                            "name": dataset["name"],
                            "operator": dataset["operator"],
                            "task": dataset["task"],
                            "recipe": existing,
                        },
                    )
            except (ApiError, ledger_v2.LedgerUnreadableError):
                self._store.mark_membership_bulk_receipt_failed(str(run["run_id"]))
            else:
                self._store.mark_membership_bulk_receipt(str(run["run_id"]), "recorded")
            return
        query = self._store.membership_bulk_query(str(run["run_id"])) or {}
        try:
            self.record_selection(
                str(run["dataset_id"]),
                DatasetSelectionRecipeCreateRequest(
                    join=query.get("join", "and"),
                    conditions=query.get("predicates", []),
                    selection_query=query,
                    matched=int(run["matched_count"]),
                    attempted=int(run["attempted"]),
                    succeeded=int(run["succeeded"]),
                    failed=int(run["failed"]),
                    catalog_truncated=False,
                    bulk_run_id=str(run["run_id"]),
                    attempt=int(run["attempt"]),
                    cumulative=True,
                ),
                # The membership pass was already committed before this
                # separate receipt step. An archive between those steps must
                # not make its provenance permanently unrecoverable.
                allow_inactive=True,
            )
        except ApiError:
            # Memberships already have their own ledger truth. Do not pretend
            # the provenance receipt landed, and do not roll successful rows
            # back merely because its append failed.
            self._store.mark_membership_bulk_receipt_failed(str(run["run_id"]))
        else:
            self._store.mark_membership_bulk_receipt(str(run["run_id"]), "recorded")

    def _ensure_bulk_member_ledger(self, dataset_id: str, capture_id: str) -> None:
        """Repair the row-first crash window before calling an item successful."""
        member = self._store.get_dataset_membership(dataset_id, capture_id)
        dataset = self._store.get_dataset(dataset_id)
        if member is None or dataset is None:
            raise ApiError(
                status_code=409,
                code="dataset_member_missing",
                message="The existing membership could not be re-read safely.",
                details={"dataset_id": dataset_id, "capture_id": capture_id},
            )
        try:
            events = ledger_v2.dataset_events(self._layout.data_dir)
        except ledger_v2.LedgerUnreadableError as exc:
            raise ApiError(
                status_code=503,
                code="ledger_unreadable",
                message="The membership ledger could not be checked for recovery.",
                details={"dataset_id": dataset_id, "capture_id": capture_id},
            ) from exc
        if any(
            event.get("kind") == "dataset_member_added"
            and event.get("dataset_id") == dataset_id
            and event.get("capture_id") == capture_id
            and event.get("membership_id") == member.membership_id
            and event.get("display_index") == member.display_index
            for event in events
        ):
            return
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
            capture_id=capture_id,
        )

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

    def restore_from_ledger(self) -> DatasetReplayReport:
        """Rebuild datasets and memberships by replaying the ledger.

        Order is the whole value here: ``member_added`` followed by
        ``member_removed`` for the same number is what says that number is
        *retired* rather than free, and a set-based reconstruction would lose
        exactly that distinction.

        The report carries the replay's counts and any **warnings** it needs an
        operator to see. The caller is expected to put those somewhere visible;
        the replay has no channel of its own.
        """
        counts = {
            "datasets": 0,
            "members": 0,
            "removed": 0,
            "deleted": 0,
            "archiving": 0,
            "archive_canceled": 0,
            "archived": 0,
        }
        # Per-dataset evidence for the watermark, accumulated as the replay
        # walks. Local to this call on purpose: every value it produces is a
        # function of the ledger alone, so a second replay over the same file
        # recomputes the same numbers instead of adding to what the first one
        # left. ``KAIROS_REBUILD=1`` replays onto a live database — the rebuild
        # upserts captures and replicas and never clears ``datasets`` — so a
        # watermark that CONSUMED anything per pass would drift upward on every
        # forced rebuild.
        floors: dict[str, _NumberFloor] = {}
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
            elif kind == "dataset_selection_recorded":
                self._ensure_dataset_row(dataset_id, event)
                recipe = event.get("recipe")
                if isinstance(recipe, dict):
                    row = self._store.get_dataset(dataset_id)
                    assert row is not None
                    recipes = _selection_recipes(row)
                    recipe_id = recipe.get("recipe_id")
                    if isinstance(recipe_id, str) and not any(
                        existing.get("recipe_id") == recipe_id for existing in recipes
                    ):
                        self._store.append_dataset_selection_recipe(dataset_id, recipe)
            elif kind == "dataset_member_added":
                counts["members"] += self._replay_member_added(
                    dataset_id, event, floors
                )
            elif kind == "dataset_member_removed":
                membership_id = event.get("membership_id")
                if isinstance(membership_id, str):
                    if self._store.remove_dataset_member(dataset_id, membership_id):
                        counts["removed"] += 1
            elif kind == "dataset_deleted":
                if self._store.delete_dataset(dataset_id):
                    counts["deleted"] += 1
            elif kind == "dataset_archive_started":
                counts["archiving"] += self._replay_archive_started(
                    dataset_id, event, floors
                )
            elif kind == "dataset_archive_canceled":
                self._ensure_dataset_row(dataset_id, event)
                self._store.mark_dataset_archive_canceled(dataset_id)
                counts["archive_canceled"] += 1
            elif kind == "dataset_archived":
                self._ensure_dataset_row(dataset_id, event)
                self._store.mark_dataset_archived(
                    dataset_id, at=_opt_str(event.get("at"))
                )
                counts["archived"] += 1
        warnings = self._report_destination_conflicts()
        counts["destination_conflicts"] = len(warnings)
        return DatasetReplayReport(counts=counts, warnings=tuple(warnings))

    def _report_destination_conflicts(self) -> list[str]:
        """Say when the replay rebuilt two claims on one archive folder.

        A live start cannot produce this — the destination claim refuses a
        second holder — but a ledger written before that guard existed can, and
        a replay is not the place to refuse history: those archives happened.
        What it IS the place for is saying so. Left silent, the catalog shows
        two datasets whose archived record is the same directory, only one of
        them can be describing its contents, and the first anyone hears of it
        is an archive refused by a dataset they have never heard of.

        Returns the sentences themselves, not a count: the caller puts them in
        the store health warnings an operator actually reads. A log line is
        what you write when there is no channel, and there is one.
        """
        warnings: list[str] = []
        for (
            destination,
            dataset_ids,
        ) in self._store.datasets_sharing_archive_destination().items():
            warnings.append(
                f"{destination} is recorded as the archive destination of more "
                f"than one dataset ({', '.join(dataset_ids)}); the ledger says "
                "both archived there, and only one of them can describe what "
                "is in that folder"
            )
        for warning in warnings:
            logger.warning("%s", warning)
        return warnings

    def _replay_archive_started(
        self, dataset_id: str, event: dict[str, Any], floors: dict[str, _NumberFloor]
    ) -> int:
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
                floors,
            )
        mode = event.get("mode")
        self._store.mark_dataset_archiving(
            dataset_id,
            destination=destination,
            mode=mode if mode in ("copy", "move") else "move",
            at=_opt_str(event.get("at")),
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

    def _replay_member_added(
        self, dataset_id: str, event: dict[str, Any], floors: dict[str, _NumberFloor]
    ) -> int:
        """Replay one membership. Returns 1 if a member row came back.

        A line this cannot use is damage, not absence: whatever else it lost,
        it still says a number was issued, and every early return below has to
        leave the watermark at least as high as that line put it. Reading a
        damaged line as absence would lower the mark and let the next add hand
        a live member's number to a different recording — §6's one prohibition.
        """
        membership_id = event.get("membership_id")
        capture_id = event.get("capture_id")
        display_index = event.get("display_index")
        # First, because the watermark is a column on this row: a membership
        # whose dataset_created line is missing (a truncated ledger tail) gets
        # its dataset back from what the membership event itself carries,
        # rather than dropping the member — and the number — on the floor.
        self._ensure_dataset_row(dataset_id, event)
        floor = floors.setdefault(dataset_id, _NumberFloor())
        if not isinstance(display_index, int) or isinstance(display_index, bool):
            # The number is the part that did not survive. Which one it was is
            # unknowable; that one was consumed is not, because numbers are
            # handed out as watermark + 1. Counting it costs a gap in the
            # numbering and keeps the retired ones retired.
            logger.warning(
                "dataset member line carries no usable display_index; "
                "retiring a number for it",
                extra={"dataset_id": dataset_id, "membership_id": membership_id},
            )
            floor.unreadable += 1
        else:
            floor.highest = max(floor.highest, display_index)
        # Raise the watermark even where nothing is inserted below: the number
        # was issued once and must never be issued again.
        self._store.set_display_index_high_water(dataset_id, floor.value)
        if not isinstance(display_index, int) or isinstance(display_index, bool):
            return 0
        if not isinstance(membership_id, str) or not isinstance(capture_id, str):
            logger.warning(
                "dataset member line names no membership or capture; its "
                "number stays retired but the member is lost",
                extra={"dataset_id": dataset_id, "display_index": display_index},
            )
            return 0
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
        append_or_503(
            self._layout.data_dir,
            kind,
            instance_id=self._instance_id,
            capture_id=capture_id,
            payload={k: v for k, v in payload.items() if v is not None},
            failure=lambda exc: (
                f"The lifecycle ledger could not be written ({exc}), so the "
                "dataset change was not applied. Datasets are recoverable "
                "only from this file, so it is not safe to proceed without it."
            ),
        )

    def _reclaimable_index(self, dataset_id: str, capture_id: str) -> int | None:
        """The number this capture last held in this dataset, if any (§6).

        Never-reuse forbids handing a retired number to a DIFFERENT recording —
        the same recording returning is the one case that cannot break the
        number↔recording binding, and re-adding after an accidental remove
        should not read as a brand-new take. The member row is gone, so the
        ledger is the only place the old number survives; latest add wins.
        None = never was a member, allocate the next number as usual.

        An unreadable ledger is refused, never guessed, and never read with
        ``strict=False``. That hatch returns the lines that did parse, and the
        line this question turns on is exactly the one that might be missing:
        a capture that held 002 then reads as never having been a member, so
        it is issued a fresh number while 002 stays retired — the same
        recording answering to a different number than every report that
        already cited it. An incomplete history gives a plausible wrong answer
        silently, which is worse here than an exception that says so.
        """
        try:
            events = ledger_v2.dataset_events(self._layout.data_dir)
        except ledger_v2.LedgerUnreadableError as exc:
            path = ledger_v2.ledger_path(self._layout.data_dir)
            raise ApiError(
                status_code=503,
                code="ledger_unreadable",
                message=(
                    f"The lifecycle ledger ({path}) "
                    f"could not be read: {exc}. The number a returning recording "
                    "takes back is recorded only there, so adding a member now "
                    "could issue a number that already belongs to another take. "
                    "Repair or restore the file, then try again."
                ),
                details={"dataset_id": dataset_id, "capture_id": capture_id},
            ) from exc
        last: int | None = None
        for event in events:
            if (
                event.get("dataset_id") == dataset_id
                and event.get("kind") == "dataset_member_added"
                and event.get("capture_id") == capture_id
            ):
                index = event.get("display_index")
                if isinstance(index, int) and not isinstance(index, bool):
                    last = index
        return last

    def _reclaimable_indexes(
        self, dataset_id: str, capture_ids: list[str]
    ) -> dict[str, int]:
        """Return reusable numbers for a frozen bulk pass in one ledger read."""
        wanted = set(capture_ids)
        if not wanted:
            return {}
        try:
            events = ledger_v2.dataset_events(self._layout.data_dir)
        except ledger_v2.LedgerUnreadableError as exc:
            path = ledger_v2.ledger_path(self._layout.data_dir)
            raise ApiError(
                status_code=503,
                code="ledger_unreadable",
                message=(
                    f"The lifecycle ledger ({path}) could not be read. "
                    "Repair or restore it before adding dataset members."
                ),
                details={"dataset_id": dataset_id},
            ) from exc
        result: dict[str, int] = {}
        for event in events:
            capture_id = event.get("capture_id")
            index = event.get("display_index")
            if (
                event.get("dataset_id") == dataset_id
                and event.get("kind") == "dataset_member_added"
                and isinstance(capture_id, str)
                and capture_id in wanted
                and isinstance(index, int)
                and not isinstance(index, bool)
            ):
                result[capture_id] = index
        return result

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

    def _reject_duplicate_labels(
        self,
        *,
        name: str,
        operator: str | None,
        task: str | None,
        exclude: str | None = None,
    ) -> None:
        """Refuse a second active dataset with the same three labels (§6).

        Name, operator and task are the folder ``views/`` generates, and two
        datasets holding all three would want one folder for both. The
        regenerator survives that by suffixing the later one, but a suffixed
        folder is not what anybody asked for — so the collision is caught at the
        door, where the operator is still looking at the form and can say what
        they actually meant.
        """
        existing = self._store.find_active_dataset_by_labels(
            name=name, operator=operator, task=task, exclude=exclude
        )
        if existing is None:
            return
        where = "/".join(part for part in (operator, task, name) if part)
        raise ApiError(
            status_code=409,
            code="dataset_labels_taken",
            message=(
                f"A dataset named {name!r} with this operator and task already "
                f"exists, and both would generate views/{where}. Rename one, or "
                f"add to the existing dataset."
            ),
            details={
                "name": name,
                "operator": operator,
                "task": task,
                "existing_dataset_id": existing["dataset_id"],
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
        archive_mode=row.get("archive_mode"),
        archive_started_at=row.get("archive_started_at"),
        archived_at=row.get("archived_at"),
        selection_recipes=_selection_recipes(row),
    )


def _selection_recipes(row: dict[str, Any]) -> list[dict[str, Any]]:
    raw = row.get("selection_recipes") or "[]"
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    return raw if isinstance(raw, list) else []


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _not_found(dataset_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="dataset_not_found",
        message=f"Dataset not found: {dataset_id}",
        details={"dataset_id": dataset_id},
    )
