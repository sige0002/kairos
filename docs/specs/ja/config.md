# 共有設定（config）仕様

> ステータス: 設計確定（v1）。日本語が正本（これを正とする）。英語版 `docs/specs/en/config.md` は自動生成ミラー（直接編集しない）。**認証は不要。** ネットワークは**信頼されたローカルネットワーク（LAN）を前提**とし、LAN 公開を許容する。

サービス間で共有する設定の単一ソースと外出しルール。「**簡単に制御できる**」ことを要件とする。

## 三層構成

1. **インフラ設定（ルート `.env`）** — docker compose が解釈し、各サービスへ env で渡す。起動時に確定する値（ポート・ドメイン・パス等）。
2. **デプロイ調整（YAML、`RECORDING_CONFIG`）** — 収録・監視のチューニング（対象 topic・expected_hz・QoS override 等）。pydantic で型検証して読み込む。
3. **実行時設定（`GET /api/v1/config`）** — `api_orchestrator` が frontend に配布する値（エンドポイント・タブ構成・既定値・スキーマ）。frontend はこれを取得してから描画する（ハードコードしない）。`defaults` には `ros_domain_id`（現在の ROS 2 ドメイン。ヘッダ表示用）も含む。RECORDING_CONFIG 全体は UI から編集・永続化できる（`PUT /api/v1/config/recording`。下記）。

## ルート `.env`（インフラ設定）

> **どのファイルを編集する？（初めての人向け）** 設定は 1 つの `.env` に集約します。用途別にひな形が 2 つあり、
> **どちらかを `.env` にコピーして**使います（ひな形自身は編集しない。`.env` は Git にコミットされない）。
>
> - **`.env.example`** — 1 台の PC で全部動かす通常構成。`cp .env.example .env` でコピーし、多くの場合そのまま動く。
>   別ロボットを使うときだけ `ROBOT=` を変える。
> - **`.env.split.example`** — ロボットとは別の「録画用 PC」で記録する分割構成（[deployment_topology](deployment_topology.md)）。
>   録画 PC 上で `cp .env.split.example .env` し、`ROBOT_IP` にロボットの IP を書くだけ。
>
> 迷ったら `.env.example`。手順つきの説明は [README](../../../README.ja.md)（「設定ファイル `.env` はどちらを使う？」）。
> **下の表は全キーのリファレンス**で、普段はそのほとんどを触る必要はありません。

