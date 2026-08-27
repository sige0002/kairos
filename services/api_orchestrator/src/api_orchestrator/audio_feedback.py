# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Replaceable, out-of-band TTS generation for browser audio feedback."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import stat
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Protocol

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


def discover_provider() -> TtsProvider | None:
    """Return the installed local provider, or ``None`` for graceful disablement."""
    executable = shutil.which("espeak-ng")
    return EspeakProvider(executable) if executable else None


class AudioFeedbackService:
    """Generate immutable, content-addressed voice assets outside Collect."""

    def __init__(self, cache_dir: Path, provider: TtsProvider | None = None) -> None:
        self.cache_dir = cache_dir
        self.provider = provider if provider is not None else discover_provider()
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
