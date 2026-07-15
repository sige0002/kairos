"""Single-file aspect editors: ``GET/PUT /api/v1/config/{signals,alerts}``.

S1' / F2'': Settings > Data quality reads and writes two per-robot config files
that are NOT selectable Config-tab options — the Review Signals defaults
(``signals/default.yaml``) and the topic_monitor alert rules
(``monitoring/alerts.yaml``). Each resolves the ACTIVE robot's file through the
catalog, validates on PUT (unknown keys rejected), and atomically rewrites the
file (temp + ``os.replace``) exactly like ``/config/recording``.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import yaml
from api_orchestrator.app_factory import create_orchestrator_app
from api_orchestrator.store import RunStore
from fastapi.testclient import TestClient
from kairos_common import Settings

_ROBOT = "testbot"
# A robot dir must carry at least one selectable aspect to be recognised, so seed
# a minimal (valid) recording config; the app also loads it at startup.
_MIN_RECORDING = {"robot_name": _ROBOT, "default_topics": ["/x"]}

_SIGNALS = {
    "hidden_field_patterns": ["header.*"],
    "default_topic": "/hsrb/joint_states",
    "defaults": [
        {"msg_type": "sensor_msgs/msg/JointState", "fields": ["position[0]"]},
    ],
    "fallback_fields": 4,
}

_ALERTS = {
    "rules": [
        {"topic": "/hsrb/joint_states", "metric": "hz", "op": "lt", "threshold": 15},
    ],
}


def _tree(
    tmp_path: Path, *, signals: dict | None = None, alerts: dict | None = None
) -> Path:
    """Build a tmp ``config/`` tree with the ``testbot`` robot; return its root."""
    root = tmp_path / "config"
    rdir = root / _ROBOT
    (rdir / "recording").mkdir(parents=True)
    (rdir / "recording" / "default.yaml").write_text(
        yaml.safe_dump(_MIN_RECORDING), encoding="utf-8"
    )
    if signals is not None:
        (rdir / "signals").mkdir(parents=True)
        (rdir / "signals" / "default.yaml").write_text(
            yaml.safe_dump(signals), encoding="utf-8"
        )
    if alerts is not None:
        (rdir / "monitoring").mkdir(parents=True)
        (rdir / "monitoring" / "alerts.yaml").write_text(
            yaml.safe_dump(alerts), encoding="utf-8"
        )
    return root


def _client(root: Path, fake_recorder) -> TestClient:
    settings = Settings(
        robot=_ROBOT,
        config_dir=str(root),
        config_local_dir=str(root / "local"),
        recording_config=str(root / _ROBOT / "recording" / "default.yaml"),
        stream_config="/nonexistent/stream.yaml",
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(
        settings, store=RunStore(":memory:"), http_client=http_client
    )
    return TestClient(app)


# ---- signals -------------------------------------------------------------


def test_get_signals_builtin_default_when_absent(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path), fake_recorder) as c:
        body = c.get("/api/v1/config/signals").json()
        # Built-in fallback (hide header.*, first 4 leaves); raw is null (unwritten).
        assert body["config"]["hidden_field_patterns"] == ["header.*"]
        assert body["config"]["fallback_fields"] == 4
        assert body["raw"] is None
        assert body["path"].endswith("signals/default.yaml")


def test_get_signals_returns_seeded(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path, signals=_SIGNALS), fake_recorder) as c:
        body = c.get("/api/v1/config/signals").json()
        assert body["config"]["default_topic"] == "/hsrb/joint_states"
        assert body["config"]["defaults"][0]["msg_type"] == "sensor_msgs/msg/JointState"
        assert body["raw"] is not None and "header.*" in body["raw"]


def test_put_signals_persists_and_reflects(tmp_path: Path, fake_recorder) -> None:
    root = _tree(tmp_path)
    target = root / _ROBOT / "signals" / "default.yaml"
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/signals", json={"config": _SIGNALS})
        assert resp.status_code == 200
        assert resp.json()["config"]["fallback_fields"] == 4

        # Written to disk (parent dir created) as YAML.
        assert target.exists()
        on_disk = yaml.safe_load(target.read_text(encoding="utf-8"))
        assert on_disk["default_topic"] == "/hsrb/joint_states"

        # GET reflects it immediately (display-only, no restart).
        got = c.get("/api/v1/config/signals").json()
        assert got["config"]["default_topic"] == "/hsrb/joint_states"
        assert got["raw"] is not None


def test_put_signals_via_raw_yaml(tmp_path: Path, fake_recorder) -> None:
    root = _tree(tmp_path)
    target = root / _ROBOT / "signals" / "default.yaml"
    raw = "hidden_field_patterns: ['header.*']\ndefault_topic: /a\nfallback_fields: 2\n"
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/signals", json={"raw": raw})
        assert resp.status_code == 200
        assert resp.json()["config"]["fallback_fields"] == 2
        assert (
            yaml.safe_load(target.read_text(encoding="utf-8"))["default_topic"] == "/a"
        )


def test_put_signals_rejects_unknown_key(tmp_path: Path, fake_recorder) -> None:
    root = _tree(tmp_path)
    target = root / _ROBOT / "signals" / "default.yaml"
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/signals", json={"config": {"bogus_key": 1}})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "invalid_config"
        assert resp.json()["error"]["details"]["errors"]
        assert not target.exists()  # nothing written on a failed validation


def test_put_signals_rejects_negative_fallback(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/signals", json={"config": {"fallback_fields": -1}})
        assert resp.status_code == 422


def test_put_signals_rejects_bad_yaml(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/signals", json={"raw": "key: [unterminated"})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "invalid_yaml"


# ---- alerts --------------------------------------------------------------


def test_get_alerts_seeded(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path, alerts=_ALERTS), fake_recorder) as c:
        body = c.get("/api/v1/config/alerts").json()
        assert body["config"]["rules"][0]["topic"] == "/hsrb/joint_states"
        assert body["warnings"] == []
        assert "hz" in body["raw"]


def test_get_alerts_empty_when_absent(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path), fake_recorder) as c:
        body = c.get("/api/v1/config/alerts").json()
        assert body["config"]["rules"] == []
        assert body["raw"] is None


def test_put_alerts_persists_and_reflects(tmp_path: Path, fake_recorder) -> None:
    root = _tree(tmp_path)
    target = root / _ROBOT / "monitoring" / "alerts.yaml"
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"config": _ALERTS})
        assert resp.status_code == 200
        assert resp.json()["warnings"] == []
        assert target.exists()
        on_disk = yaml.safe_load(target.read_text(encoding="utf-8"))
        assert on_disk["rules"][0]["metric"] == "hz"
        assert c.get("/api/v1/config/alerts").json()["config"]["rules"][0]["op"] == "lt"


def test_put_alerts_rejects_bad_metric(tmp_path: Path, fake_recorder) -> None:
    root = _tree(tmp_path, alerts=_ALERTS)
    target = root / _ROBOT / "monitoring" / "alerts.yaml"
    before = target.read_text(encoding="utf-8")
    bad = {"rules": [{"topic": "/x", "metric": "bogus", "op": "lt", "threshold": 1}]}
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"config": bad})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "invalid_config"
        assert target.read_text(encoding="utf-8") == before  # unchanged


def test_put_alerts_rejects_bad_op(tmp_path: Path, fake_recorder) -> None:
    bad = {"rules": [{"topic": "/x", "metric": "hz", "op": "eq", "threshold": 1}]}
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"config": bad})
        assert resp.status_code == 422


def test_put_alerts_loss_warning_surfaced(tmp_path: Path, fake_recorder) -> None:
    # `metric: loss` is a VALID metric (accepted) but can never fire — the write
    # succeeds and the response warns about it (F2'' loss caveat).
    loss = {"rules": [{"topic": "/x", "metric": "loss", "op": "gt", "threshold": 0.1}]}
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"config": loss})
        assert resp.status_code == 200
        warnings = resp.json()["warnings"]
        assert len(warnings) == 1 and "loss" in warnings[0] and "/x" in warnings[0]
        # And GET surfaces the same warning from the persisted file.
        assert c.get("/api/v1/config/alerts").json()["warnings"] == warnings


def test_put_alerts_accepts_derived_rules_block(tmp_path: Path, fake_recorder) -> None:
    cfg = {
        "rules": [],
        "derived_rules": {"enabled": False, "warn_ratio": 0.7, "danger_ratio": 0.4},
    }
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"config": cfg})
        assert resp.status_code == 200
        assert resp.json()["config"]["derived_rules"]["enabled"] is False
