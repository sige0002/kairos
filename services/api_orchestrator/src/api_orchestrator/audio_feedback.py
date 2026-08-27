# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Replaceable, out-of-band TTS generation for browser audio feedback."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import stat
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Protocol
from urllib.parse import urlencode
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
        output: Path,
        cancel: threading.Event,
    ) -> None:
        """Write ``text`` as a WAV asset without using the network."""

    def cancel(self) -> None:
        """Stop an in-flight synthesis promptly when recording takes priority."""


class HttpResponse(Protocol):
    """The small urllib response surface used by the VOICEVOX provider."""

    def read(self, size: int = -1) -> bytes: ...

    def close(self) -> None: ...


class OpenRequest(Protocol):
    """Injectable request seam that keeps provider tests off the network."""

    def __call__(self, request: Request, timeout: float) -> HttpResponse: ...


class GenerationDeferred(RuntimeError):
    """Recording priority cancelled or prevented voice generation."""


class EspeakProvider:
    """Small CPU-only provider used when ``espeak-ng`` is installed."""

    name = "espeak-ng"
    voices = {"en": ["en-us", "en-gb"], "ja": ["ja"]}

    def __init__(self, executable: str) -> None:
        self._executable = executable
        self._process_lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._cancellation_process: subprocess.Popen[bytes] | None = None

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        """Generate a WAV with a bounded, argument-list subprocess call."""
        if cancel.is_set():
            raise GenerationDeferred("recording took priority")
        process = subprocess.Popen(
            [self._executable, "-v", voice, "-s", "165", "-w", str(output), text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with self._process_lock:
            self._process = process
        if cancel.is_set():
            self._cancel_process(process)
        try:
            _, stderr = process.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        finally:
            with self._process_lock:
                if self._process is process:
                    self._process = None
                if self._cancellation_process is process:
                    self._cancellation_process = None
        if cancel.is_set():
            raise GenerationDeferred("recording took priority")
        if process.returncode:
            raise subprocess.CalledProcessError(
                process.returncode, process.args, stderr=stderr
            )

    def cancel(self) -> None:
        """Terminate the current process without waiting on the recording path."""
        with self._process_lock:
            process = self._process
        if process is not None:
            self._cancel_process(process)

    def _cancel_process(self, process: subprocess.Popen[bytes]) -> None:
        """Request one bounded, asynchronously escalated process stop."""
        with self._process_lock:
            if process.poll() is not None or self._cancellation_process is process:
                return
            self._cancellation_process = process
        try:
            process.terminate()
        except ProcessLookupError:
            return
        threading.Thread(
            target=self._kill_if_running,
            args=(process,),
            name="tts-cancel-escalation",
            daemon=True,
        ).start()

    @staticmethod
    def _kill_if_running(process: subprocess.Popen[bytes]) -> None:
        """Escalate cancellation off the recorder's latency-critical path."""
        try:
            process.wait(timeout=0.25)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
            except ProcessLookupError:
                pass


class VoicevoxProvider:
    """Japanese neural TTS backed by a local VOICEVOX Engine HTTP service."""

    name = "voicevox"
    _QUERY_LIMIT = 1024 * 1024
    _WAV_LIMIT = 5 * 1024 * 1024

    def __init__(
        self,
        base_url: str,
        *,
        open_request: OpenRequest | None = None,
        timeout: float = 20.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        if not self._base_url.startswith(("http://", "https://")):
            raise ValueError("TTS_VOICEVOX_URL must be an http(s) URL")
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
        self.voices = {"ja": self._discover_voices()}

    def _open_without_proxy(self, request: Request, timeout: float) -> HttpResponse:
        assert self._opener is not None
        return self._opener.open(request, timeout=timeout)  # type: ignore[return-value]

    def _discover_voices(self) -> list[str]:
        request = Request(f"{self._base_url}/speakers", method="GET")
        raw = self._read_response(request, self._QUERY_LIMIT, None)
        speakers = json.loads(raw)
        if not isinstance(speakers, list):
            raise RuntimeError("VOICEVOX /speakers returned an invalid payload")
        voices: list[tuple[int, str]] = []
        for speaker in speakers:
            if not isinstance(speaker, dict) or not isinstance(
                speaker.get("name"), str
            ):
                continue
            styles = speaker.get("styles")
            if not isinstance(styles, list):
                continue
            for style in styles:
                if (
                    isinstance(style, dict)
                    and isinstance(style.get("id"), int)
                    and isinstance(style.get("name"), str)
                ):
                    style_id = style["id"]
                    label = f"{style_id}:{speaker['name']} / {style['name']}"
                    voices.append((style_id, label))
        if not voices:
            raise RuntimeError("VOICEVOX reported no speaker styles")
        return [label for _, label in sorted(voices)]

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        if language != "ja":
            raise ValueError("VOICEVOX supports Japanese only")
        if voice not in self.voices["ja"]:
            raise ValueError(f"unsupported VOICEVOX voice: {voice}")
        try:
            speaker_id = int(voice.split(":", 1)[0])
        except ValueError as exc:
            raise ValueError(f"invalid VOICEVOX voice: {voice}") from exc
        query_string = urlencode({"text": text, "speaker": speaker_id})
        query_request = Request(
            f"{self._base_url}/audio_query?{query_string}",
            data=b"",
            method="POST",
        )
        query = self._read_response(query_request, self._QUERY_LIMIT, cancel)
        speaker_query = urlencode({"speaker": speaker_id})
        synthesis_request = Request(
            f"{self._base_url}/synthesis?{speaker_query}",
            data=query,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        wav = self._read_response(synthesis_request, self._WAV_LIMIT, cancel)
        if not wav.startswith(b"RIFF"):
            raise RuntimeError("VOICEVOX returned an invalid WAV asset")
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
            raise RuntimeError("VOICEVOX response exceeded the size limit")
        return data

    def cancel(self) -> None:
        """Close an active response; the cache gate rejects any late result."""
        with self._response_lock:
            response = self._active_response
        if response is not None:
            response.close()


class LanguageRouterProvider:
    """Route each language to one provider while exposing one API contract."""

    def __init__(self, routes: dict[str, TtsProvider]) -> None:
        self._routes = routes
        providers = list(dict.fromkeys(routes.values()))
        self.name = "+".join(provider.name for provider in providers)
        self.voices = {
            language: list(provider.voices[language])
            for language, provider in routes.items()
        }

    def synthesize(
        self,
        text: str,
        language: str,
        voice: str,
        output: Path,
        cancel: threading.Event,
    ) -> None:
        provider = self._routes.get(language)
        if provider is None:
            raise ValueError(f"unsupported language: {language}")
        provider.synthesize(text, language, voice, output, cancel)

    def cancel(self) -> None:
        for provider in set(self._routes.values()):
            provider.cancel()


def discover_provider(
    provider_name: str = "espeak-ng",
    voicevox_url: str = "http://127.0.0.1:50021",
) -> TtsProvider | None:
    """Resolve the configured provider without making audio a startup gate."""
    selected = provider_name.strip().lower()
    executable = shutil.which("espeak-ng")
    if selected in {"", "none", "disabled"}:
        return None
    if selected == "espeak-ng":
        return EspeakProvider(executable) if executable else None
    if selected == "voicevox":
        try:
            voicevox = VoicevoxProvider(voicevox_url)
        except Exception:
            LOGGER.exception("Configured VOICEVOX provider is unavailable")
            return None
        routes: dict[str, TtsProvider] = {"ja": voicevox}
        if executable:
            routes["en"] = EspeakProvider(executable)
        return LanguageRouterProvider(routes)
    LOGGER.error("Unknown TTS provider", extra={"provider": provider_name})
    return None


class AudioFeedbackService:
    """Generate immutable, content-addressed voice assets outside Collect."""

    def __init__(
        self,
        cache_dir: Path,
        provider: TtsProvider | None = None,
        *,
        configured_provider: str = "espeak-ng",
        auto_discover: bool = True,
    ) -> None:
        self.cache_dir = cache_dir
        self.provider = (
            provider
            if provider is not None or not auto_discover
            else discover_provider()
        )
        self.configured_provider = configured_provider
        self._generation_lock = threading.Lock()
        self._priority_lock = threading.Lock()
        self._recording_reservations = 0
        self._priority_epoch = 0
        self._active_cancel: threading.Event | None = None

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

    def asset_id(self, text: str, language: str, voice: str) -> str:
        """Return a stable id that changes when phrase or selected voice changes."""
        engine = self.provider.name if self.provider else "unavailable"
        material = "\0".join(("v1", engine, language, voice, text)).encode()
        return hashlib.sha256(material).hexdigest()

    def admission_token(self) -> int:
        """Capture the recording-priority epoch before checking recorder state."""
        with self._priority_lock:
            return self._priority_epoch

    def prepare(
        self, text: str, language: str, voice: str, admission_token: int
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
            asset_id = self.asset_id(text, language, voice)
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
                self.provider.synthesize(text, language, voice, temporary, cancel)
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
