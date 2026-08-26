# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Best-effort cached voice assets for browser-side feedback."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

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
        }
    assets: list[dict[str, str]] = []
    errors: list[str] = []
    for phrase in body.phrases:
        try:
            asset_id = await asyncio.to_thread(
                service.prepare, phrase.text, phrase.language, phrase.voice
            )
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
    }


@router.get("/assets/{asset_id}.wav")
async def get_asset(asset_id: str, request: Request) -> FileResponse:
    try:
        path = request.app.state.audio_feedback.path_for(asset_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="audio asset not found") from exc
    if not path.is_file():
        raise HTTPException(status_code=404, detail="audio asset not found")
    return FileResponse(path, media_type="audio/wav")
