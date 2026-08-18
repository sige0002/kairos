# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Labelling bags at import time, and why the labels go in the MANIFEST.

An import synthesizes the capture's birth ``object_manifest.json`` (§3.3), so an
operator naming themselves in the import request is doing the same thing the
recorder does when it stamps a ``/record/start`` — declaring what was recorded.
The §4.3 ``labels`` override block is for the other case: correcting a value a
sealed manifest already carries. Using it here would say a previous value was
wrong when there had never been one.

Filing them as recorded facts is what makes the two features compose. A later
Review edit becomes an override on top of these, and clearing that edit falls
back to what the import declared rather than to null — which is what an
operator who typed the name once would expect.

Rebuild survival comes for free and is still pinned below: the manifest is the
file §8 rebuilds from, so there is nothing extra to carry.

A bulk import is this same endpoint called once per bag, so "the same labels for
every bag in the request" is the client sending the same three values each time;
``test_a_bulk_selection_labels_every_bag`` drives it that way.
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from kairos_common import Settings
from test_transfer_import import _await_import, _make_bag

LABELS = {"operator": "alice", "task": "pick", "robot": "myrobot"}


def _import(client: TestClient, source: Path, **body: object) -> dict:
    response = client.post("/api/v1/imports", json={"source_path": str(source), **body})
    assert response.status_code == 202, response.text
    queued = response.json()
    status = _await_import(client, queued["import_id"])
    assert status["state"] == "succeeded", status
    return queued


def _capture(client: TestClient, capture_id: str) -> dict:
    response = client.get(f"/api/v1/captures/{capture_id}")
    assert response.status_code == 200, response.text
    return response.json()


def _manifest(layout: DataLayout, capture_id: str) -> dict:
    path = layout.capture_dir(capture_id) / "object_manifest.json"
    return json.loads(path.read_text(encoding="utf-8"))


