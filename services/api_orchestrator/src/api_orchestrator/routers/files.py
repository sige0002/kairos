# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""Guarded static-file serving (``GET /api/v1/files/{file_path}``).

dora_runner writes artifacts (e.g. ``video_check`` mp4 previews) under the shared
data root; this router lets the UI fetch one by its path **relative to
``data_dir``** (the path the job summary returns in ``file``). It is read-only and
serves nothing else.

SECURITY: the only directory ever served is ``data_dir``. The requested path is
joined onto ``data_dir`` and resolved, then rejected unless the resolved path is
still inside the resolved ``data_dir`` (defeating ``../`` traversal and absolute
paths), exists, and is a regular file. Anything else is a uniform 404 so the
endpoint never leaks whether a path outside the root exists.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse
from kairos_common import ApiError

router = APIRouter(prefix="/api/v1/files", tags=["files"])


@router.get("/{file_path:path}")
async def get_file(request: Request, file_path: str) -> FileResponse:
    """Serve a file under ``data_dir`` by its data-relative path, else 404.

    The media type is inferred by ``FileResponse`` (mp4 -> ``video/mp4``).
    """
    settings = request.app.state.settings
    root = Path(settings.data_dir).resolve()
    candidate = (root / file_path).resolve()

    if (
        not candidate.is_relative_to(root)
        or not candidate.exists()
        or not candidate.is_file()
    ):
        raise ApiError(
            status_code=404,
            code="file_not_found",
            message=f"File not found: {file_path}",
            details={"file_path": file_path},
        )
    return FileResponse(candidate)
