# kairos

**English: [README.md](README.md)**

ROS 2 のロボットデータを **収録・監視・検証・変換** するシステムです。収録の正本フォーマットは
**MCAP** であり、ライブ映像・ライブメトリクス・事後検証はすべてこの「正本」を中心に構成されます。

> **ステータス:** 全 6 サービス + frontend を実装済み（Stage 1〜4）。以下のアーキテクチャは
> `fig_const/` の図に基づきます。

## アーキテクチャ

```
                ROS 2 Robot / Sim  ──►  ROS 2 Topics
                                          │
        ┌──────────────┬──────────────────┼──────────────────────────┐
        ▼              ▼                   ▼                          ▼
  webrtc_streamer  topic_monitor    rosbag2_recorder            (選択されたトピック)
   (ライブ映像)     (ライブ監視)      ──► MCAP  /data/recorded/run_xxxx.mcap  ◄── 正本
        │              │                   │
        ▼              ▼                   ▼  (収録後)
     Browser  ◄──  api_orchestrator  ──►  dora_runner ──► レポート / 変換済みデータセット
                  (ジョブ・状態ハブ)        (検証・変換パイプライン)
                         ▲
                         │ REST / WebSocket / SSE
                      frontend (Vite + React + TS)
```

## サービス構成

| サービス | 役割 |
|---|---|
| [rosbag2_recorder](docs/specs/ja/rosbag2_recorder.md) | 選択した ROS 2 トピックを **MCAP** に記録する。唯一の正本（source of truth）。 |
| [topic_monitor](docs/specs/ja/topic_monitor.md) | 軽量・非破壊なライブ健全性メトリクス（Hz / 遅延 / 欠落 / ロス / 帯域）。ペイロードは**デコードしない**。 |
| [webrtc_streamer](docs/specs/ja/webrtc_streamer.md) | 低遅延のカメラ**プレビュー**（ROS 2 image → ブラウザ）。記録パスではない。 |
| [api_orchestrator](docs/specs/ja/api_orchestrator.md) | 単一の API ハブ。ジョブのライフサイクル・状態・設定・結果集約を担う。 |
| [dora_runner](docs/specs/ja/dora_runner.md) | 収録後の**検証・変換**パイプライン（dora ベース）。有効: `fast_validation` / `dataset_export` / `loss_report` / `video_check`。 |
| [frontend](docs/specs/ja/frontend.md) | backend-driven な Web UI（UI 表記は英語）。タブ構成: Live / Graph / Recordings / Validation / Datasets / Config。 |

## 仕様ドキュメント

各サービスの詳細仕様は [docs/specs/ja/](docs/specs/ja/README.md) を参照してください。`fig_const/` を基にした**設計の正本**です（未記載事項は推奨設計として確定。認証は不要）。

## 始め方

### 必要なもの

- **Docker** / **Docker Compose**（全サービスをまとめて起動する場合）。
- ローカル検証用のサンプル rosbag（**MCAP**）を `data/` 配下に配置（例: `data/airoa-moma-mcap/<episode>/`）。`data/` と `*.mcap` は gitignore（コミットしない）。
- 単体テストを直接走らせる場合のみ: **uv**（Python）と **Node.js + npm**（frontend）。

### 全サービスの起動（Docker）

```bash
make up                       # = build + 起動（detached）。機体は ROBOT で選択（既定 airoa_hsr）
# あるいは素の docker compose で:
cp .env.example .env          # 必要に応じて編集
docker compose build
docker compose up
```

全サービスは host networking で起動します。ROS 2 サービス（`recorder` / `monitor` / `streamer`）は
ホストの DDS グラフ（`ROS_DOMAIN_ID=0`）を共有し、純 Python サービス（`orchestrator` / `dora_runner`）
と frontend は `localhost:<port>` で相互に到達します（認証なし・LAN 前提）。

### Make ショートカット

長いコマンドを毎回打たずに済むよう、ルートに `Makefile` を用意しています。`make` だけで全
ターゲット一覧が出ます。サービス名は**位置引数**（複数可）。機体設定は単一 `ROBOT`（既定
`airoa_hsr`）で選び、`make` が `config/<robot>/`（committed）／ `config/local/<robot>/`（gitignored）を
解決して各サービスへ渡す（`.env` の陳腐化パスを回避）。

