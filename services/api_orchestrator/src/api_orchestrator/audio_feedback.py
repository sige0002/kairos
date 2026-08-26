# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Replaceable, out-of-band TTS generation for browser audio feedback."""

from __future__ import annotations

import hashlib
import os
import shutil
import stat
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Protocol


class TtsProvider(Protocol):
    """A local engine that writes one phrase to a WAV file."""

    name: str
    voices: dict[str, list[str]]

    def synthesize(self, text: str, language: str, voice: str, output: Path) -> None:
        """Write ``text`` as a WAV asset without using the network."""


class EspeakProvider:
    """Small CPU-only provider used when ``espeak-ng`` is installed."""

    name = "espeak-ng"
    voices = {"en": ["en-us", "en-gb"], "ja": ["ja"]}

    def __init__(self, executable: str) -> None:
        self._executable = executable

    def synthesize(self, text: str, language: str, voice: str, output: Path) -> None:
        """Generate a WAV with a bounded, argument-list subprocess call."""
        subprocess.run(
            [self._executable, "-v", voice, "-s", "165", "-w", str(output), text],
            check=True,
            timeout=20,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )


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

    def asset_id(self, text: str, language: str, voice: str) -> str:
        """Return a stable id that changes when phrase or selected voice changes."""
        engine = self.provider.name if self.provider else "unavailable"
        material = "\0".join(("v1", engine, language, voice, text)).encode()
        return hashlib.sha256(material).hexdigest()

    def prepare(self, text: str, language: str, voice: str) -> str:
        """Generate once and atomically publish a cached WAV asset."""
        if self.provider is None:
            raise RuntimeError("TTS engine is unavailable")
        if language not in self.provider.voices:
            raise ValueError(f"unsupported language: {language}")
        if voice not in self.provider.voices[language]:
            raise ValueError(f"unsupported voice: {voice}")
        with self._generation_lock:
            asset_id = self.asset_id(text, language, voice)
            destination = self.path_for(asset_id)
            if destination.is_file() and not destination.is_symlink():
                return asset_id
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            fd, temporary_name = tempfile.mkstemp(
                dir=self.cache_dir, prefix=f".{asset_id}.", suffix=".wav"
            )
            os.close(fd)
            temporary = Path(temporary_name)
            try:
                self.provider.synthesize(text, language, voice, temporary)
                if temporary.stat().st_size == 0:
                    raise RuntimeError("TTS engine produced an empty asset")
                os.replace(temporary, destination)
            except Exception:
                temporary.unlink(missing_ok=True)
                raise
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
