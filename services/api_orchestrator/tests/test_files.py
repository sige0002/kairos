# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Guarded static-file endpoint (``GET /api/v1/files/{file_path}``).

dora_runner writes artifacts (e.g. ``video_check`` mp4 previews) under the shared
data root; this endpoint serves one by its path relative to ``data_dir``. The
only directory ever served is ``data_dir``: traversal (``../``), absolute paths,
and missing files all yield a uniform 404 so nothing outside the root is exposed.
"""

from __future__ import annotations

from pathlib import Path

import httpx
from api_orchestrator.app_factory import create_orchestrator_app
from fastapi.testclient import TestClient
from kairos_common import Settings


def _client(tmp_path: Path, fake_recorder) -> TestClient:
    """Build a wired app whose ``data_dir`` is the writable tmp_path."""
    settings = Settings(
        data_dir=str(tmp_path),
        recording_config="/nonexistent/recording.yaml",
        stream_config="/nonexistent/stream.yaml",
    )
    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(fake_recorder.handler)
    )
    app = create_orchestrator_app(settings, http_client=http_client)
    return TestClient(app)


def test_serves_a_file_under_data_dir(tmp_path: Path, fake_recorder) -> None:
    # A video_check-style artifact written under data_dir/report/...
    rel = "report/video_check/run_x/cam.mp4"
    target = tmp_path / rel
    target.parent.mkdir(parents=True)
    target.write_bytes(b"\x00\x01fake-mp4-bytes")
    with _client(tmp_path, fake_recorder) as client:
        resp = client.get(f"/api/v1/files/{rel}")
    assert resp.status_code == 200
    assert resp.content == b"\x00\x01fake-mp4-bytes"
    # FileResponse infers the media type from the extension.
    assert resp.headers["content-type"].startswith("video/mp4")


def test_missing_file_is_404(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder) as client:
        resp = client.get("/api/v1/files/report/video_check/run_x/nope.mp4")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "file_not_found"


def test_traversal_path_is_404(tmp_path: Path, fake_recorder) -> None:
    """A ``../`` escape must not read outside data_dir (even if the target exists).

    The URL is percent-encoded so it survives client/router path normalization and
    actually reaches the handler, exercising the ``is_relative_to`` guard (rather
    than being collapsed to ``/secret.txt`` before routing).
    """
    # Create a real file just outside the data root to prove it stays unreadable.
    secret = tmp_path.parent / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")
    with _client(tmp_path, fake_recorder) as client:
        resp = client.get("/api/v1/files/%2e%2e%2fsecret.txt")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "file_not_found"
    # Plain (un-encoded) traversal is normalized away by the client/router and
    # still never serves the file — just via a generic 404 before the route.
    with _client(tmp_path, fake_recorder) as client:
        resp = client.get("/api/v1/files/../secret.txt")
    assert resp.status_code == 404


def test_deep_traversal_to_etc_passwd_is_404(tmp_path: Path, fake_recorder) -> None:
    with _client(tmp_path, fake_recorder) as client:
        resp = client.get("/api/v1/files/" + "%2e%2e%2f" * 6 + "etc%2fpasswd")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "file_not_found"


def test_absolute_path_is_404(tmp_path: Path, fake_recorder) -> None:
    """An absolute path collapses under the join and resolves back inside the root.

    ``data_dir / "/etc/passwd"`` -> ``/etc/passwd`` in pure-path terms, but the
    guard rejects anything whose resolved form is not under data_dir.
    """
    with _client(tmp_path, fake_recorder) as client:
        resp = client.get("/api/v1/files//etc/passwd")
    assert resp.status_code == 404