class TestTheLabelsReachTheCapture:
    def test_all_three_are_applied(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source, **LABELS)

        body = _capture(client, queued["capture_id"])
        assert (body["operator"], body["task"], body["robot"]) == (
            "alice",
            "pick",
            "myrobot",
        )

    def test_they_are_written_into_the_manifest_not_the_override_block(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        """The distinction the whole design rests on."""
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source, **LABELS)
        capture_id = queued["capture_id"]

        manifest = _manifest(layout, capture_id)
        assert (manifest["operator"], manifest["task"], manifest["robot"]) == (
            "alice",
            "pick",
            "myrobot",
        )
        assert not (layout.capture_dir(capture_id) / "record.json").exists(), (
            "the import wrote a review sidecar; labels declared at import are "
            "RECORDED facts, and putting them in the override block would "
            "claim a previous value had been wrong"
        )

    def test_the_row_matches_the_manifest(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        # The row is a cache of the manifest (§8). If the two disagreed, a
        # rebuild would silently change what the list shows.
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source, **LABELS)
        capture_id = queued["capture_id"]

        body = _capture(client, capture_id)
        manifest = _manifest(layout, capture_id)
        for name in ("operator", "task", "robot"):
            assert body[name] == manifest[name]

    def test_they_show_up_in_the_capture_list(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source, **LABELS)

        items = client.get("/api/v1/captures").json()["items"]
        row = next(i for i in items if i["capture_id"] == queued["capture_id"])
        assert row["operator"] == "alice"
        assert row["task"] == "pick"

    def test_a_subset_is_allowed(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source, operator="alice")

        body = _capture(client, queued["capture_id"])
        assert body["operator"] == "alice"
        assert body["task"] is None
        assert body["robot"] is None

    def test_a_bulk_selection_labels_every_bag(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        """The bulk case as the UI actually performs it: N calls, same labels."""
        sources = [tmp_path / f"bag_{i}" for i in range(3)]
        for source in sources:
            _make_bag(source)

        captures = [
            _import(client, source, **LABELS)["capture_id"] for source in sources
        ]

        assert len(set(captures)) == 3
        for capture_id in captures:
            body = _capture(client, capture_id)
            assert (body["operator"], body["task"], body["robot"]) == (
                "alice",
                "pick",
                "myrobot",
            )


class TestOmittingThemIsTheOldBehaviour:
    def test_an_unlabelled_import_still_comes_in_null(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source)

        body = _capture(client, queued["capture_id"])
        assert body["operator"] is None
        assert body["task"] is None
        assert body["robot"] is None
        assert _manifest(layout, queued["capture_id"])["operator"] is None

    def test_a_blank_label_is_read_as_not_supplied(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        """Same rule as a §4.3 review save: whitespace is not a label."""
        source = tmp_path / "external_bag"
        _make_bag(source)

        queued = _import(client, source, operator="   ", task="pick")

        body = _capture(client, queued["capture_id"])
        assert body["operator"] is None
        assert body["task"] == "pick"


class TestABadLabelImportsNothing:
    def test_a_separator_is_refused_before_anything_is_copied(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        response = client.post(
            "/api/v1/imports",
            json={"source_path": str(source), "operator": "a/b"},
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsafe_label"
        assert client.get("/api/v1/imports").json()["imports"] == [], (
            "the import was queued before its labels were checked; a copy that "
            "has to be undone is exactly what validating first avoids"
        )
        assert client.get("/api/v1/captures").json()["items"] == []
        assert list(layout.objects.iterdir()) == []

    def test_dot_names_are_refused(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        response = client.post(
            "/api/v1/imports", json={"source_path": str(source), "task": ".."}
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "unsafe_label"

    def test_an_over_long_label_is_refused(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)

        response = client.post(
            "/api/v1/imports",
            json={"source_path": str(source), "robot": "ら" * 200},
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "label_too_long"

    def test_the_source_is_left_alone(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        # A refused request must not have touched the operator's data, and with
        # move=true a partially-run import is how the original disappears.
        source = tmp_path / "external_bag"
        _make_bag(source)
        before = sorted(p.name for p in source.iterdir())

        client.post(
            "/api/v1/imports",
            json={"source_path": str(source), "move": True, "operator": "a/b"},
        )

        assert sorted(p.name for p in source.iterdir()) == before


class TestTheLabelsSurviveARebuild:
    def test_an_imported_label_outlives_the_database(
        self,
        settings: Settings,
        data_dir: Path,
        fake_recorder: FakeRecorder,
        tmp_path: Path,
    ) -> None:
        """Free, because the manifest is what §8 rebuilds from — but pinned.

        If import labels ever moved into ``record.json``'s override block, this
        would still pass while the meaning quietly changed, so the manifest
        assertion above is the one that guards the design. This guards the
        outcome an operator cares about.
        """

        def boot() -> TestClient:
            return TestClient(
                create_orchestrator_app(
                    settings,
                    http_client=httpx.AsyncClient(
                        transport=httpx.MockTransport(fake_recorder.handler)
                    ),
                )
            )

        source = tmp_path / "external_bag"
        _make_bag(source)
        with boot() as client:
            capture_id = _import(client, source, **LABELS)["capture_id"]
            assert _capture(client, capture_id)["operator"] == "alice"

        (data_dir / "kairos.db").unlink()

        with boot() as reopened:
            after = _capture(reopened, capture_id)

        assert (after["operator"], after["task"], after["robot"]) == (
            "alice",
            "pick",
            "myrobot",
        )


class TestItComposesWithReviewEditing:
    def test_a_review_edit_overrides_an_imported_label(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        source = tmp_path / "external_bag"
        _make_bag(source)
        capture_id = _import(client, source, **LABELS)["capture_id"]

        response = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "operator": "bob"},
        )

        assert response.status_code == 200, response.text
        assert response.json()["operator"] == "bob"
        # The import's declaration is still on the manifest, untouched.
        assert _manifest(layout, capture_id)["operator"] == "alice"

    def test_clearing_the_edit_falls_back_to_what_the_import_declared(
        self, client: TestClient, layout: DataLayout, tmp_path: Path
    ) -> None:
        """The payoff of writing import labels as recorded facts.

        Had they gone into the override block, clearing would leave null and
        the operator would have to type the name again — the value they
        supplied once would have been consumed by the correction that replaced
        it.
        """
        source = tmp_path / "external_bag"
        _make_bag(source)
        capture_id = _import(client, source, **LABELS)["capture_id"]
        client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 0, "operator": "bob"},
        )

        cleared = client.patch(
            f"/api/v1/captures/{capture_id}/review",
            json={"base_revision": 1, "operator": None},
        )

        assert cleared.status_code == 200, cleared.text
        assert cleared.json()["operator"] == "alice"
