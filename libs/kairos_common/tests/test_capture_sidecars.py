"""object_manifest.json / record.json: what they must reject, and never lose."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest
from kairos_common import capture_sidecars as sidecars
from kairos_common.capture_sidecars import (
    ManifestFile,
    ObjectManifestV2,
    RecordV2,
    SidecarStatus,
)
from kairos_common.ids import new_capture_id, new_instance_id


def _manifest(capture_id: str | None = None, **overrides) -> ObjectManifestV2:
    fields = {
        "capture_id": capture_id or new_capture_id(),
        "source_instance_id": new_instance_id(),
        "run_id": "run_20260802_101500",
        "state": "completed",
        "started_at": "2026-08-02T10:15:00.000Z",
        "ended_at": "2026-08-02T10:17:30.000Z",
        "operator": "op_a",
        "task": "pick",
        "robot": "airoa_hsr",
        "topics": ({"name": "/tf", "type": "tf2_msgs/msg/TFMessage", "qos": {}},),
    }
    fields.update(overrides)
    return ObjectManifestV2(**fields)


# -- reading: absent, corrupt and valid are three different answers ------------


def test_a_missing_manifest_is_missing_not_corrupt(tmp_path: Path) -> None:
    read = sidecars.read_object_manifest(tmp_path)

    assert read.status is SidecarStatus.missing
    assert read.manifest is None
    assert read.path.name == "object_manifest.json"


def test_a_zero_byte_manifest_is_corrupt(tmp_path: Path) -> None:
    """§8 rule 4. A crash between rename and writeback leaves exactly this, and
    reading it as "no capture here" silently drops a recording from the catalog."""
    path = tmp_path / "object_manifest.json"
    path.write_bytes(b"")

    read = sidecars.read_object_manifest(path)

    assert read.status is SidecarStatus.corrupt
    assert "empty" in (read.error or "")


def test_truncated_json_is_corrupt(tmp_path: Path) -> None:
    path = tmp_path / "object_manifest.json"
    full = json.dumps(_manifest().to_json())
    path.write_text(full[: len(full) // 2], encoding="utf-8")

    read = sidecars.read_object_manifest(path)

    assert read.status is SidecarStatus.corrupt
    assert "JSON" in (read.error or "")


def test_a_pre_v2_manifest_is_corrupt_rather_than_half_understood(
    tmp_path: Path,
) -> None:
    """Old sidecars are not read at all (alpha reset). Saying so beats a cascade
    of "missing field" errors from a file that was never meant to parse here."""
    path = tmp_path / "object_manifest.json"
    path.write_text(json.dumps({"run_id": "run_1", "state": "completed"}), "utf-8")

    read = sidecars.read_object_manifest(path)

    assert read.status is SidecarStatus.corrupt
    assert "schema_version" in (read.error or "")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("capture_id", "not-a-uuid7"),
        ("state", "deleted"),  # a DB state a manifest may never claim
        ("digest_state", "half"),
        ("run_id", ""),
        ("source_instance_id", None),
    ],
)
def test_a_manifest_with_an_impossible_field_is_corrupt(
    tmp_path: Path, field: str, value: object
) -> None:
    payload = _manifest().to_json()
    payload[field] = value
    path = tmp_path / "object_manifest.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    assert sidecars.read_object_manifest(path).status is SidecarStatus.corrupt


def test_read_accepts_the_capture_directory_or_the_file_itself(
    tmp_path: Path,
) -> None:
    """A scan walks directories; a caller reading objects/<id>.failed.json has
    an exact path whose name is not object_manifest.json."""
    manifest = _manifest()
    sidecars.write_object_manifest(tmp_path, manifest)

    assert sidecars.read_object_manifest(tmp_path).ok
    assert sidecars.read_object_manifest(tmp_path / "object_manifest.json").ok


# -- roundtrip ----------------------------------------------------------------


def test_a_manifest_survives_a_write_read_cycle_unchanged(tmp_path: Path) -> None:
    manifest = _manifest(
        message_count=12345,
        bytes=987_654_321,
        compression="zstd",
        split={"max_bagfile_size": 1024},
        dropped_messages=0,
        integrity="ok",
        error=None,
        files=(ManifestFile(path="run_0.mcap", size=10, sha256="a" * 64),),
        digest_state="complete",
        manifest_digest="sha256:" + "b" * 64,
    )
    sidecars.write_object_manifest(tmp_path, manifest)

    assert sidecars.read_object_manifest(tmp_path).manifest == manifest


def test_unknown_fields_survive_the_digest_jobs_rewrite(tmp_path: Path) -> None:
    """§3.3 has the digest job rewrite the whole manifest in one atomic write.
    Dropping a field a newer recorder wrote would be a silent data loss."""
    payload = _manifest().to_json()
    payload["camera_calibration_id"] = "cal-2026-08"
    path = tmp_path / "object_manifest.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    manifest = sidecars.read_object_manifest(path).manifest
    assert manifest is not None
    assert manifest.extra == {"camera_calibration_id": "cal-2026-08"}

    sealed = sidecars.write_object_manifest(
        tmp_path, replace(manifest, digest_state="complete")
    )
    rewritten = json.loads(sealed.read_text(encoding="utf-8"))
    assert rewritten["camera_calibration_id"] == "cal-2026-08"
    assert rewritten["digest_state"] == "complete"


def test_files_none_and_files_empty_are_different_statements(tmp_path: Path) -> None:
    """``null`` = the digest job has not run. ``[]`` = it ran and found nothing,
    which is a far more alarming thing to say."""
    sidecars.write_object_manifest(tmp_path, _manifest(files=None))
    assert json.loads((tmp_path / "object_manifest.json").read_text())["files"] is None

    sidecars.write_object_manifest(tmp_path, _manifest(files=()))
    assert json.loads((tmp_path / "object_manifest.json").read_text())["files"] == []


def test_imported_provenance_is_omitted_for_recorded_captures(tmp_path: Path) -> None:
    sidecars.write_object_manifest(tmp_path, _manifest())
    payload = json.loads((tmp_path / "object_manifest.json").read_text())
    assert "imported_from" not in payload

    sidecars.write_object_manifest(
        tmp_path,
        _manifest(
            operator=None, task=None, imported_from="/mnt/usb/bag", imported_at="Z"
        ),
    )
    payload = json.loads((tmp_path / "object_manifest.json").read_text())
    assert payload["imported_from"] == "/mnt/usb/bag"


# -- digest -------------------------------------------------------------------


def test_manifest_digest_does_not_depend_on_listing_order() -> None:
    """The digest is a property of the capture, not of the order the filesystem
    happened to hand back its entries — two machines holding the same bytes must
    compute the same string."""
    files = [
        ManifestFile(path="b.mcap", size=2, sha256="b" * 64),
        ManifestFile(path="a.mcap", size=1, sha256="a" * 64),
        ManifestFile(path="metadata.yaml", size=3, sha256="c" * 64),
    ]

    forward = sidecars.manifest_digest(files)
    backward = sidecars.manifest_digest(list(reversed(files)))

    assert forward == backward
    assert forward.startswith("sha256:")
    assert len(forward) == len("sha256:") + 64


def test_manifest_digest_matches_a_frozen_golden_vector() -> None:
    """Pins §3.2's canonicalization to a constant computed by hand from the spec
    text (``path\\nsize\\nsha256\\n`` per file, path-sorted, no separators
    between files). Every other digest test would still pass if the rule silently
    changed shape; this one is what makes such a change a failing test rather
    than a fleet of replicas that no longer verify against their own manifests.
    """
    files = [
        ManifestFile(path="run_0.mcap", size=1048576, sha256="b" * 64),
        ManifestFile(path="a.mcap", size=1, sha256="a" * 64),
        ManifestFile(path="metadata.yaml", size=3, sha256="c" * 64),
    ]

    assert sidecars.manifest_digest(files) == (
        "sha256:d6c402926f07bfde461dff2c2e6e552681e86ec38b6883222ea876d4f1f03b8d"
    )


def test_manifest_digest_accepts_plain_mappings_too() -> None:
    """Callers holding decoded JSON should not have to rebuild dataclasses."""
    as_objects = [ManifestFile(path="a.mcap", size=1, sha256="a" * 64)]
    as_dicts = [{"path": "a.mcap", "size": 1, "sha256": "a" * 64}]

    assert sidecars.manifest_digest(as_objects) == sidecars.manifest_digest(as_dicts)


@pytest.mark.parametrize(
    "changed",
    [
        ManifestFile(path="a.mcap", size=1, sha256="f" * 64),
        ManifestFile(path="a.mcap", size=2, sha256="a" * 64),
        ManifestFile(path="renamed.mcap", size=1, sha256="a" * 64),
    ],
)
def test_any_change_to_a_file_changes_the_digest(changed: ManifestFile) -> None:
    base = [ManifestFile(path="a.mcap", size=1, sha256="a" * 64)]

    assert sidecars.manifest_digest([changed]) != sidecars.manifest_digest(base)


@pytest.mark.parametrize(
    "sha256",
    [
        "short",
        "A" * 64,  # uppercase would hash to a different digest for one file
        "g" * 64,  # right length, not hex
        "a" * 63 + " ",
    ],
)
def test_manifest_digest_rejects_anything_that_is_not_a_sha256_hex(sha256: str) -> None:
    """§3.2 concatenates this string straight into the digest, so a spelling that
    is not exactly hashlib's output makes two identical replicas compare
    unequal — and the mismatch would be blamed on the bytes, not the string."""
    with pytest.raises(ValueError, match="sha256"):
        sidecars.manifest_digest([{"path": "a.mcap", "size": 1, "sha256": sha256}])


def test_manifest_digest_rejects_entries_it_cannot_hash() -> None:
    with pytest.raises(ValueError):
        sidecars.manifest_digest([{"path": "a.mcap", "size": -1, "sha256": "a" * 64}])
    with pytest.raises(ValueError):
        sidecars.manifest_digest([{"path": "", "size": 1, "sha256": "a" * 64}])


# -- record.json --------------------------------------------------------------


def test_a_record_survives_a_write_read_cycle(tmp_path: Path) -> None:
    record = RecordV2(
        capture_id=new_capture_id(),
        revision=3,
        review_status="adopted",
        task_result="success",
        quality="good",
        quality_source="operator",
        batch_id="batch_20260802_101500",
        index_in_batch=4,
        updated_at="2026-08-02T10:20:00.000Z",
    )
    sidecars.write_record(tmp_path, record)

    assert sidecars.read_record(tmp_path).record == record


def test_writing_a_record_stamps_updated_at(tmp_path: Path) -> None:
    sidecars.write_record(tmp_path, RecordV2(capture_id=new_capture_id(), revision=1))

    payload = json.loads((tmp_path / "record.json").read_text(encoding="utf-8"))
    assert payload["updated_at"].endswith("Z")


def test_a_record_claiming_revision_zero_is_corrupt(tmp_path: Path) -> None:
    """Revision 0 is spelled "no record.json at all" (§4). A file claiming it
    would make §4.1's CAS compare against a value no legal save can produce."""
    payload = RecordV2(capture_id=new_capture_id(), revision=1).to_json()
    payload["revision"] = 0
    (tmp_path / "record.json").write_text(json.dumps(payload), encoding="utf-8")

    read = sidecars.read_record(tmp_path)

    assert read.status is SidecarStatus.corrupt
    assert "revision" in (read.error or "")


