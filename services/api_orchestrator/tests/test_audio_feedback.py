# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Cached TTS assets for browser-local Collect feedback."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient


class FakeTtsProvider:
    """Deterministic provider: tests prove cache behavior without a TTS binary."""

    name = "fake"
    voices = {"en": ["test-en"], "ja": ["test-ja"]}

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, Path]] = []

    def synthesize(self, text: str, language: str, voice: str, output: Path) -> None:
        self.calls.append((text, language, voice, output))
        output.write_bytes(b"RIFF-test-wave")


def test_prepare_assets_generates_once_and_serves_wav(client: TestClient) -> None:
    provider = FakeTtsProvider()
    client.app.state.audio_feedback.provider = provider
    request = {
        "phrases": [
            {"key": "success", "text": "Success", "language": "en", "voice": "test-en"}
        ]
    }

    first = client.post("/api/v1/audio/assets", json=request)
    second = client.post("/api/v1/audio/assets", json=request)

    assert first.status_code == 200
    assert second.status_code == 200
    asset = first.json()["assets"][0]
    assert asset["key"] == "success"
    assert asset["url"].startswith("/api/v1/audio/assets/")
    assert len(provider.calls) == 1
    wav = client.get(asset["url"])
    assert wav.status_code == 200
    assert wav.headers["content-type"] == "audio/wav"
    assert wav.content == b"RIFF-test-wave"


def test_unavailable_provider_is_non_fatal(client: TestClient) -> None:
    client.app.state.audio_feedback.provider = None

    response = client.post(
        "/api/v1/audio/assets",
        json={
            "phrases": [
                {"key": "error", "text": "Error", "language": "en", "voice": "default"}
            ]
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "available": False,
        "engine": None,
        "assets": [],
        "errors": ["TTS engine is unavailable"],
    }


def test_prepare_rejects_oversized_or_unsupported_input(client: TestClient) -> None:
    provider = FakeTtsProvider()
    client.app.state.audio_feedback.provider = provider

    bad_language = client.post(
        "/api/v1/audio/assets",
        json={
            "phrases": [{"key": "x", "text": "Hello", "language": "fr", "voice": "x"}]
        },
    )
    too_long = client.post(
        "/api/v1/audio/assets",
        json={
            "phrases": [
                {"key": "x", "text": "x" * 201, "language": "en", "voice": "test-en"}
            ]
        },
    )

    assert bad_language.status_code == 422
    assert too_long.status_code == 422
    assert provider.calls == []
