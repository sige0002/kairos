# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Rebuild: the catalog reconstructed from sidecars and the ledger (§8)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from kairos_common import capture_sidecars as sidecars
from kairos_common import ledger_v2, rebuild
from kairos_common.capture_sidecars import ObjectManifestV2, RecordV2
from kairos_common.ids import new_capture_id, new_instance_id
from kairos_common.rebuild import ReplicaState

INSTANCE = new_instance_id()


def _capture(
    data_dir: Path,
    *,
    state: str = "completed",
    capture_id: str | None = None,
    bag: bool = True,
    **overrides,
) -> str:
    """Create ``objects/<capture_id>/`` with a manifest and (usually) a bag."""
    capture_id = capture_id or new_capture_id()
    fields = {
        "capture_id": capture_id,
        "source_instance_id": INSTANCE,
        "run_id": f"run_{capture_id[:8]}",
        "state": state,
        "started_at": "2026-08-02T10:15:00.000Z",
        "operator": "op_a",
        "task": "pick",
        "robot": "airoa_hsr",
    }
    fields.update(overrides)
    directory = sidecars.capture_dir(data_dir, capture_id)
    directory.mkdir(parents=True, exist_ok=True)
    if bag:
        (directory / "metadata.yaml").write_text("version: 5\n", encoding="utf-8")
        (directory / f"{fields['run_id']}_0.mcap").write_bytes(b"\x89MCAP0")
    sidecars.write_object_manifest(directory, ObjectManifestV2(**fields))
    return capture_id


def _run(data_dir: Path, **kwargs) -> rebuild.RebuildResult:
    """The common case: the recorder answered, and nothing is in flight."""
    kwargs.setdefault("recorder_reachable", True)
    kwargs.setdefault("live_exclusions", ())
    return rebuild.rebuild(data_dir, instance_id=INSTANCE, **kwargs)


def _row(result: rebuild.RebuildResult, capture_id: str) -> rebuild.CaptureRow:
    (row,) = [r for r in result.captures if r.capture_id == capture_id]
    return row


def _replica(result: rebuild.RebuildResult, capture_id: str) -> rebuild.ReplicaRow:
    (replica,) = [r for r in result.replicas if r.capture_id == capture_id]
    return replica


# -- rule 2: unfinalized states are normalized --------------------------------


def test_a_capture_still_recording_becomes_interrupted(tmp_path: Path) -> None:
    """Nothing is writing to it any more, so ``recording`` is a claim no later
    event will ever correct."""
    capture_id = _capture(tmp_path, state="recording")

    row = _row(_run(tmp_path), capture_id)

    assert row.state == "interrupted"


def test_a_capture_stopping_becomes_interrupted(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path, state="stopping")

    assert _row(_run(tmp_path), capture_id).state == "interrupted"


def test_an_unfinalized_capture_with_no_bag_becomes_failed(tmp_path: Path) -> None:
    """Matching the recorder's own finalise judgement, so a crash and a clean
    stop classify the same bag identically."""
    capture_id = _capture(tmp_path, state="recording", bag=False)

    assert _row(_run(tmp_path), capture_id).state == "failed"


def test_an_mcap_alone_is_enough_to_count_as_a_bag(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path, state="recording", bag=False)
    (sidecars.capture_dir(tmp_path, capture_id) / "run_0.mcap").write_bytes(b"x")

    assert _row(_run(tmp_path), capture_id).state == "interrupted"


def test_a_terminal_state_is_never_second_guessed(tmp_path: Path) -> None:
    """A completed capture whose bag was later removed stays completed — the
    recorder saw the data, and the missing copy is the replica's story to tell."""
    capture_id = _capture(tmp_path, state="completed", bag=False)

    assert _row(_run(tmp_path), capture_id).state == "completed"


