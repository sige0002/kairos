# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Smoke test: the service starts and answers /healthz."""

from __future__ import annotations

from fastapi.testclient import TestClient
from rosbag2_recorder.main import app

client = TestClient(app)


def test_healthz() -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
