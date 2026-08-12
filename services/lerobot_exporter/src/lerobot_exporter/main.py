"""lerobot_exporter service: profiles, exports, and the queue behind them."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Response, status
from kairos_common import ApiError, Settings, create_app, get_settings
from kairos_common.ids import is_uuid7

from lerobot_exporter.models import (
    ExportRequest,
    ExportStatus,
    ProfileListResponse,
)
from lerobot_exporter.paths import (
    is_non_empty_dir,
    output_dir,
    validate_segment,
)
from lerobot_exporter.profiles import scan_profiles
from lerobot_exporter.registry import ExportRecord, ExportRegistry
from lerobot_exporter.settings import ExporterConfig
from lerobot_exporter.staging import sweep_staging

SERVICE_NAME = "lerobot_exporter"

logger = logging.getLogger("kairos")


def create_exporter_app(
    settings: Settings | None = None,
    *,
    config: ExporterConfig | None = None,
) -> FastAPI:
    """Build the exporter app.

    The startup staging sweep runs HERE rather than in a lifespan hook, for the
    same reason dora_runner reconciles its interrupted jobs at construction: it
    is the point where the data directory is known, and it must have happened
    before the first request can submit an export into it.
    """
    settings = settings or get_settings()
    config = config or ExporterConfig.from_env()
    data_dir = Path(settings.data_dir)
    removed = sweep_staging(data_dir)
    if removed:
        # No conversion outlives the process that spawned it, so anything found
        # here is debris — say what was dropped rather than deleting quietly.
        logger.info(
            "removed leftover export staging trees at start",
            extra={"count": len(removed), "export_ids": removed},
        )

    app = create_app(SERVICE_NAME, settings=settings)
    registry = ExportRegistry(data_dir, config)
    app.state.registry = registry
    app.state.data_dir = data_dir
    app.state.exporter_config = config

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            # Stop the converters we own on the way out; their partial outputs
            # go with them, so a restart is not blocked by its predecessor's
            # half-written destination.
            await registry.shutdown()

    app.router.lifespan_context = lifespan

    @app.get("/")
    async def root() -> dict[str, str]:
        return {"service": SERVICE_NAME}

    # Liveness/readiness come from create_app (`/healthz`, `/readyz`) — the
    # paths the orchestrator's BaseServiceClient and the compose healthcheck
    # both probe. A second hand-rolled health path would be a second answer to
    # the same question.

    @app.get("/profiles", response_model=ProfileListResponse)
    async def profiles() -> ProfileListResponse:
        # Both trees are scanned every time rather than resolved once: a robot
        # can be committed or gitignored, and which one it is is not something
        # this service should have to be told.
        scan = scan_profiles(
            settings.config_dir, settings.config_local_dir, settings.robot
        )
        return ProfileListResponse(
            profiles=scan.items, validator_unavailable=scan.validator_unavailable
        )

    @app.post(
        "/exports",
        response_model=ExportStatus,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_export(body: ExportRequest) -> ExportStatus:
        # The library is scanned per request (a robot can be committed or
        # gitignored), and the requested profile must be ONE OF ITS FILES.
        # is_file() alone would let an unauthenticated host-network caller hand
        # us /etc/hosts to parse and read back through the converter's error —
        # so the check is membership in the resolved library, not existence.
        allowed = {
            _resolve(item.path)
            for item in scan_profiles(
                settings.config_dir, settings.config_local_dir, settings.robot
            ).items
        }
        _validate_request(body, allowed_profiles=allowed)
        existing = registry.get(body.export_id)
        if existing is not None:
            raise ApiError(
                status_code=409,
                code="export_in_progress",
                message=(
                    f"Export id is already known (state: {existing.state}). "
                    "Submit a new export with a new id."
                ),
                details={"export_id": body.export_id, "state": existing.state},
            )
        if registry.active_output_name(body.output_name):
            raise ApiError(
                status_code=409,
                code="export_in_progress",
                message=(
                    f"An export to '{body.output_name}' is already queued or running."
                ),
                details={"output_name": body.output_name},
            )
        destination = output_dir(data_dir, body.output_name)
        if is_non_empty_dir(destination):
            raise ApiError(
                status_code=409,
                code="destination_not_empty",
                message=(
                    f"exports/{body.output_name} already exists and is not "
                    "empty. Exports are never merged into or overwritten — "
                    "choose another name."
                ),
                details={"output_path": f"exports/{body.output_name}"},
            )
        record = registry.submit(
            ExportRecord(
                export_id=body.export_id,
                output_name=body.output_name,
                profile_path=body.profile_path,
                task_fallback=body.task_fallback,
                episodes=list(body.episodes),
            )
        )
        return registry.status(record)

    @app.get("/exports/{export_id}", response_model=ExportStatus)
    async def export_status(export_id: str) -> ExportStatus:
        record = registry.get(export_id)
        if record is None:
            raise _export_not_found(export_id)
        return registry.status(record)

    @app.post(
        "/exports/{export_id}/cancel",
        response_model=ExportStatus,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def cancel_export(export_id: str, response: Response) -> ExportStatus:
        record = registry.get(export_id)
        if record is None:
            raise _export_not_found(export_id)
        if record.terminal:
            raise ApiError(
                status_code=409,
                code="export_already_terminal",
                message=(
                    f"Export {export_id} has already finished (state: {record.state})."
                ),
                details={"export_id": export_id, "state": record.state},
            )
        await registry.cancel(record)
        if record.terminal:
            # It was still queued: nothing had started, so the cancel is done
            # rather than accepted. A running export stays 202 — the state turns
            # `canceled` only when its converter is confirmed dead.
            response.status_code = status.HTTP_200_OK
        return registry.status(record)

    return app


def _resolve(path: str | Path) -> str:
    """A path in its canonical form for library-membership comparison."""
    return str(Path(path).resolve())


def _validate_request(body: ExportRequest, *, allowed_profiles: set[str]) -> None:
    """Refuse a request that could never become a valid export.

    Refused HERE rather than at the first path join: an id that cannot name a
    capture, or a name that cannot be a directory, is a bad REQUEST — not an
    export that is accepted, queued, and then fails with a filesystem error.
    """
    if not is_uuid7(body.export_id):
        raise ApiError(
            status_code=400,
            code="invalid_export_id",
            message=f"export_id must be a UUIDv7: {body.export_id}",
            details={"export_id": body.export_id},
        )
    validate_segment(body.output_name, field="output_name", code="invalid_output_name")
    if not body.episodes:
        raise ApiError(
            status_code=400,
            code="no_episodes",
            message="An export needs at least one episode.",
        )
    if not body.profile_path or _resolve(body.profile_path) not in allowed_profiles:
        raise ApiError(
            status_code=400,
            code="profile_not_found",
            message=(
                f"Profile config is not in this robot's library: {body.profile_path}"
            ),
            details={"profile_path": body.profile_path},
        )
    seen: set[str] = set()
    for episode in body.episodes:
        if not is_uuid7(episode.capture_id):
            raise ApiError(
                status_code=400,
                code="invalid_capture_id",
                message=f"capture_id must be a UUIDv7: {episode.capture_id}",
                details={"capture_id": episode.capture_id},
            )
        validate_segment(episode.dir, field="dir", code="invalid_episode_dir")
        if episode.dir in seen:
            raise ApiError(
                status_code=400,
                code="duplicate_episode_dir",
                message=f"Two episodes claim the same directory: {episode.dir}",
                details={"dir": episode.dir},
            )
        seen.add(episode.dir)


def _export_not_found(export_id: str) -> ApiError:
    """The unified 404 for an unknown export id.

    Unknown includes "known to a previous process": the registry is in-memory
    by design, so a restart forgets in-flight exports rather than reporting a
    state it can no longer observe.
    """
    return ApiError(
        status_code=404,
        code="export_not_found",
        message=f"Export not found: {export_id}",
        details={"export_id": export_id},
    )


def main() -> None:
    """Run the service with uvicorn, binding host/port from config."""
    import uvicorn

    settings = get_settings()
    app = create_exporter_app(settings)
    uvicorn.run(app, host=settings.bind_host, port=settings.lerobot_exporter_port)


if __name__ == "__main__":
    main()
