# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Best-effort cached voice assets for browser-side feedback."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from api_orchestrator.audio_feedback import (
    AudioFeedbackService,
    GenerationDeferred,
    TtsProvider,
)
from api_orchestrator.deps import get_record_service
from api_orchestrator.record_service import RecordService

router = APIRouter(prefix="/api/v1/audio", tags=["audio"])


class PhraseRequest(BaseModel):
    key: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9_.:-]+$")
    text: str = Field(min_length=1, max_length=200)
    language: str = Field(pattern=r"^(en|ja)$")
    voice: str = Field(min_length=1, max_length=40)
    speed: float = Field(default=1.0, ge=0.75, le=1.25)


class PrepareRequest(BaseModel):
    phrases: list[PhraseRequest] = Field(min_length=1, max_length=64)
    release_prearm: bool = False


@router.get("/status")
async def get_status(request: Request) -> dict[str, object]:
    service = request.app.state.audio_feedback
    provider = await asyncio.to_thread(service.ensure_provider)
    return {
        "available": provider is not None,
        "engine": provider.name if provider else None,
        "model_revision": getattr(provider, "model_revision", None),
        "voices": provider.voices if provider else {},
    }


@router.post("/assets")
async def prepare_assets(
    body: PrepareRequest,
    request: Request,
    record_service: RecordService = Depends(get_record_service),
) -> dict[str, object]:
    service = request.app.state.audio_feedback
    provider = await asyncio.to_thread(service.ensure_provider)
    if provider is None:
        return {
            "available": False,
            "engine": None,
            "model_revision": None,
            "assets": [],
            "errors": ["TTS engine is unavailable"],
            "deferred": False,
        }
    async with request.app.state.audio_request_lock:
        return await _prepare_assets_serially(
            body, request, service, provider, record_service
        )


async def _prepare_assets_serially(
    body: PrepareRequest,
    request: Request,
    service: AudioFeedbackService,
    provider: TtsProvider,
    record_service: RecordService,
) -> dict[str, object]:
    """Serialize only audio work and recheck recorder state after any wait."""
    assets: list[dict[str, str]] = []
    errors: list[str] = []
    released_prearm = False
    for phrase in body.phrases:
        admission_token = service.admission_token()
        try:
            recorder_status = await request.app.state.recorder_client.status()
        except Exception:
            return {
                "available": True,
                "engine": provider.name,
                "model_revision": getattr(provider, "model_revision", None),
                "assets": assets,
                "errors": [
                    "Voice generation is deferred until recorder status is known"
                ],
                "deferred": True,
            }
        recorder_state = recorder_status.get("state")
        if recorder_state == "armed" and body.release_prearm and not released_prearm:
            capture_id = recorder_status.get("capture_id")
            if isinstance(capture_id, str) and await record_service.disarm_prepared(
                capture_id
            ):
                released_prearm = True
                recorder_state = "created"
        if recorder_state in {"armed", "recording", "stopping"}:
            return {
                "available": True,
                "engine": provider.name,
                "model_revision": getattr(provider, "model_revision", None),
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
                phrase.speed,
                admission_token,
            )
        except GenerationDeferred:
            return {
                "available": True,
                "engine": provider.name,
                "model_revision": getattr(provider, "model_revision", None),
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
        "model_revision": getattr(provider, "model_revision", None),
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