| コマンド | 内容 |
|---|---|
| `make up` / `make down` / `make ps` | スタックの起動（build込み）/ 停止削除 / 状態 |
| `make build monitor` / `make build` | サービス build（位置引数で1つ / 無指定や `all` で全部） |
| `make rebuild frontend` | build + 強制再作成（コード変更を反映） |
| `make restart monitor orchestrator` | サービス再起動 |
| `make logs streamer` | ログ追従 |
| `make config-reload` / `make config-show` | `config/*.yaml` 編集の反映（monitor+orchestrator 再起動）/ 現在の config 表示 |
| `make rosbag` / `make rosbag-loop` / `make table` | サンプル bag 単発再生 / ループ再生 / 全 topic の Hz テーブル |
| `make smoke` / `make smoke-record` | 通し確認（PASS/FAIL）/ 記録 start/stop 込み |
| `make test` / `make test-py` / `make test-fe` / `make lint` / `make fmt` | テスト・lint・整形 |

別ロボットを使う場合は `make up ROBOT=<robot>` のように `ROBOT` を切り替えます（`make` が
`config/<robot>/`（committed）/ `config/local/<robot>/`（gitignored）を解決して各サービスへ渡す）。
別 bag は `make rosbag BAG=/data/<robot>/<run>` のように上書きできます。

### 追加ロボットを使う（カスタムメッセージ型を含む）

新しいロボットを足す手順。標準メッセージ型だけのロボットは 1〜3 のうち overlay 部分が不要です。

1. **config を用意**: `config/template/` を `config/local/<robot>/` にコピーして編集する
   （`recording/` `stream/` `validation/` `validators/` の4 aspect。少なくとも `recording/default.yaml` の
   `default_topics` をそのロボットの実トピックに合わせる）。詳細は [`config/`](config/README.ja.md)。
2. **（カスタム型を使うロボットのみ）メッセージ overlay をビルド**: そのロボットの非標準メッセージ
   パッケージ（例 `<robot>_msgs`）の typesupport が無いと、recorder / monitor / bag 再生のいずれも
   該当トピックを**無言で取りこぼす**（標準型のみ流れる）。bag が**複数の**カスタムパッケージを使う場合は
   **その全て**を用意する（一つでも欠けるとそのパッケージのトピックは落ちる）。ベンダ提供の msg ソースを
   `deploy/msgs_overlay/<robot>/src/<pkg>/` に置いてからビルドする（手順は [`deploy/msgs_overlay/`](deploy/msgs_overlay/README.md)）:
   ```bash
   make msgs-build MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>
   ```
3. **起動**（overlay を渡す。カスタム型が無ければ `MSGS_OVERLAY_DIR` は不要）:
   ```bash
   make up ROBOT=<robot> MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot>
   ```
4. **bag 再生にも overlay が要る**: `ros2 bag play` はカスタム型を publish するのに typesupport が必要なので、
   再生側にも同じ overlay を渡す:
   ```bash
   MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot> BAG=/data/<robot>/<run> \
     docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   ```
5. **スモーク**: `smoke.sh` は既定で同梱 HSR の bag を見るため、追加ロボットでは bag と overlay を明示する:
   ```bash
   env BAG=/data/<robot>/<run> MSGS_OVERLAY_DIR=./deploy/msgs_overlay/<robot> bash deploy/test/smoke.sh
   ```
   なお `make table`（topic_table）は overlay を読まないので、追加ロボットのカスタム型の Hz は表示されない。
   確認は monitor の `GET /metrics`、または再生時に表示される `ros2 bag info` を使う。

### 主なエンドポイント（既定ポート）

| サービス | ポート | 例 |
|---|---|---|
| api_orchestrator | 8000 | `GET /api/v1/config` / `POST /api/v1/record/start` / `GET /api/v1/events`（SSE）/ `POST /api/v1/jobs` |
| topic_monitor | 8001 | `GET /metrics` / `GET /topics` / `GET /metrics/stream`（SSE） |
| webrtc_streamer | 8002 | `POST /stream/start` / `POST /stream/offer` |
| rosbag2_recorder | 8010 | `POST /record/start` / `POST /record/stop` / `GET /record/status` |
| dora_runner | 8020 | `POST /jobs` / `GET /jobs/{id}/result` / `POST /validation/templates/generate` |

