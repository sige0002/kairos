"""Importing an external rosbag into Review.

The bag fixtures here are synthetic but structurally real: a directory with a
``*.mcap`` file written by the ``mcap`` library (so the readability check is
exercised for real, not mocked) plus a rosbag2-shaped ``metadata.yaml``.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml
from api_orchestrator import bag_import
from fastapi.testclient import TestClient
from kairos_common import Settings
from kairos_common.errors import ApiError


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    """The service's data root for this test (never the repo's real ./data)."""
    return tmp_path / "data"


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    """Override conftest's settings so recorded/ lands under tmp_path."""
    return Settings(
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
        data_dir=str(data_dir),
        recorded_dir=str(data_dir / "recorded"),
    )


def write_mcap(path: Path, topic: str = "/hsrb/joint_states") -> None:
    """Write a small but genuinely valid MCAP file (with a summary section)."""
    from mcap.writer import Writer

    with path.open("wb") as fh:
        writer = Writer(fh)
        writer.start()
        schema_id = writer.register_schema(
            name="std_msgs/msg/String", encoding="ros2msg", data=b"string data"
        )
        channel_id = writer.register_channel(
            topic=topic, message_encoding="cdr", schema_id=schema_id
        )
        writer.add_message(
            channel_id=channel_id,
            log_time=1_000_000_000,
            data=b"\x00",
            publish_time=1_000_000_000,
        )
        writer.finish()


def metadata_doc(
    *,
    topic: str = "/hsrb/joint_states",
    message_count: int = 1,
    empty_topic: bool = False,
) -> dict:
    topics = [
        {
            "topic_metadata": {"name": topic, "type": "sensor_msgs/msg/JointState"},
            "message_count": message_count,
        }
    ]
    if empty_topic:
        topics.append(
            {
                "topic_metadata": {
                    "name": "/never_published",
                    "type": "std_msgs/msg/Empty",
                },
                "message_count": 0,
            }
        )
    return {
        "rosbag2_bagfile_information": {
            "version": 5,
            "storage_identifier": "mcap",
            "message_count": message_count,
            "starting_time": {"nanoseconds_since_epoch": 1_700_000_000_000_000_000},
            "duration": {"nanoseconds": 12_500_000_000},
            "topics_with_message_count": topics,
        }
    }


@pytest.fixture
def bag_dir(tmp_path: Path) -> Path:
    """A well-formed external rosbag2/MCAP directory."""
    source = tmp_path / "external" / "rosbag2_2026_07_27-11_00_00"
    source.mkdir(parents=True)
    write_mcap(source / "rosbag2_0.mcap")
    (source / "metadata.yaml").write_text(
        yaml.safe_dump(metadata_doc()), encoding="utf-8"
    )
    return source


# ---- validation: every rejection must name the problem --------------------