| キー | 既定 | 説明 |
|---|---|---|
| `ROS_DOMAIN_ID` | `0` | 全サービス共通の ROS 2 ドメイン |
| `ROS_DISTRO` | `jazzy` | ベースイメージの ROS 2 ディストロ。`.env` の値が Makefile 組み込み既定に勝つ（`make` が `.env` を読んで export する） |
| `RMW_IMPLEMENTATION` | `rmw_fastrtps_cpp` | DDS 実装。Fast DDS と Cyclone DDS の両 RMW をイメージに同梱しており、本キーで切替可能。Cyclone DDS のロボットには `rmw_cyclonedds_cpp` を指定する（後述） |
| `DATA_DIR` | `./data` | ホスト側データ root（→ コンテナ `/data`） |
| `ROBOT` | `airoa_hsr` | アクティブな機体。`config/<robot>/`（committed）または `config/local/<robot>/`（gitignored）を選ぶ。recording / stream / validation / validators / monitoring の各パスはこれから派生する（Makefile が committed/local を解決し、`docker compose` もネスト補間で尊重。さらに各サービスは**起動時**に、与えられた committed 形のパスが実在しなければ `config/local/` 側へ解決し直す — `kairos_common.resolve_config_path` — ため、素の `docker compose` でも local 機体が解決される）。Settings タブで機体 → aspect → option を選択・編集できる |
| `RECORDING_CONFIG` | `/config/<robot>/recording/default.yaml` | 収録・監視の YAML（通常は `ROBOT` から自動導出。`.env` で直接指定すると派生より優先される）。compose 経由のパスは**コンテナ絶対**（`./config`→`/config` マウント）（下記） |
| `STREAM_CONFIG` | `/config/<robot>/stream/default.yaml` | Stream タブの初期ペイン定義。`ROBOT` から自動導出（コンテナ絶対） |
| `LOSS_REPORT_CONFIG` | `/config/<robot>/validators/loss_report.yaml` | `dora_runner` の loss_report パラメータ。`ROBOT` から自動導出（コンテナ絶対） |
| `MSGS_OVERLAY_DIR` | `./deploy/msgs_overlay/robot` | カスタム ROS メッセージ overlay の bind-mount 元。`./` 始まり必須（named volume 化を避ける）。recorder / monitor / probe に read-only マウント。詳細は [`deploy/msgs_overlay/`](../../../deploy/msgs_overlay/README.md) |
| `BIND_HOST` | `0.0.0.0` | API バインド先。**LAN 公開を許容**（信頼された LAN 前提・認証なし）。非信頼ネットワークへ直接公開しない |
| `API_ORCH_PORT` | `8000` | `api_orchestrator` 公開ポート |
| `TOPIC_MONITOR_PORT` | `8001` | `topic_monitor` ポート |
| `WEBRTC_PORT` | `8002` | `webrtc_streamer` signaling / http ポート |
| `TOPIC_PROBE_PORT` | `8003` | `topic_probe`（数値フィールドプロット）ポート |
| `FRONTEND_PORT` | `8080` | frontend 配信ポート（dev は `5173`） |
| `RECORDER_PORT` | `8010` | `rosbag2_recorder` 内部ポート（host networking ではホストに bind） |
| `DORA_RUNNER_PORT` | `8020` | `dora_runner` 内部ポート（host networking ではホストに bind） |
| `UID` / `GID` | ホスト uid/gid | 非 root の `api_orchestrator` / `dora_runner` を `user: "${UID:-1000}:${GID:-1000}"` で動かし、host 所有の `./data`・`./config` bind マウントに書けるようにする。bash は `UID` を export せず `GID` を持たないため、`make` が `id -u`/`id -g` を export する。素の `docker compose` で uid≠1000 のホストは `export UID=$(id -u) GID=$(id -g)` が必要 |
| `WEBRTC_PUBLIC_URL` | `/webrtc` | frontend がカメラ signaling に使うベース URL（`/api/v1/config` の `endpoints.webrtc`）。既定は同一オリジンの相対パス `/webrtc` で、frontend の nginx が `webrtc_streamer` にリバースプロキシする。これにより LAN IP / SSH トンネル / Tailscale など任意のアクセス元から CORS なしで動く。ブラウザを streamer に直接つなぐ旧方式にする場合のみ絶対 URL `http://<host>:8002` を指定する（その場合 `CORS_ORIGINS` に該当 origin を追加） |
| `CORS_ORIGINS` | `http://localhost:8080,http://localhost:5173` | orchestrator と `webrtc_streamer` が許可する origin（served + dev。LAN 公開時は該当ホストの origin を追加） |
| `WEBRTC_ICE_SERVERS` | `[]` | カメラプレビューの STUN/TURN。ブラウザ RTCIceServer 形の JSON 配列（`/api/v1/config` の `ice_servers` としてブラウザ＋streamer 両方へ配布）。既定 `[]`=同一 LAN 直結（host candidate のみ）。NAT / WiFi クライアント分離 / インターネット越えのときだけ設定する。空/不正値は「ICE なし」に安全縮退（サービスは落とさない） |
| `WEBRTC_PACKET_MAX` | `1150` | RTP ペイロード上限（B）。既定 `1150` は MTU 1280 のトンネル（Tailscale/WireGuard）で断片化しないよう aiortc の 1300B 固定を縮小したもの。MTU 1500 の同一 LAN のみ `1300` に戻して overhead を減らせる |
| `WEBRTC_KEEP_IPV6` | （未設定） | `1` で answer SDP の IPv6 ICE 候補除外を無効化。既定（未設定）では v6 候補を落とす（断片化 IPv6 が WireGuard/Tailscale でブラックホール化しプレビューが黒くなるのを防ぐ）。v6 でしか到達できない網でだけ `1` にする |
| `LOG_LEVEL` | `INFO` | ログレベル |
| `RETENTION_DAYS` | `0` | `0`=無効。`>0` で古い run を保持期間で削除候補に |
| `MAX_RECORD_BYTES` | `0` | `0`=無制限。`>0` で超過時に記録を自動 stop |
| `MAX_RECORD_SECONDS` | `600` | 1 録画の wall-clock 上限（秒）。`0`=無効。孤児（zombie）録画のディスク保護バックストップ — タブを閉じても録画は止まらないため、可視の Stop UI が主たる回収で、これは無人時の保険。上限到達の自動停止は orchestrator の遅延 reconciliation により通常の completed として確定する |
| `ALERT_CONFIG_PATH` | (任意・既定は空=無効) | `topic_monitor` のアラート定義ファイル（**コンテナ絶対**、規約は `/config/<robot>/monitoring/alerts.yaml`。`config/local/<robot>/...` の override が優先）。空＝アラート無効。`make` は `ROBOT` から自動導出、素の `docker compose` では手で設定 |
| `CYCLONEDDS_URI` | (任意) | Cyclone DDS の設定ファイル URI（例 `file:///config/cyclonedds.xml`）。クロスホストで multicast discovery が通らない場合に unicast peer を明示するなどに使う。`env_file` 経由でコンテナに渡る（ROS サービスは `/config` を read-only マウント済み） |
| `NO_PROXY` | `localhost,127.0.0.1` | コンテナ内 HTTP のプロキシ除外（`no_proxy` にも同値を配布）。corporate proxy 配下のホストでは Docker が `HTTP(S)_PROXY` を全コンテナへ注入するため、これが無いとヘルスチェックやサービス間 LAN 呼び出しがプロキシへ吸われて失敗する。クロスホスト分割ではロボット IP を追加する（`.env.split.example` 参照）。orchestrator の内部 httpx クライアントはそもそも `trust_env=False` |
| `KAIROS_DORA_MAX_CONCURRENCY` | `2` | `dora_runner` が同時実行するジョブ数の上限 |
| `KAIROS_DORA_JOB_TIMEOUT_S` | `900` | `dora_runner` の 1 ジョブあたりの wall-clock 上限（秒） |

