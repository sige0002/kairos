# kairos_common

Shared library for kairos services (Stage 0 skeleton).

Provides:

- `Settings` — typed access to the root `.env` infrastructure config
  (pydantic-settings). See `docs/specs/ja/config.md` three-layer #1.
- `RecordingConfig` / `load_recording_config` — typed loader for the
  `RECORDING_CONFIG` YAML (deployment tuning, three-layer #2).
- `create_app` — FastAPI factory that mounts `/healthz` + `/readyz`,
  installs the unified error model, configures CORS, and sets up
  JSON-lines logging.
- `utc_now_iso8601` — UTC ISO8601 timestamp helper.

This is a Stage 0 skeleton: shared plumbing only, no service business logic.
