"""Capture store v2 — schema, CAS review saves, leases, replicas, datasets.

The store is the queryable cache in front of the sidecars, so the tests that
matter most are the ones about *disagreement*: a compare-and-swap that loses,
a lease that expired, a display_index that must never be handed out twice.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest
from api_orchestrator.models import (
    Batch,
    Capture,
    CaptureError,
    CaptureState,
    CaptureTopic,
    Split,
    TopicQos,
    ValidationTemplate,
)
from api_orchestrator.store import (
    SCHEMA_VERSION,
    CaptureStore,
    DatasetMemberExistsError,
)
from kairos_common.ids import new_capture_id, new_dataset_id
from kairos_common.rebuild import CaptureRow, ReplicaRow, ReplicaState

INSTANCE = "11111111-2222-3333-4444-555555555555"


def _make_capture(**kwargs: object) -> Capture:
    """A minimal terminal capture; override any field per test."""
    defaults: dict[str, object] = {
        "capture_id": new_capture_id(),
        "run_id": "run_20260801_120000",
        "source_instance_id": INSTANCE,
        "state": CaptureState.completed,
        "operator": "alice",
        "task": "pick_place",
        "robot": "myrobot",
        "started_at": "2026-08-01T12:00:00.000Z",
        "ended_at": "2026-08-01T12:01:00.000Z",
    }
    defaults.update(kwargs)
    return Capture(**defaults)  # type: ignore[arg-type]


@pytest.fixture
def store(tmp_path: Path) -> Iterator[CaptureStore]:
    s = CaptureStore(tmp_path / "kairos.db", data_dir=tmp_path)
    yield s
    s.close()


class TestSchema:
    def test_fresh_db_is_stamped_with_the_v2_user_version(self, tmp_path: Path) -> None:
        db = tmp_path / "kairos.db"
        store = CaptureStore(db, data_dir=tmp_path)
        store.close()
        conn = sqlite3.connect(db)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        conn.close()

    def test_fresh_db_is_not_reported_as_discarded(self, tmp_path: Path) -> None:
        store = CaptureStore(tmp_path / "kairos.db", data_dir=tmp_path)
        # A database that never existed was not thrown away; only a version
        # mismatch is, and the caller uses this flag to decide whether a full
        # rebuild is mandatory (§8).
        assert store.was_discarded is False
        store.close()

    def test_a_wrong_version_db_is_discarded_and_recreated(
        self, tmp_path: Path
    ) -> None:
        db = tmp_path / "kairos.db"
        conn = sqlite3.connect(db)
        conn.execute("PRAGMA user_version = 1")
        conn.execute("CREATE TABLE runs (run_id TEXT)")
        conn.execute("INSERT INTO runs VALUES ('run_old')")
        conn.commit()
        conn.close()

        store = CaptureStore(db, data_dir=tmp_path)
        assert store.was_discarded is True
        # No migration: the v1 table is gone, not carried forward (alpha reset).
        with pytest.raises(sqlite3.OperationalError):
            store.execute_read("SELECT * FROM runs")
        store.close()

    def test_reopening_a_v2_db_keeps_its_rows(self, tmp_path: Path) -> None:
        db = tmp_path / "kairos.db"
        first = CaptureStore(db, data_dir=tmp_path)
        capture = first.create_capture(_make_capture())
        first.close()

        second = CaptureStore(db, data_dir=tmp_path)
        assert second.was_discarded is False
        assert second.get_capture(capture.capture_id) is not None
        second.close()


class TestCaptureRoundTrip:
    def test_json_columns_survive_a_write_and_read(self, store: CaptureStore) -> None:
        capture = _make_capture(
            topics=[
                CaptureTopic(
                    name="/joint_states",
                    type="sensor_msgs/msg/JointState",
                    qos=TopicQos(
                        reliability="reliable", durability="volatile", depth=10
                    ),
                )
            ],
            split=Split(max_size_mb=512),
            error=CaptureError(code="boom", message="it broke"),
        )
        store.create_capture(capture)

        loaded = store.get_capture(capture.capture_id)
        assert loaded is not None
        assert loaded.topics[0].name == "/joint_states"
        assert loaded.topics[0].qos is not None
        assert loaded.topics[0].qos.depth == 10
        assert loaded.split is not None and loaded.split.max_size_mb == 512
        assert loaded.error is not None and loaded.error.code == "boom"

    def test_a_null_topic_type_reads_back_instead_of_breaking_the_catalog(
        self, store: CaptureStore
    ) -> None:
        # A failed start's sidecar records topics before type discovery, as an
        # explicit null (§3.4). E2E §13-4 found one such rebuilt row turning
        # EVERY catalog read into a 500 — permanently, since the row is in the
        # DB. Write the raw shape the sidecar produces and read the whole list.
        capture = _make_capture()
        capture = capture.model_copy(
            update={
                "topics": [CaptureTopic.model_validate({"name": "/x", "type": None})]
            }
        )
        store.create_capture(capture)
        listed, _ = store.list_captures(limit=10)
        assert [t.type for t in listed[0].topics] == [""]

    def test_an_unreviewed_capture_reads_back_at_revision_zero(
        self, store: CaptureStore
    ) -> None:
        capture = store.create_capture(_make_capture())
        loaded = store.get_capture(capture.capture_id)
        assert loaded is not None
        # Revision 0 is the spelling of "no record.json exists" (§4).
        assert loaded.review_revision == 0
        assert loaded.review_status == "pending"

    def test_run_id_may_be_null_for_many_captures(self, store: CaptureStore) -> None:
        # run_id is UNIQUE, and SQLite treats every NULL as distinct — which is
        # what lets a ledger-only tombstone row (no run_id recoverable) coexist
        # with another.
        store.create_capture(_make_capture(run_id=None))
        store.create_capture(_make_capture(run_id=None))
        assert len(store.list_captures(limit=10)[0]) == 2


class TestListFilters:
    @pytest.fixture
    def populated(self, store: CaptureStore) -> CaptureStore:
        store.create_capture(
            _make_capture(operator="alice", task="pick", robot="r1", run_id="run_a")
        )
        store.create_capture(
            _make_capture(
                operator="bob",
                task="place",
                robot="r2",
                run_id="run_b",
                review_status="adopted",
                batch_id="batch_1",
            )
        )
        store.create_capture(
            _make_capture(
                operator="alice",
                task="pick",
                robot="r1",
                run_id="run_c",
                state=CaptureState.failed,
            )
        )
        return store

    @pytest.mark.parametrize(
        ("filters", "expected"),
        [
            ({"operator": "alice"}, 2),
            ({"task": "place"}, 1),
            ({"robot": "r1"}, 2),
            ({"state": "failed"}, 1),
            ({"review_status": "adopted"}, 1),
            ({"batch_id": "batch_1"}, 1),
            ({"operator": "alice", "state": "completed"}, 1),
            ({"operator": "nobody"}, 0),
        ],
    )
    def test_filters_select_the_expected_rows(
        self, populated: CaptureStore, filters: dict[str, str], expected: int
    ) -> None:
        items, _ = populated.list_captures(limit=50, **filters)
        assert len(items) == expected

    def test_pagination_walks_every_row_exactly_once(
        self, populated: CaptureStore
    ) -> None:
        seen: list[str] = []
        cursor: int | None = None
        for _ in range(5):
            page, cursor = populated.list_captures(limit=2, cursor=cursor)
            seen.extend(c.capture_id for c in page)
            if cursor is None:
                break
        assert len(seen) == 3
        assert len(set(seen)) == 3

    def test_tombstoned_captures_are_excluded_by_default(
        self, store: CaptureStore
    ) -> None:
        alive = store.create_capture(_make_capture(run_id="run_alive"))
        buried = store.create_capture(
            _make_capture(run_id="run_buried", state=CaptureState.discarded)
        )
        items, _ = store.list_captures(limit=50)
        ids = {c.capture_id for c in items}
        # The row survives a deletion (§7) so "where did it go" stays
        # answerable, but a default list is the operator's working set.
        assert alive.capture_id in ids
        assert buried.capture_id not in ids

        items, _ = store.list_captures(limit=50, include_deleted=True)
        assert buried.capture_id in {c.capture_id for c in items}


class TestReviewCas:
    def test_a_matching_base_revision_applies_the_update(
        self, store: CaptureStore
    ) -> None:
        capture = store.create_capture(_make_capture())
        ok = store.save_review_cas(
            capture.capture_id,
            base_revision=0,
            fields={"review_status": "adopted", "task_result": "success"},
        )
        assert ok is True
        loaded = store.get_capture(capture.capture_id)
        assert loaded is not None
        assert loaded.review_revision == 1
        assert loaded.review_status == "adopted"

    def test_a_stale_base_revision_changes_nothing(self, store: CaptureStore) -> None:
        capture = store.create_capture(_make_capture())
        store.save_review_cas(
            capture.capture_id, base_revision=0, fields={"review_status": "adopted"}
        )
        # A second terminal still holding revision 0 must lose, not merge.
        ok = store.save_review_cas(
            capture.capture_id, base_revision=0, fields={"review_status": "excluded"}
        )
        assert ok is False
        loaded = store.get_capture(capture.capture_id)
        assert loaded is not None
        assert loaded.review_status == "adopted"
        assert loaded.review_revision == 1

    def test_cas_against_a_missing_capture_is_false_not_an_error(
        self, store: CaptureStore
    ) -> None:
        assert (
            store.save_review_cas(
                new_capture_id(), base_revision=0, fields={"review_status": "adopted"}
            )
            is False
        )


class TestLease:
    def test_a_lease_can_be_taken_and_read_back(self, store: CaptureStore) -> None:
        capture = store.create_capture(_make_capture())
        assert store.acquire_lease(capture.capture_id, "digest", ttl_s=60) is True
        loaded = store.get_capture(capture.capture_id)
        assert loaded is not None
        assert loaded.lease_owner == "digest"

    def test_a_second_owner_cannot_take_a_live_lease(self, store: CaptureStore) -> None:
        capture = store.create_capture(_make_capture())
        store.acquire_lease(capture.capture_id, "digest", ttl_s=60)
        assert store.acquire_lease(capture.capture_id, "export", ttl_s=60) is False

    def test_the_same_owner_may_renew(self, store: CaptureStore) -> None:
        capture = store.create_capture(_make_capture())
        store.acquire_lease(capture.capture_id, "digest", ttl_s=60)
        assert store.acquire_lease(capture.capture_id, "digest", ttl_s=60) is True

    def test_an_expired_lease_no_longer_blocks(self, store: CaptureStore) -> None:
        capture = store.create_capture(_make_capture())
        store.acquire_lease(capture.capture_id, "digest", ttl_s=-1)
        # An expired lease is not a lease: a job that died holding one must not
        # lock its capture out of deletion forever (§7.1).
        assert store.has_live_lease(capture.capture_id) is False
        assert store.acquire_lease(capture.capture_id, "export", ttl_s=60) is True

    def test_release_only_succeeds_for_the_holder(self, store: CaptureStore) -> None:
        capture = store.create_capture(_make_capture())
        store.acquire_lease(capture.capture_id, "digest", ttl_s=60)
        assert store.release_lease(capture.capture_id, "export") is False
        assert store.release_lease(capture.capture_id, "digest") is True
        assert store.has_live_lease(capture.capture_id) is False


class TestReplicas:
    def test_upsert_replaces_the_row_for_one_instance(
        self, store: CaptureStore
    ) -> None:
        capture = store.create_capture(_make_capture())
        store.upsert_replica(
            capture.capture_id, INSTANCE, ReplicaState.present_unverified, path="/x"
        )
        store.upsert_replica(
            capture.capture_id,
            INSTANCE,
            ReplicaState.present_verified,
            path="/x",
            manifest_digest="sha256:" + "a" * 64,
        )
        replica = store.get_replica(capture.capture_id, INSTANCE)
        assert replica is not None
        assert replica.state == ReplicaState.present_verified
        assert replica.manifest_digest == "sha256:" + "a" * 64
        assert replica.verified_at is not None

    def test_digest_state_is_derived_from_the_replica(
        self, store: CaptureStore
    ) -> None:
        capture = store.create_capture(_make_capture())
        store.upsert_replica(
            capture.capture_id, INSTANCE, ReplicaState.present_unverified
        )
        loaded = store.get_capture(capture.capture_id, instance_id=INSTANCE)
        assert loaded is not None
        assert loaded.digest_state == "pending"

        store.upsert_replica(
            capture.capture_id, INSTANCE, ReplicaState.present_verified
        )
        loaded = store.get_capture(capture.capture_id, instance_id=INSTANCE)
        assert loaded is not None
        # Only a verified replica may say "complete": that is §9-4's rule
        # expressed as a derivation rather than a second column to keep in sync.
        assert loaded.digest_state == "complete"

    def test_present_replica_count_is_the_threshold_denominator(
        self, store: CaptureStore
    ) -> None:
        for state in (
            ReplicaState.present_unverified,
            ReplicaState.present_verified,
            ReplicaState.trashed,
            ReplicaState.missing_unmanaged,
            ReplicaState.absent_managed,
        ):
            capture = store.create_capture(_make_capture(run_id=f"run_{state}"))
            store.upsert_replica(capture.capture_id, INSTANCE, state)
        # §9-3: the denominator is present_* replicas of THIS instance, not the
        # capture count — a store full of tombstones must not inflate it.
        assert store.count_present_replicas(INSTANCE) == 2


class TestDatasets:
    def test_display_index_is_not_reused_after_a_removal(
        self, store: CaptureStore
    ) -> None:
        dataset_id = new_dataset_id()
        store.create_dataset(dataset_id, name="ds", operator="alice", task="pick")
        first = store.add_dataset_member(
            dataset_id, store.create_capture(_make_capture(run_id="run_1")).capture_id
        )
        assert first.display_index == 1
        store.remove_dataset_member(dataset_id, first.membership_id)

        second = store.add_dataset_member(
            dataset_id, store.create_capture(_make_capture(run_id="run_2")).capture_id
        )
        # 1 is retired, not free: reusing it would make two different takes
        # share an identity in every export and report that cites the number.
        assert second.display_index == 2

    def test_the_high_water_mark_can_be_seeded_from_history(
        self, store: CaptureStore
    ) -> None:
        dataset_id = new_dataset_id()
        store.create_dataset(dataset_id, name="ds")
        # A rebuild replays the ledger and knows 7 numbers were once issued even
        # though no member row survives.
        store.set_display_index_high_water(dataset_id, 7)
        member = store.add_dataset_member(
            dataset_id, store.create_capture(_make_capture()).capture_id
        )
        assert member.display_index == 8

    def test_the_same_capture_cannot_join_a_dataset_twice(
        self, store: CaptureStore
    ) -> None:
        dataset_id = new_dataset_id()
        store.create_dataset(dataset_id, name="ds")
        capture = store.create_capture(_make_capture())
        store.add_dataset_member(dataset_id, capture.capture_id)
        with pytest.raises(DatasetMemberExistsError):
            store.add_dataset_member(dataset_id, capture.capture_id)

    def test_membership_lookup_answers_the_delete_guard(
        self, store: CaptureStore
    ) -> None:
        dataset_id = new_dataset_id()
        store.create_dataset(dataset_id, name="ds")
        capture = store.create_capture(_make_capture())
        assert store.dataset_memberships_for(capture.capture_id) == []
        store.add_dataset_member(dataset_id, capture.capture_id)
        # §7 refuses to delete a capture a dataset still cites; this is the read
        # that decides it.
        assert len(store.dataset_memberships_for(capture.capture_id)) == 1


class TestDatasetArchive:
    def _dataset(self, store: CaptureStore, name: str = "ds") -> str:
        dataset_id = new_dataset_id()
        store.create_dataset(dataset_id, name=name, operator="alice", task="pick")
        return dataset_id

    def test_only_one_start_wins_the_cas(self, store: CaptureStore) -> None:
        dataset_id = self._dataset(store)

        assert store.begin_dataset_archive(dataset_id, destination="/mnt/nas/ds")
        # The WHERE clause is the concurrency story: the second start finds no
        # active row to flip and learns it lost without any lock being held.
        assert not store.begin_dataset_archive(dataset_id, destination="/mnt/nas/ds")

        row = store.get_dataset(dataset_id)
        assert row is not None
        assert row["status"] == "archiving"
        assert row["archive_destination"] == "/mnt/nas/ds"
        assert row["archive_started_at"] is not None

    def test_abort_rolls_an_unledgered_start_back(self, store: CaptureStore) -> None:
        dataset_id = self._dataset(store)
        store.begin_dataset_archive(dataset_id, destination="/mnt/nas/ds")

        store.abort_dataset_archive(dataset_id)

        row = store.get_dataset(dataset_id)
        assert row is not None
        assert row["status"] == "active"
        assert row["archive_destination"] is None
        assert row["archive_started_at"] is None

    def test_finish_seals_only_an_archiving_dataset(self, store: CaptureStore) -> None:
        dataset_id = self._dataset(store)
        assert not store.finish_dataset_archive(dataset_id)  # never started

        store.begin_dataset_archive(dataset_id, destination="/mnt/nas/ds")
        assert store.finish_dataset_archive(dataset_id)
        assert not store.finish_dataset_archive(dataset_id)  # already sealed

        row = store.get_dataset(dataset_id)
        assert row is not None
        assert row["status"] == "archived"
        assert row["archived_at"] is not None
        # Terminal means terminal: a new start finds no active row.
        assert not store.begin_dataset_archive(dataset_id, destination="/elsewhere")

    def test_replay_marks_are_idempotent_and_never_unseal(
        self, store: CaptureStore
    ) -> None:
        dataset_id = self._dataset(store)
        store.mark_dataset_archiving(
            dataset_id, destination="/mnt/nas/ds", at="2026-08-01T00:00:00.000Z"
        )
        store.mark_dataset_archiving(
            dataset_id, destination="/mnt/nas/ds", at="2026-08-01T00:00:00.000Z"
        )
        store.mark_dataset_archived(dataset_id, at="2026-08-01T01:00:00.000Z")
        # A replay reads oldest-first, but a stray started line after the seal
        # must not reopen a sealed dataset.
        store.mark_dataset_archiving(
            dataset_id, destination="/mnt/nas/ds", at="2026-08-01T02:00:00.000Z"
        )

        row = store.get_dataset(dataset_id)
        assert row is not None
        assert row["status"] == "archived"
        assert row["archived_at"] == "2026-08-01T01:00:00.000Z"

    def test_progress_is_derived_from_member_rows(self, store: CaptureStore) -> None:
        dataset_id = self._dataset(store)
        done = store.create_capture(_make_capture(run_id="run_1"))
        pending = store.create_capture(_make_capture(run_id="run_2"))
        store.add_dataset_member(dataset_id, done.capture_id)
        store.add_dataset_member(dataset_id, pending.capture_id)

        assert store.count_archived_members(dataset_id) == (0, 2)
        store.update_capture(
            done.capture_id,
            archived_at="2026-08-01T00:00:00.000Z",
            archive_destination="/mnt/nas/ds/001",
        )
        assert store.count_archived_members(dataset_id) == (1, 2)

    def test_view_entries_come_from_active_datasets_only(
        self, store: CaptureStore
    ) -> None:
        active_id = self._dataset(store, name="ds_active")
        leaving_id = self._dataset(store, name="ds_leaving")
        store.add_dataset_member(
            active_id, store.create_capture(_make_capture(run_id="run_1")).capture_id
        )
        store.add_dataset_member(
            leaving_id, store.create_capture(_make_capture(run_id="run_2")).capture_id
        )

        assert {e["dataset_name"] for e in store.list_view_entries()} == {
            "ds_active",
            "ds_leaving",
        }
        # The filter, not the regenerator's missing-source skip, is what removes
        # an archiving dataset from views/ — a decision, not a surprise.
        store.begin_dataset_archive(leaving_id, destination="/mnt/nas/ds")
        assert {e["dataset_name"] for e in store.list_view_entries()} == {"ds_active"}


class TestCatalogSidecars:
    def test_a_saved_template_is_mirrored_to_the_catalog_dir(
        self, store: CaptureStore, tmp_path: Path
    ) -> None:
        store.create_template(ValidationTemplate(name="t", version=1))
        sidecar = tmp_path / "catalog" / "validation_templates.json"
        # kairos.db is rebuildable only from what is beside it on disk (§8), so
        # anything the DB alone holds must be mirrored out or it is lost.
        assert sidecar.is_file()
        assert json.loads(sidecar.read_text())["items"][0]["name"] == "t"

    def test_the_plan_catalog_is_mirrored_too(
        self, store: CaptureStore, tmp_path: Path
    ) -> None:
        store.set_plan_catalog([{"name": "proj"}], "2026-08-01T00:00:00.000Z")
        sidecar = tmp_path / "catalog" / "plan_catalog.json"
        assert sidecar.is_file()
        assert json.loads(sidecar.read_text())["projects"][0]["name"] == "proj"

    def test_catalog_sidecars_restore_into_a_fresh_db(self, tmp_path: Path) -> None:
        first = CaptureStore(tmp_path / "kairos.db", data_dir=tmp_path)
        first.create_template(ValidationTemplate(name="t", version=3))
        first.set_plan_catalog([{"name": "proj"}], "2026-08-01T00:00:00.000Z")
        first.close()
        (tmp_path / "kairos.db").unlink()

        second = CaptureStore(tmp_path / "kairos.db", data_dir=tmp_path)
        second.restore_catalog_from_sidecars()
        templates, _ = second.list_templates(limit=10)
        assert [(t.name, t.version) for t in templates] == [("t", 3)]
        catalog = second.get_plan_catalog()
        assert catalog is not None and catalog[0] == [{"name": "proj"}]
        second.close()


class TestBatches:
    def test_recorded_counter_only_grows(self, store: CaptureStore) -> None:
        store.create_batch(Batch(batch_id="batch_1", project="p", task="t"))
        store.increment_episodes_recorded("batch_1")
        store.increment_episodes_recorded("batch_1")
        batch = store.get_batch("batch_1")
        assert batch is not None and batch.episodes_recorded == 2


class TestApplyRebuild:
    def test_rebuilt_rows_land_as_captures_and_replicas(
        self, store: CaptureStore
    ) -> None:
        capture_id = new_capture_id()
        store.apply_rebuild(
            captures=[
                CaptureRow(
                    capture_id=capture_id,
                    state="completed",
                    run_id="run_20260801_120000",
                    operator="alice",
                    review_status="adopted",
                    review_revision=4,
                    digest_state="complete",
                )
            ],
            replicas=[
                ReplicaRow(
                    capture_id=capture_id,
                    instance_id=INSTANCE,
                    state=ReplicaState.present_verified,
                    path="/data/objects/x",
                )
            ],
        )
        loaded = store.get_capture(capture_id, instance_id=INSTANCE)
        assert loaded is not None
        assert loaded.review_revision == 4
        assert loaded.digest_state == "complete"

    def test_a_row_with_review_from_sidecar_false_keeps_the_db_values(
        self, store: CaptureStore
    ) -> None:
        capture = store.create_capture(_make_capture())
        store.save_review_cas(
            capture.capture_id,
            base_revision=0,
            fields={"review_status": "adopted", "quality": "good"},
        )
        store.apply_rebuild(
            captures=[
                CaptureRow(
                    capture_id=capture.capture_id,
                    state="completed",
                    review_status="pending",
                    review_revision=0,
                    # §4.1-4: the scan found the DB ahead of record.json and
                    # said so rather than "correcting" it. Overwriting here
                    # would destroy the newer review to match an older file.
                    review_from_sidecar=False,
                )
            ],
            replicas=[],
        )
        loaded = store.get_capture(capture.capture_id)
        assert loaded is not None
        assert loaded.review_status == "adopted"
        assert loaded.review_revision == 1