def test_missing_path_is_rejected_with_the_path(tmp_path: Path) -> None:
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(tmp_path / "nope", recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_source_missing"
    assert "nope" in exc.value.message


def test_a_file_is_not_a_bag_directory(tmp_path: Path) -> None:
    lone = tmp_path / "bag.mcap"
    write_mcap(lone)
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(lone, recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_source_not_a_directory"


def test_directory_without_mcap_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "empty"
    source.mkdir()
    (source / "metadata.yaml").write_text(
        yaml.safe_dump(metadata_doc()), encoding="utf-8"
    )
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(source, recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_no_mcap"
    # The message has to say what kind of bag we DO take.
    assert "ros2 bag record" in exc.value.message


def test_missing_metadata_is_rejected_and_names_the_remedy(
    bag_dir: Path, tmp_path: Path
) -> None:
    """Rejected, not accepted-with-a-warning — see inspect_source's docstring.

    Without metadata.yaml the run would report bag_local=false forever (Review
    reads that as "still on the robot"), carry an unknown topic signature, and
    be unvalidatable. All four consequences are invisible at import time, so
    the import is the only place the operator can still be told.
    """
    (bag_dir / "metadata.yaml").unlink()
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_no_metadata"
    assert "ros2 bag reindex" in exc.value.message
    assert exc.value.details["remedy"].startswith("ros2 bag reindex")


def test_unparseable_metadata_is_rejected(bag_dir: Path, tmp_path: Path) -> None:
    (bag_dir / "metadata.yaml").write_text("{{{ not yaml", encoding="utf-8")
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_unreadable_metadata"


def test_unreadable_mcap_is_rejected(bag_dir: Path, tmp_path: Path) -> None:
    """A truncated bag must be caught here, not by a validator days later."""
    (bag_dir / "rosbag2_0.mcap").write_bytes(b"not an mcap file at all")
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_unreadable_mcap"


def test_bag_with_no_message_carrying_topic_is_rejected(
    bag_dir: Path, tmp_path: Path
) -> None:
    doc = metadata_doc(message_count=0)
    doc["rosbag2_bagfile_information"]["topics_with_message_count"][0][
        "message_count"
    ] = 0
    (bag_dir / "metadata.yaml").write_text(yaml.safe_dump(doc), encoding="utf-8")
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    assert exc.value.code == "import_no_topics"


def test_source_inside_recorded_is_rejected(tmp_path: Path) -> None:
    """Importing a run onto itself would just make a second copy of it."""
    recorded = tmp_path / "data" / "recorded"
    source = recorded / "run_20260727_120000"
    source.mkdir(parents=True)
    write_mcap(source / "rosbag2_0.mcap")
    (source / "metadata.yaml").write_text(
        yaml.safe_dump(metadata_doc()), encoding="utf-8"
    )
    with pytest.raises(ApiError) as exc:
        bag_import.inspect_source(source, recorded_dir=recorded)
    assert exc.value.code == "import_source_inside_recorded"


# ---- what the bag declares -------------------------------------------------


def test_inspect_reads_the_bags_own_numbers(bag_dir: Path, tmp_path: Path) -> None:
    bag = bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    assert bag.message_count == 1
    assert bag.duration_s == pytest.approx(12.5)
    assert bag.started_at is not None and bag.started_at.endswith("Z")
    assert bag.ended_at is not None and bag.ended_at > bag.started_at
    assert bag.topics == [("/hsrb/joint_states", "sensor_msgs/msg/JointState")]
    assert bag.bytes > 0


def test_topics_that_recorded_nothing_are_left_out(
    bag_dir: Path, tmp_path: Path
) -> None:
    """Same rule as the topic signature: an empty topic is an ABSENT modality.

    If the two disagreed, a run's topic list and its signature would describe
    different bags.
    """
    (bag_dir / "metadata.yaml").write_text(
        yaml.safe_dump(metadata_doc(empty_topic=True)), encoding="utf-8"
    )
    bag = bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    assert [name for name, _ in bag.topics] == ["/hsrb/joint_states"]


def test_session_payload_never_invents_operator_or_task(
    bag_dir: Path, tmp_path: Path
) -> None:
    bag = bag_import.inspect_source(bag_dir, recorded_dir=tmp_path / "rec")
    payload = bag_import.session_payload(bag, "imported_20260727_110000", moved=False)
    assert payload["operator"] is None
    assert payload["task"] is None
    # Provenance survives even though the run_id doesn't encode it.
    assert payload["imported_from"] == str(bag_dir)
    assert payload["import_mode"] == "copy"
    assert payload["topics"] == ["/hsrb/joint_states"]


def test_generated_run_id_satisfies_the_run_id_charset() -> None:
    """``^[A-Za-z0-9_-]+$`` — the charset mcap_utils.validate_run_id and the
    recorder both enforce, since the id becomes a directory name."""
    assert re.fullmatch(r"[A-Za-z0-9_-]+", bag_import.allocate_import_run_id())


# ---- the endpoint ----------------------------------------------------------


def _post_import(client: TestClient, source: Path, **body: object) -> dict:
    resp = client.post("/api/v1/imports", json={"source_path": str(source), **body})
    assert resp.status_code == 202, resp.text
    return resp.json()


def _await_import(
    client: TestClient, import_id: str, expect: str = "succeeded"
) -> dict:
    """Poll until the queued copy finishes.

    The import is deliberately a background task, and TestClient only turns the
    event loop while it is servicing a request — so polling the status endpoint
    is both what a real client does and what gives the copy its turns.
    """
    for _ in range(200):
        status = client.get(f"/api/v1/imports/{import_id}").json()
        if status["state"] != "running":
            assert status["state"] == expect, status
            return status
        time.sleep(0.01)
    raise AssertionError(f"import {import_id} never finished")


def test_import_lands_a_run_review_can_see(
    client: TestClient, bag_dir: Path, data_dir: Path
) -> None:
    started = _post_import(client, bag_dir)
    run_id = started["run_id"]
    assert run_id.startswith("imported_")

    _await_import(client, started["import_id"])

    run_dir = data_dir / "recorded" / run_id
    assert (run_dir / "rosbag2_0.mcap").is_file()
    # metadata.yaml at the FINAL path is the "complete, never partial" marker
    # RunService._bag_local keys on.
    assert (run_dir / "metadata.yaml").is_file()

    session = json.loads((run_dir / "session.json").read_text(encoding="utf-8"))
    assert session["operator"] is None and session["task"] is None
    assert session["imported_from"] == str(bag_dir)

    listed = client.get("/api/v1/runs").json()["items"]
    imported = next(r for r in listed if r["run_id"] == run_id)
    assert imported["state"] == "completed"
    assert imported["bag_local"] is True
    assert [t["name"] for t in imported["topics"]] == ["/hsrb/joint_states"]
    assert imported["message_count"] == 1


def test_copy_is_the_default_and_leaves_the_source_alone(
    client: TestClient, bag_dir: Path
) -> None:
    started = _post_import(client, bag_dir)
    _await_import(client, started["import_id"])
    assert (bag_dir / "rosbag2_0.mcap").is_file()
    assert (bag_dir / "metadata.yaml").is_file()


def test_move_removes_the_source_only_on_success(
    client: TestClient, bag_dir: Path, data_dir: Path
) -> None:
    started = _post_import(client, bag_dir, move=True)
    _await_import(client, started["import_id"])
    assert not bag_dir.exists()
    assert (data_dir / "recorded" / started["run_id"] / "rosbag2_0.mcap").is_file()


def test_a_failed_import_leaves_no_run_no_staging_and_an_intact_source(
    client: TestClient, bag_dir: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The half-imported case: nothing may look complete, and move must not delete."""

    def boom(bag: object, staging: Path) -> int:
        staging.mkdir(parents=True, exist_ok=True)
        (staging / "rosbag2_0.mcap").write_bytes(b"partial")
        raise OSError("disk full")

    monkeypatch.setattr(bag_import, "copy_into_staging", boom)
    started = _post_import(client, bag_dir, move=True)

    status = _await_import(client, started["import_id"], expect="failed")
    assert "disk full" in status["error"]["message"]

    run_id = started["run_id"]
    assert not (data_dir / "recorded" / run_id).exists()
    assert not (data_dir / "recorded" / ".incoming" / run_id).exists()
    # move=true, but the import failed — the operator's data is still theirs.
    assert (bag_dir / "rosbag2_0.mcap").is_file()
    assert client.get(f"/api/v1/runs/{run_id}").status_code == 404


def test_bad_source_fails_the_request_not_a_background_job(
    client: TestClient, tmp_path: Path
) -> None:
    """Validation is synchronous so the operator learns immediately."""
    resp = client.post("/api/v1/imports", json={"source_path": str(tmp_path / "ghost")})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "import_source_missing"
    assert client.get("/api/v1/imports").json()["imports"] == []


def test_two_imports_of_the_same_bag_get_distinct_runs(
    client: TestClient, bag_dir: Path, data_dir: Path
) -> None:
    first = _post_import(client, bag_dir)
    _await_import(client, first["import_id"])
    second = _post_import(client, bag_dir)
    _await_import(client, second["import_id"])
    assert first["run_id"] != second["run_id"]
    assert (data_dir / "recorded" / first["run_id"]).is_dir()
    assert (data_dir / "recorded" / second["run_id"]).is_dir()


def test_move_keeps_the_source_when_the_import_fails_AFTER_copying(
    client: TestClient, bag_dir: Path, data_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The destructive window: copy succeeded, finalize did not.

    ``move=true`` must delete the operator's bag only once the import is
    irreversibly complete. Deleting it any earlier — e.g. straight after the
    copy, while the rename can still fail — destroys the only good copy of a
    recording in exchange for a run that never appeared.
    """

    def boom(staging: Path, final: Path) -> None:
        raise OSError("cross-device link")

    monkeypatch.setattr(bag_import, "finalize", boom)
    started = _post_import(client, bag_dir, move=True)
    status = _await_import(client, started["import_id"], expect="failed")
    assert "cross-device link" in status["error"]["message"]

    # The source is still the operator's.
    assert (bag_dir / "rosbag2_0.mcap").is_file()
    assert (bag_dir / "metadata.yaml").is_file()
    # And nothing half-imported was left behind.
    run_id = started["run_id"]
    assert not (data_dir / "recorded" / run_id).exists()
    assert not (data_dir / "recorded" / ".incoming" / run_id).exists()
    assert client.get(f"/api/v1/runs/{run_id}").status_code == 404


def test_move_never_deletes_what_it_did_not_import(tmp_path: Path) -> None:
    """Verified by codex review, 2026-07-27.

    The staging copy takes top-level FILES only — a nested directory is
    deliberately not smuggled into the run. `move` used to `rmtree` the whole
    source, so an operator's `notes/` beside the bag was destroyed having never
    been imported: data that then existed nowhere.
    """
    source = tmp_path / "src"
    source.mkdir()
    (source / "bag_0.mcap").write_bytes(b"\x89MCAP0\r\n" + b"x" * 128)
    (source / "metadata.yaml").write_text("rosbag2: {}\n", encoding="utf-8")
    (source / "notes").mkdir()
    (source / "notes" / "calibration.md").write_text("hand-eye offsets\n")

    bag = SimpleNamespace(path=source)
    remaining = bag_import.remove_moved_source(bag)

    # The imported files are gone…
    assert not (source / "bag_0.mcap").exists()
    assert not (source / "metadata.yaml").exists()
    # …and what was never imported survives, named rather than destroyed.
    assert remaining == ["notes"]
    assert (source / "notes" / "calibration.md").read_text() == "hand-eye offsets\n"


def test_move_removes_the_source_directory_when_it_held_only_the_bag(
    tmp_path: Path,
) -> None:
    source = tmp_path / "src"
    source.mkdir()
    (source / "bag_0.mcap").write_bytes(b"x" * 32)
    (source / "metadata.yaml").write_text("rosbag2: {}\n", encoding="utf-8")

    assert bag_import.remove_moved_source(SimpleNamespace(path=source)) == []
    assert not source.exists()
