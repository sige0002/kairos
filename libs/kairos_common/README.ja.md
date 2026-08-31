# kairos_common

kairos services が共有するライブラリです。

- `Settings` — root `.env` infrastructure config への typed access
- `RecordingConfig` / `load_recording_config` — `RECORDING_CONFIG` YAML の typed loader
- `create_app` — `/healthz` / `/readyz`、統一 error model、CORS、JSON-lines logging を持つ FastAPI factory
- `utc_now_iso8601` — UTC ISO8601 timestamp helper
- capture store v2 の ID、sidecar、ledger、atomic I/O、rebuild、archive path

service 固有の business logic は置かず、service 間で同じでなければならない契約と基盤だけを持ちます。
設定設計の正本は `docs/specs/ja/config.md` です。
