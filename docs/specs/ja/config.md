# 共有設定（config）仕様

> ステータス: 設計確定（v1）。日本語が正本（これを正とする）。英語版 `docs/specs/en/config.md` は自動生成ミラー（直接編集しない）。**認証は不要。** ネットワークは**信頼されたローカルネットワーク（LAN）を前提**とし、LAN 公開を許容する。

サービス間で共有する設定の単一ソースと外出しルール。「**簡単に制御できる**」ことを要件とする。

## 三層構成

1. **インフラ設定（ルート `.env`）** — docker compose が解釈し、各サービスへ env で渡す。起動時に確定する値（ポート・ドメイン・パス等）。
2. **デプロイ調整（YAML、`RECORDING_CONFIG`）** — 収録・監視のチューニング（対象 topic・expected_hz・QoS override 等）。pydantic で型検証して読み込む。
3. **実行時設定（`GET /api/v1/config`）** — `api_orchestrator` が frontend に配布する値（エンドポイント・タブ構成・既定値・スキーマ）。frontend はこれを取得してから描画する（ハードコードしない）。`defaults` には `ros_domain_id`（現在の ROS 2 ドメイン。ヘッダ表示用）も含む。RECORDING_CONFIG 全体は UI から編集・永続化できる（`PUT /api/v1/config/recording`。下記）。

## ルート `.env`（インフラ設定）

| キー | 既定 | 説明 |
|---|---|---|
| `ROS_DOMAIN_ID` | `0` | 全サービス共通の ROS 2 ドメイン |
| `ROS_DISTRO` | `jazzy` | ベースイメージの ROS 2 ディストロ |
| `RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` | DDS 実装。Fast DDS と Cyclone DDS の両 RMW をイメージに同梱しており、本キーで切替可能。Cyclone DDS のロボットには `rmw_cyclonedds_cpp` を指定する（後述） |
| `DATA_DIR` | `./data` | ホスト側データ root（→ コンテナ `/data`） |
| `RECORDING_CONFIG` | `config/recording.yaml` | 収録・監視の YAML 設定ファイル（下記） |
| `BIND_HOST` | `0.0.0.0` | API バインド先。**LAN 公開を許容**（信頼された LAN 前提・認証なし）。非信頼ネットワークへ直接公開しない |
| `API_ORCH_PORT` | `8000` | `api_orchestrator` 公開ポート |
| `TOPIC_MONITOR_PORT` | `8001` | `topic_monitor` ポート |
| `WEBRTC_PORT` | `8002` | `webrtc_streamer` signaling / http ポート |
| `FRONTEND_PORT` | `8080` | frontend 配信ポート（dev は `5173`） |
| `RECORDER_PORT` | `8010` | `rosbag2_recorder` 内部ポート（host networking ではホストに bind） |
| `DORA_RUNNER_PORT` | `8020` | `dora_runner` 内部ポート（host networking ではホストに bind） |
| `WEBRTC_PUBLIC_URL` | `http://<host>:8002` | frontend が映像/シグナリングに直接つなぐ URL（LAN ではホスト IP / 名前） |
| `CORS_ORIGINS` | `http://localhost:8080,http://localhost:5173` | orchestrator と `webrtc_streamer` が許可する origin（served + dev。LAN 公開時は該当ホストの origin を追加） |
| `LOG_LEVEL` | `INFO` | ログレベル |
| `RETENTION_DAYS` | `0` | `0`=無効。`>0` で古い run を保持期間で削除候補に |
| `MAX_RECORD_BYTES` | `0` | `0`=無制限。`>0` で超過時に記録を自動 stop |
| `ALERT_CONFIG_PATH` | (任意) | `topic_monitor` のアラート定義ファイル |
| `CYCLONEDDS_URI` | (任意) | Cyclone DDS の設定ファイル URI（例 `file:///config/cyclonedds.xml`）。クロスホストで multicast discovery が通らない場合に unicast peer を明示するなどに使う。`env_file` 経由でコンテナに渡る（3 ROS サービスとも `/config` を read-only マウント済み） |

- サービス間は信頼 LAN 内で通信する（既定は host networking で `localhost:<port>`。内部ポートも上表のとおり）。マルチテナント host ではブリッジ網 + DDS unicast に切替（`compose.yaml` のネットワーク注記参照）。
- 共通の設定スキーマは `libs/` に置き（pydantic-settings 想定）、各サービスが env を型付きで読む。

### DDS 実装の切替（Fast DDS ↔ Cyclone DDS）

ROS 2 では**両端（ロボット側と購読側）で同じ RMW 実装**でないと相互通信できない（Fast DDS と Cyclone DDS のクロスベンダ間相互運用は ROS 2 として非対応）。ロボットが Cyclone DDS で publish している場合は、Kairos 側も Cyclone DDS に合わせる。

- 3 つの ROS サービス（recorder / monitor / streamer）のイメージには Fast DDS と Cyclone DDS の**両 RMW を同梱**済み。`.env` で `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp` を指定して**リビルド不要で切替**できる（既定は `rmw_fastrtps_cpp`）。
- 併せて **`ROS_DOMAIN_ID` をロボットと一致**させること（既定 `0`）。
- 同一ホスト / 同一 LAN で multicast discovery が通る環境なら追加設定は不要。別ホストで discovery が通らない場合は `CYCLONEDDS_URI` で unicast peer を指定する（上表）。
- ローカル検証用のテストハーネス（`deploy/test/`、bag 再生でロボット役）も同梱・`RMW_IMPLEMENTATION` で切替可能なので、Cyclone DDS 経路をサンプル bag で疎通確認できる。