def test_an_unreachable_recorder_defers_instead_of_guessing(tmp_path: Path) -> None:
    """Rule 1's fallback: without knowing whether a ``recording`` manifest is
    live or abandoned, converting it could stamp on the recorder's own writes."""
    live_ish = _capture(tmp_path, state="recording")
    settled = _capture(tmp_path, state="completed")

    result = _run(tmp_path, recorder_reachable=False)

    assert result.deferred == (live_ish,)
    assert [row.capture_id for row in result.captures] == [settled]


def test_the_recorder_liveness_answer_cannot_be_left_unspoken() -> None:
    """A caller that never asked the recorder must not be able to look like one
    that asked and was told "nothing is running" — that is the reading which
    normalizes a live capture to interrupted while it is still being written."""
    with pytest.raises(TypeError):
        rebuild.rebuild("/tmp", instance_id=INSTANCE)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        rebuild.rebuild(  # type: ignore[call-arg]
            "/tmp", instance_id=INSTANCE, recorder_reachable=True
        )


# -- rule 1: live captures are left to the recorder ---------------------------


def test_a_live_capture_produces_no_row_at_all(tmp_path: Path) -> None:
    """Not a row, not a replica, not a warning: the recorder is still its sole
    writer and the normal finalise path will produce the row."""
    live = _capture(tmp_path, state="recording")
    other = _capture(tmp_path, state="completed")

    result = _run(tmp_path, live_exclusions=[live])

    assert [row.capture_id for row in result.captures] == [other]
    assert [r.capture_id for r in result.replicas] == [other]
    assert result.warnings == ()


# -- rule 3: the ledger outranks the manifest ---------------------------------


def test_a_tombstone_overrides_a_healthy_manifest(tmp_path: Path) -> None:
    """The operator discarded it and the machine died before the directory was
    moved. Believing the manifest would resurrect data somebody destroyed."""
    capture_id = _capture(tmp_path, state="completed")
    ledger_v2.append(
        tmp_path,
        "capture_discarded",
        instance_id=INSTANCE,
        capture_id=capture_id,
        payload={"reason": "operator error"},
    )

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.state == "discarded"
    assert row.delete_kind == "discard"
    assert row.delete_reason == "operator error"
    assert row.deleted_at is not None
    # The bytes are still there, so the copy is still present — and somebody has
    # to finish the job.
    assert _replica(result, capture_id).state == ReplicaState.present_unverified
    assert any("delete-resume" in warning for warning in result.warnings)


def test_a_deleted_tombstone_maps_to_the_delete_kind(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)
    ledger_v2.append(
        tmp_path, "capture_deleted", instance_id=INSTANCE, capture_id=capture_id
    )

    row = _row(_run(tmp_path), capture_id)

    assert (row.state, row.delete_kind) == ("deleted", "delete")


def test_a_capture_with_only_a_tombstone_left_still_gets_a_row(
    tmp_path: Path,
) -> None:
    """§7 keeps the row after a deletion. It answers "where did that recording
    go", and it is what stops a later transfer from re-adopting the bytes."""
    capture_id = new_capture_id()
    ledger_v2.append(
        tmp_path,
        "capture_discarded",
        instance_id=INSTANCE,
        capture_id=capture_id,
        payload={"reason": "not uploaded"},
    )

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.state == "discarded"
    assert row.delete_reason == "not uploaded"
    assert row.run_id is None  # nothing but the ledger is left of it
    assert _replica(result, capture_id).state == ReplicaState.absent_managed


def test_a_capture_still_in_trash_is_not_reported_as_cleaned_up(
    tmp_path: Path,
) -> None:
    """§7 step 5: absent_managed is only true once the bytes are verifiably
    gone, and the reaper has not finished here."""
    capture_id = new_capture_id()
    (sidecars.trash_dir(tmp_path) / capture_id).mkdir(parents=True)
    ledger_v2.append(
        tmp_path, "capture_deleted", instance_id=INSTANCE, capture_id=capture_id
    )

    assert _replica(_run(tmp_path), capture_id).state == ReplicaState.trashed


