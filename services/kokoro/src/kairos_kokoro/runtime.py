# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Pinned, CPU-only Kokoro runtime with no network access."""

from __future__ import annotations

import io
import multiprocessing
import os
import threading
import time
from pathlib import Path
from typing import Any

MODEL_REVISION = "f3ff3571791e39611d31c381e3a41a3af07b4987"
MODEL_REPOSITORY = "hexgrad/Kokoro-82M"

VOICES = {
    "en": ["af_heart", "af_bella", "am_michael", "bf_emma"],
    "ja": ["jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo"],
}
_UNKNOWN_PHONEME = "\ue000"


def reject_unknown_english(phonemes: str, tokens: list[object]) -> None:
    """Reject English input when native G2P would silently omit a token."""
    if _UNKNOWN_PHONEME not in phonemes:
        return
    unknown = [
        str(getattr(token, "text", "")).strip()
        for token in tokens
        if _UNKNOWN_PHONEME in str(getattr(token, "phonemes", ""))
        or getattr(token, "phonemes", "present") is None
    ]
    names = ", ".join(filter(None, unknown)) or "unknown token"
    raise ValueError(f"English pronunciation is unavailable for: {names}")


def terminate_process(process: Any, timeout: float = 1.0) -> None:
    """Terminate a model worker, escalating to SIGKILL when needed."""
    if process is None or not process.is_alive():
        return
    process.terminate()
    process.join(timeout)
    if process.is_alive():
        process.kill()
        process.join(timeout)
    if process.is_alive():
        raise RuntimeError("Kokoro worker could not be terminated")


def _worker_main(connection: Any, model_dir_text: str, threads: int) -> None:
    """Own the model in a process that can be terminated before recording."""
    try:
        import soundfile
        import torch
        from kokoro.model import KModel
        from misaki import en, ja

        torch.set_num_threads(threads)
        model_dir = Path(model_dir_text)
        model = (
            KModel(
                repo_id=MODEL_REPOSITORY,
                config=str(model_dir / "config.json"),
                model=str(model_dir / "kokoro-v1_0.pth"),
            )
            .to("cpu")
            .eval()
        )
        g2p = {
            "en-us": en.G2P(british=False, fallback=None, unk=_UNKNOWN_PHONEME),
            "en-gb": en.G2P(british=True, fallback=None, unk=_UNKNOWN_PHONEME),
            "ja": ja.JAG2P(version="pyopenjtalk"),
        }
        voice_packs: dict[str, object] = {}
        connection.send(("ready",))
    except BaseException as exc:
        connection.send(("startup_error", type(exc).__name__, str(exc)))
        return

    while True:
        request = connection.recv()
        if request is None:
            return
        request_id, text, language, voice, speed = request
        try:
            pipeline_key = (
                "ja"
                if language == "ja"
                else ("en-gb" if voice.startswith("b") else "en-us")
            )
            phonemes, tokens = g2p[pipeline_key](text)
            if not phonemes:
                raise RuntimeError("Kokoro phonemizer produced no phonemes")
            if language == "en":
                reject_unknown_english(phonemes, tokens)
            if len(phonemes) > 510:
                raise ValueError("Kokoro phoneme limit exceeded")
            pack = voice_packs.get(voice)
            if pack is None:
                voice_path = model_dir / "voices" / f"{voice}.pt"
                if not voice_path.is_file():
                    raise ValueError(f"Kokoro voice file is missing: {voice}")
                pack = torch.load(voice_path, weights_only=True)
                voice_packs[voice] = pack
            audio = model(phonemes, pack[len(phonemes) - 1], speed)
            if audio is None or not audio.numel():
                raise RuntimeError("Kokoro produced no audio")
            output = io.BytesIO()
            soundfile.write(
                output,
                audio.clamp(-1, 1).numpy(),
                24_000,
                format="WAV",
                subtype="PCM_16",
            )
            connection.send(("result", request_id, output.getvalue()))
        except BaseException as exc:
            connection.send(("error", request_id, type(exc).__name__, str(exc)))


class NativeKokoroRuntime:
    """Load one shared Kokoro model and language-specific G2P pipelines."""

    engine = "kokoro-82m"
    model_revision = MODEL_REVISION
    voices = VOICES

    def __init__(self, model_dir: Path) -> None:
        self._model_dir = model_dir
        self._threads = max(1, int(os.environ.get("KOKORO_THREADS", "2")))
        self._context = multiprocessing.get_context("spawn")
        self._lock = threading.Lock()
        self._cancel_requested = threading.Event()
        self._process: Any = None
        self._connection: Any = None
        self._request_id = 0
        self._start_worker()

    def _start_worker(self) -> None:
        parent, child = self._context.Pipe()
        process = self._context.Process(
            target=_worker_main,
            args=(child, str(self._model_dir), self._threads),
            daemon=True,
        )
        process.start()
        child.close()
        self._connection = parent
        self._process = process
        deadline = time.monotonic() + 120
        while not parent.poll(0.05):
            if self._cancel_requested.is_set() or not process.is_alive():
                self._stop_worker()
                raise RuntimeError("Kokoro worker startup was cancelled")
            if time.monotonic() >= deadline:
                self._stop_worker()
                raise RuntimeError("Kokoro worker startup timed out")
        if self._cancel_requested.is_set():
            self._stop_worker()
            raise RuntimeError("Kokoro worker startup was cancelled")
        message = parent.recv()
        if message[0] != "ready":
            self._stop_worker()
            raise RuntimeError(f"Kokoro worker startup failed: {message[-1]}")

    def _stop_worker(self) -> None:
        process = self._process
        connection = self._connection
        self._process = None
        self._connection = None
        terminate_process(process)
        if connection is not None:
            connection.close()

    def synthesize(self, text: str, language: str, voice: str, speed: float) -> bytes:
        """Synthesize one phrase serially and encode it as PCM-16 WAV."""
        with self._lock:
            self._cancel_requested.clear()
            if self._process is None or not self._process.is_alive():
                self._stop_worker()
                self._start_worker()
            self._request_id += 1
            request_id = self._request_id
            self._connection.send((request_id, text, language, voice, speed))
            while not self._connection.poll(0.05):
                if self._cancel_requested.is_set() or not self._process.is_alive():
                    self._stop_worker()
                    raise RuntimeError("Kokoro synthesis was cancelled")
            if self._cancel_requested.is_set() or not self._process.is_alive():
                self._stop_worker()
                raise RuntimeError("Kokoro synthesis was cancelled")
            message = self._connection.recv()
            if message[0] == "result" and message[1] == request_id:
                return message[2]
            if message[0] == "error" and message[1] == request_id:
                error_type, detail = message[2], message[3]
                if error_type == "ValueError":
                    raise ValueError(detail)
                raise RuntimeError(detail)
            raise RuntimeError("Kokoro worker returned an invalid response")

    def cancel(self) -> None:
        """Terminate model inference so recording immediately regains the CPU."""
        self._cancel_requested.set()
        process = self._process
        terminate_process(process)
