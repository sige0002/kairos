# CLAUDE.md（日本語・正本）

このリポジトリで Claude Code（および人間）が作業するためのメモ。
プロジェクト概要: [README.ja.md](README.ja.md)（English: [README.md](README.md)）。
現時点の設計は `docs/specs/ja/`（`fig_const/` の図を基にした**正本**）にある。詳細はそこを見ること。ここで設計を再記述しない。

> ステータス: **グリーンフィールド / 設計前。** コード・技術スタックは未決。ディレクトリ構成はコンテナレベルのみ合意（各サービス内部は TBD）。
> **設計判断を勝手にしない** — ユーザーと一緒に決める。未決事項は **TBD** のまま残す。

## ドキュメントの言語ルール（重要）

- ドキュメントは **日本語が正本**。著者は日本語ファイル（`*.ja.md`）だけを編集する。
- 英語ファイル（`*.md`）は **自動生成ミラー** — 手で編集しない。日本語から `/sync-docs` で再生成する。
- **コード・コメント・識別子・コミットメッセージは英語。**

## 規約

- ディレクトリ構成は **コンテナレベルのみ合意**（下記）。バックエンドは基本 **Python**、frontend は **TS**（→ スタック）。コード規約・テスト方針もベースライン合意済み（下記）。
- API 契約・各サービスの内部詳細・サービス個別のビルド/実行コマンドは **未決（TBD）。**

## サンプルデータ（ローカル動作確認用）

- ローカルでの動作確認用に、サンプルの rosbag（**MCAP**）を `data/` 配下に置く。
- 例: `data/airoa-moma-mcap/<episode>/`（各 `<id>.mcap` + `metadata.yaml`）。HSR ロボットのテレオペ収録（AIROA MOMA）で、収録の正本となる生の MCAP。
- **MCAP が収録の正本フォーマット**であり、検証・変換パイプラインの入力になる。
- `data/` の中身は `.gitignore`（`data/.gitkeep` でディレクトリだけ追跡 → `./data`→`/data` マウントが
  user 所有で作られ、root 所有マウントを避けられる）。`*.mcap` やサンプルデータはコミットしない。
- これはローカル作業の便宜であり、**正式なディレクトリ構成の決定ではない**（構成は TBD）。

## ディレクトリ構成

コンテナレベルの構成のみ合意済み（**1 フォルダ = 1 コンテナイメージ**、図のボックスと 1:1）。各フォルダの内部（`src/` / `tests/` / `Dockerfile` など）とサービスごとのスタックは **TBD**（詳細は `docs/` に書く）。

```
kairos/
├─ services/              # 各コンテナ（図のボックスと 1:1）
│  ├─ rosbag2_recorder/   #   ROS 2: topics → MCAP（収録の正本）
│  ├─ topic_monitor/      #   ROS 2: ライブ監視メトリクス
│  ├─ webrtc_streamer/    #   ROS 2: カメラ低遅延プレビュー
│  ├─ api_orchestrator/   #   API ハブ / ジョブ・状態管理
│  ├─ dora_runner/        #   収録後の検証・変換（dora）
│  └─ frontend/           #   Web UI（Vite + React + TS）
├─ libs/                  # サービス間の共有（API 契約 / ROS msg / 共通ユーティリティ）
├─ config/                # 収録/監視の設定（どの topic を録るか・RECORDING_CONFIG）
├─ deploy/                # オーケストレーション補助（env / k8s / 結合テスト harness）
├─ Makefile               # docker compose + テストハーネスのショートカット
├─ compose.yaml           # ルートの起動エントリ（docker compose）
├─ docs/                  # 仕様・設計ドキュメント
└─ data/                  # ランタイムデータ（gitignored）
```

- 各サービスの仕様は `docs/specs/ja/<service>.md` を参照。
- まだフォルダの実体は作っていない（合意した構成の記録のみ）。スキャフォールドは別途行う。

## スタック

> 合意済みの基本方針のみ。サービスごとの詳細は確定時に `docs/` へ。

- **バックエンドは基本 Python。**
  - ROS 2 ノード（`rosbag2_recorder` / `topic_monitor` / `webrtc_streamer`）: **rclpy**。
  - `api_orchestrator` / `dora_runner`: Python（フレームワーク等の詳細は TBD）。
- **frontend**: Vite + React + TypeScript（確定）。
- ROS 2 ディストロ: テストハーネスの既定は **Jazzy**（`ROS_DISTRO` で変更可）。
- 各サービスは自己完結（1 フォルダ = 1 イメージ）。依存はサービス内で閉じる。

## コード規約

- **コード・コメント・識別子・コミットメッセージは英語**（言語ルール参照）。
- **Python**
  - フォーマッタ / リンタ: **Ruff**（format + lint）。行長は Ruff 既定（88）。
  - 型: パブリック I/F に type hints を付ける。`mypy` は任意（CI で段階導入）。
  - テスト: **pytest**（ROS 2 ノードの結合は `launch_testing` を任意で）。
  - パッケージ: 各サービスに `pyproject.toml`（PEP 621）。
- **TypeScript / frontend**: ESLint + Prettier、テストは Vitest、`tsconfig` は strict。
- 上記は合意済みのベースライン。個別の追加規約は `docs/` に分離する。

