"""dataset_archive: copy -> verify -> only then remove the source.

The ordering IS the feature, so most of these tests are about what survives a
failure. A dataset that vanished with no record is the incident this pipeline
was written against; every path that ends without a verified destination must
leave the source exactly where it was.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from dora_runner import dataset_archive
from dora_runner.dataset_archive import run_dataset_archive
from kairos_common import ApiError


def _make_dataset(data_dir: Path, operator: str, task: str, index: str) -> Path:
    dataset_dir = data_dir / operator / task / index
    dataset_dir.mkdir(parents=True)
    (dataset_dir / f"run_{index}_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 4096)
    (dataset_dir / "metadata.yaml").write_text("rosbag2: {}\n", encoding="utf-8")
    (dataset_dir / "dataset.json").write_text(
        json.dumps({"run_id": f"run_{index}", "bytes": 4104}), encoding="utf-8"
    )
    return dataset_dir


def _set_roots(monkeypatch: pytest.MonkeyPatch, value: str | None) -> None:
    """Configure the allow-list the way a DEPLOYMENT does — the environment.

    The variable name is spelled out here on purpose rather than imported from
    the source: if it were shared, a misspelling would move both sides together
    and the tests would keep passing while archiving silently read nothing.
    ``None`` means the variable is absent, which is not the same case as an
    empty value and is worth being able to express.
    """
    if value is None:
        monkeypatch.delenv("KAIROS_ARCHIVE_ROOTS", raising=False)
    else:
        monkeypatch.setenv("KAIROS_ARCHIVE_ROOTS", value)


def _archive(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **over):
    """Run an archive with a tmp data_dir + an allow-listed destination root.

    ``roots`` overrides the environment value (``None`` unsets it); everything
    else is forwarded to :func:`run_dataset_archive`.
    """
    data_dir = over.pop("data_dir", tmp_path / "data")
    root = over.pop("root", tmp_path / "nas")
    roots = over.pop("roots", str(root))
    root.mkdir(parents=True, exist_ok=True)
    _set_roots(monkeypatch, roots)
    kwargs = {
        "data_dir": data_dir,
        "dataset_dir": "yuki/pick/001",
        "destination": str(root / "yuki" / "pick" / "001"),
    }
    kwargs.update(over)
    return run_dataset_archive(**kwargs)


def test_copies_verifies_then_removes_the_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    original = {p.name: p.read_bytes() for p in source.iterdir()}

    out = _archive(tmp_path, monkeypatch)

    summary = out["summary"]
    destination = Path(summary["destination"])
    # Every byte arrived…
    assert {p.name: p.read_bytes() for p in destination.iterdir()} == original
    # …the summary is auditable without the source (it is gone)…
    assert summary["file_count"] == 3
    assert summary["verified"] == "sha256-readback"
    assert summary["source_removed"] is True
    assert all(len(f["sha256"]) == 64 for f in summary["files"])
    assert summary["bytes"] == sum(len(b) for b in original.values())
    # …and the source is gone, husk parents pruned.
    assert not source.exists()
    assert not (data_dir / "yuki").exists()


def test_a_failed_verification_never_removes_the_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE test. Corruption between write and read-back must abort the delete."""
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    before = {p.name: p.read_bytes() for p in source.iterdir()}

    # The destination read-back disagrees with what we wrote.
    monkeypatch.setattr(dataset_archive, "_sha256", lambda _path: "0" * 64)

    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch)

    assert excinfo.value.code == "archive_verify_failed"
    assert "source is untouched" in excinfo.value.message
    assert source.is_dir()
    assert {p.name: p.read_bytes() for p in source.iterdir()} == before