**クロスホスト分割用の `*_HOST`**（[deployment_topology](deployment_topology.md) Option A）。単一ホストでは既定のままでよい:

| キー | 既定 | 説明 |
|---|---|---|
| `RECORDER_HOST` / `TOPIC_MONITOR_HOST` / `WEBRTC_HOST` / `TOPIC_PROBE_HOST` / `DORA_RUNNER_HOST` | `localhost` | `api_orchestrator` が下流サービスに向ける接続先。録画 PC 側では recorder/monitor/streamer/probe をロボットの LAN IP に向ける（dora はローカル同居のまま） |
| `API_HOST` / `WEBRTC_HOST` / `PROBE_HOST` | `127.0.0.1` | frontend の nginx リバースプロキシのアップストリーム先（`default.conf.template`）。録画 PC では `WEBRTC_HOST` / `PROBE_HOST` をロボット IP に |

**サンプルbag再生ハーネス用**（`deploy/test/compose.yaml`。`make rosbag` / `make rosbag-loop` が読む。本体の 7 サービスには渡らない）:

| キー | 既定 | 説明 |
|---|---|---|
| `BAG` | `airoa-moma-mcap/235210` | 再生する bag。`data/` からの相対パス（例 `airoa-moma-mcap/000730`）。絶対パス（`/data/...`）も可。コマンドライン優先指定は `make rosbag BAG=...` |
| `LOOP` | (空=1 回のみ) | `--loop` を指定するとループ再生（`make rosbag-loop` と同じ効果） |

