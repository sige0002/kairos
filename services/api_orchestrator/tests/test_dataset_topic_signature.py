"""The catalog's topic signature (``topics_hash`` / ``topic_count``).

2026-07-26 ML-consumer finding F1: one ``(task, condition)`` group held nine
``/hsrb/*`` episodes and two ``/camera/*`` ones — disjoint observation/action
spaces presented as a single dataset. The catalog now carries a comparable
signature per row so that split is visible before a conversion is attempted.

Pinned here: the signature is served on both list paths (catalog + tree scan)
with an identical row shape, exports written before the field existed HEAL from
their own ``metadata.yaml``, and an unreadable bag stays honestly null.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from api_orchestrator import datasets_index
from api_orchestrator.routers.datasets import _scan_datasets
from kairos_common.bag_metadata import topic_signature

HSR_TOPICS = [
    ("/hsrb/joint_states", "sensor_msgs/msg/JointState", 600),
    ("/hsrb/hand_camera/image_raw/compressed", "sensor_msgs/msg/CompressedImage", 300),
]
MYROBOT_TOPICS = [
    ("/left_arm_controller/joint_states", "sensor_msgs/msg/JointState", 600),
    ("/camera/head/color/image_raw/compressed", "sensor_msgs/msg/CompressedImage", 300),
]


def _write_metadata(dataset_dir: Path, topics: list[tuple[str, str, int]]) -> None:
    payload = {
        "rosbag2_bagfile_information": {
            "version": 9,
            "storage_identifier": "mcap",
            "topics_with_message_count": [
                {
                    "topic_metadata": {"name": name, "type": type_},
                    "message_count": count,
                }
                for name, type_, count in topics
            ],
        }
    }
    (dataset_dir / "metadata.yaml").write_text(
        yaml.safe_dump(payload), encoding="utf-8"
    )


def _make_dataset(
    data_dir: Path,
    operator: str,
    task: str,
    index: str,
    *,
    topics: list[tuple[str, str, int]] | None,
    signed: bool,
) -> Path:
    """An exported dataset dir; ``signed`` writes the fields into dataset.json.

    ``signed=False`` reproduces a LEGACY export (written before the signature
    existed): the sidecar has no topic fields, only the bag's metadata.yaml.
    """
    dataset_dir = data_dir / operator / task / index
    dataset_dir.mkdir(parents=True)
    meta: dict = {"run_id": f"run_{index}", "bytes": 10, "exported_at": "t"}
    if topics is not None:
        _write_metadata(dataset_dir, topics)
        if signed:
            signature = topic_signature(dataset_dir)
            assert signature is not None
            meta["topics_hash"] = signature.hash
            meta["topic_count"] = signature.count
    (dataset_dir / "dataset.json").write_text(json.dumps(meta), encoding="utf-8")
    return dataset_dir


def test_scan_serves_the_signature_written_at_export(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=True)

    (row,) = _scan_datasets(data_dir)
    expected = topic_signature(data_dir / "yuki" / "pick" / "001")
    assert expected is not None
    assert row["topics_hash"] == expected.hash
    assert row["topic_count"] == 2


def test_legacy_export_heals_from_its_own_metadata_yaml(tmp_path: Path) -> None:
    """No topic fields in dataset.json: the scan derives them from the bag."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=False)

    (row,) = _scan_datasets(data_dir)
    assert isinstance(row["topics_hash"], str) and row["topics_hash"]
    assert row["topic_count"] == 2


def test_disjoint_topic_sets_are_distinguishable_on_the_catalog(tmp_path: Path) -> None:
    """The finding itself: same task+condition, two different embodiments."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=True)
    _make_dataset(data_dir, "yuki", "pick", "002", topics=MYROBOT_TOPICS, signed=True)

    rows = _scan_datasets(data_dir)
    hashes = {r["index"]: r["topics_hash"] for r in rows}
    assert hashes["001"] != hashes["002"]
    # Same topic COUNT — so a count alone would have hidden the split; the hash
    # is what makes it visible.
    assert {r["topic_count"] for r in rows} == {2}


def test_unreadable_bag_stays_null_not_a_shared_hash(tmp_path: Path) -> None:
    """Two datasets with no metadata must NOT compare equal to each other."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=None, signed=False)
    _make_dataset(data_dir, "yuki", "pick", "002", topics=None, signed=False)

    rows = _scan_datasets(data_dir)
    assert [r["topics_hash"] for r in rows] == [None, None]
    assert [r["topic_count"] for r in rows] == [None, None]


