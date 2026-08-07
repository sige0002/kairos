"""The importer sidecar's ``/pull`` body contract (§10.6).

This parser is small and it is the whole reason B1 was a blocker rather than a
typo. Before v2 an unrecognised body meant "pull every finished capture from the
robot", so the ``run_id`` → ``capture_id`` rename would have turned every
targeted pull into a full sweep — silently, with no error and no test to catch
it. Each case below pins one way that must not come back.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

_MODULE = Path(__file__).resolve().parents[1] / "importer_httpd.py"


def _load():  # noqa: ANN202 - a module object
    """Import the sidecar directly.

    It lives outside any package (it is COPYed alone into a container that runs
    ``python3 /app/importer_httpd.py``), so there is nothing to import by name.
    Loading it by path is what lets the deployed artifact itself be tested
    rather than a copy of its logic.
    """
    spec = importlib.util.spec_from_file_location("importer_httpd", _MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["importer_httpd"] = module
    spec.loader.exec_module(module)
    return module


importer = _load()
parse_pull_body = importer.parse_pull_body
PullRequestError = importer.PullRequestError

CAPTURE = "01920000-0000-7000-8000-000000000001"


class TestAccepted:
    def test_a_capture_id_is_returned(self) -> None:
        assert parse_pull_body({"capture_id": CAPTURE}) == CAPTURE

    def test_an_explicit_all_requests_the_sweep(self) -> None:
        # None is the sweep signal downstream; it must be reachable ONLY this
        # way, never by omission.
        assert parse_pull_body({"all": True}) is None

    def test_all_false_is_not_a_sweep(self) -> None:
        with pytest.raises(PullRequestError, match="capture_id is required"):
            parse_pull_body({"all": False})


class TestRejected:
    def test_an_empty_body_is_refused(self) -> None:
        # THE regression: this used to mean "pull everything".
        with pytest.raises(PullRequestError, match="capture_id is required"):
            parse_pull_body({})

    def test_the_v1_run_id_key_is_named_in_the_error(self) -> None:
        # A caller that was not updated must get a message it can ACT on. The
        # match is deliberately on the run_id-specific wording rather than on
        # "capture_id": the generic "capture_id is required" branch would also
        # contain that word, so a laxer assertion here would pass even if this
        # key were quietly accepted again.
        with pytest.raises(PullRequestError, match="run_id is not accepted"):
            parse_pull_body({"run_id": "run_20260801_120000"})

    def test_a_run_id_alongside_a_capture_id_is_still_refused(self) -> None:
        # Belt and braces for a half-migrated caller: the presence of the old
        # key is what is refused, not merely the absence of the new one.
        with pytest.raises(PullRequestError, match="run_id is not accepted"):
            parse_pull_body({"run_id": "run_x", "capture_id": CAPTURE})

    def test_a_typo_does_not_degrade_into_a_sweep(self) -> None:
        with pytest.raises(PullRequestError, match="unknown field"):
            parse_pull_body({"captureId": CAPTURE})

    @pytest.mark.parametrize(
        "value",
        [
            "not-a-uuid",
            "01920000-0000-4000-8000-000000000001",  # v4, not v7
            "01920000-0000-7000-0000-000000000001",  # bad variant nibble
            "01920000-0000-7000-8000-00000000000",  # too short
            "../../etc/passwd",
            "",
            123,
            None,
        ],
    )
    def test_a_capture_id_that_is_not_a_uuid7_is_refused(self, value: object) -> None:
        # It is interpolated into a remote find(1) pattern and into local paths
        # on both hosts, so this is a traversal guard as much as a type check.
        with pytest.raises(PullRequestError):
            parse_pull_body({"capture_id": value})

    def test_both_keys_at_once_is_ambiguous(self) -> None:
        with pytest.raises(PullRequestError, match="not both"):
            parse_pull_body({"capture_id": CAPTURE, "all": True})

    @pytest.mark.parametrize("body", ["a string", ["a", "list"], 42, None])
    def test_a_non_object_body_is_refused(self, body: object) -> None:
        with pytest.raises(PullRequestError, match="JSON object"):
            parse_pull_body(body)


class TestJobKey:
    def test_the_script_is_driven_by_CAPTURE_ID(self, monkeypatch) -> None:
        """The env var the sidecar exports must be the one the script reads.

        These are two files that only meet through the environment, so nothing
        else would notice if one of them were renamed.
        """
        captured: dict[str, str] = {}

        class _Result:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(cmd, env, **kwargs):  # noqa: ANN001, ANN202
            captured.update(env)
            return _Result()

        monkeypatch.setattr(importer.subprocess, "run", fake_run)
        importer._run_script(CAPTURE)
        assert captured["CAPTURE_ID"] == CAPTURE
        assert "RUN_ID" not in captured

    def test_a_sweep_unsets_the_capture_key(self, monkeypatch) -> None:
        captured: dict[str, str] = {}

        class _Result:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_run(cmd, env, **kwargs):  # noqa: ANN001, ANN202
            captured.update(env)
            return _Result()

        monkeypatch.setenv("CAPTURE_ID", "leftover-from-a-previous-job")
        monkeypatch.setattr(importer.subprocess, "run", fake_run)
        importer._run_script(None)
        # A stale CAPTURE_ID would silently narrow a sweep to one capture.
        assert "CAPTURE_ID" not in captured
