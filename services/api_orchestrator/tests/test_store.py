"""Unit tests for the SQLite runs store (round-trip, paging, persistence)."""

from __future__ import annotations

from pathlib import Path

from api_orchestrator.models import (
    Run,
    RunError,
    RunState,
    RunTopic,
    Split,
    TopicQos,
)
from api_orchestrator.store import RunStore
from kairos_common import Compression, Durability, Reliability


def _topic(name: str) -> RunTopic:
    return RunTopic(
        name=name,
        type="std_msgs/msg/Header",
        qos=TopicQos(
            reliability=Reliability.best_effort,
            durability=Durability.volatile,
            depth=1,
        ),
    )


def test_create_and_get_round_trips_all_fields() -> None:
    store = RunStore(":memory:")
    run = Run(
        run_id="run_20260101_000000",
        state=RunState.recording,
        started_at="2026-01-01T00:00:00.000Z",
        topics=[_topic("/tf")],
        compression=Compression.zstd,
        split=Split(max_size_mb=512, max_duration_s=None),
        error=RunError(code="x", message="y"),
    )
    store.create(run)

    got = store.get("run_20260101_000000")
    assert got is not None
    assert got.model_dump() == run.model_dump()
    store.close()


def test_update_patches_only_named_fields() -> None:
    store = RunStore(":memory:")
    store.create(Run(run_id="run_a", state=RunState.created))

    updated = store.update("run_a", state=RunState.completed, message_count=10)
    assert updated.state is RunState.completed
    assert updated.message_count == 10
    # Clearing error to None is supported.
    cleared = store.update("run_a", error=None)
    assert cleared.error is None
    store.close()


def test_list_by_states_filters() -> None:
    store = RunStore(":memory:")
    store.create(Run(run_id="run_a", state=RunState.recording))
    store.create(Run(run_id="run_b", state=RunState.completed))
    store.create(Run(run_id="run_c", state=RunState.stopping))

    live = store.list_by_states([RunState.recording, RunState.stopping])
    assert {r.run_id for r in live} == {"run_a", "run_c"}
    store.close()


def test_pagination_cursor_is_stable(tmp_path: Path) -> None:
    """Paging on a file-backed DB returns every row once, newest first."""
    store = RunStore(tmp_path / "kairos.db")
    for i in range(5):
        store.create(Run(run_id=f"run_{i}", state=RunState.completed))

    page1, cursor1 = store.list_runs(limit=2)
    assert [r.run_id for r in page1] == ["run_4", "run_3"]
    assert cursor1 is not None

    page2, cursor2 = store.list_runs(limit=2, cursor=cursor1)
    assert [r.run_id for r in page2] == ["run_2", "run_1"]

    page3, cursor3 = store.list_runs(limit=2, cursor=cursor2)
    assert [r.run_id for r in page3] == ["run_0"]
    assert cursor3 is None


def test_file_db_persists_across_instances(tmp_path: Path) -> None:
    """A file-backed store survives reopening (real /data/kairos.db behavior)."""
    db = tmp_path / "kairos.db"
    RunStore(db).create(Run(run_id="run_persist", state=RunState.completed))

    reopened = RunStore(db)
    assert reopened.get("run_persist") is not None
