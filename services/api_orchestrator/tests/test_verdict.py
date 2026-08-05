"""Validation gating (§ verdict): a validator that can refuse, not a diary.

The defect these pin: a capture could fail validation, stay GOOD, be adopted,
join a dataset and be archived — because the verdict lived in a JSON file
nothing consulted. The gate refuses; a human may override it; the override is
on the record.
"""

from __future__ import annotations

import json
from pathlib import Path

from api_orchestrator.layout import DataLayout
from api_orchestrator.verdict import Verdict, blocks_adoption, verdict_of
from conftest import settle_views  # noqa: F401  (fixture side effects)
from fastapi.testclient import TestClient
from kairos_common import ledger_v2


def _write_report(layout: DataLayout, capture_id: str, result: str) -> None:
    directory = layout.report_dir("fast_validation", capture_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "summary.json").write_text(
        json.dumps({"result": result}), encoding="utf-8"
    )


class TestVerdictFold:
    def test_never_validated_is_unknown_not_a_pass(self) -> None:
        # Silence is not evidence: nothing ran, so nothing is claimed.
        assert verdict_of({"fast_validation": None}) is Verdict.unknown

    def test_a_failure_wins_over_a_pass(self) -> None:
        assert verdict_of({"fast_validation": {"result": "fail"}}) is (
            Verdict.needs_review
        )
        assert verdict_of({"fast_validation": {"result": "pass"}}) is Verdict.passed

    def test_only_a_real_failure_blocks_and_only_until_overridden(self) -> None:
        assert blocks_adoption(Verdict.needs_review, None) is True
        assert blocks_adoption(Verdict.needs_review, "operator judged it fine") is (
            False
        )
        # v1 gates on evidence of breakage, never on its absence — otherwise a
        # deployment that runs no validators could build no datasets at all.
        assert blocks_adoption(Verdict.unknown, None) is False
        assert blocks_adoption(Verdict.passed, None) is False


class TestGate:
    def _capture_id(self, client: TestClient, layout: DataLayout) -> str:
        from test_datasets import _capture

        return _capture(client, layout)

    def test_a_failed_capture_is_refused_by_datasets(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        capture_id = self._capture_id(client, layout)
        _write_report(layout, capture_id, "fail")
        dataset_id = client.post("/api/v1/datasets", json={"name": "gated"}).json()[
            "dataset_id"
        ]

        resp = client.post(
            f"/api/v1/datasets/{dataset_id}/members", json={"capture_id": capture_id}
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["error"]["code"] == "validation_failed"
        assert resp.json()["error"]["details"]["verdict"] == "needs_review"

    def test_an_override_admits_it_and_lands_in_the_ledger(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._capture_id(client, layout)
        _write_report(layout, capture_id, "fail")
        dataset_id = client.post(
            "/api/v1/datasets", json={"name": "overridden"}
        ).json()["dataset_id"]

        ok = client.post(
            f"/api/v1/captures/{capture_id}/validation-override",
            json={"reason": "camera check is a known false positive here"},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["validation_override"]

        added = client.post(
            f"/api/v1/datasets/{dataset_id}/members", json={"capture_id": capture_id}
        )
        assert added.status_code == 201, added.text

        # The judgement is durable and attributable, not just a column.
        events = [
            e
            for e in ledger_v2.read_all(layout.data_dir)
            if e.get("kind") == "capture_validation_overridden"
        ]
        assert len(events) == 1
        assert events[0]["capture_id"] == capture_id
        assert "false positive" in events[0]["reason"]
        assert events[0]["verdict"] == "needs_review"

    def test_an_empty_reason_is_refused(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._capture_id(client, layout)
        resp = client.post(
            f"/api/v1/captures/{capture_id}/validation-override", json={"reason": "  "}
        )
        assert resp.status_code == 400
        assert resp.json()["error"]["code"] == "reason_required"

    def test_a_passing_capture_needs_no_override(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._capture_id(client, layout)
        _write_report(layout, capture_id, "pass")
        dataset_id = client.post("/api/v1/datasets", json={"name": "clean"}).json()[
            "dataset_id"
        ]
        added = client.post(
            f"/api/v1/datasets/{dataset_id}/members", json={"capture_id": capture_id}
        )
        assert added.status_code == 201, added.text

    def test_the_detail_serves_the_derived_verdict(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        capture_id = self._capture_id(client, layout)
        assert client.get(f"/api/v1/captures/{capture_id}").json()["verdict"] == (
            "unknown"
        )
        _write_report(layout, capture_id, "fail")
        # Derived on every read: a re-run cannot leave a stale copy behind.
        assert client.get(f"/api/v1/captures/{capture_id}").json()["verdict"] == (
            "needs_review"
        )
