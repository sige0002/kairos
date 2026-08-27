# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""HTTP contract tests for the isolated Kokoro synthesis sidecar."""

from __future__ import annotations

from fastapi.testclient import TestClient
from kairos_kokoro.app import create_app


class FakeRuntime:
    """Deterministic runtime that keeps unit tests independent of model weights."""

    engine = "kokoro-82m"
    model_revision = "test-revision"
    voices = {
        "en": ["af_heart", "am_michael"],
        "ja": ["jf_alpha", "jm_kumo"],
    }

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, float]] = []
        self.cancelled = False

    def synthesize(self, text: str, language: str, voice: str, speed: float) -> bytes:
        self.calls.append((text, language, voice, speed))
        return b"RIFF-test-wave"

    def cancel(self) -> None:
        self.cancelled = True


def test_health_and_voice_catalog_expose_the_pinned_model() -> None:
    client = TestClient(create_app(FakeRuntime()))

    assert client.get("/healthz").json() == {
        "status": "ready",
        "engine": "kokoro-82m",
        "model_revision": "test-revision",
    }
    assert client.get("/voices").json() == {
        "engine": "kokoro-82m",
        "model_revision": "test-revision",
        "voices": {
            "en": ["af_heart", "am_michael"],
            "ja": ["jf_alpha", "jm_kumo"],
        },
    }


def test_cancel_forwards_to_the_runtime() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(runtime))

    response = client.post("/cancel")

    assert response.status_code == 204
    assert runtime.cancelled is True


def test_synthesis_tunes_short_text_and_forwards_speed() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(runtime))

    response = client.post(
        "/synthesize",
        json={
            "text": "録画開始",
            "language": "ja",
            "voice": "jf_alpha",
            "speed": 0.92,
        },
    )

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.content == b"RIFF-test-wave"
    assert runtime.calls == [("録画開始。", "ja", "jf_alpha", 0.92)]


def test_synthesis_accepts_catalog_failure_reason_limit() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(runtime))

    response = client.post(
        "/synthesize",
        json={
            "text": "x" * 200,
            "language": "en",
            "voice": "af_heart",
            "speed": 1.0,
        },
    )

    assert response.status_code == 200
    assert runtime.calls[0][0] == "x" * 200 + "."


def test_synthesis_rejects_wrong_language_voice_and_unsafe_speed() -> None:
    runtime = FakeRuntime()
    client = TestClient(create_app(runtime))

    wrong_voice = client.post(
        "/synthesize",
        json={
            "text": "Recording started",
            "language": "en",
            "voice": "jf_alpha",
            "speed": 1.0,
        },
    )
    too_fast = client.post(
        "/synthesize",
        json={
            "text": "Recording started",
            "language": "en",
            "voice": "af_heart",
            "speed": 1.5,
        },
    )

    assert wrong_voice.status_code == 422
    assert too_fast.status_code == 422
    assert runtime.calls == []


def test_synthesis_refuses_non_wav_runtime_output() -> None:
    class BrokenRuntime(FakeRuntime):
        def synthesize(
            self, text: str, language: str, voice: str, speed: float
        ) -> bytes:
            return b"not-wave"

    client = TestClient(create_app(BrokenRuntime()))

    response = client.post(
        "/synthesize",
        json={
            "text": "Recording started",
            "language": "en",
            "voice": "af_heart",
            "speed": 1.0,
        },
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "Kokoro returned an invalid WAV asset"