def test_an_archived_capture_is_not_treated_as_a_tombstone(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)
    ledger_v2.append(
        tmp_path,
        "capture_archived",
        instance_id=INSTANCE,
        capture_id=capture_id,
        payload={"destination": "/mnt/nas"},
    )

    assert _row(_run(tmp_path), capture_id).state == "completed"


# -- §6: archived captures survive a rebuild ----------------------------------


def _archive(tmp_path: Path, capture_id: str, **payload) -> None:
    ledger_v2.append(
        tmp_path,
        "capture_archived",
        instance_id=INSTANCE,
        capture_id=capture_id,
        payload={"destination": "/mnt/nas/2026-08", **payload},
    )


def test_an_archived_capture_is_rebuilt_from_its_ledger_event(
    tmp_path: Path,
) -> None:
    """Archiving verifies the copy and then deletes the source, so nothing is
    left under objects/. Without this the capture would silently vanish from the
    catalog and "where did episode 011 go" would be unanswerable again."""
    capture_id = new_capture_id()
    _archive(
        tmp_path,
        capture_id,
        run_id="run_20260802_101500",
        operator="op_a",
        task="pick",
        bytes=1024,
        message_count=4321,
    )

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.state == "completed"
    assert row.archive_destination == "/mnt/nas/2026-08"
    assert row.archived_at is not None
    assert (row.run_id, row.operator, row.task) == (
        "run_20260802_101500",
        "op_a",
        "pick",
    )
    assert (row.bytes, row.message_count) == (1024, 4321)
    assert _replica(result, capture_id).state == ReplicaState.absent_managed


def test_an_archived_context_is_rebuilt_from_the_ledger_event(tmp_path: Path) -> None:
    capture_id = new_capture_id()
    _archive(
        tmp_path,
        capture_id,
        collection_context={
            "batch_id": "batch_archived",
            "batch_seq": 5,
            "project": "project-a",
            "task": "pick",
            "condition": "wet",
            "robot": "robot-a",
            "operator": "op_a",
            "future_label": "preserved",
        },
    )

    context = _row(_run(tmp_path), capture_id).collection_context
    assert context is not None
    assert context.batch_id == "batch_archived"
    assert context.condition == "wet"
    assert context.extra == {"future_label": "preserved"}


def test_malformed_archived_context_is_warned_and_ignored(tmp_path: Path) -> None:
    capture_id = new_capture_id()
    _archive(tmp_path, capture_id, collection_context="not-an-object")

    result = _run(tmp_path)
    assert _row(result, capture_id).collection_context is None
    assert any(
        "archived collection_context is invalid" in warning
        for warning in result.warnings
    )


def test_a_dataset_annotated_archive_rebuilds_like_any_other(tmp_path: Path) -> None:
    """A dataset archive (§6.x) reuses ``capture_archived`` per member, adding
    dataset_id/membership_id/display_index to the payload. The per-capture
    rebuild must keep working unchanged — the extra fields describe the
    dataset, and the dataset side replays them from its own events."""
    capture_id = new_capture_id()
    _archive(
        tmp_path,
        capture_id,
        operator="op_a",
        task="pick",
        bytes=2048,
        dataset_id="d1",
        membership_id="m1",
        display_index=3,
    )

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.state == "completed"
    assert row.archive_destination == "/mnt/nas/2026-08"
    assert (row.operator, row.task, row.bytes) == ("op_a", "pick", 2048)
    assert _replica(result, capture_id).state == ReplicaState.absent_managed


def test_a_rebuilt_archive_row_admits_what_it_cannot_know(tmp_path: Path) -> None:
    """The sidecars went with the bytes, so the row is only as good as the event
    and must say so rather than look like a complete record."""
    capture_id = new_capture_id()
    _archive(tmp_path, capture_id)

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.topics == ()
    assert row.started_at is None
    assert row.review_revision == 0
    # Whoever ran the archive is not necessarily who recorded the capture.
    assert row.source_instance_id is None
    assert any("capture_archived event only" in w for w in result.warnings)


