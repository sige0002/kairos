# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Cached TTS assets for browser-local Collect feedback."""

from __future__ import annotations

import threading
import time
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
        "deferred": False,
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


def test_asset_download_refuses_symbolic_links(
    client: TestClient, tmp_path: Path
) -> None:
    service = client.app.state.audio_feedback
    service.cache_dir.mkdir(parents=True, exist_ok=True)
    asset_id = "a" * 64
    service.path_for(asset_id).symlink_to(tmp_path / "outside.wav")
    (tmp_path / "outside.wav").write_bytes(b"not-cache-content")

    response = client.get(f"/api/v1/audio/assets/{asset_id}.wav")

    assert response.status_code == 404
    assert b"not-cache-content" not in response.content


def test_voice_generation_is_deferred_during_recording(
    client: TestClient, fake_recorder
) -> None:
    provider = FakeTtsProvider()
    client.app.state.audio_feedback.provider = provider
    fake_recorder.state = "recording"

    response = client.post(
        "/api/v1/audio/assets",
        json={
            "phrases": [
                {
                    "key": "success",
                    "text": "Success",
                    "language": "en",
                    "voice": "test-en",
                }
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["assets"] == []
    assert response.json()["errors"] == [
        "Voice generation is deferred while recording is active"
    ]
    assert response.json()["deferred"] is True
    assert provider.calls == []


def test_voice_generation_is_deferred_when_recorder_status_is_unknown(
    client: TestClient, fake_recorder
) -> None:
    provider = FakeTtsProvider()
    client.app.state.audio_feedback.provider = provider
    fake_recorder.transport_down = True

    response = client.post(
        "/api/v1/audio/assets",
        json={
            "phrases": [
                {
                    "key": "success",
                    "text": "Success",
                    "language": "en",
                    "voice": "test-en",
                }
            ]
        },
    )

    assert response.status_code == 200
    assert response.json()["assets"] == []
    assert response.json()["deferred"] is True
    assert response.json()["errors"] == [
        "Voice generation is deferred until recorder status is known"
    ]
    assert provider.calls == []


def test_record_start_waits_for_in_flight_voice_generation(
    client: TestClient, fake_recorder
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class BlockingProvider(FakeTtsProvider):
        def synthesize(
            self, text: str, language: str, voice: str, output: Path
        ) -> None:
            entered.set()
            assert release.wait(timeout=5)
            super().synthesize(text, language, voice, output)

    client.app.state.audio_feedback.provider = BlockingProvider()
    responses: dict[str, object] = {}
    initial_recorder_state = fake_recorder.state

    def prepare_voice() -> None:
        responses["audio"] = client.post(
            "/api/v1/audio/assets",
            json={
                "phrases": [
                    {
                        "key": "success",
                        "text": "Success",
                        "language": "en",
                        "voice": "test-en",
                    }
                ]
            },
        )

    def start_recording() -> None:
        responses["start"] = client.post(
            "/api/v1/record/start", json={"topics": ["/joint_states"]}
        )

    audio_thread = threading.Thread(target=prepare_voice)
    start_thread = threading.Thread(target=start_recording)
    audio_thread.start()
    assert entered.wait(timeout=5)
    start_thread.start()
    time.sleep(0.1)

    assert start_thread.is_alive()
    assert fake_recorder.state == initial_recorder_state
    release.set()
    audio_thread.join(timeout=5)
    start_thread.join(timeout=5)

    assert responses["audio"].status_code == 200
    assert responses["start"].status_code == 200
    assert fake_recorder.state == "recording"