## 収録・監視の YAML（`RECORDING_CONFIG`、デプロイ調整）

`rosbag2_recorder` と `topic_monitor` が共有する、デプロイ単位のチューニング（`../rosbag-view` を参考）。pydantic モデルで型検証し、トピックはパターン（fnmatch）一致で適用する。

```yaml
robot_name: hsr
default_topics:            # 収録/監視の既定対象（glob 可）
  - /tf
  - "/camera/*/image_raw"
expected_hz_patterns:      # パターン → 期待 Hz（first match wins。hz 省略で動的学習）
  - { pattern: "/camera/*/image_raw", hz: 30 }
  - { pattern: "/joint_states", hz: 100 }
topic_qos_overrides:       # パターン → QoS（recorder / monitor が適用。first match wins）
  - { pattern: "/camera/*/image_raw", reliability: best_effort, durability: volatile, depth: 1 }
# monitor / recording / validation は config/recording.yaml を参照（dataset は stage3）
```

- **`recording` チューニング**: `start_delay_s`（publisher ウォームアップ待ち）に加え、開始時の購読確立 lag 対策として `start_paused`（既定 `false`／`true` で `--start-paused`＋購読 readiness gate＋resume を有効化）と `subscription_ready_timeout_s`（既定 5.0）を持つ。詳細は [rosbag2_recorder](rosbag2_recorder.md)。
- **UI からの編集・永続化**: この `RECORDING_CONFIG` 全体は Config タブから編集できる（`GET/PUT /api/v1/config/recording`、[api_orchestrator](api_orchestrator.md)）。`PUT` は `RecordingConfig` で型検証し（失敗は `422`）、設定ファイルへアトミックに書き込んで在メモリ設定をホットスワップする。`default_topics` / `robot_name` は即時反映、`expected_hz` / QoS は各サービスの**再起動時**に反映される。

## 実行時設定（`GET /api/v1/config`）

`api_orchestrator` が frontend 向けに返す（例）:

```json
{
  "endpoints": { "api": "/api/v1", "events": "/api/v1/events", "webrtc": "<WEBRTC_PUBLIC_URL>" },
  "tabs": [
    { "id": "record",    "enabled": true },
    { "id": "monitor",   "enabled": true },
    { "id": "stream",    "enabled": true },
    { "id": "runs",      "enabled": true },
    { "id": "pipelines", "enabled": false }
  ],
  "defaults": { "expected_hz": {}, "encoding": "vp8", "default_topics": [], "robot_name": "...", "ros_domain_id": 0 },
  "schemas": {
    "record_start": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "required": ["topics"],
      "properties": {
        "topics": { "oneOf": [ { "type": "array", "items": { "type": "string" } }, { "const": "all" } ] },
        "compression": { "enum": ["none", "zstd"], "default": "none" },
        "split": { "type": ["object", "null"],
          "properties": { "max_size_mb": { "type": ["integer", "null"] }, "max_duration_s": { "type": ["integer", "null"] } } }
      }
    },
    "pipeline_forms": {
      "fast_validation": {
        "type": "object", "required": ["template"],
        "properties": { "template": { "type": "string" } }
      }
    }
  }
}
```

- **タブはレジストリ駆動。** 表示・順序・有効/無効を backend が差し替えられる（「簡単に組み替え可能」の要件）。
- `schemas` は **JSON Schema（draft 2020-12）**。frontend はこれでフォームを描画する（backend-driven。`record_start` や各 pipeline の実行フォーム等。nullable・enum・既定値を含めて固定）。

## 共通規約

- **ネットワーク前提**: 信頼された LAN。認証は持たない。LAN 公開は許容するが、インターネット等の非信頼ネットワークへは直接公開しない。
- タイムスタンプは **UTC ISO8601**（例 `2026-06-24T01:23:45.123Z`）。
- エラー形式は全 API 共通: `{ "error": { "code": "...", "message": "...", "details": {} } }`。
- 各サービスは `GET /healthz`（liveness）/ `GET /readyz`（readiness）を持つ。
- ログは JSON lines（`run_id` / `component` / `request_id` を含める）。
- backend は OpenAPI を公開（`/openapi.json`）。frontend はそこからクライアントを自動生成する（Orval、[frontend](frontend.md)）。

## API 共通規約（全 HTTP サービス）

- すべて OpenAPI 生成可能な粒度で型を固定する（pydantic モデル）。`null` 可否・既定値を明示。
- ステータスコード: `200` / `201` 正常、`400` 不正入力、`404` 不在、`409` 競合（多重 start 等）、`422` バリデーション、`503` 内部サービス不通、`507` 容量不足。本文はエラー形式に従う。
- 一覧 API はカーソルページング: `?limit`（既定 50）+ `?cursor`、応答 `{ items: [], next_cursor: string|null }`。
- enum（全サービス共通の語彙）:
  - run state: `created` | `recording` | `stopping` | `completed` | `failed` | `interrupted`
  - job state: `queued` | `running` | `succeeded` | `failed` | `canceled`
  - encoding: `vp8` | `h264`
  - alert metric: `hz` | `bandwidth` | `gap` | `late` | `loss`
  - alert op: `lt` | `gt` | `le` | `ge`
- 時刻は UTC ISO8601。期間・サイズは数値とし、接尾辞で単位を示す（`*_ms` / `*_bytes` / `*_bps` など）。
