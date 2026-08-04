"""Infrastructure settings (three-layer config #1: root ``.env``).

These are the values docker compose resolves at startup and passes to each
service as environment variables (ports, ROS domain, paths, CORS, ...). The
single source of truth for the schema is ``docs/specs/ja/config.md``; keep the
keys and defaults here in sync with that table and ``.env.example``.

Usage::

    from kairos_common import get_settings
    settings = get_settings()
    uvicorn.run(app, host=settings.bind_host, port=settings.api_orch_port)
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Annotated

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Typed view of the root ``.env`` infrastructure config.

    Field names are lower-case; the corresponding environment variables are
    the upper-case names from ``docs/specs/ja/config.md`` (pydantic-settings
    matches case-insensitively). Reads ``.env`` if present, but real values
    are normally injected by docker compose ``env_file``.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ---- ROS 2 graph -------------------------------------------------------
    ros_domain_id: Annotated[int, Field(ge=0, le=232)] = 0
    ros_distro: str = "jazzy"
    rmw_implementation: str = "rmw_fastrtps_cpp"

    # ---- Data / config paths ----------------------------------------------
    data_dir: str = "./data"
    recording_config: str = "config/airoa_hsr/recording/default.yaml"
    # Stream tab layout config (initial preview panes); surfaced UI-side via
    # GET /api/v1/config. Optional — missing file just means a single empty pane.
    stream_config: str = "config/airoa_hsr/stream/default.yaml"
    # Active robot — the Config tab lists robots from config_dir + config_local_dir
    # and selects per-aspect options (recording / stream / validation / validators)
    # within the active one. Committed robots: config/<robot>/; gitignored ones:
    # config/local/<robot>/. ROBOT also labels the active set in GET /api/v1/config.
    robot: str = "airoa_hsr"
    config_dir: str = "config"
    config_local_dir: str = "config/local"
    # Destinations a dataset may be ARCHIVED to (colon-separated absolute paths,
    # PATH convention) — e.g. "/mnt/nas/datasets:/mnt/backup". Archiving copies,
    # verifies, then DELETES the source, so the destination is allow-listed
    # rather than free-form; see kairos_common.archive_paths. Empty (the
    # default) means the feature is not offered at all, and the API advertises
    # it as disabled instead of exposing a control that can only ever fail.
    #
    # The documented name is KAIROS_ARCHIVE_ROOTS (config.md and every
    # archive_paths docstring say so), so that is the alias that must work: an
    # operator who followed the docs and still saw no archive control was this
    # field silently answering only to ARCHIVE_ROOTS — found by E2E scenario 6,
    # not by any unit test, because unit tests construct Settings directly.
    archive_roots: str = Field(
        default="",
        validation_alias=AliasChoices(
            "KAIROS_ARCHIVE_ROOTS", "ARCHIVE_ROOTS", "archive_roots"
        ),
    )

    # ---- HTTP bind + ports -------------------------------------------------
    # BIND_HOST defaults to 0.0.0.0: LAN exposure is allowed on a trusted LAN
    # (no auth). Do not expose directly to untrusted networks.
    bind_host: str = "0.0.0.0"
    api_orch_port: Annotated[int, Field(ge=1, le=65535)] = 8000
    topic_monitor_port: Annotated[int, Field(ge=1, le=65535)] = 8001
    webrtc_port: Annotated[int, Field(ge=1, le=65535)] = 8002
    frontend_port: Annotated[int, Field(ge=1, le=65535)] = 8080
    # Internal service ports (not public; on host networking they bind the host).
    recorder_port: Annotated[int, Field(ge=1, le=65535)] = 8010
    dora_runner_port: Annotated[int, Field(ge=1, le=65535)] = 8020
    importer_port: Annotated[int, Field(ge=1, le=65535)] = 8030
    # topic_probe (OL-3.3): generic numeric-field live plotter. A SEPARATE
    # ROS 2 service that decodes only the one selected topic (sampled/throttled)
    # so it never touches topic_monitor (raw) or the recorder.
    topic_probe_port: Annotated[int, Field(ge=1, le=65535)] = 8003

    # ---- Inter-service hosts (multi-host / robot-edge split) ---------------
    # Hostname/IP of each downstream service the orchestrator (and nginx) reach.
    # Default "localhost" = the single-host co-located deployment (UNCHANGED).
    #
    # For the robot-edge / recording-host SPLIT — the way kairos records from a
    # SEPARATE PC WITHOUT loading the robot's onboard system — the four
    # DDS-reading services (recorder/monitor/streamer/probe) run ON the robot
    # host (sharing its DDS graph via host-net + ipc SHM = zero extra network),
    # while the orchestrator/dora_runner/frontend run on the recording PC and
    # never join DDS. On the recording PC set RECORDER_HOST / TOPIC_MONITOR_HOST
    # / WEBRTC_HOST / TOPIC_PROBE_HOST to the robot's LAN IP; dora_runner is
    # CPU-heavy and runs beside the orchestrator, so DORA_RUNNER_HOST stays
    # local. Only lightweight data crosses the boundary (monitor metrics JSON,
    # the already-encoded WebRTC preview, recorded MCAP via file sync) — no heavy
    # DDS flow ever leaves the robot. See docs/specs/ja/deployment_topology.md.
    recorder_host: str = "localhost"
    topic_monitor_host: str = "localhost"
    webrtc_host: str = "localhost"
    topic_probe_host: str = "localhost"
    dora_runner_host: str = "localhost"
    # Importer sidecar (compose/recording.yaml only): pulls finalised runs from
    # the robot on request. Co-located with the orchestrator on the recording
    # PC, so it stays localhost even in the split (like dora_runner).
    importer_host: str = "localhost"

    # ---- Frontend-facing URLs / CORS --------------------------------------
    # Browser-facing base URL of the webrtc_streamer signaling endpoints
    # (/stream/start, /stream/offer), returned as endpoints.webrtc in
    # GET /api/v1/config. Default is the SAME-ORIGIN path "/webrtc", which the
    # frontend's nginx reverse-proxies to the streamer on the host (see
    # services/frontend/nginx.conf). A relative base keeps the camera preview
    # working from any access origin (LAN IP, SSH tunnel, Tailscale) with no
    # CORS — the browser only ever talks to the page's own origin. Override with
    # an absolute "http://<host>:8002" to connect the browser directly to the
    # streamer instead (then cors_origins must list that browser origin).
    webrtc_public_url: str = "/webrtc"
    # Origins allowed by orchestrator and webrtc_streamer (served + dev).
    # NoDecode: docker compose passes a comma-separated string, not JSON, so
    # skip pydantic-settings' JSON decoding and split it in the validator.
    cors_origins: Annotated[list[str], NoDecode] = [
        "http://localhost:8080",
        "http://localhost:5173",
    ]
    # ---- WebRTC ICE servers (STUN/TURN for cross-network preview) -----------
    # The browser AND aiortc both consume the RTCIceServer JSON shape, so ONE
    # value feeds both (returned as ice_servers in GET /api/v1/config). A JSON
    # array, e.g. [{"urls":["stun:stun.l.google.com:19302"]},
    # {"urls":["turn:HOST:3478"],"username":"u","credential":"p"}]. Default [] =
    # LAN/direct (host candidates only, UNCHANGED); set only to cross NAT / WiFi
    # client isolation / the internet (TBD T02/T22; see .env.example). NoDecode +
    # the validator below mean a blank or malformed WEBRTC_ICE_SERVERS degrades
    # to [] (no ICE) instead of raising — this field lives in the SHARED Settings
    # every service loads, so a parse error here must not crash the whole stack.
    webrtc_ice_servers: Annotated[list[dict[str, object]], NoDecode] = []

    # ---- Operational -------------------------------------------------------
    log_level: str = "INFO"
    # 0 disables; >0 marks old runs as deletion candidates after the period.
    retention_days: Annotated[int, Field(ge=0)] = 0
    # 0 means unlimited; >0 auto-stops recording when exceeded.
    max_record_bytes: Annotated[int, Field(ge=0)] = 0
    # Hard wall-clock cap on one recording; 0 disables. Default 10 minutes — a
    # disk backstop against orphaned ("zombie") recordings that nobody stops
    # (persona review R2 / HCD D-9①): a normal episode is seconds-to-minutes,
    # observed zombies ran 8-12 min unattended at ~GBs. The recorder stops
    # itself and the orchestrator's lazy status reconciliation finalizes the
    # run as completed within one poll.
    max_record_seconds: Annotated[int, Field(ge=0)] = 600
    # Optional path to the topic_monitor alert-definition file.
    alert_config_path: str | None = None

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, value: object) -> object:
        """Accept a comma-separated ``CORS_ORIGINS`` string from ``.env``.

        docker compose passes a single string (``a,b``); split it into a list
        and drop blanks. A real list (e.g. from code) passes through.
        """
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @field_validator("webrtc_ice_servers", mode="before")
    @classmethod
    def _parse_ice_servers(cls, value: object) -> object:
        """Parse WEBRTC_ICE_SERVERS (a JSON array of RTCIceServer dicts) safely.

        NoDecode hands us the raw env string; we parse it here so a blank or
        malformed value becomes ``[]`` (no ICE) rather than raising and taking
        down EVERY service that loads Settings. A real list (from code) passes
        through untouched.
        """
        if value is None or value == "":
            return []
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return []
            try:
                parsed = json.loads(raw)
            except (ValueError, TypeError):
                return []
            return parsed if isinstance(parsed, list) else []
        return value


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a process-wide cached :class:`Settings` instance."""
    return Settings()