def test_a_tombstone_beats_an_archive_for_the_same_capture(tmp_path: Path) -> None:
    """Archived and later discarded: the tombstone is the later intent."""
    capture_id = new_capture_id()
    _archive(tmp_path, capture_id, operator="op_a")
    ledger_v2.append(
        tmp_path,
        "capture_discarded",
        instance_id=INSTANCE,
        capture_id=capture_id,
        payload={"reason": "archived copy was corrupt"},
    )

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.state == "discarded"
    assert row.delete_reason == "archived copy was corrupt"
    assert row.archive_destination is None
    assert len(result.captures) == 1


def test_an_archive_of_a_capture_still_on_disk_defers_to_the_manifest(
    tmp_path: Path,
) -> None:
    """A crashed archive left the source behind. The manifest is richer than the
    event, so it wins and only one row is produced."""
    capture_id = _capture(tmp_path, state="completed")
    _archive(tmp_path, capture_id, operator="someone_else")

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.operator == "op_a"  # from the manifest, not the event
    assert len(result.captures) == 1
    assert _replica(result, capture_id).state == ReplicaState.present_unverified


def test_a_live_capture_is_never_resurrected_by_an_old_archive_event(
    tmp_path: Path,
) -> None:
    capture_id = _capture(tmp_path, state="recording")
    _archive(tmp_path, capture_id)

    result = _run(tmp_path, live_exclusions=[capture_id])

    assert result.captures == ()
    assert result.replicas == ()


# -- rule 4: corrupt is reported, not dropped ---------------------------------


def test_a_zero_byte_manifest_is_reported_rather_than_erasing_the_capture(
    tmp_path: Path,
) -> None:
    capture_id = _capture(tmp_path)
    sidecars.object_manifest_path(tmp_path, capture_id).write_bytes(b"")

    result = _run(tmp_path)

    assert result.captures == ()
    assert [entry.capture_id for entry in result.corrupt] == [capture_id]
    assert "empty" in result.corrupt[0].reason
    # The bytes are here and their description is broken, which is a different
    # state from "no copy here" and has to be visible in the replica set too.
    assert _replica(result, capture_id).state == ReplicaState.corrupt


def test_an_unparseable_manifest_is_reported(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)
    sidecars.object_manifest_path(tmp_path, capture_id).write_text("{oops", "utf-8")

    result = _run(tmp_path)

    assert [entry.capture_id for entry in result.corrupt] == [capture_id]


def test_a_manifest_naming_a_different_capture_is_corrupt(tmp_path: Path) -> None:
    """The directory name and the manifest must agree, or one of them is a copy
    of something else and adopting either would attach the wrong bytes to a row."""
    capture_id = _capture(tmp_path)
    stranger = ObjectManifestV2(
        capture_id=new_capture_id(),
        source_instance_id=INSTANCE,
        run_id="run_x",
        state="completed",
        started_at="2026-08-02T10:15:00.000Z",
    )
    sidecars.write_object_manifest(sidecars.capture_dir(tmp_path, capture_id), stranger)

    result = _run(tmp_path)

    assert result.captures == ()
    assert "mismatch" in result.corrupt[0].reason
    assert _replica(result, capture_id).state == ReplicaState.corrupt


def test_a_failed_marker_naming_a_different_capture_is_corrupt(
    tmp_path: Path,
) -> None:
    """The filename and the record must agree here too, or one of them describes
    a different start entirely."""
    capture_id = new_capture_id()
    path = sidecars.failed_start_path(tmp_path, capture_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            ObjectManifestV2(
                capture_id=new_capture_id(),
                source_instance_id=INSTANCE,
                run_id="run_x",
                state="failed",
                started_at="2026-08-02T10:15:00.000Z",
            ).to_json()
        ),
        encoding="utf-8",
    )

    result = _run(tmp_path)

    assert result.captures == ()
    assert "mismatch" in result.corrupt[0].reason
    # No bytes were ever written, so there is no replica to describe.
    assert result.replicas == ()


