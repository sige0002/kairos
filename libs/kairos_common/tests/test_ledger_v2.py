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


def test_pre_v2_and_unknown_kind_lines_are_skipped(tmp_path: Path) -> None:
    """v1 lines have a different shape entirely and a future version may write
    a kind this one has never heard of. Both are well-formed and say so, so
    neither may make the ledger unreadable — wherever in the file they sit."""
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "n"})
    with ledger.ledger_path(tmp_path).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"event": "archived", "index": "003"}) + "\n")  # v1
        handle.write(json.dumps({"schema_version": 2, "kind": "nonsense"}) + "\n")
        handle.write("\n")
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d2", "name": "n"})

    events = ledger.read_all(tmp_path)

    assert [event["kind"] for event in events] == ["dataset_created"] * 2


def test_a_write_torn_mid_line_is_skipped(tmp_path: Path) -> None:
    """ENOSPC mid-append leaves a partial last line and no newline after it.
    That event never reached the disk whole, so it never happened."""
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "n"})
    with ledger.ledger_path(tmp_path).open("a", encoding="utf-8") as handle:
        handle.write('{"schema_version":2,"kind":"dataset_del')  # no newline

    assert [event["kind"] for event in ledger.read_all(tmp_path)] == ["dataset_created"]


def test_a_hand_edited_LAST_line_is_refused_even_though_it_is_last(
    tmp_path: Path,
) -> None:
    """Position alone does not make a line forgivable — the missing newline
    does, because that is what a write dying mid-line leaves behind.

    The most recent line is the most likely one for an operator to open the
    file and 'fix', and it is the newest tombstone. Forgiving the last line
    unconditionally would drop exactly that one, silently.
    """
    _append(tmp_path, "capture_deleted", capture_id=new_capture_id())
    path = ledger.ledger_path(tmp_path)
    damaged = path.read_text(encoding="utf-8").rstrip("\n")
    # Truncated by a text editor, then saved — so the newline is still there.
    path.write_text(damaged[: len(damaged) // 2] + "\n", encoding="utf-8")

    with pytest.raises(ledger.LedgerUnreadableError, match="line 1"):
        ledger.read_all(tmp_path)


def test_an_enospc_retry_glued_onto_a_torn_line_is_refused(tmp_path: Path) -> None:
    """The case the torn-tail rule does NOT cover, reproduced through the
    module's own recovery path rather than by hand.

    ``append_with_slack_release`` retries after ENOSPC and ``write_event``
    opens O_APPEND, so the retry lands immediately after the torn bytes — same
    line, and now with a newline after it. Refusing is right: two records went
    in, one of them completed, and neither can be read back.
    """
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "n"})
    path = ledger.ledger_path(tmp_path)
    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"schema_version":2,"kind":"capture_dele')  # ENOSPC here
    # Space is freed and the append is retried; O_APPEND has no idea a partial
    # line is sitting there.
    ledger.append_with_slack_release(
        tmp_path,
        "capture_deleted",
        instance_id=new_instance_id(),
        capture_id=new_capture_id(),
    )

    text = path.read_text(encoding="utf-8")
    assert text.endswith("\n")  # the retry completed, so nothing looks torn
    with pytest.raises(ledger.LedgerUnreadableError, match="line 2"):
        ledger.read_all(tmp_path)