def test_a_short_write_is_caught_by_size_before_the_delete(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Truncation is the common NAS failure; it must not need the checksum."""
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")

    real_copy = dataset_archive._sha256_and_copy

    def truncating_copy(src: Path, dst: Path) -> tuple[str, int]:
        digest, size = real_copy(src, dst)
        dst.write_bytes(dst.read_bytes()[:-10])  # something ate the tail
        return digest, size

    monkeypatch.setattr(dataset_archive, "_sha256_and_copy", truncating_copy)

    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch)

    assert excinfo.value.code == "archive_verify_failed"
    assert "bytes at the destination" in excinfo.value.message
    assert source.is_dir()


def test_a_missing_destination_file_is_caught(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")

    real_copy = dataset_archive._sha256_and_copy

    def vanishing_copy(src: Path, dst: Path) -> tuple[str, int]:
        digest, size = real_copy(src, dst)
        dst.unlink()
        return digest, size

    monkeypatch.setattr(dataset_archive, "_sha256_and_copy", vanishing_copy)

    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch)
    assert excinfo.value.code == "archive_verify_failed"
    assert source.is_dir()


def test_a_destination_outside_the_allow_list_is_refused_before_any_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    outside = tmp_path / "outside"

    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch, destination=str(outside / "ep"))

    assert excinfo.value.code == "destination_not_allowed"
    assert source.is_dir()
    assert not outside.exists()  # nothing was written


def test_the_runner_refuses_when_archiving_is_unconfigured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Defence in depth: the job re-checks even though the API checked first."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch, roots="")
    assert excinfo.value.code == "archive_not_configured"


def test_a_non_empty_destination_is_refused_rather_than_merged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")
    root = tmp_path / "nas"
    target = root / "yuki" / "pick" / "001"
    target.mkdir(parents=True)
    (target / "debris_from_a_failed_run.mcap").write_bytes(b"stale")

    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch, root=root)

    assert excinfo.value.code == "destination_not_empty"
    assert source.is_dir()
    assert (target / "debris_from_a_failed_run.mcap").read_bytes() == b"stale"


def test_an_empty_destination_directory_is_fine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-created by an operator or an mkdir -p is normal, not debris."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    root = tmp_path / "nas"
    (root / "yuki" / "pick" / "001").mkdir(parents=True)

    out = _archive(tmp_path, monkeypatch, root=root)
    assert out["summary"]["source_removed"] is True


def test_a_traversal_dataset_dir_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    for bad in ("../../etc", "recorded/run_a/x", "yuki/pick", "yuki/pick/001/extra"):
        with pytest.raises(ApiError) as excinfo:
            _archive(tmp_path, monkeypatch, dataset_dir=bad)
        assert excinfo.value.code in {"invalid_dataset_dir", "dataset_not_found"}


def test_an_unknown_dataset_is_a_404(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "data").mkdir()
    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch)
    assert excinfo.value.status_code == 404


def test_a_directory_without_dataset_json_is_not_a_dataset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same rule as delete: never remove an arbitrary directory."""
    data_dir = tmp_path / "data"
    stray = data_dir / "yuki" / "pick" / "001"
    stray.mkdir(parents=True)
    (stray / "something.mcap").write_bytes(b"x")

    with pytest.raises(ApiError) as excinfo:
        _archive(tmp_path, monkeypatch)
    assert excinfo.value.code == "dataset_not_found"
    assert stray.is_dir()


def test_the_departure_is_recorded_before_the_source_is_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The record must survive a crash between the two steps.

    Whoever destroys the data records it first: if the ledger were written
    afterwards (or by the caller once the job returned), a crash in between
    would leave the source gone with nothing saying where it went — and the
    index number quietly reusable.
    """
    from kairos_common import lifecycle_ledger

    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "003")
    seen: list[bool] = []

    real_append = lifecycle_ledger.append

    def append_then_observe(dir_, entry):
        real_append(dir_, entry)
        seen.append(source.is_dir())  # was the source still there?

    monkeypatch.setattr(lifecycle_ledger, "append", append_then_observe)

    _archive(tmp_path, monkeypatch, dataset_dir="yuki/pick/003")

    assert seen == [True]  # recorded while the data still existed
    entries = lifecycle_ledger.read_all(data_dir)
    assert len(entries) == 1
    assert entries[0]["event"] == "archived"
    assert entries[0]["index"] == "003"
    assert entries[0]["run_id"] == "run_003"
    # The retired number can never be handed out again.
    assert lifecycle_ledger.retired_indices(data_dir, "yuki", "pick") == {3}


def test_the_reason_and_topic_signature_reach_the_ledger(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ledger line is all that remains, so it carries WHY and WHICH robot."""
    from kairos_common import lifecycle_ledger

    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    (data_dir / "yuki" / "pick" / "001" / "metadata.yaml").write_text(
        "rosbag2_bagfile_information:\n"
        "  topics_with_message_count:\n"
        "    - topic_metadata: {name: /hsrb/joint_states,"
        " type: sensor_msgs/msg/JointState}\n"
        "      message_count: 9\n",
        encoding="utf-8",
    )

    _archive(tmp_path, monkeypatch, reason="moved to the NAS")

    entry = lifecycle_ledger.read_all(data_dir)[0]
    assert entry["reason"] == "moved to the NAS"
    assert isinstance(entry["topics_hash"], str) and entry["topics_hash"]
    assert entry["topic_count"] == 1
    assert entry["destination"].endswith("/yuki/pick/001")


def test_a_ledger_that_cannot_be_written_stops_the_removal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from kairos_common import lifecycle_ledger

    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "yuki", "pick", "001")

    def boom(*_a, **_kw):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(lifecycle_ledger, "append", boom)

    with pytest.raises(OSError):
        _archive(tmp_path, monkeypatch)

    # The copy exists at the destination, but the source is NOT removed — an
    # unrecorded departure is worse than a duplicate.
    assert source.is_dir()