def test_a_record_cannot_be_constructed_at_revision_zero() -> None:
    """§4.1 step 2 writes base_revision + 1. A caller that computed 0 there would
    produce a sidecar the step-3 CAS can never match, so review saves would fail
    with nothing to point at."""
    with pytest.raises(ValueError, match="revision"):
        RecordV2(capture_id=new_capture_id(), revision=0)
    with pytest.raises(ValueError, match="revision"):
        RecordV2(capture_id=new_capture_id(), revision=-1)


def test_an_unreviewed_capture_has_no_record_file(tmp_path: Path) -> None:
    read = sidecars.read_record(tmp_path)

    assert read.status is SidecarStatus.missing
    assert read.record is None


def test_an_unknown_review_status_is_corrupt(tmp_path: Path) -> None:
    payload = RecordV2(capture_id=new_capture_id(), revision=1).to_json()
    payload["review_status"] = "maybe"
    (tmp_path / "record.json").write_text(json.dumps(payload), encoding="utf-8")

    assert sidecars.read_record(tmp_path).status is SidecarStatus.corrupt


# -- paths --------------------------------------------------------------------


def test_path_helpers_refuse_an_id_that_is_not_a_uuid7(tmp_path: Path) -> None:
    """capture_id becomes a directory name, so this is what keeps
    objects/<capture_id> inside objects/."""
    for bad in ("../../etc", "run_20260802", "", "a/b"):
        with pytest.raises(ValueError):
            sidecars.capture_dir(tmp_path, bad)
        with pytest.raises(ValueError):
            sidecars.failed_start_path(tmp_path, bad)


