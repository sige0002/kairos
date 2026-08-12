# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""E-4: two datasets that want the same folder must not freeze ``views/``.

The generated tree is ``<operator>/<task>/<dataset>/<NNN>`` (§6) and nothing in
that path is unique — ``display_index`` restarts at 1 in every dataset. So two
datasets sharing name, operator and task ask for the identical symlink, and the
regeneration that builds them both raises ``FileExistsError`` partway through.

That failure is silent where it hurts most: the dataset write path logs it and
carries on, and because the tree is only flipped at the *end* of a successful
build, ``views/`` keeps serving the last good generation forever. Every later
edit hits the same collision, so the tree stops reflecting reality with nothing
in the UI to say so, while ``POST /api/v1/views/refresh`` surfaces it as a
raw 500.

Either the collision is refused when the dataset is created, or the tree
disambiguates the two — but a refresh must always finish, and the tree must
always describe what the catalog says.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator import views as views_mod
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.layout import DataLayout
from api_orchestrator.models import Capture, CaptureState
from conftest import FakeRecorder, settle_views
from fastapi.testclient import TestClient
from kairos_common import ledger_v2
from kairos_common.capture_sidecars import ObjectManifestV2, write_object_manifest
from kairos_common.ids import new_capture_id

COLLIDING = {"name": "pick_v1", "operator": "alice", "task": "pick"}


def _capture(client: TestClient, layout: DataLayout) -> str:
    """A completed capture, in the catalog and on disk with its manifest.

    The manifest is what makes the capture survive a rebuild, which the
    ledger-replay test below depends on: without it the directory is an orphan
    rather than a capture.
    """
    capture_id = new_capture_id()
    capture_dir = layout.capture_dir(capture_id)
    capture_dir.mkdir(parents=True, exist_ok=True)
    (capture_dir / "metadata.yaml").write_text("x: 1\n", encoding="utf-8")
    (capture_dir / f"{capture_id}_0.mcap").write_bytes(b"\x89MCAP0\r\n")
    write_object_manifest(
        capture_dir,
        ObjectManifestV2(
            capture_id=capture_id,
            source_instance_id=client.app.state.instance_id,
            run_id=f"run_{capture_id[:13]}",
            state="completed",
            started_at="2026-08-01T00:00:00.000Z",
            ended_at="2026-08-01T00:01:00.000Z",
            operator="alice",
            task="pick",
            message_count=100,
            bytes=4096,
        ),
    )
    client.app.state.capture_store.create_capture(
        Capture(
            capture_id=capture_id,
            run_id=f"run_{capture_id[:13]}",
            state=CaptureState.completed,
            operator="alice",
            task="pick",
            started_at="2026-08-01T00:00:00.000Z",
        )
    )
    return capture_id


def _create_pair(client: TestClient, layout: DataLayout) -> list[dict]:
    """Create the colliding pair, each with one member. Returns what stuck.

    A refusal is a legitimate answer to the second create (the collision never
    reaches the tree), so this reports which datasets exist rather than
    insisting both do.
    """
    created: list[dict] = []
    for _ in range(2):
        response = client.post("/api/v1/datasets", json=COLLIDING)
        if response.status_code >= 400:
            # Refused — but it has to say why in a way an operator can act on.
            error = response.json()["error"]
            assert response.status_code in (400, 409), response.status_code
            assert COLLIDING["name"] in error["message"], error
            continue
        dataset = response.json()
        member = client.post(
            f"/api/v1/datasets/{dataset['dataset_id']}/members",
            json={"capture_id": _capture(client, layout)},
        )
        assert member.status_code == 201, member.text
        created.append(dataset)
    assert created, "at least the first dataset must be creatable"
    return created


def _links(root: Path) -> dict[str, str]:
    """Every symlink under the views tree, as path -> capture_id."""
    return {
        str(path.relative_to(root)): Path(path.readlink()).name
        for path in root.rglob("*")
        if path.is_symlink()
    }


