# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Small, bounded HTTP surface around the Kokoro model runtime."""

from __future__ import annotations

import logging
from typing import Literal, Protocol

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class KokoroRuntime(Protocol):
    """Inference capability consumed by the HTTP adapter."""

    engine: str
    model_revision: str
    voices: dict[str, list[str]]

    def synthesize(self, text: str, language: str, voice: str, speed: float) -> bytes:
        """Return one complete PCM WAV asset."""

    def cancel(self) -> None:
        """Stop any in-flight inference and release its CPU and model memory."""


class SynthesisRequest(BaseModel):
    """Bounded synthesis request for cached operator feedback phrases."""

    text: str = Field(min_length=1, max_length=200)
    language: Literal["en", "ja"]
    voice: str = Field(min_length=1, max_length=40)
    speed: float = Field(ge=0.75, le=1.25)


def tune_short_phrase(text: str, language: str) -> str:
    """Add a natural stopping boundary when a short cue has none."""
    stripped = text.strip()
    endings = (".", "!", "?", "。", "！", "？")
    if stripped.endswith(endings):
        return stripped
    return f"{stripped}{'。' if language == 'ja' else '.'}"


def create_app(runtime: KokoroRuntime) -> FastAPI:
    """Create the sidecar app with an already-loaded runtime."""
    app = FastAPI(title="kairos Kokoro sidecar", docs_url=None, redoc_url=None)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {
            "status": "ready",
            "engine": runtime.engine,
            "model_revision": runtime.model_revision,
        }

    @app.get("/voices")
    def voices() -> dict[str, object]:
        return {
            "engine": runtime.engine,
            "model_revision": runtime.model_revision,
            "voices": runtime.voices,
        }

    @app.post("/synthesize")
    def synthesize(body: SynthesisRequest) -> Response:
        if body.voice not in runtime.voices.get(body.language, []):
            raise HTTPException(
                status_code=422,
                detail=f"voice {body.voice!r} does not support {body.language}",
            )
        try:
            wav = runtime.synthesize(
                tune_short_phrase(body.text, body.language),
                body.language,
                body.voice,
                body.speed,
            )
        except Exception as exc:
            logger.exception("Kokoro synthesis failed")
            raise HTTPException(
                status_code=502, detail="Kokoro synthesis failed"
            ) from exc
        if not wav.startswith(b"RIFF"):
            raise HTTPException(
                status_code=502, detail="Kokoro returned an invalid WAV asset"
            )
        if len(wav) > 5 * 1024 * 1024:
            raise HTTPException(
                status_code=502, detail="Kokoro WAV exceeded the size limit"
            )
        return Response(content=wav, media_type="audio/wav")

    @app.post("/cancel", status_code=204)
    def cancel() -> Response:
        runtime.cancel()
        return Response(status_code=204)

    return app