- サービス間は信頼 LAN 内で通信する（既定は host networking で `localhost:<port>`。内部ポートも上表のとおり）。マルチテナント host ではブリッジ網 + DDS unicast に切替（`compose.yaml` のネットワーク注記参照）。
- 共通の設定スキーマは `libs/kairos_common`（pydantic-settings）に置き、各サービスが env を型付きで読む。
- compose は全 7 サービスに `GET /healthz`（frontend は nginx root）ベースの healthcheck を持ち、frontend は `depends_on: orchestrator (service_healthy)` で orchestrator の healthy を待って起動する。

### DDS 実装の切替（Fast DDS ↔ Cyclone DDS）

ROS 2 では**両端（ロボット側と購読側）で同じ RMW 実装**でないと相互通信できない（Fast DDS と Cyclone DDS のクロスベンダ間相互運用は ROS 2 として非対応）。ロボットが Cyclone DDS で publish している場合は、Kairos 側も Cyclone DDS に合わせる。

- 3 つの ROS サービス（recorder / monitor / streamer）のイメージには Fast DDS と Cyclone DDS の**両 RMW を同梱**済み。`.env` で `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp` を指定して**リビルド不要で切替**できる（既定は `rmw_fastrtps_cpp`）。
- 併せて **`ROS_DOMAIN_ID` をロボットと一致**させること（既定 `0`）。
- 同一ホスト / 同一 LAN で multicast discovery が通る環境なら追加設定は不要。別ホストで discovery が通らない場合は `CYCLONEDDS_URI` で unicast peer を指定する（上表）。
- ローカル検証用のテストハーネス（`deploy/test/`、bag 再生でロボット役）も同梱・`RMW_IMPLEMENTATION` で切替可能なので、Cyclone DDS 経路をサンプル bag で疎通確認できる。
- **同一ホストの共有メモリ（SHM）はベンダ依存**: Fast DDS は `ipc: host`（設定済み）で既定有効。**Cyclone DDS は Iceoryx が別途必要（未同梱）**のため、同一ホストでも各リーダが loopback UDP のフルコピーを受ける。大きなメッセージ（画像）でフラグメント欠落によるエラーが出る場合は、ホスト `net.core.rmem_max` を引き上げ、`CYCLONEDDS_URI` の XML に `<Internal><SocketReceiveBufferSize min="16MB"/></Internal>` を指定して受信バッファを拡大する。詳細と実測確認手順は [deployment_topology](deployment_topology.md) の「単一ホスト SHM の成立条件」。

## 収録・監視の YAML（`RECORDING_CONFIG`、デプロイ調整）

`rosbag2_recorder` と `topic_monitor` が共有する、デプロイ単位のチューニング。pydantic モデルで型検証し、トピックはパターン（fnmatch）一致で適用する。

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
# monitor / recording / validation は config/<robot>/recording/default.yaml を参照（dataset は stage3）
```

- **`recording` チューニング**: `start_delay_s`（publisher ウォームアップ待ち）に加え、開始時の購読確立 lag 対策として `start_paused`（既定 `false`／`true` で `--start-paused`＋購読 readiness gate＋resume を有効化）と `subscription_ready_timeout_s`（既定 5.0）を持つ。two-phase start 用に `prepare_disarm_timeout_s`（既定 120 — 未消費 armed セッションの自動解消）と `pre_arm`（既定 `true` — **frontend が読む**: Collect 画面が ready の間 recorder を armed に保ち Start を即時化する。armed 中は記録相当の DDS 受信負荷が乗るため、受信余力の無いロボットは `false`）。詳細は [rosbag2_recorder](rosbag2_recorder.md)。
- **UI からの編集・永続化**: この `RECORDING_CONFIG` 全体は Settings タブから編集できる（`GET/PUT /api/v1/config/recording`、[api_orchestrator](api_orchestrator.md)）。`PUT` は `RecordingConfig` で型検証し（失敗は `422`）、設定ファイルへアトミックに書き込んで在メモリ設定をホットスワップする。`default_topics` / `robot_name` は即時反映、`expected_hz` / QoS は各サービスの**再起動時**に反映される。

## ワンクリック検証プリセット（`config/<robot>/validation_presets.yaml`）

Validation タブの「ワンクリック検証ボタン」を機体単位で定義するファイル（aspect ではなく機体ルート直下のフラットな一覧。committed / gitignored 両対応）。各プリセットは dora_runner の `pipeline` を固定 `params` で束ねたもの。

```yaml
presets:
  - id: hsr_required_topics        # ^[a-z0-9_]+$。プリセットの安定キー
    name: HSR required topics      # ボタン表示名
    description: ...               # 任意。ボタンの補足
    pipeline: fast_validation      # dora_runner の pipeline id（GET /api/v1/pipelines）
    params: { template: airoa_hsr }# POST /jobs にそのまま渡す（任意）
  - id: loss_scan
    name: Loss scan
    pipeline: loss_report