class TestCollidingDatasetsDoNotFreezeViews:
    def test_a_refresh_completes_and_the_tree_holds_every_member(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        datasets = _create_pair(client, layout)
        settle_views(client)

        # The manual repair must not be the thing that reports the bug.
        refresh = client.post("/api/v1/views/refresh")
        assert refresh.status_code == 200, refresh.text
        assert refresh.json()["links"] == len(datasets)

        # One link per member, each pointing at its own capture — whether the
        # tree disambiguated the pair or the second create was refused.
        members = {
            member["capture_id"]
            for dataset in datasets
            for member in client.get(
                f"/api/v1/datasets/{dataset['dataset_id']}"
            ).json()["members"]
        }
        links = _links(layout.views.resolve())
        assert len(links) == len(members)
        assert set(links.values()) == members

    def test_the_tree_keeps_tracking_the_catalog_after_the_collision(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        datasets = _create_pair(client, layout)
        client.post("/api/v1/views/refresh")

        # A frozen tree looks exactly like a working one until something
        # changes, so the assertion that matters is that a LATER edit lands.
        later = client.post(
            "/api/v1/datasets", json={"name": "place_v1", "operator": "bob"}
        ).json()
        capture_id = _capture(client, layout)
        client.post(
            f"/api/v1/datasets/{later['dataset_id']}/members",
            json={"capture_id": capture_id},
        )
        settle_views(client)
        assert client.post("/api/v1/views/refresh").status_code == 200

        links = _links(layout.views.resolve())
        assert capture_id in links.values(), sorted(links)
        assert len(links) == len(datasets) + 1

    def test_regeneration_alone_survives_a_collision_already_in_the_catalog(
        self, client: TestClient, layout: DataLayout
    ) -> None:
        """The regenerator is the last line: rows can predate any create guard.

        Dataset rows come back from the ledger on a rebuild (§8), so a pair
        created before a uniqueness rule existed — or restored from an older
        install's ledger — still has to produce a tree rather than an exception.
        """
        entries = [
            {
                "capture_id": _capture(client, layout),
                "display_index": 1,
                "dataset_name": COLLIDING["name"],
                "operator": COLLIDING["operator"],
                "task": COLLIDING["task"],
                "dataset_id": f"ds_{index}",
            }
            for index in range(2)
        ]
        # Whatever list_view_entries selects, the regenerator must cope with two
        # rows that resolve to one path.
        result = views_mod.regenerate(layout, entries)

        assert result.links == 2
        links = _links(layout.views.resolve())
        assert len(links) == 2
        assert set(links.values()) == {e["capture_id"] for e in entries}

    def test_a_pair_restored_from_the_ledger_still_produces_a_whole_tree(
        self,
        client: TestClient,
        layout: DataLayout,
        settings,
        fake_recorder: FakeRecorder,
    ) -> None:
        """The collision a real deployment actually gets, end to end.

        The create guard is not on the rebuild path and must not be: §8 replays
        the ledger to restore what already happened, and refusing history would
        drop a dataset rather than protect anything. ``_replay_member_added``
        recreates the row straight from the event, so a pair that predates the
        guard — or that an older install wrote — comes back intact.

        This is the case the other tests cannot reach, because they go through
        the API and the second create is refused. It runs the REAL
        ``list_view_entries`` query, so the tree here depends on that SELECT
        carrying ``dataset_id``: without it both datasets key on their shared
        name, collide again, and a member disappears from the tree with the
        refresh still answering 200.
        """
        instance_id = client.app.state.instance_id
        captures = {
            # Ids chosen so the order is decided rather than observed: on the
            # created_at tie these events can produce, dataset_id breaks it, and
            # "ds_aaa" is also the one appended first.
            "ds_aaa": _capture(client, layout),
            "ds_bbb": _capture(client, layout),
        }
        for dataset_id, capture_id in captures.items():
            ledger_v2.append(
                layout.data_dir,
                "dataset_created",
                instance_id=instance_id,
                payload={"dataset_id": dataset_id, **COLLIDING},
            )
            ledger_v2.append(
                layout.data_dir,
                "dataset_member_added",
                instance_id=instance_id,
                capture_id=capture_id,
                payload={
                    "dataset_id": dataset_id,
                    "membership_id": f"m_{dataset_id}",
                    "display_index": 1,
                    "dataset_name": COLLIDING["name"],
                    "operator": COLLIDING["operator"],
                    "task": COLLIDING["task"],
                },
            )

        # Drop the index and restart: the replay is what puts the colliding pair
        # in the catalog, exactly as it would on a real recovery.
        client.__exit__(None, None, None)
        layout.db.unlink()
        restarted = TestClient(
            create_orchestrator_app(
                settings,
                http_client=httpx.AsyncClient(
                    transport=httpx.MockTransport(fake_recorder.handler)
                ),
            )
        )
        with restarted:
            both = {
                d["dataset_id"]
                for d in restarted.get("/api/v1/datasets").json()["items"]
            }
            assert both == set(captures), "the replay must restore both datasets"

            refresh = restarted.post("/api/v1/views/refresh")
            assert refresh.status_code == 200, refresh.text
            body = refresh.json()
            assert body["links"] == 2
            assert body["datasets"] == 2
            # The suffix is not a silent repair: it changes a path an operator
            # globs, so the refresh has to say so and name which dataset moved.
            assert len(body["renamed"]) == 1, body["renamed"]
            assert "ds_bbb" in body["renamed"][0]

            links = _links(layout.views.resolve())
            assert set(links.values()) == set(captures.values()), sorted(links)
            # The dataset that was there first keeps the path it always had.
            assert links[f"alice/pick/{COLLIDING['name']}/001"] == captures["ds_aaa"]
            moved = [
                path
                for path in links
                if not path.startswith(f"alice/pick/{COLLIDING['name']}/")
            ]
            assert len(moved) == 1, sorted(links)
            assert moved[0].startswith(f"alice/pick/{COLLIDING['name']}__")
            assert links[moved[0]] == captures["ds_bbb"]
