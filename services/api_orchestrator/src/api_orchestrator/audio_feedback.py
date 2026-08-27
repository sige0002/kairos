# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Replaceable, out-of-band TTS generation for browser audio feedback."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import stat
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from urllib.request import OpenerDirector, ProxyHandler, Request, build_opener

LOGGER = logging.getLogger("kairos")


class TtsProvider(Protocol):
    """A local engine that writes one phrase to a WAV file."""

    name: str
    voices: dict[str, list[str]]

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        speed: float,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        """Write ``text`` as a WAV asset without using the network."""

    def cancel(self) -> None:
        """Stop an in-flight synthesis promptly when recording takes priority."""


class HttpResponse(Protocol):
    """The small urllib response surface used by the Kokoro provider."""

    def read(self, size: int = -1) -> bytes: ...

    def close(self) -> None: ...


class OpenRequest(Protocol):
    """Injectable request seam that keeps provider tests off the network."""

    def __call__(self, request: Request, timeout: float) -> HttpResponse: ...


class GenerationDeferred(RuntimeError):
    """Recording priority cancelled or prevented voice generation."""


class KokoroProvider:
    """English/Japanese neural TTS backed by the local Kokoro sidecar."""

    name = "kokoro-82m"
    _WAV_LIMIT = 5 * 1024 * 1024

    def __init__(
        self,
        base_url: str,
        *,
        open_request: OpenRequest | None = None,
        timeout: float = 90.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        if not self._base_url.startswith(("http://", "https://")):
            raise ValueError("TTS_KOKORO_URL must be an http(s) URL")
        self._timeout = timeout
        self._opener: OpenerDirector | None = None
        if open_request is None:
            # This is a trusted-LAN internal dependency. Host proxy variables
            # must not capture a request intended for the co-located engine.
            self._opener = build_opener(ProxyHandler({}))
            self._open_request: OpenRequest = self._open_without_proxy
        else:
            self._open_request = open_request
        self._response_lock = threading.Lock()
        self._active_response: HttpResponse | None = None
        self.voices, self.model_revision = self._discover_voices()

    def _open_without_proxy(self, request: Request, timeout: float) -> HttpResponse:
        assert self._opener is not None
        return self._opener.open(request, timeout=timeout)  # type: ignore[return-value]

    def _discover_voices(self) -> tuple[dict[str, list[str]], str | None]:
        request = Request(f"{self._base_url}/voices", method="GET")
        raw = self._read_response(request, 64 * 1024, None)
        payload = json.loads(raw)
        voices = payload.get("voices") if isinstance(payload, dict) else None
        if not isinstance(voices, dict):
            raise RuntimeError("Kokoro /voices returned an invalid payload")
        normalized: dict[str, list[str]] = {}
        for language in ("en", "ja"):
            candidates = voices.get(language)
            if not isinstance(candidates, list) or not all(
                isinstance(voice, str) for voice in candidates
            ):
                raise RuntimeError(f"Kokoro reported no {language} voices")
            normalized[language] = candidates
        revision = payload.get("model_revision")
        return normalized, revision if isinstance(revision, str) else None

    def refresh(self) -> None:
        """Refresh catalog identity after a sidecar rebuild or restart."""
        self.voices, self.model_revision = self._discover_voices()

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        speed: float,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        if language not in self.voices:
            raise ValueError(f"unsupported language: {language}")
        if voice not in self.voices[language]:
            raise ValueError(f"unsupported Kokoro voice: {voice}")
        payload = json.dumps(
            {"text": text, "language": language, "voice": voice, "speed": speed}
        ).encode()
        synthesis_request = Request(
            f"{self._base_url}/synthesize",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        wav = self._read_response(synthesis_request, self._WAV_LIMIT, cancel)
        if not wav.startswith(b"RIFF"):
            raise RuntimeError("Kokoro returned an invalid WAV asset")
        output.write_bytes(wav)

    def _read_response(
        self,
        request: Request,
        limit: int,
        cancel: threading.Event | None,
    ) -> bytes:
        if cancel is not None and cancel.is_set():
            raise GenerationDeferred("recording took priority")
        response: HttpResponse | None = None
        try:
            response = self._open_request(request, self._timeout)
            with self._response_lock:
                self._active_response = response
            data = response.read(limit + 1)
        except Exception:
            if cancel is not None and cancel.is_set():
                raise GenerationDeferred("recording took priority") from None
            raise
        finally:
            with self._response_lock:
                if self._active_response is response:
                    self._active_response = None
            if response is not None:
                response.close()
        if cancel is not None and cancel.is_set():
            raise GenerationDeferred("recording took priority")
        if len(data) > limit:
            raise RuntimeError("Kokoro response exceeded the size limit")
        return data

    def cancel(self) -> None:
        """Ask the sidecar to terminate inference, then close any response."""
        try:
            request = Request(f"{self._base_url}/cancel", data=b"", method="POST")
            response = self._open_request(request, min(self._timeout, 2.0))
            response.close()
        except Exception:
            LOGGER.exception("Kokoro cancellation request failed")
        with self._response_lock:
            response = self._active_response
        if response is not None:
            response.close()


def discover_provider(
    kokoro_url: str = "http://127.0.0.1:8050",
) -> TtsProvider | None:
    """Discover Kokoro without making optional audio a startup gate."""
    try:
        return KokoroProvider(kokoro_url)
    except Exception:
        LOGGER.exception("Kokoro provider is unavailable")
        return None


class AudioFeedbackService:
    """Generate immutable, content-addressed voice assets outside Collect."""

    def __init__(
        self,
        cache_dir: Path,
        provider: TtsProvider | None = None,
        *,
        auto_discover: bool = True,
        rediscover: Callable[[], TtsProvider | None] | None = None,
    ) -> None:
        self.cache_dir = cache_dir
        self.provider = (
            provider
            if provider is not None or not auto_discover
            else discover_provider()
        )
        self._rediscover = rediscover
        self._discovery_lock = threading.Lock()
        self._generation_lock = threading.Lock()
        self._priority_lock = threading.Lock()
        self._recording_reservations = 0
        self._priority_epoch = 0
        self._active_cancel: threading.Event | None = None

    def ensure_provider(self) -> TtsProvider | None:
        """Retry optional sidecar discovery when Settings asks for audio."""
        with self._discovery_lock:
            if self.provider is not None:
                refresh = getattr(self.provider, "refresh", None)
                if refresh is not None:
                    try:
                        refresh()
                    except Exception:
                        LOGGER.exception("Kokoro provider refresh failed")
                        self.provider = None
                return self.provider
            if self._rediscover is None:
                return None
            if self.provider is None:
                self.provider = self._rediscover()
        return self.provider

    def reserve_for_recording(self) -> None:
        """Preempt synthesis synchronously before recorder Prepare or Start."""
        with self._priority_lock:
            self._priority_epoch += 1
            self._recording_reservations += 1
            if self._active_cancel is not None:
                self._active_cancel.set()
            provider = self.provider
        if provider is not None:
            try:
                provider.cancel()
            except Exception:
                LOGGER.exception(
                    "TTS provider cancellation failed; recording continues"
                )

    def release_recording_reservation(self) -> None:
        """Release one Prepare/Start priority reservation."""
        with self._priority_lock:
            self._recording_reservations = max(0, self._recording_reservations - 1)

    def asset_id(self, text: str, language: str, voice: str, speed: float) -> str:
        """Return a stable id that changes when phrase or selected voice changes."""
        engine = self.provider.name if self.provider else "unavailable"
        revision = (
            getattr(self.provider, "model_revision", None) if self.provider else None
        )
        material = "\0".join(
            ("v3", engine, revision or "unknown", language, voice, repr(speed), text)
        ).encode()
        return hashlib.sha256(material).hexdigest()

    def admission_token(self) -> int:
        """Capture the recording-priority epoch before checking recorder state."""
        with self._priority_lock:
            return self._priority_epoch

    def prepare(
        self,
        text: str,
        language: str,
        voice: str,
        speed: float,
        admission_token: int,
    ) -> str:
        """Generate once and atomically publish a cached WAV asset."""
        if self.provider is None:
            raise RuntimeError("TTS engine is unavailable")
        if language not in self.provider.voices:
            raise ValueError(f"unsupported language: {language}")
        if voice not in self.provider.voices[language]:
            raise ValueError(f"unsupported voice: {voice}")
        with self._generation_lock:
            with self._priority_lock:
                if (
                    self._recording_reservations
                    or admission_token != self._priority_epoch
                ):
                    raise GenerationDeferred("recording took priority")
            asset_id = self.asset_id(text, language, voice, speed)
            destination = self.path_for(asset_id)
            if destination.is_file() and not destination.is_symlink():
                return asset_id
            with self._priority_lock:
                if (
                    self._recording_reservations
                    or admission_token != self._priority_epoch
                ):
                    raise GenerationDeferred("recording took priority")
                cancel = threading.Event()
                self._active_cancel = cancel
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                dir=self.cache_dir, prefix=f".{asset_id}.", suffix=".wav"
            )
            os.close(fd)
            temporary = Path(temporary_name)
            try:
                self.provider.synthesize(
                    text, language, voice, speed, temporary, cancel
                )
                with self._priority_lock:
                    if (
                        cancel.is_set()
                        or self._recording_reservations
                        or admission_token != self._priority_epoch
                    ):
                        raise GenerationDeferred("recording took priority")
                    if temporary.stat().st_size == 0:
                        raise RuntimeError("TTS engine produced an empty asset")
                    os.replace(temporary, destination)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
            finally:
                with self._priority_lock:
                    if self._active_cancel is cancel:
                        self._active_cancel = None
        return asset_id

    def read_asset(self, asset_id: str) -> bytes:
        """Read one regular cached file without following symbolic links."""
        path = self.path_for(asset_id)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except OSError as exc:
            raise FileNotFoundError(asset_id) from exc
        try:
            file_stat = os.fstat(descriptor)
            if (
                not stat.S_ISREG(file_stat.st_mode)
                or file_stat.st_size > 5 * 1024 * 1024
            ):
                raise FileNotFoundError(asset_id)
            chunks: list[bytes] = []
            remaining = file_stat.st_size
            while remaining:
                chunk = os.read(descriptor, remaining)
                if not chunk:
                    raise FileNotFoundError(asset_id)
                chunks.append(chunk)
                remaining -= len(chunk)
        finally:
            os.close(descriptor)
        return b"".join(chunks)

    def path_for(self, asset_id: str) -> Path:
        """Resolve a validated SHA-256 asset id inside the cache directory."""
        if len(asset_id) != 64 or any(ch not in "0123456789abcdef" for ch in asset_id):
            raise ValueError("invalid audio asset id")
        return self.cache_dir / f"{asset_id}.wav"