frontend は nginx で配信（既定 `8080`）。UI は起動時に `GET /api/v1/config` を取得し、タブ構成・スキーマを
backend 駆動で描画します。

### 典型的な利用フロー

1. **トピックを流す**: 実ロボット/シミュレータを接続するか、サンプル bag を再生する。
   ```bash
   # 流れている topic を“見える化”（全 topic の Hz/帯域/件数を定期表示）
   docker compose -f deploy/test/compose.yaml run --rm topic_table
   # サンプル bag を ROS 2 グラフへ再生（別ターミナル・単発再生）
   docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   # 繰り返し再生（連続で流し続ける）
   LOOP=--loop docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   # 別の bag を指定
   BAG=/data/airoa-moma-mcap/000730 docker compose -f deploy/test/compose.yaml run --rm rosbag_player
   ```
2. **記録**: UI（Live タブ）または `POST /api/v1/record/start {"topics":"all"}` で開始 → MCAP が
   `/data/recorded/<run_id>/` に生成される（停止は `POST /api/v1/record/stop`）。Live タブの
   **Operator（データ取得者）/ Task（タスク名）** を入れると、その内容＋トピック・件数・開始/終了が
   MCAP と同じ `/data/recorded/<run_id>/session.json` に保存され、Recordings タブでも表示される。
   収録は **Recordings タブから削除**できる（DB 行＋`/data/recorded/<run_id>` を削除）。recorder は出力を
   `chmod 0777` するので、ホスト側（コンテナ外）からも sudo なしで削除できる。
3. **監視 / プレビュー**: `GET /metrics` でライブ健全性（Hz / 欠落 / 帯域）、`/stream` でカメラの
   WebRTC プレビュー。UI の Live タブは Stream プレビューと Monitor パネル（**グラフ上の全 topic を常時表示**し、
   監視対象は live Hz を重ねる）を融合表示。サンプル bag の Hz は既定の `ROBOT=airoa_hsr` で出る（どの
   topic を録る/監視するかは機体ごとに [`config/`](config/README.ja.md) で定義。Live タブの RECORD
   チェックに事前選択として反映）。
4. **収録後の検証・処理**（`POST /api/v1/jobs`、`dora_runner` 経由）:
   - `fast_validation` — 必須トピックの過不足を検証 → `/data/report/fast_validation/<run_id>/summary.json` に `pass`/`fail`。
   - `loss_report` — トピックごとのロス推定（Recordings タブの「Run loss report」）。
   - `video_check` — カメラトピックの mp4 プレビュー（Recordings タブ。`GET /api/v1/files/...` で再生）。
   - `dataset_export` — 完了した収録を `data/<operator>/<task>/NNN` へ export（Datasets タブ）。

### テスト / 結合テスト

- **単体テスト**: `make test`（= Python 各サービス `uv run --extra test pytest` + frontend `npm run build && npm test && npm run lint`）。
- **スモークテスト（PASS/FAIL を表示）**: スタック起動後に `make smoke`（= `bash deploy/test/smoke.sh`）。
  health → `GET /api/v1/config` の `default_topics` → topic discovery → monitor の live metrics を順に検証して
  結果を出力します（`make smoke-record` で記録 start/stop も実行）。「テストしたのに何も出ない」を解消する入口です。
- **可視化付き再生**: `make table`（全 topic の Hz/帯域を定期表示）と `make rosbag` / `make rosbag-loop`（再生）。

詳しいコマンド・確認済みレシピは [CLAUDE.ja.md](CLAUDE.ja.md) の「ビルド / テスト / 実行コマンド」を参照してください。

## ドキュメントの言語ルール

**日本語が正本**です。日本語ファイル（`*.ja.md`）を編集し、英語版（`*.md`）は `/sync-docs` スキルで
再生成します。英語版は手で編集しないでください。

## コントリビュート

- コード・コメント・コミットメッセージは英語で記述します。
- 作業上の取り決め・規約は [CLAUDE.ja.md](CLAUDE.ja.md) を参照してください。
