# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""E-14: a relabel while the archive dialog is open must not move the export.

The adopted scenario says the bytes land in the OLD name's folder while the
dataset has been renamed underneath — a dialog that promised one destination
and a run that wrote another.

Measured against the shipped code, the harmful half does not happen, and the
reason is worth pinning rather than assuming. The destination is **bound at
start and never re-derived**:

* the dialog sends ``path``, prefilled at open time with the views shape
  (`useDatasetsState.openDatasetArchive`), and ``_dataset_dir`` applies it
  verbatim. So the folder is the one the operator was shown, whatever the
  labels have become since;
* that resolved path is written into the row and the ``dataset_archive_started``
  event inside the start request. The runner reads the ROW, so nothing it does
  later consults a label;
* the labels cannot move under a live run at all — ``update`` requires an
  active dataset and a run leaves it ``archiving``.

What is left is narrower and deliberately recorded here: **with no ``path``,
the destination is derived from the row as it is at start.** That is the API's
documented default and no shipped client takes it, but it is the one branch
where "what a dialog showed" and "what gets written" can differ, so the tests
below state which branch does which rather than leaving it to be rediscovered.
"""

from __future__ import annotations

from pathlib import Path

from api_orchestrator.layout import DataLayout
from conftest import FakeRecorder
from fastapi.testclient import TestClient
from test_dataset_archive import _archive_client, _dataset, _events, _settle

# What the dialog prefills for a dataset labelled alice / pick / final_set,
# computed the moment it opens and held in component state from then on.
PROMISED = "alice/pick/final_set"


def _rename(client: TestClient, dataset_id: str) -> None:
    """The other terminal, between the dialog opening and the operator clicking."""
    renamed = client.patch(
        f"/api/v1/datasets/{dataset_id}",
        json={"name": "v2", "operator": "bob", "task": "place"},
    )
    assert renamed.status_code == 200, renamed.text


def _folders(exports: Path) -> list[str]:
    return sorted(str(p.relative_to(exports)) for p in exports.rglob("*") if p.is_dir())


class TestTheDestinationIsBoundAtStart:
    def test_a_relabel_in_the_dialog_window_does_not_move_the_export(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """The scenario, driven exactly as the UI drives it.

        The dialog holds the path it computed when it opened; the rename lands;
        the operator clicks. The bytes must go where the dialog said, and the
        row and the ledger must both name that same folder — a run recorded at
        one path and written at another is unfindable years later, which is
        what the archive exists to prevent.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout: DataLayout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1, name="final_set")
            dataset_id = dataset["dataset_id"]

            _rename(client, dataset_id)

            started = client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={
                    "destination": str(roots / "exports"),
                    "path": PROMISED,
                    "mode": "copy",
                },
            )
            assert started.status_code == 202, started.text
            expected = str(roots / "exports" / PROMISED)
            assert started.json()["destination"] == expected
            _settle(client, dataset_id)

            row = client.get(f"/api/v1/datasets/{dataset_id}").json()
            assert row["status"] == "archived"
            assert row["archive_destination"] == expected
            starts = _events(layout, "dataset_archive_started")
            assert [e["destination"] for e in starts] == [expected]
            assert _folders(roots / "exports") == [
                "alice",
                "alice/pick",
                "alice/pick/final_set",
                "alice/pick/final_set/001",
            ]

    def test_the_labels_cannot_move_once_the_run_owns_them(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """A rename DURING the run is refused, not applied late.

        This is the protection that makes the binding above sufficient rather
        than lucky: if an archiving dataset could be relabelled, a resume would
        re-derive from labels the first pass never saw.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout: DataLayout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1, name="final_set")
            dataset_id = dataset["dataset_id"]
            client.app.state.capture_store.begin_dataset_archive(
                dataset_id, destination=str(roots / "exports" / PROMISED), mode="copy"
            )

            refused = client.patch(
                f"/api/v1/datasets/{dataset_id}", json={"name": "v2"}
            )
            assert refused.status_code == 409, refused.text
            assert refused.json()["error"]["code"] == "dataset_not_active"
            row = client.get(f"/api/v1/datasets/{dataset_id}").json()
            assert row["name"] == "final_set"

    def test_the_default_destination_is_derived_from_the_row_at_start(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """The positive control, and the residual, in one.

        Omitting ``path`` is the documented default and it binds LATE — the
        labels as they are when the request arrives. That makes the test above
        meaningful (the server really would have used the new name) and marks
        the branch a future client must not take from a dialog it prefilled
        earlier: there, and only there, E-14 is reachable.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout: DataLayout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1, name="final_set")
            dataset_id = dataset["dataset_id"]

            _rename(client, dataset_id)

            started = client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={"destination": str(roots / "exports"), "mode": "copy"},
            )
            assert started.status_code == 202, started.text
            assert started.json()["destination"] == str(
                roots / "exports" / "bob/place/v2"
            )


class TestTheArchivePathSpellsNamesLikeViews:
    def test_a_control_character_never_reaches_the_archive_folder(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """``path`` is applied verbatim, so the rule has to live server-side.

        ``views`` replaces control characters in a component (E-11), and the
        dialog's prefill mirrors that sanitisation in TypeScript — a mirror
        that is one edit away from drifting. If it drifts, the prefill arrives
        here carrying a newline and this is the only thing left between it and
        a folder no line-oriented tool can list. Separators and dots are
        untouched: the path is multi-component and ``..`` is handled by the
        allow-list check, not by spelling.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout: DataLayout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=1, name="final_set")
            started = client.post(
                f"/api/v1/datasets/{dataset['dataset_id']}/archive",
                json={
                    "destination": str(roots / "exports"),
                    "path": "ali\tce/pi\nck/final_set",
                    "mode": "copy",
                },
            )
            assert started.status_code == 202, started.text
            destination = started.json()["destination"]
            assert "\n" not in destination and "\t" not in destination
            assert destination.endswith("ali_ce/pi_ck/final_set")
            _settle(client, dataset["dataset_id"])
            assert _folders(roots / "exports") == [
                "ali_ce",
                "ali_ce/pi_ck",
                "ali_ce/pi_ck/final_set",
                "ali_ce/pi_ck/final_set/001",
            ]
