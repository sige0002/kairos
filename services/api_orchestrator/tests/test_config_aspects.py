# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Single-file aspect editor: ``GET/PUT /api/v1/config/alerts``.

F2'': Settings > Data quality reads and writes a per-robot config file that is
NOT a selectable Config-tab option — the topic_monitor alert rules
(``monitoring/alerts.yaml``). It resolves the ACTIVE robot's file through the
catalog, validates on PUT (unknown keys rejected), and atomically rewrites the
file (temp + ``os.replace``) exactly like ``/config/recording``.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import yaml
from api_orchestrator.app_factory import create_orchestrator_app
from fastapi.testclient import TestClient
from kairos_common import Settings

_ROBOT = "testbot"
# A robot dir must carry at least one selectable aspect to be recognised, so seed
# a minimal (valid) recording config; the app also loads it at startup.
_MIN_RECORDING = {"robot_name": _ROBOT, "default_topics": ["/x"]}

_ALERTS = {
    "rules": [
        {"topic": "/hsrb/joint_states", "metric": "hz", "op": "lt", "threshold": 15},
    ],
}


def _tree(tmp_path: Path, *, alerts: dict | None = None) -> Path:
    """Build a tmp ``config/`` tree with the ``testbot`` robot; return its root."""
    root = tmp_path / "config"
    rdir = root / _ROBOT
    (rdir / "recording").mkdir(parents=True)
    (rdir / "recording" / "default.yaml").write_text(
        yaml.safe_dump(_MIN_RECORDING), encoding="utf-8"
    )
    if alerts is not None:
        (rdir / "monitoring").mkdir(parents=True)
        (rdir / "monitoring" / "alerts.yaml").write_text(
            yaml.safe_dump(alerts), encoding="utf-8"
        )
    return root


def _client(root: Path, fake_recorder) -> TestClient:
    settings = Settings(
        data_dir=str(root.parent / "data"),
        robot=_ROBOT,
        config_dir=str(root),
        config_local_dir=str(root / "local"),
        recording_config=str(root / _ROBOT / "recording" / "default.yaml"),
        stream_config="/nonexistent/stream.yaml",
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, http_client=http_client)
    return TestClient(app)


# ---- alerts --------------------------------------------------------------


def test_config_signals_endpoint_is_gone(tmp_path: Path, fake_recorder) -> None:
    """The retired ``/config/signals`` editor 404s (removed with the Review chart)."""
    with _client(_tree(tmp_path), fake_recorder) as c:
        assert c.get("/api/v1/config/signals").status_code == 404


def test_put_alerts_rejects_bad_yaml(tmp_path: Path, fake_recorder) -> None:
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"raw": "key: [unterminated"})
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "invalid_yaml"


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


# ---- YAML hazards in the Advanced (raw) editor ---------------------------
# The frontend ships no YAML parser, so `raw` is parsed here and the file is
# rewritten CANONICALLY from the validated model. That round trip is where an
# operator's text can lose meaning, so each hazard is pinned to the behaviour we
# want rather than left to whatever PyYAML happens to do.


def test_put_alerts_rejects_duplicate_keys_naming_the_key(
    tmp_path: Path, fake_recorder
) -> None:
    """A duplicated key must be REFUSED, not silently resolved to the last one.

    PyYAML keeps the last occurrence and drops the earlier silently, so this
    text — which visibly contains two rules — would save with one rule and no
    error at all. A refused save is fine; a save that drops a rule is not.
    """
    root = _tree(tmp_path)
    target = root / _ROBOT / "monitoring" / "alerts.yaml"
    raw = (
        "rules:\n"
        "  - topic: /hsrb/joint_states\n"
        "    metric: hz\n"
        "    op: lt\n"
        "    threshold: 15\n"
        "rules:\n"
        "  - topic: /hsrb/odom\n"
        "    metric: gap\n"
        "    op: gt\n"
        "    threshold: 2\n"
    )
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"raw": raw})
        assert resp.status_code == 422
        err = resp.json()["error"]
        # The operator is looking at YAML that reads as valid, so the message has
        # to say WHICH key collided — "invalid YAML" alone is half a fix.
        assert "rules" in err["message"]
        assert "duplicate" in err["message"].lower()
        # Nothing was written.
        assert not target.exists()


def test_put_alerts_rejects_a_duplicate_key_inside_one_rule(
    tmp_path: Path, fake_recorder
) -> None:
    """Same hazard one level down: two `topic:` in a single rule."""
    raw = (
        "rules:\n"
        "  - topic: /hsrb/joint_states\n"
        "    topic: /hsrb/odom\n"
        "    metric: hz\n"
        "    op: lt\n"
        "    threshold: 15\n"
    )
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"raw": raw})
        assert resp.status_code == 422
        assert "topic" in resp.json()["error"]["message"]


def test_put_alerts_rejects_tabs_loudly(tmp_path: Path, fake_recorder) -> None:
    """Tabs are a hard YAML scan error — already loud, pinned so it stays that way.

    The scanner message goes in ``details.error`` and is the only part that says
    WHERE the bad character is; the client renders it (see configAspects'
    formatValidationDetails), so the contract is pinned on both sides.
    """
    with _client(_tree(tmp_path), fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"raw": "rules:\n\t- topic: /a\n"})
        assert resp.status_code == 422
        err = resp.json()["error"]
        assert err["code"] == "invalid_yaml"
        assert "line 2" in err["details"]["error"]


def test_put_alerts_expands_anchors_keeping_every_rule(
    tmp_path: Path, fake_recorder
) -> None:
    """Anchors/merge keys EXPAND: the structure is lost, the meaning is not.

    Both rules survive, and because the response carries the rewritten file the
    editor re-seeds from it — so the operator sees the expansion immediately
    rather than keeping an illusion of anchors that are no longer on disk. That
    is loud enough, so this is recorded as intended behaviour, not a defect.
    """
    root = _tree(tmp_path)
    raw = (
        "rules:\n"
        "  - &base\n"
        "    topic: /hsrb/joint_states\n"
        "    metric: hz\n"
        "    op: lt\n"
        "    threshold: 15\n"
        "  - <<: *base\n"
        "    topic: /hsrb/odom\n"
    )
    with _client(root, fake_recorder) as c:
        resp = c.put("/api/v1/config/alerts", json={"raw": raw})
        assert resp.status_code == 200
        rules = resp.json()["config"]["rules"]
        assert [r["topic"] for r in rules] == ["/hsrb/joint_states", "/hsrb/odom"]
        # The merged rule really inherited the anchor's fields …
        assert rules[1]["metric"] == "hz"
        # … and what comes back is the expanded file, with no anchor left in it.
        assert "&base" not in resp.json()["raw"]
        assert "<<" not in resp.json()["raw"]
