"""Stream-config editor endpoints (``GET``/``PUT`` ``/api/v1/config/stream``).

Settings > Robots edits the Collect camera-grid layout (STREAM_CONFIG) in
place: ``PUT`` validates, atomically persists the YAML, and hot-swaps the
in-memory copy so ``GET /api/v1/config``'s ``stream`` block serves the new
layout immediately. An invalid config is rejected (422) and leaves the file
untouched; a robot without a stream aspect has nowhere to write (404).
"""

from __future__ import annotations

from pathlib import Path

import httpx
import yaml
from api_orchestrator.app_factory import create_orchestrator_app
from fastapi.testclient import TestClient
from kairos_common import Settings

_VALID_CONFIG = {
    "columns": 3,
    "panes": [
        {"topic": "/camera/head/color/image_raw/compressed"},
        {"topic": None},
    ],
}


def _client(tmp_path: Path, fake_recorder, *, seed: dict | None = None) -> TestClient:
    """Build a wired app whose STREAM_CONFIG points at a writable tmp file.

    If *seed* is given it is written first so the service boots with a live
    stream config; otherwise the file is absent (config starts as ``None`` but
    the path still points where a first save would create it).
    """
    cfg_path = tmp_path / "stream.yaml"
    if seed is not None:
        cfg_path.write_text(yaml.safe_dump(seed), encoding="utf-8")
    settings = Settings(
        data_dir=str(tmp_path / "data"),
        recording_config=str(tmp_path / "recording.yaml"),
        stream_config=str(cfg_path),
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, http_client=http_client)
    return TestClient(app)


def test_get_stream_config_returns_seeded(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, seed=_VALID_CONFIG) as c:
        body = c.get("/api/v1/config/stream").json()
        assert body["config"]["columns"] == 3
        assert [p["topic"] for p in body["config"]["panes"]] == [
            "/camera/head/color/image_raw/compressed",
            None,
        ]
        assert body["path"] == str(tmp_path / "stream.yaml")


def test_get_stream_config_null_when_absent_but_path_known(
    tmp_path: Path, fake_recorder
) -> None:
    with _client(tmp_path, fake_recorder) as c:
        body = c.get("/api/v1/config/stream").json()
        assert body["config"] is None
        # The path is still reported: a first PUT creates the file there.
        assert body["path"] == str(tmp_path / "stream.yaml")
        # Absent, not broken — no load error to disclose.
        assert body["error"] is None


def test_get_discloses_a_present_but_broken_file(tmp_path: Path, fake_recorder) -> None:
    """A file that EXISTS but fails to load is not the same as an absent one.

    The editor used to render both as a clean `{}` — and a save then replaced
    the broken original (with whatever camera topics it meant to define) with
    an empty default, silently. The GET now carries the loader's error so the
    editor can warn first.
    """
    cfg_path = tmp_path / "stream.yaml"
    cfg_path.write_text("columns: 9\npanes: []\n", encoding="utf-8")  # out of range
    with _client(tmp_path, fake_recorder) as c:
        body = c.get("/api/v1/config/stream").json()
        assert body["config"] is None
        assert body["path"] == str(cfg_path)
        assert body["error"] and "stream config" in body["error"].lower()


def test_get_readopts_a_file_fixed_on_disk(tmp_path: Path, fake_recorder) -> None:
    """Broken at startup, fixed outside kairos: GET converges to the file."""
    cfg_path = tmp_path / "stream.yaml"
    cfg_path.write_text("columns: [broken\n", encoding="utf-8")
    with _client(tmp_path, fake_recorder) as c:
        assert c.get("/api/v1/config/stream").json()["error"]
        cfg_path.write_text("columns: 4\npanes: []\n", encoding="utf-8")
        body = c.get("/api/v1/config/stream").json()
        assert body["error"] is None
        assert body["config"]["columns"] == 4
        # The live copy converged too: GET /api/v1/config serves it.
        assert c.get("/api/v1/config").json()["stream"]["columns"] == 4


def test_put_creates_persists_and_hot_swaps(tmp_path: Path, fake_recorder) -> None:
    cfg_path = tmp_path / "stream.yaml"
    with _client(tmp_path, fake_recorder) as c:  # file absent: first save creates
        resp = c.put("/api/v1/config/stream", json={"config": _VALID_CONFIG})
        assert resp.status_code == 200
        assert resp.json()["config"]["columns"] == 3

        # Persisted to the file as YAML.
        on_disk = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert on_disk["columns"] == 3
        assert on_disk["panes"][0]["topic"] == (
            "/camera/head/color/image_raw/compressed"
        )

        # GET /config/stream reflects the new config without a restart.
        assert c.get("/api/v1/config/stream").json()["config"]["columns"] == 3

        # GET /api/v1/config's stream block (what Collect reads) serves it too.
        stream = c.get("/api/v1/config").json()["stream"]
        assert stream["columns"] == 3
        assert len(stream["panes"]) == 2


def test_put_invalid_returns_422_and_does_not_write(
    tmp_path: Path, fake_recorder
) -> None:
    cfg_path = tmp_path / "stream.yaml"
    with _client(tmp_path, fake_recorder, seed=_VALID_CONFIG) as c:
        before = cfg_path.read_text(encoding="utf-8")
        # columns out of range AND an unknown key (extra="forbid").
        bad = {"columns": 9, "bogus_key": 1}
        resp = c.put("/api/v1/config/stream", json={"config": bad})
        assert resp.status_code == 422
        envelope = resp.json()["error"]
        assert envelope["code"] == "invalid_config"
        assert envelope["details"]["errors"]

        # The on-disk file is unchanged, and the live config still the seed.
        assert cfg_path.read_text(encoding="utf-8") == before
        assert c.get("/api/v1/config/stream").json()["config"]["columns"] == 3


def test_put_404_when_robot_has_no_config_dir(tmp_path: Path, fake_recorder) -> None:
    """A robot with no config dir at all has nowhere to read or write.

    (A robot WITH a config dir but no stream file gets a creation target
    instead — see test_config_select.py.) The editor must get a clear 404,
    not a write to some stale path.
    """
    with _client(tmp_path, fake_recorder, seed=_VALID_CONFIG) as c:
        c.app.state.stream_config_path = None  # what _apply_stream resolves to
        c.app.state.stream_config = None
        assert c.get("/api/v1/config/stream").json() == {
            "config": None,
            "path": None,
            "error": None,
        }
        resp = c.put("/api/v1/config/stream", json={"config": _VALID_CONFIG})
        assert resp.status_code == 404
        assert resp.json()["error"]["code"] == "config_not_found"


def test_empty_config_saves_defaults(tmp_path: Path, fake_recorder) -> None:
    """`{}` is a valid stream config (all defaults) — the seed for a new file."""
    with _client(tmp_path, fake_recorder) as c:
        resp = c.put("/api/v1/config/stream", json={"config": {}})
        assert resp.status_code == 200
        assert resp.json()["config"] == {"columns": 2, "panes": []}