def test_a_symlink_under_objects_is_never_followed(tmp_path: Path) -> None:
    """Nothing kairos writes under objects/ is a symlink. Following one would
    let a planted link attach another capture's bytes — or a path outside the
    store — to this capture_id."""
    real = _capture(tmp_path, state="completed")
    impostor = new_capture_id()
    (sidecars.objects_dir(tmp_path) / impostor).symlink_to(
        sidecars.capture_dir(tmp_path, real)
    )

    result = _run(tmp_path)

    assert [row.capture_id for row in result.captures] == [real]
    assert any(
        impostor in warning and "symlink" in warning for warning in result.warnings
    )


def test_a_directory_with_no_manifest_is_warned_about_not_adopted(
    tmp_path: Path,
) -> None:
    """§2's invariant says an incomplete directory can only be a live capture,
    and live ones were excluded. Adopting this would invent a capture out of a
    directory name."""
    orphan = new_capture_id()
    sidecars.capture_dir(tmp_path, orphan).mkdir(parents=True)

    result = _run(tmp_path)

    assert result.captures == ()
    assert any(orphan in warning for warning in result.warnings)


def test_a_directory_that_is_not_a_capture_id_is_ignored_with_a_warning(
    tmp_path: Path,
) -> None:
    (sidecars.objects_dir(tmp_path) / "recorded").mkdir(parents=True)

    result = _run(tmp_path)

    assert result.captures == ()
    assert any("recorded" in warning for warning in result.warnings)


# -- rule 5: review state comes from record.json ------------------------------


def test_review_state_is_taken_from_the_sidecar(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)
    sidecars.write_record(
        sidecars.capture_dir(tmp_path, capture_id),
        RecordV2(
            capture_id=capture_id,
            revision=4,
            review_status="adopted",
            task_result="success",
            quality="good",
            quality_source="operator",
            batch_id="batch_20260802_101500",
            index_in_batch=2,
        ),
    )

    row = _row(_run(tmp_path), capture_id)

    assert row.review_revision == 4
    assert row.review_status == "adopted"
    assert row.task_result == "success"
    assert row.quality == "good"
    assert row.batch_id == "batch_20260802_101500"
    assert row.index_in_batch == 2
    assert row.review_from_sidecar is True


def test_a_capture_with_no_record_file_is_unreviewed(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)

    row = _row(_run(tmp_path), capture_id)

    assert (row.review_revision, row.review_status) == (0, "pending")
    assert row.task_result is None


def test_a_database_ahead_of_the_sidecar_is_reported_not_corrected(
    tmp_path: Path,
) -> None:
    """§4.1-4. A DB ahead of its sidecar means something wrote review state
    without going through §4.1, and quietly overwriting either side hides it."""
    capture_id = _capture(tmp_path)
    sidecars.write_record(
        sidecars.capture_dir(tmp_path, capture_id),
        RecordV2(capture_id=capture_id, revision=2, review_status="adopted"),
    )

    result = _run(tmp_path, known_revisions={capture_id: 5})
    row = _row(result, capture_id)

    assert row.review_from_sidecar is False
    assert any("ahead" in warning for warning in result.warnings)


def test_a_sidecar_level_with_the_database_still_wins(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)
    sidecars.write_record(
        sidecars.capture_dir(tmp_path, capture_id),
        RecordV2(capture_id=capture_id, revision=5, review_status="excluded"),
    )

    row = _row(_run(tmp_path, known_revisions={capture_id: 5}), capture_id)

    assert row.review_from_sidecar is True
    assert row.review_status == "excluded"


def test_a_corrupt_record_is_reported_and_does_not_wipe_review_state(
    tmp_path: Path,
) -> None:
    capture_id = _capture(tmp_path)
    sidecars.record_path(tmp_path, capture_id).write_bytes(b"")

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.review_from_sidecar is False
    assert any(entry.path.endswith("record.json") for entry in result.corrupt)
    # The capture itself is still catalogued; only its review is unreadable.
    assert row.state == "completed"


# -- failed starts ------------------------------------------------------------


