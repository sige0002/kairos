"""lifecycle.jsonl v2: what may be written, what reads back, and the ENOSPC exit."""

from __future__ import annotations

import errno
import json
from pathlib import Path

import pytest
from kairos_common import ledger_v2 as ledger
from kairos_common.ids import is_uuid7, new_capture_id, new_instance_id

INSTANCE = new_instance_id()


def _append(tmp_path: Path, kind: str, **kwargs):
    return ledger.append(tmp_path, kind, instance_id=INSTANCE, **kwargs)


# -- the envelope -------------------------------------------------------------


def test_append_stamps_the_envelope_and_returns_what_it_wrote(tmp_path: Path) -> None:
    capture_id = new_capture_id()

    event = _append(
        tmp_path,
        "capture_discarded",
        capture_id=capture_id,
        payload={"reason": "blurry"},
    )

    lines = ledger.ledger_path(tmp_path).read_text(encoding="utf-8").splitlines()
    assert json.loads(lines[0]) == event
    assert event["schema_version"] == 2
    assert event["kind"] == "capture_discarded"
    assert event["capture_id"] == capture_id
    assert event["source_instance_id"] == INSTANCE
    assert event["reason"] == "blurry"
    assert event["at"].endswith("Z")
    assert is_uuid7(event["event_id"])


def test_event_ids_are_unique_so_a_resume_can_be_idempotent(tmp_path: Path) -> None:
    """§7's resume replays a deletion by event_id; two events sharing one would
    make the replay skip real work."""
    ids = {
        _append(tmp_path, "dataset_deleted", payload={"dataset_id": "d"})["event_id"]
        for _ in range(50)
    }

    assert len(ids) == 50


# -- what may not be written --------------------------------------------------


def test_a_recording_lifecycle_kind_is_rejected(tmp_path: Path) -> None:
    """§9-5. Accepting one would make ``start`` depend on this file being
    writable, and recording must survive a full disk."""
    with pytest.raises(ValueError, match="unknown ledger kind"):
        _append(tmp_path, "capture_started", capture_id=new_capture_id())

    assert not ledger.ledger_path(tmp_path).exists()


def test_an_unknown_kind_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        _append(tmp_path, "capture_vaporized", capture_id=new_capture_id())


def test_a_capture_event_without_a_capture_id_is_rejected(tmp_path: Path) -> None:
    """A tombstone that does not name its capture buries nothing."""
    with pytest.raises(ValueError, match="capture_id"):
        _append(tmp_path, "capture_deleted")


def test_a_payload_may_not_forge_envelope_fields(tmp_path: Path) -> None:
    """A caller-supplied event_id could forge idempotency; a caller-supplied
    ``at`` could rewrite history."""
    with pytest.raises(ValueError, match="envelope"):
        _append(
            tmp_path,
            "capture_deleted",
            capture_id=new_capture_id(),
            payload={"event_id": "forged"},
        )


def test_an_archive_must_say_where_the_bytes_went(tmp_path: Path) -> None:
    """An archive event without a destination answers none of the questions it
    exists for."""
    with pytest.raises(ValueError, match="destination"):
        _append(tmp_path, "capture_archived", capture_id=new_capture_id())

    with pytest.raises(ValueError, match="destination"):
        _append(
            tmp_path,
            "capture_archived",
            capture_id=new_capture_id(),
            payload={"destination": ""},
        )


def test_an_archive_carries_the_description_a_rebuild_will_need(
    tmp_path: Path,
) -> None:
    """Archiving deletes the local copy, so this event is the only surviving
    description of the capture."""
    capture_id = new_capture_id()

    event = _append(
        tmp_path,
        "capture_archived",
        capture_id=capture_id,
        payload={
            "destination": "/mnt/nas/2026-08",
            "run_id": "run_20260802_101500",
            "operator": "op_a",
            "task": "pick",
            "bytes": 1024,
            "message_count": 4321,
        },
    )

    stored = ledger.archive_events(tmp_path)[capture_id]
    assert stored == event
    assert stored["operator"] == "op_a"
    assert stored["message_count"] == 4321


