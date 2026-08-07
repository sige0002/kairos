"""E-27: the validation presets endpoint must not scale with the catalog.

``GET /api/v1/validation/presets`` shows "N pending" per preset, which needs
two things: how many captures are validation targets, and which of them have no
report yet. The obvious implementation asks the filesystem once per capture per
preset — and at 5,000 captures with three presets that is 15,000 ``is_file()``
calls for one request, measured, plus 5,000 rows materialised as models to
produce a count.

The test is written at a size that runs fast; the invariant is the one that
matters at any size. **The number of report-tree lookups must not grow with the
number of captures.** A screen that polls this endpoint is otherwise doing tens
of thousands of syscalls a second on a store that has simply been used for a
few months.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from api_orchestrator.store import CaptureStore
from fastapi.testclient import TestClient
from kairos_common.ids import new_capture_id
from kairos_common.rebuild import ReplicaState

CAPTURES = 300
PRESETS = 2


@dataclass
class _Preset:
    id: str
    name: str
    description: str
    pipeline: str
    params: dict[str, Any] = field(default_factory=dict)


def _seed(client: TestClient, layout: DataLayout, instance_id: str) -> list[str]:
    store = client.app.state.capture_store
    ids = []
    for index in range(CAPTURES):
        capture_id = new_capture_id()
        ids.append(capture_id)
        store.create_capture(
            Capture(
                capture_id=capture_id,
                run_id=f"run_{index:06d}",
                state=CaptureState.completed,
                operator="alice",
                task="pick",
                started_at="2026-08-01T00:00:00.000Z",
            )
        )
        store.upsert_replica(
            capture_id,
            instance_id,
            ReplicaState.present_unverified,
            path=str(layout.capture_dir(capture_id)),
        )
    return ids


class TestPresetsDoNotWalkEveryCapture:
    def test_report_lookups_do_not_grow_with_the_catalog(
        self,
        client: TestClient,
        layout: DataLayout,
        instance_id: str,
        monkeypatch,
    ) -> None:
        ids = _seed(client, layout, instance_id)
        # One capture already has a report; the rest are pending. That is the
        # ordinary shape — most of a store has never been validated — and it is
        # what makes per-capture probing so wasteful: thousands of questions to
        # discover a handful of answers.
        done = ids[0]
        for pipeline in ("pipeline_0", "pipeline_1"):
            report = layout.report_dir(pipeline, done)
            report.mkdir(parents=True, exist_ok=True)
            (report / "summary.json").write_text('{"result": "pass"}', encoding="utf-8")

        client.app.state.config_catalog.list_validation_presets = lambda: [
            _Preset(f"p{i}", f"P{i}", "", f"pipeline_{i}") for i in range(PRESETS)
        ]

        # Instrumented at the FILESYSTEM, not at one helper. A regression that
        # builds `layout.report / pipeline / cid / "summary.json"` by hand does
        # the same O(captures x presets) syscalls while never touching
        # `report_dir`, so counting that method would have measured a coding
        # style rather than the cost. These count every probe of a path under
        # the report tree, however the path was constructed.
        #
        # Patched by hand and restored in `finally` rather than with
        # monkeypatch: pytest calls these same methods while formatting a
        # failure, so leaving them patched past the request turns an ordinary
        # assertion error into an INTERNALERROR. The comparison is on strings
        # for the same reason — a counter that touches the disk to decide
        # whether to count is a counter that can recurse.
        probes = {"n": 0}
        models = {"n": 0}
        root = f"{layout.report}/"
        probed = ("is_file", "stat", "exists")
        originals = {name: getattr(Path, name) for name in probed}
        real_from_row = CaptureStore._capture_from_row

        def _counted(name: str):
            real = originals[name]

            def probe(self: Path, *args: Any, **kwargs: Any):
                if str(self).startswith(root):
                    probes["n"] += 1
                return real(self, *args, **kwargs)

            return probe

        # The other half of the cost: turning every row into a model. The
        # endpoint needs a count and a set difference, both of which the query
        # can answer; materialising 5,000 Capture objects to produce them was
        # 75 ms of the original 168 (E-27). This is the store's single funnel
        # from row to model, so it catches any path that goes back to rows.
        def counting_from_row(row):
            models["n"] += 1
            return real_from_row(row)

        for name in originals:
            setattr(Path, name, _counted(name))
        CaptureStore._capture_from_row = staticmethod(counting_from_row)
        try:
            response = client.get("/api/v1/validation/presets")
        finally:
            for name, real in originals.items():
                setattr(Path, name, real)
            CaptureStore._capture_from_row = staticmethod(real_from_row)

        assert response.status_code == 200, response.text
        items = response.json()["items"]
        assert len(items) == PRESETS
        for item in items:
            assert item["total"] == CAPTURES
            assert item["pending"] == CAPTURES - 1
            assert done not in item["pending_capture_ids"]
        # A per-capture probe would be CAPTURES * PRESETS. The honest budget is
        # one listing per preset plus one check per report that EXISTS.
        assert probes["n"] <= PRESETS * 4, (
            f"{probes['n']} filesystem probes under the report tree for "
            f"{CAPTURES} captures and {PRESETS} presets — this endpoint is "
            "asking about every capture"
        )
        # And a count is not a reason to build a model per row.
        assert models["n"] == 0, (
            f"{models['n']} capture rows were materialised as models to answer "
            "a count and a set difference"
        )