## ビルド / テスト / 実行コマンド

> 全 6 サービス + frontend が実装済み（Stage 1〜4）。本書で最重要の節。

- **Make ショートカット（推奨入口）**: ルートの `Makefile` が下記コマンドを薄くラップする。`make` で
  ターゲット一覧。サービス名は**位置引数**（`make build monitor`、`make restart monitor orchestrator`）。
  機体設定は単一 `ROBOT`（既定 `airoa_hsr`）で選ぶ。`make` が `config/<robot>/`（committed）/
  `config/local/<robot>/`（gitignored）を解決し、recording/stream/validation/validators の各パスを
  派生して各サービスへ渡す（`.env` の陳腐化パス回避）。
  主なもの: `make up` / `make rebuild <svc>` / `make restart <svc>` / `make logs <svc>` /
  `make config-reload`（config 反映）/ `make rosbag-loop` / `make table` / `make smoke[-record]` /
  `make test` / `make lint` / `make fmt`。以下は各コマンドの実体。
- **単体テスト（Python）**: 各サービス／共有ライブラリ内で `uv run --extra test pytest -q`。
  ```
  for d in libs/kairos_common services/rosbag2_recorder services/topic_monitor \
           services/webrtc_streamer services/api_orchestrator services/dora_runner; do
    (cd "$d" && uv run --extra test pytest -q)
  done
  ```
  ROS ノード（recorder/monitor/streamer）は rclpy を**遅延 import** するため、ROS 未導入のホストでも純ロジックのテストは走る（rclpy 依存パスは Docker で検証）。
- **単体テスト（frontend）**: `cd services/frontend && npm run build && npm test && npm run lint`。
- **Lint / format**: `uvx ruff check libs services` / `uvx ruff format libs services`。
- **ビルド**: 各サービスは自身の `Dockerfile` で 1 イメージ。全体は `docker compose build`、起動は `docker compose up`。
- **結合テスト（実データ再生）**: テスト用に **rosbag2 を再生 + 可視化するコンテナ**を用意済み。
  - 定義: `deploy/test/`（`Dockerfile` + `compose.yaml` + `topic_table.py` + `smoke.sh`）。
  - `data/` を**ボリューム共有**（`/data` に read-only マウント）し、収録済み MCAP を ROS 2 グラフへ流す。
  - **`ROS_DOMAIN_ID=0`**、`network_mode: host` / `ipc: host`（ホストの DDS グラフ・SHM を共有）。
  - 2 サービス（**別ターミナルで併用**）:
    ```
    # ① 流れている topic を“見える化”（全 topic の Hz/帯域/件数を定期表示）
    docker compose -f deploy/test/compose.yaml run --rm topic_table
    # ② bag を単発再生（先に `ros2 bag info` を表示してから再生）。LOOP=--loop で繰り返し。
    docker compose -f deploy/test/compose.yaml run --rm rosbag_player
    BAG=/data/airoa-moma-mcap/000730 docker compose -f deploy/test/compose.yaml run --rm rosbag_player
    ```
  - **スモークテスト（PASS/FAIL を出力）**: スタック起動後に `bash deploy/test/smoke.sh`。
    health → `GET /api/v1/config` の `default_topics` → topic discovery → monitor の live metrics
    を順に検証して結果を表示（`RECORD=1` で記録 start/stop も実行）。「何も出ない」を解消する入口。
  - **設定の入口は `config/`**（旧 `deploy/config/`）。`RECORDING_CONFIG` で 1 ファイルを指す。詳細は
    [`config/README.ja.md`](config/README.ja.md)。
  - 検証済みの結合手順（要点）:
    - **Stage 1 記録**: `topic_table` で topic 確立を確認 → recorder へ `POST /record/start {"topics":"all"}`
      （run_id は orchestrator が採番）→ MCAP が `/data/recorded/<run_id>/` に生成。サンプル bag で
      数千 msg を記録できることを `smoke.sh RECORD=1` で確認済み。
    - **Stage 2 監視**: 既定の **`ROBOT=airoa_hsr`** がサンプル bag（HSR）の `/hsrb/*` に一致するので、
      そのまま monitor を起動すれば `GET /metrics` に `/hsrb/*` の実 Hz/帯域が出る（別機体の config を
      選ぶと `default_topics` が合わず metrics が空になり得る＝Monitor タブの Hz が出ない。Monitor タブ
      自体は discovery で全 topic を常時表示する）。
    - **Stage 3 検証**: `dora_runner` 単体起動 + `POST /jobs {pipeline:"fast_validation", run_id, params:{template}}`、または orchestrator 経由 `POST /api/v1/jobs`。`/data/report/fast_validation/<run_id>/summary.json` に `result: pass|fail` を出力。MCAP は `mcap` + `mcap-ros2-support` で直接読む（ROS 不要）。

## 仕様 docs

各サービスの仕様は `docs/specs/ja/<service>.md`（英語ミラー: `docs/specs/en/<service>.md`）。`fig_const/` を基にした**設計の正本**（未記載事項は推奨設計として確定。認証は不要）。共有設定は [`docs/specs/ja/config.md`](docs/specs/ja/config.md)。
