# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Cached TTS assets for browser-local Collect feedback."""

from __future__ import annotations

import json
import threading
import time
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from api_orchestrator.audio_feedback import (
    AudioFeedbackService,
    GenerationDeferred,
    KokoroProvider,
)
from fastapi.testclient import TestClient


class FakeTtsProvider:
    """Deterministic provider: tests prove cache behavior without a TTS binary."""

    name = "fake"
    voices = {"en": ["test-en"], "ja": ["test-ja"]}

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, float, Path]] = []

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        speed: float,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        self.calls.append((text, language, voice, speed, output))
        output.write_bytes(b"RIFF-test-wave")

    def cancel(self) -> None:
        """No synthesis is long-running in the ordinary fake."""


class FakeHttpResponse(BytesIO):
    """Small urllib response stand-in used by the Kokoro provider tests."""

    def __enter__(self) -> FakeHttpResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


def test_kokoro_forwards_language_voice_and_speed(
    tmp_path: Path,
) -> None:
    calls: list[tuple[str, str, bytes | None]] = []

    def open_request(request, timeout: float):
        assert timeout == 90.0
        method = request.get_method()
        url = request.full_url
        body = request.data
        calls.append((method, url, body))
        path = urlsplit(url).path
        if path == "/voices":
            return FakeHttpResponse(
                b'{"model_revision":"revision",'
                b'"voices":{"en":["af_heart"],"ja":["jf_alpha"]}}'
            )
        if path == "/synthesize":
            assert json.loads(body or b"") == {
                "text": "録画開始",
                "language": "ja",
                "voice": "jf_alpha",
                "speed": 0.9,
            }
            return FakeHttpResponse(b"RIFF-kokoro-wave")
        raise AssertionError(url)

    provider = KokoroProvider("http://kokoro.test:8050", open_request=open_request)
    assert provider.voices == {"en": ["af_heart"], "ja": ["jf_alpha"]}
    assert provider.model_revision == "revision"

    output = tmp_path / "voice.wav"
    provider.synthesize(
        "録画開始",
        "ja",
        "jf_alpha",
        0.9,
        output,
        threading.Event(),
    )

    assert output.read_bytes() == b"RIFF-kokoro-wave"
    assert [urlsplit(url).path for _, url, _ in calls] == [
        "/voices",
        "/synthesize",
    ]


def test_kokoro_cancel_calls_the_sidecar() -> None:
    calls: list[tuple[str, float]] = []

    def open_request(request, timeout: float):
        path = urlsplit(request.full_url).path
        calls.append((path, timeout))
        if path == "/voices":
            return FakeHttpResponse(b'{"voices":{"en":["af_heart"],"ja":["jf_alpha"]}}')
        assert path == "/cancel"
        return FakeHttpResponse(b"")

    provider = KokoroProvider("http://kokoro.test:8050", open_request=open_request)

    provider.cancel()

    assert calls == [("/voices", 90.0), ("/cancel", 2.0)]


def test_kokoro_refreshes_model_revision() -> None:
    revisions = iter(("revision-a", "revision-b"))

    def open_request(request, _timeout: float):
        assert urlsplit(request.full_url).path == "/voices"
        revision = next(revisions)
        return FakeHttpResponse(
            json.dumps(
                {
                    "model_revision": revision,
                    "voices": {"en": ["af_heart"], "ja": ["jf_alpha"]},
                }
            ).encode()
        )

    provider = KokoroProvider("http://kokoro.test:8050", open_request=open_request)

    provider.refresh()

    assert provider.model_revision == "revision-b"


def test_voice_and_speed_change_asset_identity(tmp_path: Path) -> None:
    def open_request(request, _timeout: float):
        assert urlsplit(request.full_url).path == "/voices"
        return FakeHttpResponse(
            b'{"voices":{"en":["af_heart","af_bella"],"ja":["jf_alpha"]}}'
        )

    provider = KokoroProvider("http://kokoro.test:8050", open_request=open_request)
    service = AudioFeedbackService(tmp_path / "audio", provider)

    normal = service.asset_id("Success", "en", "af_heart", 1.0)
    other_voice = service.asset_id("Success", "en", "af_bella", 1.0)
    slower = service.asset_id("Success", "en", "af_heart", 0.9)
    close_speed = service.asset_id("Success", "en", "af_heart", 0.9001)

    assert normal != other_voice
    assert normal != slower
    assert slower != close_speed


def test_model_revision_changes_asset_identity(tmp_path: Path) -> None:
    first = FakeTtsProvider()
    first.model_revision = "revision-a"
    second = FakeTtsProvider()
    second.model_revision = "revision-b"

    first_id = AudioFeedbackService(tmp_path / "first", first).asset_id(
        "Success", "en", "test-en", 1.0
    )
    second_id = AudioFeedbackService(tmp_path / "second", second).asset_id(
        "Success", "en", "test-en", 1.0
    )

    assert first_id != second_id


def test_stale_admission_token_cannot_generate_after_recording_reservation(
    tmp_path: Path,
) -> None:
    provider = FakeTtsProvider()
    service = AudioFeedbackService(tmp_path / "audio", provider)
    token = service.admission_token()

    service.reserve_for_recording()
    service.release_recording_reservation()

    with pytest.raises(GenerationDeferred):
        service.prepare("Success", "en", "test-en", 1.0, token)
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
            speed: float,
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
    asset_id = service.asset_id("Success", "en", "test-en", 1.0)
    outcome: dict[str, object] = {}

    def generate() -> None:
        try:
            service.prepare("Success", "en", "test-en", 1.0, token)
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
    assert first.json()["model_revision"] is None
    asset = first.json()["assets"][0]
    assert asset["key"] == "success"
    assert asset["url"].startswith("/api/v1/audio/assets/")
    assert len(provider.calls) == 1
    wav = client.get(asset["url"])
    assert wav.status_code == 200
    assert wav.headers["content-type"] == "audio/wav"
    assert wav.content == b"RIFF-test-wave"


def test_prepare_assets_accepts_catalog_failure_reason_limit(
    client: TestClient,
) -> None:
    client.app.state.audio_feedback.provider = FakeTtsProvider()

    response = client.post(
        "/api/v1/audio/assets",
        json={
            "phrases": [
                {
                    "key": "failure.catalog",
                    "text": "x" * 200,
                    "language": "en",
                    "voice": "test-en",
                }
            ]
        },
    )

    assert response.status_code == 200
    assert len(response.json()["assets"]) == 1


def test_unavailable_provider_is_non_fatal(client: TestClient) -> None:
    service = client.app.state.audio_feedback
    service.provider = None
    service._rediscover = None

    status = client.get("/api/v1/audio/status")
    assert status.status_code == 200
    assert status.json() == {
        "available": False,
        "engine": None,
        "model_revision": None,
        "voices": {},
    }

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
        "model_revision": None,
        "assets": [],
        "errors": ["TTS engine is unavailable"],
        "deferred": False,
    }


def test_status_rediscovers_sidecar_after_late_start(client: TestClient) -> None:
    provider = FakeTtsProvider()
    service = client.app.state.audio_feedback
    service.provider = None
    service._rediscover = lambda: provider

    response = client.get("/api/v1/audio/status")

    assert response.status_code == 200
    assert response.json()["available"] is True
    assert response.json()["engine"] == "fake"
    assert service.provider is provider


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
            speed: float,
            output: Path,
            cancel: threading.Event,
        ) -> None:
            entered.set()
            assert release.wait(timeout=5)
            super().synthesize(text, language, voice, speed, output, cancel)

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