def test_capture_paths_are_built_under_objects(tmp_path: Path) -> None:
    capture_id = new_capture_id()

    assert sidecars.capture_dir(tmp_path, capture_id) == (
        tmp_path / "objects" / capture_id
    )
    assert sidecars.object_manifest_path(tmp_path, capture_id).name == (
        "object_manifest.json"
    )
    assert sidecars.failed_start_path(tmp_path, capture_id) == (
        tmp_path / "objects" / f"{capture_id}.failed.json"
    )


def test_a_failed_start_writes_a_sibling_and_never_a_capture_directory(
    tmp_path: Path,
) -> None:
    """§3.4's invariant: a directory under objects/ means bytes were written.
    A failed start that created one would look like a real recording to a scan."""
    manifest = _manifest(state="failed", ended_at=None, error="ros2 bag exited 1")

    path = sidecars.write_failed_start(tmp_path, manifest)

    assert path == sidecars.failed_start_path(tmp_path, manifest.capture_id)
    assert not sidecars.capture_dir(tmp_path, manifest.capture_id).exists()
    assert sidecars.read_object_manifest(path).manifest == manifest


def test_the_manifest_writer_refuses_a_failed_start_path(tmp_path: Path) -> None:
    """It would otherwise create objects/<id>.failed.json as a DIRECTORY and put
    the manifest inside — breaking §3.4's invariant in the one place it has to
    hold."""
    manifest = _manifest(state="failed")
    path = sidecars.failed_start_path(tmp_path, manifest.capture_id)

    with pytest.raises(ValueError, match="write_failed_start"):
        sidecars.write_object_manifest(path, manifest)

    assert not path.exists()
