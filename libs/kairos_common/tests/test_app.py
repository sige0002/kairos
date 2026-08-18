# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Tests for the shared FastAPI app factory."""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.testclient import TestClient
from kairos_common import ApiError, create_app
from kairos_common.logging import (
    JsonLinesFormatter,
    get_request_id,
    reset_request_id,
    set_request_id,
)
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


# ---- request-id middleware -------------------------------------------------


def _app_echoing_request_id() -> FastAPI:
    app = create_app("test-service", settings=Settings(_env_file=None))

    @app.get("/echo")
    async def echo() -> dict[str, str | None]:
        # Read the id the middleware bound for this request off the contextvar.
        return {"request_id": get_request_id()}

    return app


def test_request_id_generated_when_absent() -> None:
    client = TestClient(_app_echoing_request_id(), raise_server_exceptions=False)
    resp = client.get("/echo")
    assert resp.status_code == 200
    header_id = resp.headers["X-Request-ID"]
    # A uuid4 was minted, and the SAME id is echoed in the header and visible to
    # the handler via the contextvar.
    assert header_id
    assert resp.json()["request_id"] == header_id


def test_request_id_adopted_from_incoming_header() -> None:
    client = TestClient(_app_echoing_request_id(), raise_server_exceptions=False)
    resp = client.get("/echo", headers={"X-Request-ID": "trace-123"})
    assert resp.status_code == 200
    assert resp.headers["X-Request-ID"] == "trace-123"
    assert resp.json()["request_id"] == "trace-123"


def test_request_id_echoed_on_handled_error_responses() -> None:
    # Correlation matters most on errors: an ApiError response must still carry
    # the header (it is produced by a handler inside the request-id middleware).
    app = create_app("test-service", settings=Settings(_env_file=None))

    @app.get("/boom")
    async def boom() -> None:
        raise ApiError(409, "conflict", "already recording")

    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/boom", headers={"X-Request-ID": "err-trace"})
    assert resp.status_code == 409
    assert resp.headers["X-Request-ID"] == "err-trace"


def test_request_id_context_resets_between_requests() -> None:
    # After a request finishes the contextvar is reset (no leakage to the next).
    client = TestClient(_app_echoing_request_id(), raise_server_exceptions=False)
    first = client.get("/echo", headers={"X-Request-ID": "a"}).json()["request_id"]
    second = client.get("/echo", headers={"X-Request-ID": "b"}).json()["request_id"]
    assert (first, second) == ("a", "b")


def test_json_formatter_includes_bound_request_id() -> None:
    token = set_request_id("rid-42")
    try:
        record = logging.LogRecord(
            "kairos", logging.INFO, __file__, 1, "hello", (), None
        )
        line = JsonLinesFormatter().format(record)
    finally:
        reset_request_id(token)
    assert '"request_id": "rid-42"' in line


def test_json_formatter_extra_request_id_wins_over_contextvar() -> None:
    token = set_request_id("ctx-id")
    try:
        record = logging.LogRecord(
            "kairos", logging.INFO, __file__, 1, "hello", (), None
        )
        record.request_id = "explicit-id"
        line = JsonLinesFormatter().format(record)
    finally:
        reset_request_id(token)
    assert '"request_id": "explicit-id"' in line
    assert "ctx-id" not in line