def test_catalog_row_and_list_row_carry_the_signature(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    dataset_dir = _make_dataset(
        data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=True
    )
    meta = json.loads((dataset_dir / "dataset.json").read_text(encoding="utf-8"))

    row = datasets_index.index_row(dataset_dir, meta, None, data_dir)
    assert row is not None
    assert row["topics_hash"] == meta["topics_hash"]
    assert row["topic_count"] == 2

    listed = datasets_index.to_list_row(row, data_dir)
    assert listed["topics_hash"] == meta["topics_hash"]
    assert listed["topic_count"] == 2


def test_a_legacy_catalog_heals_lazily_on_the_first_read(tmp_path: Path) -> None:
    """Rows written before the field existed must not serve None forever.

    The catalog is written the OLD way (no topic keys at all); simply listing it
    fills them in from each bag and persists the result.
    """
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=False)
    _make_dataset(data_dir, "yuki", "pick", "002", topics=MYROBOT_TOPICS, signed=False)
    legacy_rows = [
        {
            "operator": "yuki",
            "task": "pick",
            "index": idx,
            "dataset_dir": f"yuki/pick/{idx}",
            "run_id": f"run_{idx}",
            "schema_version": 1,
        }
        for idx in ("001", "002")
    ]
    datasets_index._atomic_write(datasets_index.index_path(data_dir), legacy_rows)

    served = datasets_index.list_from_index(data_dir)
    assert served is not None
    hashes = {r["index"]: r["topics_hash"] for r in served}
    assert all(isinstance(h, str) and h for h in hashes.values())
    assert hashes["001"] != hashes["002"]  # the split is visible immediately

    # Persisted, so the ~5 ms/episode is paid once rather than per request.
    on_disk = datasets_index.read_rows(data_dir)
    assert on_disk is not None
    assert {r["topics_hash"] for r in on_disk} == set(hashes.values())


def test_backfill_marks_an_unreadable_bag_so_it_is_not_retried(tmp_path: Path) -> None:
    """A permanently unreadable bag must be attempted ONCE, not on every read."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=None, signed=False)
    rows = [
        {
            "operator": "yuki",
            "task": "pick",
            "index": "001",
            "dataset_dir": "yuki/pick/001",
            "schema_version": 1,
        }
    ]

    assert datasets_index.backfill_topic_signature(data_dir, rows) == 1
    assert rows[0]["topics_hash"] is None  # honest unknown, never a hash
    # The KEY is now present, which is what marks the row as already attempted.
    assert "topics_hash" in rows[0]
    assert datasets_index.backfill_topic_signature(data_dir, rows) == 0


def test_backfill_is_a_no_op_once_rows_carry_the_field(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    dataset_dir = _make_dataset(
        data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=True
    )
    meta = json.loads((dataset_dir / "dataset.json").read_text(encoding="utf-8"))
    row = datasets_index.index_row(dataset_dir, meta, None, data_dir)
    assert row is not None

    assert datasets_index.backfill_topic_signature(data_dir, [row]) == 0


def test_rebuild_preserves_the_signature_and_matches_the_scan(tmp_path: Path) -> None:
    """The two serving paths must stay byte-for-byte identical."""
    data_dir = tmp_path / "data"
    _make_dataset(data_dir, "yuki", "pick", "001", topics=HSR_TOPICS, signed=False)
    _make_dataset(data_dir, "yuki", "pick", "002", topics=MYROBOT_TOPICS, signed=True)

    scan = _scan_datasets(data_dir)
    assert datasets_index.rebuild(data_dir, scan) == 2
    served = datasets_index.list_from_index(data_dir)
    assert served == scan
    # …and both actually CARRY the signature (equality alone would also hold if
    # neither path had it, which is exactly the pre-change state).
    hashes = {r["index"]: r["topics_hash"] for r in served}
    assert all(isinstance(h, str) and h for h in hashes.values())
    assert hashes["001"] != hashes["002"]
    assert {r["topic_count"] for r in served} == {2}