def test_a_damaged_line_that_is_not_a_torn_tail_is_refused(tmp_path: Path) -> None:
    """The other half of the rule above, and the reason it has to be a rule.

    A completed append is fsynced, so a whole line that no longer parses was
    changed after the fact — a hand edit, a bad sector. Skipping it would state
    "nothing was ever deleted" for whatever it said, which §5 makes
    authoritative and every consumer believes.
    """
    _append(tmp_path, "capture_deleted", capture_id=new_capture_id())
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "n"})
    path = ledger.ledger_path(tmp_path)
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[0] = lines[0][: len(lines[0]) // 2]  # interior, still newline-terminated
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(ledger.LedgerUnreadableError, match="line 1"):
        ledger.read_all(tmp_path)
    # The escape hatch degrades to what SURVIVED, not to nothing. Handing back
    # [] would answer "no capture was ever deleted and no dataset was ever
    # created" — a confident statement about the whole history, built from one
    # bad line. The tombstone is the fact that was lost; the dataset event is
    # still on disk and still true.
    degraded = ledger.read_all(tmp_path, strict=False)
    assert [event["kind"] for event in degraded] == ["dataset_created"]


def test_a_line_that_parses_to_something_other_than_an_object_is_refused(
    tmp_path: Path,
) -> None:
    """Valid JSON, but no event ever looked like this. It is damage, not a
    shape from another version — those are objects with a schema_version."""
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d1", "name": "n"})
    with ledger.ledger_path(tmp_path).open("a", encoding="utf-8") as handle:
        handle.write("[1, 2, 3]\n")
    _append(tmp_path, "dataset_created", payload={"dataset_id": "d2", "name": "n"})

    with pytest.raises(ledger.LedgerUnreadableError, match="line 2"):
        ledger.read_all(tmp_path)


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


# -- the dataset archive pair (§6.x) ------------------------------------------


def _started_payload(**overrides):
    payload = {
        "dataset_id": "d1",
        "destination": "/mnt/nas/exports/yuki/pick/ds1",
        "dataset_name": "ds1",
        "members": [
            {"membership_id": "m1", "capture_id": new_capture_id(), "display_index": 1}
        ],
    }
    payload.update(overrides)
    return payload


def test_a_dataset_archive_run_reads_back_start_to_seal(tmp_path: Path) -> None:
    """The run's whole history — freeze, per-member archives, seal — must come
    back through the existing readers without special cases."""
    capture_id = new_capture_id()
    _append(
        tmp_path,
        "dataset_archive_started",
        payload=_started_payload(
            members=[
                {"membership_id": "m1", "capture_id": capture_id, "display_index": 1}
            ]
        ),
    )
    _append(
        tmp_path,
        "capture_archived",
        capture_id=capture_id,
        payload={
            "destination": "/mnt/nas/exports/yuki/pick/ds1/001",
            "dataset_id": "d1",
            "membership_id": "m1",
            "display_index": 1,
        },
    )
    _append(
        tmp_path,
        "dataset_archived",
        payload={
            "dataset_id": "d1",
            "destination": "/mnt/nas/exports/yuki/pick/ds1",
            "dataset_name": "ds1",
            "member_total": 1,
            "bytes_total": 0,
            "manifest_sha256": "a" * 64,
        },
    )

    dataset_kinds = [event["kind"] for event in ledger.dataset_events(tmp_path)]
    assert dataset_kinds == ["dataset_archive_started", "dataset_archived"]

    member_event = ledger.archive_events(tmp_path)[capture_id]
    assert member_event["dataset_id"] == "d1"
    assert member_event["membership_id"] == "m1"
    assert member_event["display_index"] == 1

    # Not tombstones: the recordings still exist, just not here.
    assert ledger.tombstones(tmp_path) == {}


def test_a_dataset_archive_start_must_freeze_its_members(tmp_path: Path) -> None:
    """The started event is the set the resume path replays; an empty or
    malformed freeze would be a hole in a dataset that can no longer be rebuilt
    any other way."""
    for members in (
        None,
        [],
        [{"membership_id": "m1", "display_index": 1}],  # no capture_id
        [{"membership_id": "m1", "capture_id": new_capture_id(), "display_index": 0}],
        [
            {
                "membership_id": "m1",
                "capture_id": new_capture_id(),
                "display_index": True,
            }
        ],
        [["m1"]],
    ):
        with pytest.raises(ValueError, match="members"):
            _append(
                tmp_path,
                "dataset_archive_started",
                payload=_started_payload(members=members),
            )

    assert not ledger.ledger_path(tmp_path).exists()


def test_a_dataset_archive_start_names_dataset_and_destination(tmp_path: Path) -> None:
    for key in ("dataset_id", "destination", "dataset_name"):
        with pytest.raises(ValueError, match=key):
            _append(
                tmp_path,
                "dataset_archive_started",
                payload=_started_payload(**{key: ""}),
            )
    with pytest.raises(ValueError, match="reason"):
        _append(
            tmp_path, "dataset_archive_started", payload=_started_payload(reason=42)
        )


def test_the_dataset_seal_validates_its_hash_and_totals(tmp_path: Path) -> None:
    base = {"dataset_id": "d1", "destination": "/mnt/nas/exports/ds1"}

    _append(tmp_path, "dataset_archived", payload=dict(base))  # minimal form is legal

    with pytest.raises(ValueError, match="manifest_sha256"):
        _append(
            tmp_path, "dataset_archived", payload=dict(base, manifest_sha256="A" * 64)
        )
    with pytest.raises(ValueError, match="member_total"):
        _append(tmp_path, "dataset_archived", payload=dict(base, member_total=-1))
    with pytest.raises(ValueError, match="bytes_total"):
        _append(tmp_path, "dataset_archived", payload=dict(base, bytes_total=True))
    with pytest.raises(ValueError, match="destination"):
        _append(tmp_path, "dataset_archived", payload={"dataset_id": "d1"})


def test_an_archive_may_name_its_dataset_membership_but_typed(tmp_path: Path) -> None:
    """The dataset annotations ride the same optional-but-typed rule as the
    other descriptive fields: absent is fine, the wrong type is not."""
    capture_id = new_capture_id()

    _append(
        tmp_path,
        "capture_archived",
        capture_id=capture_id,
        payload={"destination": "/mnt/nas/solo"},  # per-capture archive, no dataset
    )

    with pytest.raises(ValueError, match="display_index"):
        _append(
            tmp_path,
            "capture_archived",
            capture_id=capture_id,
            payload={"destination": "/mnt/nas/solo", "display_index": "001"},
        )


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


# ---- capture_archived: the per-file audit record --------------------------


def _file(path: str = "bag_0.mcap", **overrides: object) -> dict[str, object]:
    record: dict[str, object] = {"path": path, "size": 1024, "sha256": "a" * 64}
    record.update(overrides)
    return record


def test_an_archive_can_carry_per_file_hashes(tmp_path: Path) -> None:
    """The ledger ALONE has to be able to audit an archive.

    Once the source is deleted the manifest goes with it, so without these an
    archive event can say "N bytes went to /mnt/nas" and nothing that would let
    anyone check the copy years later.
    """
    capture_id = new_capture_id()
    files = [_file("bag_0.mcap"), _file("metadata.yaml", size=64, sha256="b" * 64)]

    _append(
        tmp_path,
        "capture_archived",
        capture_id=capture_id,
        payload={"destination": "/mnt/nas/2026-08", "files": files},
    )

    stored = ledger.archive_events(tmp_path)[capture_id]
    assert stored["files"] == files


def test_the_file_list_is_optional(tmp_path: Path) -> None:
    # §9-1 puts the append before the archive proceeds, so an archive must stay
    # possible even where hashing did not happen.
    event = _append(
        tmp_path,
        "capture_archived",
        capture_id=new_capture_id(),
        payload={"destination": "/mnt/nas"},
    )
    assert "files" not in event


@pytest.mark.parametrize(
    ("files", "match"),
    [
        ("not-a-list", "must be a list"),
        ([["path", "size"]], "must be objects"),
        ([_file(size="1024")], r"files\[\]\.size"),
        ([_file(path=None)], r"files\[\]\.path"),
        ([_file(size=-1)], "must be >= 0"),
        ([_file(sha256="A" * 64)], "lowercase hex"),
        ([_file(sha256="abc")], "lowercase hex"),
        ([{"path": "x", "size": 1}], r"files\[\]\.sha256"),
        ([_file(size=True)], r"files\[\]\.size"),
    ],
)
def test_a_malformed_file_record_is_refused(
    tmp_path: Path, files: object, match: str
) -> None:
    """Validated field by field, not waved through as "a list".

    This list is an audit record that outlives everything else about the
    capture. A malformed entry is discovered when someone is trying to prove an
    archived recording is intact — the worst possible moment to learn the
    hashes were never usable.
    """
    with pytest.raises(ValueError, match=match):
        _append(
            tmp_path,
            "capture_archived",
            capture_id=new_capture_id(),
            payload={"destination": "/mnt/nas", "files": files},
        )


def test_the_file_record_shape_matches_the_manifest(tmp_path: Path) -> None:
    """Same ``{path, size, sha256}`` vocabulary as object_manifest.json (§3.2).

    One shape across both means an archived capture and a local one describe
    their bytes identically, and a caller can hand a manifest's file list
    straight to the ledger without re-keying it.
    """
    from kairos_common.capture_sidecars import ManifestFile

    entry = ManifestFile(path="bag_0.mcap", size=1024, sha256="a" * 64).to_json()
    event = _append(
        tmp_path,
        "capture_archived",
        capture_id=new_capture_id(),
        payload={"destination": "/mnt/nas", "files": [entry]},
    )
    assert event["files"] == [entry]


class TestDatasetExported:
    """§6.2: the output is exactly ``exports/<safe-name>`` — no traversal."""

    def _payload(self, **overrides):
        payload = {
            "dataset_id": "ds1",
            "export_id": "e1",
            "output": "exports/alice_full_beta1",
            "captures": [{"capture_id": new_capture_id(), "dir": "001"}],
        }
        payload.update(overrides)
        return payload

    def test_a_well_formed_export_is_accepted(self, tmp_path: Path) -> None:
        event = _append(tmp_path, "dataset_exported", payload=self._payload())
        assert event["output"] == "exports/alice_full_beta1"

    def test_an_absolute_output_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            _append(
                tmp_path,
                "dataset_exported",
                payload=self._payload(output="/abs/exports/x"),
            )

    def test_traversal_in_the_output_is_rejected(self, tmp_path: Path) -> None:
        # The old validator only rejected a leading '/', so these slipped by.
        for bad in ("../outside", "exports/../escape", "exports/a/b", "other/x"):
            with pytest.raises(ValueError):
                _append(
                    tmp_path,
                    "dataset_exported",
                    payload=self._payload(output=bad),
                )

    def test_a_captureless_export_is_rejected(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            _append(tmp_path, "dataset_exported", payload=self._payload(captures=[]))
