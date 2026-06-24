"""Tests for the shared FastAPI app factory."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
from kairos_common import ApiError, create_app
from kairos_common.settings import Settings


def _client() -> TestClient:
    app = create_app("test-service", settings=Settings(_env_file=None))
    return TestClient(app, raise_server_exceptions=False)


def test_healthz_ok() -> None:
    resp = _client().get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_readyz_ok() -> None:
    resp = _client().get("/readyz")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ready"}


def test_api_error_rendered_in_unified_shape() -> None:
    app = create_app("test-service", settings=Settings(_env_file=None))

    @app.get("/boom")
    async def boom() -> None:
        raise ApiError(409, "conflict", "already recording", {"run_id": "r1"})

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/boom")
    assert resp.status_code == 409
    body = resp.json()
    assert body["error"]["code"] == "conflict"
    assert body["error"]["message"] == "already recording"
    assert body["error"]["details"] == {"run_id": "r1"}


def test_unexpected_error_is_masked() -> None:
    app = create_app("test-service", settings=Settings(_env_file=None))

    @app.get("/crash")
    async def crash() -> None:
        raise RuntimeError("secret internal detail")

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/crash")
    assert resp.status_code == 500
    body = resp.json()
    assert body["error"]["code"] == "internal_error"
    assert "secret internal detail" not in body["error"]["message"]


def test_create_app_returns_fastapi() -> None:
    assert isinstance(create_app("x", settings=Settings(_env_file=None)), FastAPI)
