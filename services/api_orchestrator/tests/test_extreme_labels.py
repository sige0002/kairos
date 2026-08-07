"""E-11: labels an operator can type that a filesystem cannot hold.

``name`` / ``operator`` / ``task`` are free text AND the three components of
every ``views/<operator>/<task>/<dataset>/NNN`` path (§6), so the set of legal
labels is bounded by something no form control knows about: ``NAME_MAX``, 255
**bytes** per component on every Linux filesystem kairos runs on.

Two separate things have to be true, and neither implies the other:

* **the door** — a label that cannot become a path is refused when it is typed,
  with a message naming the limit, the way a reserved name already is;
* **the tree** — a label that got in anyway must not stop the regeneration.
  ``views.regenerate`` promises this in its own docstring ("A regeneration
  always finishes. Nothing about one member may abandon the walk"), because the
  symlink flip happens at the END: an exception partway through leaves ``views``
  pointing at the tree from before the change and every LATER edit hitting the
  same fault. One bad label freezes the tree for every dataset, permanently.

The second is not hypothetical once the first exists, because the door is not
the only way in. ``list_view_entries`` resolves a member's path with
``COALESCE(d.operator, c.operator)``: a dataset that leaves ``operator`` unset
inherits the CAPTURE's, which comes from the recorder's start request and from
rebuilt manifests, and is bounded by nothing at all. Ledger replay reaches the
same rows without passing the service guards — the E-4 lesson.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from api_orchestrator.layout import DataLayout
from api_orchestrator.store import CaptureStore
from conftest import settle_views
from fastapi.testclient import TestClient

# NAME_MAX. A label is a single path component, so this is the whole budget.
NAME_MAX_BYTES = 255


def _seed_capture_with_labels(
    client: TestClient, data_dir: Path, *, operator: str, task: str
) -> str:
    """A completed capture carrying labels nothing on the write path checks.

    ``POST /record/start`` takes ``operator``/``task`` as unbounded strings and
    the recorder stamps them into the manifest, so this is what a recording
    made with a pasted label looks like by the time views reads it.
    """
    from test_batch_index_collision import _seed_capture

    store: CaptureStore = client.app.state.capture_store
    capture_id = _seed_capture(
        store, DataLayout(data_dir=data_dir), client.app.state.instance_id
    )
    store.update_capture(capture_id, operator=operator, task=task)
    return capture_id


def _dataset_with_a_member(
    client: TestClient, data_dir: Path, body: dict[str, object]
) -> str:
    from test_batch_index_collision import _seed_capture

    created = client.post("/api/v1/datasets", json=body)
    assert created.status_code == 201, created.text
    dataset_id = created.json()["dataset_id"]
    capture_id = _seed_capture(
        client.app.state.capture_store,
        DataLayout(data_dir=data_dir),
        client.app.state.instance_id,
    )
    added = client.post(
        f"/api/v1/datasets/{dataset_id}/members", json={"capture_id": capture_id}
    )
    assert added.status_code == 201, added.text
    return dataset_id


def _tree(data_dir: Path) -> list[str]:
    views = data_dir / "views"
    if not views.exists():
        return []
    return sorted(str(p.relative_to(views)) for p in views.rglob("*"))


class TestTheDoor:
    """A label that cannot become a path is refused where it is typed."""

    @pytest.mark.parametrize("field", ["operator", "task"])
    def test_a_ten_thousand_character_label_is_refused(
        self, field: str, client: TestClient
    ) -> None:
        """``name`` has had a 200-character cap all along; these two had none.

        They are path components exactly as ``name`` is, so an unbounded one is
        the same fault with no message attached to it.
        """
        body = {"name": "fine", field: "o" * 10_000}
        response = client.post("/api/v1/datasets", json=body)
        assert response.status_code in (400, 422), response.text
        # The refusal describes the label; it does not repeat it. Pydantic's
        # own ``string_too_long`` quotes the offending input back, which for a
        # pasted document means the error is the document.
        assert "o" * 300 not in response.text
        assert len(response.text) < 1000

    def test_two_hundred_emoji_are_too_long_even_though_they_are_200_characters(
        self, client: TestClient
    ) -> None:
        """The cap that exists counts characters; the filesystem counts bytes.

        200 emoji satisfy ``max_length=200`` and occupy 800 bytes, which is
        three times what a directory entry can hold. A character cap alone
        cannot express this limit.
        """
        name = "\U0001f600" * 200
        assert len(name) == 200
        assert len(name.encode()) > NAME_MAX_BYTES

        response = client.post("/api/v1/datasets", json={"name": name})
        assert response.status_code in (400, 422), response.text

    def test_a_label_that_fits_is_still_accepted(self, client: TestClient) -> None:
        """The positive control: this must not become "ASCII only".

        A Japanese task name is three bytes per character and entirely
        reasonable; a rule stated in bytes must still admit it, and the
        long-standing 200-character ASCII limit must not quietly tighten.
        """
        response = client.post(
            "/api/v1/datasets",
            json={"name": "n" * 200, "operator": "田中", "task": "ペットボトルを掴む"},
        )
        assert response.status_code == 201, response.text
        assert response.json()["task"] == "ペットボトルを掴む"

    def test_the_refusal_says_what_the_limit_is(self, client: TestClient) -> None:
        """A rejection an operator cannot act on is a dead end (§12).

        ``reserved_name`` names the offending label and what to do; this one has
        to name the budget, because "too long" without a number leaves an
        operator deleting characters at random.
        """
        response = client.post(
            "/api/v1/datasets", json={"name": "ok", "operator": "o" * 10_000}
        )
        assert response.status_code == 400, response.text
        error = response.json()["error"]
        assert error["code"] == "label_too_long"
        assert str(NAME_MAX_BYTES) in error["message"]
        assert error["details"]["field"] == "operator"


class TestTheTree:
    """A label that got in anyway must not freeze the generated tree."""

    def test_one_impossible_label_does_not_stop_the_regeneration(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """The freeze, through the door the dataset guard cannot cover.

        The dataset leaves ``operator`` unset, so views takes the CAPTURE's —
        and no write path bounds that. Before the fix this raised
        ``OSError: [Errno 36] File name too long`` out of ``mkdir`` in the
        middle of the walk, so ``views`` was never flipped.
        """
        _dataset_with_a_member(
            client, data_dir, {"name": "healthy", "operator": "op", "task": "t"}
        )
        settle_views(client)
        assert client.post("/api/v1/views/refresh").status_code == 200
        assert "op/t/healthy/001" in _tree(data_dir)

        from test_batch_index_collision import _seed_capture

        created = client.post("/api/v1/datasets", json={"name": "inherits"})
        assert created.status_code == 201
        doomed = _seed_capture_with_labels(
            client, data_dir, operator="o" * 10_000, task="t"
        )
        added = client.post(
            f"/api/v1/datasets/{created.json()['dataset_id']}/members",
            json={"capture_id": doomed},
        )
        assert added.status_code == 201, added.text

        refreshed = client.post("/api/v1/views/refresh")
        assert refreshed.status_code == 200, refreshed.text
        # Skipped and NAMED: a member silently missing from the tree is the
        # failure this module's docstring is about.
        skipped = refreshed.json()["skipped"]
        assert any(doomed in entry for entry in skipped), skipped

        # And the tree is still being maintained for everyone else — the whole
        # point. A later, perfectly ordinary dataset must appear.
        _seed_capture(
            client.app.state.capture_store,
            DataLayout(data_dir=data_dir),
            client.app.state.instance_id,
        )
        _dataset_with_a_member(
            client, data_dir, {"name": "later", "operator": "op", "task": "t"}
        )
        assert client.post("/api/v1/views/refresh").status_code == 200
        tree = _tree(data_dir)
        assert "op/t/later/001" in tree
        assert "op/t/healthy/001" in tree

    def test_the_refresh_endpoint_does_not_answer_with_a_bare_oserror(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """``POST /views/refresh`` raised the OSError straight through.

        Not a 500 with a code — an unhandled exception out of the handler, which
        is the shape E-4 already had to fix once for the collision case.
        """
        created = client.post("/api/v1/datasets", json={"name": "inherits"})
        doomed = _seed_capture_with_labels(
            client, data_dir, operator="o" * 10_000, task="t"
        )
        client.post(
            f"/api/v1/datasets/{created.json()['dataset_id']}/members",
            json={"capture_id": doomed},
        )
        response = client.post("/api/v1/views/refresh")
        assert response.status_code == 200, response.text


class TestLabelsThatAreMerelyAwkward:
    """Already handled. Pinned so a future edit to ``_UNSAFE`` cannot undo it."""

    def test_separators_never_add_a_directory_level(
        self, client: TestClient, data_dir: Path
    ) -> None:
        _dataset_with_a_member(
            client, data_dir, {"name": "a/b", "operator": "c\\d", "task": "e/f"}
        )
        assert client.post("/api/v1/views/refresh").status_code == 200
        assert _tree(data_dir) == ["c_d", "c_d/e_f", "c_d/e_f/a_b", "c_d/e_f/a_b/001"]

    def test_dot_names_fall_back_instead_of_escaping_views(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """``..`` as a path component would climb out of the tree entirely."""
        _dataset_with_a_member(
            client, data_dir, {"name": "..", "operator": ".", "task": ".."}
        )
        assert client.post("/api/v1/views/refresh").status_code == 200
        assert "unknown_operator/unknown_task/unnamed/001" in _tree(data_dir)

    def test_newlines_and_tabs_do_not_reach_the_tree(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """A folder whose name contains a newline breaks the tree's own purpose.

        ``views/`` exists for "an operator with a file manager, and a training
        script with a glob". A newline in a component is legal on Linux and
        wrecks every line-oriented tool that walks it — ``find | while read``,
        a manifest listing, a log line. It is sanitized for the same reason
        ``/`` is: not because the kernel refuses it, but because the tree is
        meant to be readable by things that are not this program.
        """
        _dataset_with_a_member(
            client, data_dir, {"name": "a\nb", "operator": "c\td", "task": "e\x0bf"}
        )
        assert client.post("/api/v1/views/refresh").status_code == 200
        tree = _tree(data_dir)
        assert not any("\n" in entry or "\t" in entry for entry in tree), tree
        assert "c_d/e_f/a_b/001" in tree


class TestFailureReason:
    """The other free-text field E-11 names. Not a path — still unbounded."""

    def _capture(self, client: TestClient, data_dir: Path) -> str:
        from test_batch_index_collision import _seed_capture

        return _seed_capture(
            client.app.state.capture_store,
            DataLayout(data_dir=data_dir),
            client.app.state.instance_id,
        )

    def test_a_pasted_document_is_not_stored_as_a_failure_reason(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """10,000 characters were accepted and stored in full.

        It reaches record.json, the Review row and the delete dialog's
        "episode #N · <reason>". ``ValidationOverrideRequest.reason`` — the
        other free-text explanation on this API — has been capped at 500 all
        along; this one had no bound.
        """
        response = client.patch(
            f"/api/v1/captures/{self._capture(client, data_dir)}/review",
            json={
                "base_revision": 0,
                "task_result": "failure",
                "failure_reason": "r" * 10_000,
            },
        )
        assert response.status_code == 422, response.text

    def test_a_real_failure_reason_still_saves(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """The positive control: the vocabulary Collect actually sends."""
        response = client.patch(
            f"/api/v1/captures/{self._capture(client, data_dir)}/review",
            json={
                "base_revision": 0,
                "task_result": "failure",
                "failure_reason": "把持に失敗（対象が滑った）",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["failure_reason"] == "把持に失敗（対象が滑った）"


class TestTheLedgerStaysOneLinePerEvent:
    def test_a_label_full_of_newlines_does_not_forge_a_line(
        self, client: TestClient, data_dir: Path
    ) -> None:
        """``lifecycle.jsonl`` is the store's source of truth for §8 replay.

        One event per line is what makes it recoverable. A label carrying a
        newline plus a plausible-looking object would, if it were ever written
        raw, insert an event nobody performed.
        """
        forged = 'a\nb\n{"kind": "dataset_deleted", "dataset_id": "x"}'
        created = client.post(
            "/api/v1/datasets", json={"name": "real", "operator": "op", "task": forged}
        )
        assert created.status_code == 201, created.text

        raw = (data_dir / "lifecycle.jsonl").read_text(encoding="utf-8")
        lines = [line for line in raw.splitlines() if line.strip()]
        kinds = []
        for line in lines:
            kinds.append(json.loads(line)["kind"])  # raises if a line is not JSON
        assert kinds == ["dataset_created"]
        assert json.loads(lines[0])["task"] == forged
