# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Best-effort cached voice assets for browser-side feedback."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api_orchestrator.audio_feedback import (
    AudioFeedbackService,
    GenerationDeferred,
    TtsProvider,
)

router = APIRouter(prefix="/api/v1/audio", tags=["audio"])


class PhraseRequest(BaseModel):
    key: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_.:-]+$")
    text: str = Field(min_length=1, max_length=200)
    language: str = Field(pattern=r"^(en|ja)$")
    voice: str = Field(min_length=1, max_length=40)


class PrepareRequest(BaseModel):
    phrases: list[PhraseRequest] = Field(min_length=1, max_length=64)


@router.get("/status")
async def get_status(request: Request) -> dict[str, object]:
    service = request.app.state.audio_feedback
    provider = service.provider
    return {
        "available": provider is not None,
        "engine": provider.name if provider else None,
        "configured_provider": service.configured_provider,
        "voices": provider.voices if provider else {},
    }


@router.post("/assets")
async def prepare_assets(body: PrepareRequest, request: Request) -> dict[str, object]:
    service = request.app.state.audio_feedback
    provider = service.provider
    if provider is None:
        return {
            "available": False,
            "engine": None,
            "assets": [],
            "errors": ["TTS engine is unavailable"],
            "deferred": False,
        }
    async with request.app.state.audio_request_lock:
        return await _prepare_assets_serially(body, request, service, provider)


async def _prepare_assets_serially(
    body: PrepareRequest,
    request: Request,
    service: AudioFeedbackService,
    provider: TtsProvider,
) -> dict[str, object]:
    """Serialize only audio work and recheck recorder state after any wait."""
    assets: list[dict[str, str]] = []
    errors: list[str] = []
    for phrase in body.phrases:
        admission_token = service.admission_token()
        try:
            recorder_status = await request.app.state.recorder_client.status()
        except Exception:
            return {
                "available": True,
                "engine": provider.name,
                "assets": assets,
                "errors": [
                    "Voice generation is deferred until recorder status is known"
                ],
                "deferred": True,
            }
        if recorder_status.get("state") in {"armed", "recording", "stopping"}:
            return {
                "available": True,
                "engine": provider.name,
                "assets": assets,
                "errors": ["Voice generation is deferred while recording is active"],
                "deferred": True,
            }
        try:
            asset_id = await asyncio.to_thread(
                service.prepare,
                phrase.text,
                phrase.language,
                phrase.voice,
                admission_token,
            )
        except GenerationDeferred:
            return {
                "available": True,
                "engine": provider.name,
                "assets": assets,
                "errors": [
                    "Voice generation was preempted because recording took priority"
                ],
                "deferred": True,
            }
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except Exception as exc:
            errors.append(f"{phrase.key}: {exc}")
            continue
        assets.append(
            {
                "key": phrase.key,
                "asset_id": asset_id,
                "url": f"/api/v1/audio/assets/{asset_id}.wav",
            }
        )
    return {
        "available": True,
        "engine": provider.name,
        "assets": assets,
        "errors": errors,
        "deferred": False,
    }


@router.get("/assets/{asset_id}.wav")
async def get_asset(asset_id: str, request: Request) -> Response:
    try:
        data = request.app.state.audio_feedback.read_asset(asset_id)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(status_code=404, detail="audio asset not found") from exc
    return Response(content=data, media_type="audio/wav")
