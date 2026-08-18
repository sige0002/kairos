# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""A ``dataset_manifest.json`` that parses to something other than an object.

``_read_manifest`` used to hand back whatever ``json.loads`` produced, and both
of its callers go straight to ``.get("members")``. A manifest holding a bare
array — a truncated write, a hand-edit, a tool that rewrote the file — therefore
raised ``AttributeError`` out of a progress poll or a resume, which is a 500 on
a request whose whole job is to report the state of a damaged archive.

Unreadable and not-an-object are the same fact: nothing here can be trusted.
Both callers already have a defined answer for it — report no progress yet, and
re-copy the members — and that answer is the safe one, because a copy re-run
verifies and overwrites. The cost of being wrong is time, not bytes.
"""

from __future__ import annotations

import json
from pathlib import Path

from api_orchestrator.dataset_archive import MANIFEST_NAME
from conftest import FakeRecorder
from kairos_common import ledger_v2
from test_dataset_archive import (
    _archive_client,
    _dataset,
    _dataset_dir,
    _settle,
)

# The shapes a manifest must never crash on. A list is the one seen in the
# wild; the scalar and the null cover the rest of what `json.loads` can return
# without producing a mapping.
NOT_OBJECTS = ['[{"dir": "001"}]', '"archiving"', "null", "42"]


class TestAProgressPollSurvivesIt:
    def test_a_manifest_that_is_an_array_reports_no_progress_instead_of_500(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            dataset = _dataset(client, layout, members=2)
            dataset_id = dataset["dataset_id"]
            accepted = client.post(
                f"/api/v1/datasets/{dataset_id}/archive",
                json={"destination": str(roots / "exports"), "mode": "copy"},
            )
            assert accepted.status_code == 202, accepted.text
            _settle(client, dataset_id)
            target = _dataset_dir(roots)
            # The archive completed; the manifest goes bad afterwards, which is
            # exactly when an operator polls to find out what survived.
            for shape in NOT_OBJECTS:
                (target / MANIFEST_NAME).write_text(shape, encoding="utf-8")

                progress = client.get(f"/api/v1/datasets/{dataset_id}/archive")

                assert progress.status_code == 200, (
                    f"a manifest holding {shape} took down the progress poll: "
                    f"{progress.text}"
                )
                body = progress.json()
                # The rows still know the set was archived; only the per-member
                # copy count came from the file that is now unreadable.
                assert body["status"] == "archived"
                assert body["member_total"] == 2
                assert body["members_done"] == 2


class TestAResumeSurvivesIt:
    def test_an_unreadable_manifest_makes_a_resume_re_copy_every_member(
        self, data_dir: Path, tmp_path: Path, fake_recorder: FakeRecorder
    ) -> None:
        """Believing nothing is the safe reading: a re-copy verifies and wins.

        The previous run's bytes are left at the target under a member whose
        manifest entry can no longer be read. Trusting the file would mean
        keeping them; being unable to read it means re-copying from the source
        that copy mode leaves in place, which is what the real content proves.
        """
        roots = tmp_path / "nas"
        roots.mkdir()
        with _archive_client(data_dir, roots, fake_recorder) as client:
            layout = client.app.state.data_layout
            store = client.app.state.capture_store
            dataset = _dataset(client, layout, members=1)
            dataset_id = dataset["dataset_id"]
            members = client.get(f"/api/v1/datasets/{dataset_id}").json()["members"]
            target = _dataset_dir(roots)
            assert store.begin_dataset_archive(
                dataset_id, destination=str(target), mode="copy"
            )
            ledger_v2.append(
                layout.data_dir,
                "dataset_archive_started",
                instance_id=client.app.state.instance_id,
                payload={
                    "dataset_id": dataset_id,
                    "destination": str(target),
                    "dataset_name": "ds",
                    "mode": "copy",
                    "members": [
                        {
                            "membership_id": m["membership_id"],
                            "capture_id": m["capture_id"],
                            "display_index": m["display_index"],
                        }
                        for m in members
                    ],
                },
            )
            # Bytes from the interrupted run, and a manifest that no longer
            # says anything about them.
            (target / "001").mkdir(parents=True)
            (target / "001" / "bag_0.mcap").write_bytes(b"from the last run")
            (target / MANIFEST_NAME).write_text(
                '[{"dir": "001", "files": []}]', encoding="utf-8"
            )

            response = client.post(f"/api/v1/datasets/{dataset_id}/archive", json={})

            assert response.status_code == 202, response.text
            _settle(client, dataset_id)
            progress = client.get(f"/api/v1/datasets/{dataset_id}/archive").json()
            assert progress["status"] == "archived", (
                f"the resume did not finish: {progress}"
            )
            assert progress["error"] is None
            # Re-copied from the living source, and the manifest is an object
            # again — the run rewrote what it could not read.
            assert (target / "001" / "bag_0.mcap").read_bytes().startswith(b"\x89MCAP0")
            manifest = json.loads((target / MANIFEST_NAME).read_bytes())
            assert isinstance(manifest, dict)
            assert manifest["status"] == "complete"
            assert all(m["files"] for m in manifest["members"])