def test_a_failed_start_marker_produces_a_failed_row_and_no_replica(
    tmp_path: Path,
) -> None:
    """§3.4: the start happened and left no bag, so there is a capture to show
    and nothing to hold a copy of."""
    capture_id = new_capture_id()
    sidecars.write_failed_start(
        tmp_path,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=INSTANCE,
            run_id="run_failed",
            state="failed",
            started_at="2026-08-02T10:15:00.000Z",
            error="ros2 bag exited 1",
        ),
    )

    result = _run(tmp_path)
    row = _row(result, capture_id)

    assert row.state == "failed"
    assert row.error == "ros2 bag exited 1"
    assert result.replicas == ()


def test_a_directory_beats_a_stale_failed_marker(tmp_path: Path) -> None:
    """A directory means the bag exists, which contradicts "the start produced
    nothing"."""
    capture_id = _capture(tmp_path, state="completed")
    sidecars.write_failed_start(
        tmp_path,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=INSTANCE,
            run_id="run_x",
            state="failed",
            started_at="2026-08-02T10:15:00.000Z",
        ),
    )

    result = _run(tmp_path)

    assert _row(result, capture_id).state == "completed"
    assert any("stale" in warning for warning in result.warnings)


def test_a_corrupt_failed_marker_is_reported(tmp_path: Path) -> None:
    capture_id = new_capture_id()
    sidecars.failed_start_path(tmp_path, capture_id).parent.mkdir(parents=True)
    sidecars.failed_start_path(tmp_path, capture_id).write_bytes(b"")

    result = _run(tmp_path)

    assert result.captures == ()
    assert [entry.capture_id for entry in result.corrupt] == [capture_id]


# -- replicas -----------------------------------------------------------------


def test_a_sealed_digest_is_what_promotes_a_replica_to_verified(
    tmp_path: Path,
) -> None:
    """§9-4 forbids present_verified before the digest exists."""
    digest = "sha256:" + "a" * 64
    pending = _capture(tmp_path)
    verified = _capture(
        tmp_path, digest_state="complete", manifest_digest=digest, files=()
    )

    result = _run(tmp_path)

    assert _replica(result, pending).state == ReplicaState.present_unverified
    assert _replica(result, pending).manifest_digest is None
    assert _replica(result, verified).state == ReplicaState.present_verified
    assert _replica(result, verified).manifest_digest == digest


def test_replicas_are_filed_under_this_installation_not_the_recording_one(
    tmp_path: Path,
) -> None:
    """A transferred capture keeps the sender's source_instance_id. Filing the
    local copy under that id would claim a copy on a machine we know nothing
    about."""
    sender = new_instance_id()
    capture_id = _capture(tmp_path, source_instance_id=sender)

    result = _run(tmp_path)

    assert _row(result, capture_id).source_instance_id == sender
    assert _replica(result, capture_id).instance_id == INSTANCE


def test_the_replica_path_points_at_the_capture_directory(tmp_path: Path) -> None:
    capture_id = _capture(tmp_path)

    replica = _replica(_run(tmp_path), capture_id)

    assert replica.path == str(sidecars.capture_dir(tmp_path, capture_id))
    # Nothing was re-hashed, so nothing may claim to have been verified.
    assert replica.verified_at is None


# -- the whole scan -----------------------------------------------------------


def test_a_fresh_data_dir_rebuilds_to_nothing(tmp_path: Path) -> None:
    result = _run(tmp_path)

    assert result == rebuild.RebuildResult()


def test_an_unreadable_ledger_stops_the_rebuild_rather_than_reading_as_empty(
    tmp_path: Path, monkeypatch
) -> None:
    """The ledger outranks the manifests, so "I could not read it" must not
    arrive as "nothing was ever deleted" — that rebuild silently resurrects
    every capture an operator discarded."""
    discarded = _capture(tmp_path, state="completed")
    ledger_v2.append(
        tmp_path, "capture_discarded", instance_id=INSTANCE, capture_id=discarded
    )

    def unreadable(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "read_text", unreadable)

    with pytest.raises(ledger_v2.LedgerUnreadableError):
        _run(tmp_path)