def test_the_descriptive_archive_fields_are_optional_but_typed(
    tmp_path: Path,
) -> None:
    """§9-1 puts this append before the archive proceeds, so a capture whose
    message_count was never determined must still be archivable — but a string
    where an int belongs would surface as a broken catalog much later."""
    minimal = _append(
        tmp_path,
        "capture_archived",
        capture_id=new_capture_id(),
        payload={"destination": "/mnt/nas"},
    )
    assert minimal["destination"] == "/mnt/nas"

    with pytest.raises(ValueError, match="bytes"):
        _append(
            tmp_path,
            "capture_archived",
            capture_id=new_capture_id(),
            payload={"destination": "/mnt/nas", "bytes": "lots"},
        )
    with pytest.raises(ValueError, match="operator"):
        _append(
            tmp_path,
            "capture_archived",
            capture_id=new_capture_id(),
            payload={"destination": "/mnt/nas", "operator": 7},
        )


def test_an_instance_id_is_required(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="instance_id"):
        ledger.append(tmp_path, "dataset_deleted", instance_id="", payload={})


# -- reading ------------------------------------------------------------------


def test_a_missing_ledger_reads_as_no_history(tmp_path: Path) -> None:
    assert ledger.read_all(tmp_path) == []
    assert ledger.tombstones(tmp_path) == {}
    assert ledger.dataset_events(tmp_path) == []


def test_unparseable_and_pre_v2_lines_are_skipped(tmp_path: Path) -> None:
    """A write that hit ENOSPC mid-line leaves a truncated tail, and v1 lines
    have a different shape entirely. Neither may make the ledger unreadable."""
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "n"})
    with ledger.ledger_path(tmp_path).open("a", encoding="utf-8") as handle:
        handle.write('{"schema_version":2,"kind":"dataset_del\n')  # truncated
        handle.write(json.dumps({"event": "archived", "index": "003"}) + "\n")  # v1
        handle.write(json.dumps({"schema_version": 2, "kind": "nonsense"}) + "\n")
        handle.write("\n")

    events = ledger.read_all(tmp_path)

    assert [event["kind"] for event in events] == ["dataset_created"]


def test_tombstones_report_the_latest_fate_per_capture(tmp_path: Path) -> None:
    kept = new_capture_id()
    discarded = new_capture_id()
    _append(
        tmp_path, "capture_discarded", capture_id=discarded, payload={"reason": "x"}
    )
    _append(tmp_path, "capture_discarded", capture_id=kept, payload={"reason": "first"})
    _append(tmp_path, "capture_deleted", capture_id=kept, payload={"reason": "final"})

    tombs = ledger.tombstones(tmp_path)

    assert set(tombs) == {kept, discarded}
    assert tombs[kept]["kind"] == "capture_deleted"
    assert tombs[kept]["reason"] == "final"


def test_an_archived_capture_is_not_a_tombstone(tmp_path: Path) -> None:
    """The bytes moved somewhere the operator chose; the capture still exists.
    Normalising that into "deleted" would lose where it went."""
    capture_id = new_capture_id()
    _append(
        tmp_path,
        "capture_archived",
        capture_id=capture_id,
        payload={"destination": "/mnt/nas/2026-08"},
    )

    assert ledger.tombstones(tmp_path) == {}
    assert ledger.archive_events(tmp_path)[capture_id]["destination"] == (
        "/mnt/nas/2026-08"
    )


def test_dataset_events_come_back_in_order(tmp_path: Path) -> None:
    """Order is the whole value: added-then-removed for one display_index is
    what says the number is retired rather than free."""
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "pick"})
    _append(
        tmp_path,
        "dataset_member_added",
        payload={"dataset_id": "d1", "membership_id": "m1", "display_index": 1},
    )
    _append(
        tmp_path,
        "dataset_member_removed",
        payload={"dataset_id": "d1", "membership_id": "m1"},
    )
    _append(tmp_path, "capture_deleted", capture_id=new_capture_id())

    kinds = [event["kind"] for event in ledger.dataset_events(tmp_path)]

    assert kinds == [
        "dataset_created",
        "dataset_member_added",
        "dataset_member_removed",
    ]


# -- the ENOSPC slack ---------------------------------------------------------


def test_ensure_slack_reserves_real_blocks_and_is_idempotent(tmp_path: Path) -> None:
    """A sparse file would reserve nothing and free nothing when deleted, which
    is the entire point of the reservation."""
    path = ledger.ensure_slack(tmp_path)

    assert path.stat().st_size == ledger.SLACK_BYTES
    assert len(path.read_bytes()) == ledger.SLACK_BYTES
    assert path.stat().st_blocks > 0  # a hole would report zero

    before = path.stat().st_mtime_ns
    assert ledger.ensure_slack(tmp_path).stat().st_mtime_ns == before


