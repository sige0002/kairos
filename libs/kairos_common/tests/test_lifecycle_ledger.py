"""The lifecycle ledger: what left the catalog, and why a number stays retired."""

from __future__ import annotations

import json
from pathlib import Path

from kairos_common import lifecycle_ledger as ledger


def _entry(index: str, event: str = "archived", **kwargs) -> ledger.LedgerEntry:
    return ledger.LedgerEntry(
        event=event,  # type: ignore[arg-type]
        operator="op_a",
        task="pick",
        index=index,
        **kwargs,
    )


def test_append_writes_one_json_line_per_departure(tmp_path: Path) -> None:
    ledger.append(tmp_path, _entry("003", destination="/mnt/nas/2026-07"))
    ledger.append(tmp_path, _entry("004", event="deleted", reason="bad data"))

    lines = ledger.ledger_path(tmp_path).read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["event"] == "archived"
    assert first["destination"] == "/mnt/nas/2026-07"
    assert first["at"].endswith("Z")
    # Absent optionals are omitted rather than written as null: a ledger line is
    # kept small because it is the file that grows forever.
    assert "reason" not in first
    assert json.loads(lines[1])["reason"] == "bad data"


def test_retired_indices_covers_both_departures(tmp_path: Path) -> None:
    """Archive and delete both retire a number — the bytes' fate differs, the
    path's identity does not."""
    ledger.append(tmp_path, _entry("003"))
    ledger.append(tmp_path, _entry("004", event="deleted"))
    ledger.append(tmp_path, _entry("009"))

    assert ledger.retired_indices(tmp_path, "op_a", "pick") == {3, 4, 9}
    # Scoped per (operator, task): another task's history must not skip numbers.
    assert ledger.retired_indices(tmp_path, "op_a", "place") == set()
    assert ledger.retired_indices(tmp_path, "op_b", "pick") == set()


def test_a_malformed_line_cannot_inflate_the_high_water_mark(tmp_path: Path) -> None:
    """A corrupt line must be skipped, not parsed into a huge index that would
    skip a whole block of numbers for every future export."""
    ledger.append(tmp_path, _entry("003"))
    with ledger.ledger_path(tmp_path).open("a", encoding="utf-8") as handle:
        handle.write("{not json\n")
        handle.write(
            json.dumps({"operator": "op_a", "task": "pick", "index": "NaN"}) + "\n"
        )
        handle.write("\n")

    assert ledger.retired_indices(tmp_path, "op_a", "pick") == {3}


def test_missing_ledger_reads_as_no_history(tmp_path: Path) -> None:
    assert ledger.read_all(tmp_path) == []
    assert ledger.retired_indices(tmp_path, "op_a", "pick") == set()
    assert ledger.find(tmp_path, "op_a", "pick", "003") is None


def test_find_answers_where_did_it_go(tmp_path: Path) -> None:
    """The question the ledger exists for. The latest entry for a path wins, so
    a re-archived-then-deleted path reports its final fate."""
    ledger.append(tmp_path, _entry("003", destination="/mnt/nas/old"))
    ledger.append(tmp_path, _entry("003", event="deleted", reason="superseded"))

    found = ledger.find(tmp_path, "op_a", "pick", "003")
    assert found is not None
    assert found["event"] == "deleted"
    assert found["reason"] == "superseded"


def test_signature_is_carried_so_an_archived_episode_stays_identifiable(
    tmp_path: Path,
) -> None:
    """Without the bag you cannot recompute it, and the topic signature is what
    says which embodiment the archived episode was."""
    ledger.append(tmp_path, _entry("003", topics_hash="97d89b0b", topic_count=7))

    found = ledger.find(tmp_path, "op_a", "pick", "003")
    assert found["topics_hash"] == "97d89b0b"
    assert found["topic_count"] == 7