def test_rows_come_back_in_capture_id_order(tmp_path: Path) -> None:
    """capture_ids are UUIDv7, so this is oldest-first without a sort column."""
    minted = [_capture(tmp_path) for _ in range(5)]

    result = _run(tmp_path)

    assert [row.capture_id for row in result.captures] == sorted(minted)


def test_a_full_directory_survives_deleting_the_database(tmp_path: Path) -> None:
    """The §13 acceptance scenario in miniature: everything the DB cached is
    recoverable from the sidecars and the ledger."""
    completed = _capture(tmp_path, state="completed", message_count=42, bytes=1024)
    sidecars.write_record(
        sidecars.capture_dir(tmp_path, completed),
        RecordV2(capture_id=completed, revision=1, review_status="adopted"),
    )
    interrupted = _capture(tmp_path, state="recording")
    discarded = _capture(tmp_path)
    ledger_v2.append(
        tmp_path, "capture_discarded", instance_id=INSTANCE, capture_id=discarded
    )
    broken = _capture(tmp_path)
    sidecars.object_manifest_path(tmp_path, broken).write_text("{", encoding="utf-8")

    result = _run(tmp_path)

    assert _row(result, completed).message_count == 42
    assert _row(result, completed).review_status == "adopted"
    assert _row(result, interrupted).state == "interrupted"
    assert _row(result, discarded).state == "discarded"
    assert [entry.capture_id for entry in result.corrupt] == [broken]
    assert len(result.captures) == 3


def test_topics_and_split_survive_the_round_trip(tmp_path: Path) -> None:
    topics = ({"name": "/tf", "type": "tf2_msgs/msg/TFMessage", "qos": {"depth": 10}},)
    capture_id = _capture(
        tmp_path, topics=topics, split={"max_bagfile_size": 1024}, compression="zstd"
    )

    row = _row(_run(tmp_path), capture_id)

    assert row.topics == topics
    assert row.split == {"max_bagfile_size": 1024}
    assert row.compression == "zstd"
    # The orchestrator stores these as JSON columns, so they must be encodable.
    assert json.dumps({"topics": list(row.topics), "split": row.split})


def test_a_damaged_tombstone_line_does_not_resurrect_the_capture(
    tmp_path: Path,
) -> None:
    """E-20: the ledger was edited by hand and one tombstone line is now junk.

    A truncated TAIL is a write that never completed, so skipping it is right.
    An interior line is the opposite: the event was fsynced, the capture really
    was destroyed, and its directory can still be sitting there because the
    reaper had not got to it. Dropping that line silently makes rule 3 read the
    healthy manifest instead and hand back a live row — data somebody
    deliberately destroyed, resurrected by a text editor.
    """
    kept = _capture(tmp_path, capture_id=new_capture_id())
    destroyed = _capture(tmp_path, capture_id=new_capture_id())
    ledger_v2.append(
        tmp_path, "capture_deleted", instance_id=INSTANCE, capture_id=destroyed
    )
    ledger_v2.append(
        tmp_path,
        "capture_discarded",
        instance_id=INSTANCE,
        capture_id=kept,
        payload={"reason": "operator error"},
    )

    # Damage the FIRST line and leave the rest intact — an edit, not a tail.
    path = ledger_v2.ledger_path(tmp_path)
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[0] = lines[0][: len(lines[0]) // 2]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Refusing is the only honest answer: the rebuild cannot tell whether the
    # damaged line said this capture was destroyed, and the directory is still
    # there to be believed. Before this was caught, the scan came back with
    # `state='completed', deleted_at=None` for a capture that had been deleted.
    with pytest.raises(ledger_v2.LedgerUnreadableError) as excinfo:
        _run(tmp_path)
    # Named down to the line, because the operator has to go and repair it.
    assert "line 1" in str(excinfo.value)
    assert destroyed not in str(excinfo.value)  # the message is about the FILE
