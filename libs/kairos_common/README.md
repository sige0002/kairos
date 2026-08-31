<!-- AUTO-GENERATED from libs/kairos_common/README.ja.md. Do not edit by hand — edit the Japanese source and run /sync-docs. -->
# kairos_common

The shared library for kairos services.

Provides:

- `Settings` — typed access to the root `.env` infrastructure config
  (pydantic-settings). See `docs/specs/ja/config.md` three-layer #1.
- `RecordingConfig` / `load_recording_config` — typed loader for the
  `RECORDING_CONFIG` YAML (deployment tuning, three-layer #2).
- `create_app` — FastAPI factory that mounts `/healthz` + `/readyz`,
  installs the unified error model, configures CORS, and sets up
  JSON-lines logging.
- `utc_now_iso8601` — UTC ISO8601 timestamp helper.
- capture store v2 IDs, sidecars, ledger, atomic I/O, rebuild, and archive paths.

It contains only contracts and infrastructure that must remain identical across
services, not service-specific business logic. The canonical configuration design
is `docs/specs/ja/config.md`.
