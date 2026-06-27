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

from functools import lru_cache
from typing import Annotated

from pydantic import Field, field_validator
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
    # Recording output root (where the recorder writes <run_id>/...). The
    # orchestrator uses it to delete a run's directory; the recorder relaxes its
    # mode to 0o777 so the orchestrator (uid 1000) can remove it.
    recorded_dir: str = "/data/recorded"
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
    # topic_probe (OL-3.3): generic numeric-field live plotter. A SEPARATE
    # ROS 2 service that decodes only the one selected topic (sampled/throttled)
    # so it never touches topic_monitor (raw) or the recorder.
    topic_probe_port: Annotated[int, Field(ge=1, le=65535)] = 8003

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

    # ---- Operational -------------------------------------------------------
    log_level: str = "INFO"
    # 0 disables; >0 marks old runs as deletion candidates after the period.
    retention_days: Annotated[int, Field(ge=0)] = 0
    # 0 means unlimited; >0 auto-stops recording when exceeded.
    max_record_bytes: Annotated[int, Field(ge=0)] = 0
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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a process-wide cached :class:`Settings` instance."""
    return Settings()
