"""Recording-config editor endpoints (``GET``/``PUT`` ``/api/v1/config/recording``).

The Config tab edits the full RECORDING_CONFIG (task T-C1): ``PUT`` validates,
atomically persists the YAML to the on-prem ``settings.recording_config`` file,
and hot-swaps the in-memory copy so ``GET /api/v1/config`` and the next start's
``default_topics`` reflect it immediately (recorder/monitor caches still need a
restart, which the UI states). An invalid config is rejected (422) and leaves
the file untouched.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import yaml
from api_orchestrator.app_factory import create_orchestrator_app
from fastapi.testclient import TestClient
from kairos_common import Settings

# A minimal-but-complete RecordingConfig the editor can post.
_VALID_CONFIG = {
    "robot_name": "hsr",
    "default_topics": ["/hsrb/joint_states"],
    "expected_hz_patterns": [{"pattern": "/hsrb/*", "hz": 30.0}],
    "topic_qos_overrides": [
        {
            "pattern": "/hsrb/head_*",
            "reliability": "best_effort",
            "durability": "volatile",
            "depth": 5,
        }
    ],
}


def _client(tmp_path: Path, fake_recorder, *, seed: dict | None = None) -> TestClient:
    """Build a wired app whose RECORDING_CONFIG points at a writable tmp file.

    If *seed* is given, it is written to the path first so the service boots with
    a live config; otherwise the file is absent (config starts as ``None``).
    """
    cfg_path = tmp_path / "recording.yaml"
    if seed is not None:
        cfg_path.write_text(yaml.safe_dump(seed), encoding="utf-8")
    settings = Settings(
        data_dir=str(tmp_path / "data"),
        recording_config=str(cfg_path),
        stream_config="/nonexistent/stream.yaml",
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, http_client=http_client)
    return TestClient(app)


def test_get_recording_config_returns_seeded(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder, seed=_VALID_CONFIG) as c:
        body = c.get("/api/v1/config/recording").json()
        assert body["config"]["robot_name"] == "hsr"
        assert body["config"]["default_topics"] == ["/hsrb/joint_states"]
        assert body["path"] == str(tmp_path / "recording.yaml")


def test_get_recording_config_null_when_absent(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder) as c:
        body = c.get("/api/v1/config/recording").json()
        assert body["config"] is None
        assert body["path"] == str(tmp_path / "recording.yaml")


def test_put_persists_and_hot_swaps(tmp_path: Path, fake_recorder) -> None:
    cfg_path = tmp_path / "recording.yaml"
    with _client(tmp_path, fake_recorder) as c:
        resp = c.put("/api/v1/config/recording", json={"config": _VALID_CONFIG})
        assert resp.status_code == 200
        assert resp.json()["config"]["robot_name"] == "hsr"

        # Persisted to the on-prem file as YAML.
        assert cfg_path.exists()
        on_disk = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
        assert on_disk["robot_name"] == "hsr"
        assert on_disk["default_topics"] == ["/hsrb/joint_states"]

        # GET reflects the new config without a restart.
        assert c.get("/api/v1/config/recording").json()["config"]["robot_name"] == "hsr"

        # GET /api/v1/config defaults now surface the edited topics + robot.
        defaults = c.get("/api/v1/config").json()["defaults"]
        assert defaults["default_topics"] == ["/hsrb/joint_states"]
        assert defaults["robot_name"] == "hsr"
        assert defaults["expected_hz"] == {"/hsrb/*": 30.0}


def test_put_invalid_returns_422_and_does_not_write(
    tmp_path: Path, fake_recorder
) -> None:
    cfg_path = tmp_path / "recording.yaml"
    # Seed a known-good file so we can assert it is left untouched on a bad PUT.
    with _client(tmp_path, fake_recorder, seed=_VALID_CONFIG) as c:
        before = cfg_path.read_text(encoding="utf-8")
        # Missing required `robot_name` + an unknown key (extra="forbid").
        bad = {"default_topics": ["/x"], "bogus_key": 1}
        resp = c.put("/api/v1/config/recording", json={"config": bad})
        assert resp.status_code == 422
        envelope = resp.json()["error"]
        assert envelope["code"] == "invalid_config"
        assert envelope["details"]["errors"]  # field errors carried through

        # The on-disk file is unchanged, and the live config still the seed.
        assert cfg_path.read_text(encoding="utf-8") == before
        assert c.get("/api/v1/config/recording").json()["config"]["robot_name"] == "hsr"


def test_a_hand_broken_config_degrades_instead_of_stopping_the_service(
    tmp_path: Path, fake_recorder
) -> None:
    """E-20, config half: the file was edited outside kairos and left invalid.

    ``_load_recording_config`` is written to warn and carry on for a config it
    cannot use — that is the whole point of returning ``None``. An unparseable
    file is the most ordinary way to arrive there, and it must reach the same
    place as a config that merely fails validation, rather than escaping as a
    YAML error nobody catches and taking the service down at construction.
    """
    cfg_path = tmp_path / "recording.yaml"
    cfg_path.write_text("robot_name: hsr\ntopics:\n\t- /a\n", encoding="utf-8")
    settings = Settings(
        data_dir=str(tmp_path / "data"),
        recording_config=str(cfg_path),
        stream_config="/nonexistent/stream.yaml",
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )

    with TestClient(create_orchestrator_app(settings, http_client=http_client)) as c:
        body = c.get("/api/v1/config/recording").json()
        # Reported as absent, with the path, so the Config tab can say which
        # file to go and fix.
        assert body["config"] is None
        assert body["path"] == str(cfg_path)