```

- `GET /api/v1/validation/presets`（[api_orchestrator](api_orchestrator.md)）が各プリセットに、**その pipeline がまだ検証していない完了収録**（`pending_run_ids`）を付けて返す。ボタン押下でその run すべてに一括実行する（実行対象＝未検証データ）。
- **「未検証」判定は pipeline 単位**（`report/<pipeline>/<run_id>/summary.json` の有無）。同じ pipeline を使う複数プリセットは「検証済み」状態を共有する（**1 pipeline = 1 preset を推奨**）。
- 壊れたエントリ 1 個は skip + warn（他は生きる）。ファイルが無ければプリセット無し。plugin を足したら、その id をここに書くだけで押せる（UI 改修不要）。ひな形は `config/template/validation_presets.yaml`。

## 実行時設定（`GET /api/v1/config`）

`api_orchestrator` が frontend 向けに返す（例）:

```json
{
  "endpoints": { "api": "/api/v1", "events": "/api/v1/events", "webrtc": "<WEBRTC_PUBLIC_URL>" },
  "tabs": [
    { "id": "live",       "enabled": true },
    { "id": "graph",      "enabled": true },
    { "id": "runs",       "enabled": true },
    { "id": "validation", "enabled": true },
    { "id": "dataset",    "enabled": true },
    { "id": "config",     "enabled": true }
  ],
  "defaults": { "expected_hz": {}, "encoding": "vp8", "default_topics": [], "robot_name": "...", "ros_domain_id": 0 },
  "stream": { "columns": 2, "panes": [{ "topic": "/camera/head/color/image_raw/compressed" }] },
  "schemas": {
    "pipeline_forms": {
      "fast_validation": {
        "type": "object", "required": ["template"],
        "properties": { "template": { "type": "string" } }
      }
    }
  }
}
```

- **`tabs` は v1 legacy。** v1 では表示・順序・有効/無効を backend が差し替えるレジストリだったが、**Console v2 のタブは frontend 固定の 6 枚**（Collect / Review / Datasets / Validation / Monitor / Settings。旧タブ id はリダイレクト — [frontend.md](frontend.md)）で、このフィールドは表示に使われない。互換のため payload には残る。
- `stream` はカメラプレビューの初期レイアウト（`columns` と `panes`。`STREAM_CONFIG` 由来。Collect のカメラペインはこれで初期化される）。
- `schemas` は **JSON Schema（draft 2020-12）**。frontend はこれで各 pipeline の実行フォームを描画する（`pipeline_forms` は `dora_runner` の `/pipelines` から動的に構成。到達不能時は `fast_validation` の静的フォームにフォールバック）。記録開始のトピック選択は Collect / Monitor タブが discovery と config から直接構成し、この schema には含めない。

## 共通規約

- **ネットワーク前提**: 信頼された LAN。認証は持たない。LAN 公開は許容するが、インターネット等の非信頼ネットワークへは直接公開しない。
- タイムスタンプは **UTC ISO8601**（例 `2026-06-24T01:23:45.123Z`）。
- エラー形式は全 API 共通: `{ "error": { "code": "...", "message": "...", "details": {} } }`。
- 各サービスは `GET /healthz`（liveness）/ `GET /readyz`（readiness）を持つ。
- ログは JSON lines（`run_id` / `component` / `request_id` を含める）。全サービス共通の request-id middleware（`kairos_common`）が、受信リクエストの `X-Request-ID` を採用（無ければ uuid4 を生成）し、処理中の全ログ行にその `request_id` を付与、応答ヘッダ `X-Request-ID` で返す（呼び出し側での相関に使える）。
- backend は OpenAPI を公開（`/openapi.json`）。frontend は現状**手書きの型付きクライアント**（`src/api/client.ts` + `types.ts`）で、OpenAPI からの自動生成（Orval 等）は**未採用**（将来の契約ゲート候補、[frontend](frontend.md)）。

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

## 運用（データライフサイクル）

### 保持期間（`RETENTION_DAYS`）

- `RETENTION_DAYS` は**助言のみ**で、自動削除は一切行わない（2026-07-14 裁定）。`GET /api/v1/retention` が、**未エクスポート**（run 行が残る＝export で行は消える）・**終端状態**（`completed` / `failed` / `interrupted`。録画中は対象外）・**開始が N 日超**の run を「削除候補」として返す（`{ days, candidates: [{ run_id, started_at, bytes, state, has_episode }], total_bytes }`）。サイズはディレクトリの best-effort 合計、候補は都度計算。`RETENTION_DAYS<=0` で無効（候補は常に空）。
- 実際の削除は既存の**確認付き** `DELETE /api/v1/runs/{id}` のみを経由する。Review 画面は候補があると却下可能なバナーを出し、ボタンで対象のみに絞り込む（そこから先の削除はしない）。エクスポート済みデータセットは成果物なので不可侵。

### データセットカタログ（`data/index.jsonl`）

- エクスポート済みデータセットの**派生・再構築可能**なフラットカタログ（1 行 1 データセット、JSON lines）。**正本はツリー上のサイドカー**（`dataset.json` / `episode.json`）で、カタログはツリー走査を省くための最適化に過ぎない。
- export 成功時に 1 行追記、データセット削除時に該当行を除いて再書き込み（tmp+rename でアトミック）。`dataset_dir` は `data_dir` 相対で保存（ツリー移動・リストアに強い）。
- `GET /api/v1/datasets` はカタログが存在し解釈可能ならそこから返し、**不在・破損時はツリー走査へ自動フォールバック**（応答形は同一）。`POST /api/v1/datasets/index/rebuild` でサイドカーからカタログを丸ごと再生成する（`{ count }` を返す）。`schema_version: 1`（`episode.json` にも付与。読み手は欠落時 1 とみなす）。

### バックアップ / リストア

- `make backup` で一貫スナップショットを `backups/<timestamp>.tar.gz` に作成する:
  - `data/kairos.db` を **`sqlite3 .backup`** で一貫コピー（WAL 込み。`sqlite3` が無ければ db + `-wal` / `-shm` を best-effort コピー）。
  - `data/index.jsonl` / `data/recorded/` / `data/report/` とエクスポート済みデータセット（`data/<operator>/<task>/<NNN>/`）、および `config/`。
  - **含まれないもの**: 生サンプル rosbag 入力（`data/` 直下のサンプルディレクトリ。`BACKUP_SAMPLE_DIRS` で指定、既定 `airoa-moma-mcap realman` — 自分のサンプル名に合わせて上書きする）、mp4 プレビューキャッシュ（`data/report/video_check/`）、`.env` などリポジトリ外の秘密情報。稼働中は録画/レポートが書き換わり得るため、完全な一貫性が要るときは停止中（`make down`）に実行する。
- **リストア手順**:
  1. スタックを停止: `make down`。
  2. リポジトリルート（`<restore_root>`）で展開: `tar xzf backups/<timestamp>.tar.gz -C <restore_root>`。
  3. DB スナップショットを所定位置へ: 展開された `kairos.db` を `data/kairos.db` に置く（既存を上書き。古い `data/kairos.db-wal` / `-shm` は削除）。`config/` と `data/{index.jsonl,recorded,report,<datasets>}` はそのまま所定パスへ。
  4. `make up` で再起動。起動時の reconcile が「録画中のまま残った run」を `interrupted` に整合する。
  5. カタログがツリーとずれている疑いがあれば `POST /api/v1/datasets/index/rebuild` で再生成（サイドカーが正本）。