def test_a_failed_reservation_leaves_the_existing_slack_intact(
    tmp_path: Path, monkeypatch
) -> None:
    """Opening the real path for writing would truncate first, so a failure
    after that point shrinks the reserve at exactly the moment the disk is too
    full to rebuild it."""
    ledger.ensure_slack(tmp_path)
    ledger.slack_path(tmp_path).write_bytes(b"\0" * 4096)  # a short, stale reserve

    def no_space(*args, **kwargs):
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(ledger, "_allocate", no_space)

    with pytest.raises(OSError):
        ledger.ensure_slack(tmp_path)

    assert ledger.slack_path(tmp_path).stat().st_size == 4096
    assert [p.name for p in tmp_path.iterdir() if p.name.endswith(".tmp")] == []


def test_an_unreadable_ledger_is_not_reported_as_an_empty_one(
    tmp_path: Path, monkeypatch
) -> None:
    """ "I could not read it" and "nothing ever left" are opposite answers, and
    the second is the one that resurrects deleted captures."""
    _append(tmp_path, "capture_deleted", capture_id=new_capture_id())

    def unreadable(*args, **kwargs):
        raise PermissionError(13, "Permission denied")

    monkeypatch.setattr(Path, "read_text", unreadable)

    with pytest.raises(ledger.LedgerUnreadableError):
        ledger.read_all(tmp_path)
    with pytest.raises(ledger.LedgerUnreadableError):
        ledger.tombstones(tmp_path)

    # Opt-in only, for callers that genuinely degrade gracefully.
    assert ledger.read_all(tmp_path, strict=False) == []


def test_release_slack_reports_whether_there_was_anything_to_free(
    tmp_path: Path,
) -> None:
    assert ledger.release_slack(tmp_path) is False

    ledger.ensure_slack(tmp_path)
    assert ledger.release_slack(tmp_path) is True
    assert not ledger.slack_path(tmp_path).exists()


def test_a_full_disk_is_survived_by_releasing_the_slack_and_retrying(
    tmp_path: Path, monkeypatch
) -> None:
    """Discarding captures is how an operator frees a full disk, and §7 makes
    the ledger append come first — so that append must not be what blocks it."""
    ledger.ensure_slack(tmp_path)
    calls: list[str] = []
    real_append = ledger.append

    def full_disk_once(*args, **kwargs):
        calls.append("append")
        if len(calls) == 1:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real_append(*args, **kwargs)

    monkeypatch.setattr(ledger, "append", full_disk_once)
    capture_id = new_capture_id()

    event = ledger.append_with_slack_release(
        tmp_path,
        "capture_discarded",
        instance_id=INSTANCE,
        capture_id=capture_id,
        payload={"reason": "disk full"},
    )

    assert len(calls) == 2
    assert not ledger.slack_path(tmp_path).exists()
    assert ledger.tombstones(tmp_path)[capture_id]["event_id"] == event["event_id"]


def test_without_a_slack_file_the_enospc_error_propagates(
    tmp_path: Path, monkeypatch
) -> None:
    """Retrying without having freed anything would only repeat the failure with
    a more confusing traceback."""
    calls: list[str] = []

    def always_full(*args, **kwargs):
        calls.append("append")
        raise OSError(errno.ENOSPC, "No space left on device")

    monkeypatch.setattr(ledger, "append", always_full)

    with pytest.raises(OSError) as excinfo:
        ledger.append_with_slack_release(
            tmp_path,
            "capture_deleted",
            instance_id=INSTANCE,
            capture_id=new_capture_id(),
        )

    assert excinfo.value.errno == errno.ENOSPC
    assert len(calls) == 1


def test_a_non_enospc_failure_is_not_retried(tmp_path: Path, monkeypatch) -> None:
    ledger.ensure_slack(tmp_path)
    calls: list[str] = []

    def read_only_filesystem(*args, **kwargs):
        calls.append("append")
        raise OSError(errno.EROFS, "Read-only file system")

    monkeypatch.setattr(ledger, "append", read_only_filesystem)

    with pytest.raises(OSError):
        ledger.append_with_slack_release(
            tmp_path,
            "capture_deleted",
            instance_id=INSTANCE,
            capture_id=new_capture_id(),
        )

    assert len(calls) == 1
    # The reservation is untouched: it is only spent on the failure it can fix.
    assert ledger.slack_path(tmp_path).exists()
