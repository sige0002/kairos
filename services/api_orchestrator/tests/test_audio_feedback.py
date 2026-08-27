# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Cached TTS assets for browser-local Collect feedback."""

from __future__ import annotations

import subprocess
import threading
import time
from pathlib import Path

import pytest
from api_orchestrator.audio_feedback import (
    AudioFeedbackService,
    EspeakProvider,
    GenerationDeferred,
)
from fastapi.testclient import TestClient


class FakeTtsProvider:
    """Deterministic provider: tests prove cache behavior without a TTS binary."""

    name = "fake"
    voices = {"en": ["test-en"], "ja": ["test-ja"]}

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, Path]] = []

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        self.calls.append((text, language, voice, output))
        output.write_bytes(b"RIFF-test-wave")

    def cancel(self) -> None:
        """No synthesis is long-running in the ordinary fake."""


def test_stale_admission_token_cannot_generate_after_recording_reservation(
    tmp_path: Path,
) -> None:
    provider = FakeTtsProvider()
    service = AudioFeedbackService(tmp_path / "audio", provider)
    token = service.admission_token()

    service.reserve_for_recording()
    service.release_recording_reservation()

    with pytest.raises(GenerationDeferred):
        service.prepare("Success", "en", "test-en", token)
    assert provider.calls == []


def test_recording_cancellation_prevents_asset_publication(tmp_path: Path) -> None:
    entered = threading.Event()
    release = threading.Event()

    class PausingProvider(FakeTtsProvider):
        def synthesize(
            self,
            text: str,
            language: str,
            voice: str,
            output: Path,
            cancel: threading.Event,
        ) -> None:
            output.write_bytes(b"RIFF-test-wave")
            entered.set()
            assert release.wait(timeout=5)

        def cancel(self) -> None:
            release.set()

    provider = PausingProvider()
    service = AudioFeedbackService(tmp_path / "audio", provider)
    token = service.admission_token()
    asset_id = service.asset_id("Success", "en", "test-en")
    outcome: dict[str, object] = {}

    def generate() -> None:
        try:
            service.prepare("Success", "en", "test-en", token)
        except Exception as exc:
            outcome["error"] = exc

    thread = threading.Thread(target=generate)
    thread.start()
    assert entered.wait(timeout=5)
    service.reserve_for_recording()
    service.release_recording_reservation()
    thread.join(timeout=5)

    assert isinstance(outcome.get("error"), GenerationDeferred)
    assert not service.path_for(asset_id).exists()


def test_espeak_cancel_escalates_without_blocking() -> None:
    killed = threading.Event()

    class UnresponsiveProcess:
        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            pass

        def wait(self, timeout: float) -> None:
            raise subprocess.TimeoutExpired("espeak-ng", timeout)

        def kill(self) -> None:
            killed.set()

    provider = EspeakProvider("espeak-ng")
    provider._process = UnresponsiveProcess()  # type: ignore[assignment]

    started_at = time.monotonic()
    provider.cancel()

    assert time.monotonic() - started_at < 0.1
    assert killed.wait(timeout=1)


def test_espeak_cancel_during_process_creation_still_escalates(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    creation_started = threading.Event()
    allow_creation = threading.Event()
    killed = threading.Event()

    class UnresponsiveProcess:
        args = ["espeak-ng"]
        returncode = -9

        def poll(self) -> int | None:
            return -9 if killed.is_set() else None

        def terminate(self) -> None:
            pass

        def wait(self, timeout: float) -> int:
            raise subprocess.TimeoutExpired("espeak-ng", timeout)

        def kill(self) -> None:
            killed.set()

        def communicate(self, timeout: float) -> tuple[bytes, bytes]:
            assert killed.wait(timeout=1)
            return b"", b""

    process = UnresponsiveProcess()

    def create_process(*args: object, **kwargs: object) -> UnresponsiveProcess:
        creation_started.set()
        assert allow_creation.wait(timeout=5)
        return process

    monkeypatch.setattr(subprocess, "Popen", create_process)
    provider = EspeakProvider("espeak-ng")
    cancel = threading.Event()
    outcome: dict[str, object] = {}

    def synthesize() -> None:
        try:
            provider.synthesize("Success", "en", "en-us", tmp_path / "out.wav", cancel)
        except Exception as exc:
            outcome["error"] = exc

    thread = threading.Thread(target=synthesize)
    thread.start()
    assert creation_started.wait(timeout=5)
    cancel.set()
    provider.cancel()
    allow_creation.set()
    thread.join(timeout=5)

    assert killed.is_set()
    assert isinstance(outcome.get("error"), GenerationDeferred)


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


def test_record_start_preempts_in_flight_and_queued_voice_generation(
    client: TestClient, fake_recorder
) -> None:
    entered = threading.Event()
    release = threading.Event()

    class BlockingProvider(FakeTtsProvider):
        def synthesize(
            self,
            text: str,
            language: str,
            voice: str,
            output: Path,
            cancel: threading.Event,
        ) -> None:
            entered.set()
            assert release.wait(timeout=5)
            super().synthesize(text, language, voice, output, cancel)

        def cancel(self) -> None:
            release.set()

    provider = BlockingProvider()
    client.app.state.audio_feedback.provider = provider
    responses: dict[str, object] = {}

    def prepare_voice(response_key: str) -> None:
        responses[response_key] = client.post(
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

    audio_thread = threading.Thread(target=prepare_voice, args=("audio",))
    queued_audio_thread = threading.Thread(target=prepare_voice, args=("queued_audio",))
    start_thread = threading.Thread(target=start_recording)
    audio_thread.start()
    assert entered.wait(timeout=5)
    queued_audio_thread.start()
    started_at = time.monotonic()
    start_thread.start()
    start_thread.join(timeout=1)
    start_elapsed = time.monotonic() - started_at

    assert not start_thread.is_alive()
    assert start_elapsed < 0.5
    assert fake_recorder.state == "recording"
    audio_thread.join(timeout=5)
    queued_audio_thread.join(timeout=5)

    assert responses["audio"].status_code == 200
    assert responses["audio"].json()["deferred"] is True
    assert responses["queued_audio"].status_code == 200
    assert responses["queued_audio"].json()["deferred"] is True
    assert responses["start"].status_code == 200
    assert fake_recorder.state == "recording"
    assert len(provider.calls) == 1