def test_the_departure_is_recorded_by_the_process_that_deletes(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The ledger entry is written by the archive job itself, before the rmtree.

    Recording it from the caller instead — once the job reports success — leaves
    a window in which the bytes are gone and the index number is free again,
    which is the one state the ledger exists to prevent. A service restart lands
    in that window for real, so the write belongs to the process that deletes.
    """
    from kairos_common import lifecycle_ledger

    data_dir = tmp_path / "data"
    nas = tmp_path / "nas"
    nas.mkdir()
    source = _make_dataset(data_dir, "op", "pick", "003")
    # A real rosbag2 metadata block, so the signature is actually computable —
    # the shared fixture's stub yields an honest "unknown" instead.
    (source / "metadata.yaml").write_text(
        "rosbag2_bagfile_information:\n"
        "  topics_with_message_count:\n"
        "  - topic_metadata: {name: /joint_states, type: sensor_msgs/msg/JointState}\n"
        "    message_count: 12\n",
        encoding="utf-8",
    )

    _set_roots(monkeypatch, str(nas))
    run_dataset_archive(
        data_dir=data_dir,
        dataset_dir="op/pick/003",
        destination=str(nas / "e003"),
        reason="moved to the NAS",
    )

    assert not source.exists()
    entries = lifecycle_ledger.read_all(data_dir)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["event"] == "archived"
    assert entry["index"] == "003"
    assert entry["destination"] == str(nas / "e003")
    assert entry["reason"] == "moved to the NAS"
    # The signature is computed from the bag while it is still readable — this
    # is the last moment it can be, and dataset.json may predate the signature.
    assert isinstance(entry["topics_hash"], str) and entry["topics_hash"]


def test_a_failed_archive_records_nothing_and_keeps_the_source(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Writing the entry first must not mean writing it optimistically."""
    from kairos_common import ApiError, lifecycle_ledger

    data_dir = tmp_path / "data"
    nas = tmp_path / "nas"
    nas.mkdir()
    source = _make_dataset(data_dir, "op", "pick", "003")

    _set_roots(monkeypatch, str(nas))
    with pytest.raises(ApiError):
        run_dataset_archive(
            data_dir=data_dir,
            dataset_dir="op/pick/003",
            destination="/etc/not-allowed",
        )

    assert source.is_dir()
    assert lifecycle_ledger.read_all(data_dir) == []


def test_a_destination_overlapping_the_data_dir_is_refused(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Verified by codex review, 2026-07-27.

    With an archive root that contains the data directory, archiving into the
    source's own subdirectory copies, verifies, and then `rmtree(source)`
    deletes the verified archive along with the original — a job reporting
    success with nothing left anywhere.
    """
    from kairos_common import ApiError

    data_dir = tmp_path / "data"
    source = _make_dataset(data_dir, "op", "pick", "001")

    # A root that CONTAINS the data directory — the configuration that makes
    # this overlap reachable at all.
    _set_roots(monkeypatch, str(tmp_path))
    with pytest.raises(ApiError) as excinfo:
        run_dataset_archive(
            data_dir=data_dir,
            dataset_dir="op/pick/001",
            destination=str(source / "archive"),
        )

    assert excinfo.value.code == "destination_inside_data_dir"
    assert source.is_dir()
    assert (source / "run_001_0.mcap").is_file()


def test_the_allow_list_is_read_from_the_environment_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The branch a DEPLOYMENT takes, stated outright.

    Until 2026-07-27 every test injected the roots as a parameter, so this read
    — the only one that runs in production — was never executed by the suite. A
    misspelled variable name would have passed CI and shipped as "archiving is
    silently unconfigured", or worse, configured differently than the operator
    believes. The two halves below are what make this a NAME test: only reading
    that exact variable can flip the outcome between them.
    """
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    nas = tmp_path / "nas"
    nas.mkdir()
    call = {
        "data_dir": data_dir,
        "dataset_dir": "yuki/pick/001",
        "destination": str(nas / "ep001"),
    }

    # Absent -> refused, and no parameter exists that could override it.
    monkeypatch.delenv("KAIROS_ARCHIVE_ROOTS", raising=False)
    with pytest.raises(ApiError) as excinfo:
        run_dataset_archive(**call)
    assert excinfo.value.code == "archive_not_configured"
    assert (data_dir / "yuki" / "pick" / "001").is_dir()  # nothing was touched

    # Set to a REAL root -> the identical call now goes through.
    monkeypatch.setenv("KAIROS_ARCHIVE_ROOTS", str(nas))
    summary = run_dataset_archive(**call)["summary"]
    assert summary["source_removed"] is True
    assert (nas / "ep001" / "run_001_0.mcap").is_file()


def test_a_second_root_in_the_environment_value_is_honoured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A real deployment sets several roots, colon-separated (the PATH shape).

    Exercises env value -> parse -> allow-list end to end, so a change that
    broke the separator handling could not pass by testing a single-root value.
    """
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001")
    first = tmp_path / "nas_a"
    second = tmp_path / "nas_b"
    first.mkdir()
    second.mkdir()
    monkeypatch.setenv("KAIROS_ARCHIVE_ROOTS", f"{first}:{second}")

    summary = run_dataset_archive(
        data_dir=data_dir,
        dataset_dir="yuki/pick/001",
        destination=str(second / "ep001"),
    )["summary"]

    assert (second / "ep001" / "run_001_0.mcap").is_file()
    assert summary["source_removed"] is True
