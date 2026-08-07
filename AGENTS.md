# AGENTS.md — kairos 共通ルール（正本）

このリポジトリで作業する**すべてのコーディングエージェント（Claude Code / Codex など）と人間**に共通のルール。

- Claude Code は [`CLAUDE.md`](CLAUDE.md) の `@AGENTS.md` により本ファイルを読み込む。Claude 固有のルールだけが `CLAUDE.md` にある。
- Codex など `AGENTS.md` を直接読むエージェントは、本ファイルだけで足りる。
- 共通ルールの追記・修正は**本ファイルにのみ**行う（`CLAUDE.md` に共通ルールを二重に書かない）。

プロジェクト概要: [README.ja.md](README.ja.md)（English: [README.md](README.md)）。
現時点の設計は `docs/specs/ja/`（`fig_const/` の図を基にした**正本**）にある。詳細はそこを見ること。ここで設計を再記述しない。

> ステータス: **実装済み。** 全 7 サービス（frontend を含む）が動作する。技術スタック・
> ディレクトリ構成・API 契約は確定済みで、設計の正本は `docs/specs/ja/` にある。
> 収録データの同一性・配置は **capture store v2**（`capture_id` を軸に再設計。v1 データからの
> migration は持たない）→ [`docs/specs/ja/capture_store.md`](docs/specs/ja/capture_store.md)。

## 基本方針

- **既存コードを確認してから変更する。** 推測だけで実装しない。
- **変更範囲は必要最小限。** 依頼されていないファイルを巻き込まない。
- **大きな設計変更はユーザーと決める** — 実装済みの機能・挙動を勝手に作り替えない。未確定の論点は **TBD** と明記する。
- エラーを握りつぶさない。不要な依存関係を追加しない。
- 変更後は関連するテストを実行する（→ ビルド / テスト / 実行コマンド）。

## ドキュメントの言語ルール（重要）

- ドキュメントは **日本語が正本**。著者は日本語ファイル（`*.ja.md`）だけを編集する。
- 英語ファイル（`*.md`）は日本語正本の**ミラー**。内容の編集は必ず日本語側で行い、英語は日本語から**再生成**する（英語側を手で編集しない）。Claude Code は `/sync-docs` スキルで再生成し、それ以外のツールは日本語 diff の忠実な英訳で追随させる。
- **例外: `AGENTS.md` と `CLAUDE.md` はエージェント向け指示なので日本語のみ**とし、英語ミラー（`*.ja.md` / 英訳）を作らない。
- **コード・コメント・識別子・コミットメッセージは英語。**

## 規約

- ディレクトリ構成は **1 フォルダ = 1 コンテナ**（下記）。バックエンドは **Python**、frontend は **TS**（→ スタック）。コード規約・テスト方針もベースライン確定済み（下記）。
- API 契約・各サービスの内部詳細・ビルド/実行コマンドは実装済み。詳細は `docs/specs/ja/<service>.md` を参照。

## サンプルデータ（ローカル動作確認用）

- 動作確認用のサンプル rosbag（**MCAP**）を `data/` 配下に置く。例: `data/airoa-moma-mcap/<episode>/`
  （各 `<id>.mcap` + `metadata.yaml`。HSR のテレオペ収録 AIROA MOMA）。
- **MCAP が収録の正本フォーマット**であり、検証・変換パイプラインの入力になる。
- `data/` の中身は gitignore（`data/.gitkeep` でディレクトリだけ追跡 → `./data`→`/data` マウントが
  user 所有で作られ、root 所有マウントを避けられる）。`*.mcap` やサンプルデータはコミットしない。
- これはサンプル**入力**の置き場所であり、収録データの配置そのものではない（→ データ配置と識別子）。

## ディレクトリ構成

**1 フォルダ = 1 コンテナイメージ**（図のボックスと 1:1）。各フォルダは `src/` と `Dockerfile` を持ち、実装済み。テストは Python サービスが `tests/`、frontend は `src/` 内に併置。

```
kairos/
├─ services/              # 各コンテナ（図のボックスと 1:1）
│  ├─ rosbag2_recorder/   #   ROS 2: topics → MCAP（収録の正本）
│  ├─ topic_monitor/      #   ROS 2: ライブ監視メトリクス（非デコード）
│  ├─ webrtc_streamer/    #   ROS 2: カメラ低遅延プレビュー
│  ├─ topic_probe/        #   ROS 2: 数値フィールドのライブプロット（decode 隔離）
│  ├─ api_orchestrator/   #   API ハブ / ジョブ・状態管理
│  ├─ dora_runner/        #   収録後の検証・変換（validation 系は同梱 dora + bagflow、他は in-process）
│  └─ frontend/           #   Web UI（Vite + React + TS）
├─ libs/                  # サービス間の共有（API 契約 / ROS msg / 共通ユーティリティ）
├─ config/                # 収録/監視の設定（どの topic を録るか・RECORDING_CONFIG）
├─ deploy/                # 補助（msgs overlay / 結合テスト harness / ロボット→PC 取り込み sync）
├─ e2e/                   # UI 受け入れテスト（Playwright。frontend とは別プロジェクト）
├─ Makefile               # docker compose + テストハーネスのショートカット
├─ compose/               # 起動定義（単一ホスト = compose.yaml。分割構成は robot.yaml /
│                         #   recording.yaml〔代替 zenoh.yaml〕。TURN = turn.yaml、archive = archive.yaml）
├─ .github/workflows/     # CI（ci.yml = ローカルの make と同じ検証、ros-integration.yml）
├─ docs/                  # 仕様・設計ドキュメント
└─ data/                  # ランタイムデータ（gitignored）→ 次節
```

- 各サービスの仕様は `docs/specs/ja/<service>.md` を参照。

## データ配置と識別子（capture store v2）

収録の実体は `<data_dir>`（既定 `./data`、コンテナ内 `/data`）にある。**ディスク上のサイドカーが正本で、
`kairos.db` はそこから再構築できる索引**。以下は最低限の要約で、不変条件・サイドカーの形式・削除手順の
正本は [`docs/specs/ja/capture_store.md`](docs/specs/ja/capture_store.md)（`data/` を触る作業の前に読む）。

```
<data_dir>/
├─ objects/<capture_id>/            # 録画の実体（MCAP + object_manifest.json / record.json）
│                                   #   兄弟ファイル: <capture_id>.failed.json / .qos.yaml
├─ .incoming/<capture_id>/          # import・転送の staging（objects/ と同一 FS 必須）
├─ .trash/<capture_id>/             # 削除の中間状態（同上。復元は提供しない）
├─ views/                           # 生成 symlink 木（全消し・再生成可）
├─ report/<pipeline>/<capture_id>/  # dora_runner の成果物
├─ catalog/                         # validation_templates / plan_catalog のサイドカー
├─ lifecycle.jsonl                  # ライフサイクル ledger（削除もここに残る）
├─ instance.json                    # この設置の identity（再生成しない）
└─ kairos.db                        # 索引。捨てて再起動すれば再構築される
```

- **`capture_id`（UUIDv7）が唯一のキー** — パス・DB 主キー・サイドカー・API のすべて。発行するのは
  **recorder**（外部 bag の取り込み時だけ orchestrator が claim 時に発行）。
- **`run_id`（`run_YYYYMMDD_HHMMSS(_N)`、取り込み bag は `imported_…`）は表示名専用。** API のキーにもパスにも使わない。
- `<data_dir>` 直下の上記の名前は**予約名**。dataset 作成（`name` / `operator` / `task`）で衝突すると
  `400 reserved_name`（この 3 つは `views/` のパス構成要素になるため）。
- 削除は **discard（未送信の破棄）と delete（通常削除）の 2 種**で経路は共通 —
  ledger 追記 → `.trash/` へ atomic rename → 行は墓標として残す。ロボット側コピーの drop-local は**未実装**。
- v1 の `recorded/<run_id>/`・`<operator>/<task>/<NNN>/`・`data/index.jsonl` は**廃止**（migration は無く、
  作業ツリーに残っていても読まれない）。スキーマ変更は migration ではなく rebuild で吸収する。

## スタック

> 確定済み。サービスごとの詳細は `docs/specs/ja/<service>.md` を参照。

- **バックエンドは Python。**
  - ROS 2 ノード（`rosbag2_recorder` / `topic_monitor` / `webrtc_streamer` / `topic_probe`）: **rclpy**。
  - `api_orchestrator` / `dora_runner`: Python（FastAPI）。
- **frontend**: Vite + React + TypeScript（確定）。
- ROS 2 ディストロ: テストハーネスの既定は **Jazzy**（`ROS_DISTRO` で変更可）。
- 各サービスは自己完結（1 フォルダ = 1 イメージ）。依存はサービス内で閉じる。

## コード規約

- **コード・コメント・識別子・コミットメッセージは英語**（言語ルール参照）。
- **Python**
  - フォーマッタ / リンタ: **Ruff**（format + lint）。共有設定はルートの `pyproject.toml`（`line-length = 88`、lint は `E,F,I,UP,B`、pytest の `testpaths` も同居）。
  - 型: パブリック I/F に type hints を付ける。`mypy` は未導入（CI でも実行していない）。
  - 例外を握りつぶさない。大きなデータを不要にコピーしない。
  - テスト: **pytest**（ROS 2 ノードの結合は `launch_testing` を任意で）。
  - パッケージ: 各サービスに `pyproject.toml`（PEP 621）。
- **TypeScript / frontend**: ESLint + Prettier、テストは Vitest、`tsconfig` は strict。
  - **Collect の新ロジックは `v2/collect/hooks/`（純粋な状態遷移は `machine/`）へ置き、`useBatchMachine.ts` 本体に足さない。** 修正が本体へ積まれて 3,274 行まで育った実績があるため（2026-08 リファクタで分割済み）。既存の抽出済み hook（useTakeClock / usePreArm / useCollectContext 等）が配置の見本。
- 上記は合意済みのベースライン。個別の追加規約は `docs/` に分離する。

## ビルド / テスト / 実行コマンド

> 全 7 サービス（frontend を含む）が実装済み。本書で最重要の節。

- **Make ショートカット（推奨入口）**: ルートの `Makefile` が下記コマンドを薄くラップする。`make` で
  ターゲット一覧。サービス名は**位置引数**（`make build monitor`、`make restart monitor orchestrator`）。
  機体設定は単一 `ROBOT`（既定 `airoa_hsr`）で選ぶ。`make` が `config/<robot>/`（committed）/
  `config/local/<robot>/`（gitignored）を解決し、recording/stream/validators/flows/monitoring の各パスを
  派生して各サービスへ渡す（`.env` の陳腐化パス回避）。
  主なもの: `make up`（**起動のみ・build しない**）/ `make build` / `make rebuild <svc>`（コード変更の反映）/
  `make restart <svc>` / `make logs <svc>` / `make config-reload`（config 反映）/ `make rosbag-loop` /
  `make table` / `make smoke[-record]` / `make test` / `make lint` / `make fmt`。以下は各コマンドの実体。
  **build と起動は意図的に分離**している（build は変更が無くてもネットワークを要するため、`up` が毎回
  build するとネットの無い現場で起動できない）。イメージの無いマシンへは
  `make images-save` → コピー → `make images-load` で持ち込む。
- **単体テスト**: `make test`（= `make test-py` + `make test-fe`）。
  - `make test-py` — `libs/kairos_common` + 全 Python サービスを順に `uv run --extra test pytest -q`。
    **最後に `deploy/sync` のテストも回す**（orchestrator の venv から実行）。1 パッケージだけ試すときは
    そのディレクトリで `uv run --extra test pytest -q`。
  - `make test-fe` — `cd services/frontend && npm run build && npm test && npm run lint`。
  - ROS ノード（recorder/monitor/streamer/probe）は rclpy を**遅延 import** するため、ROS 未導入のホストでも純ロジックのテストは走る（rclpy 依存パスは Docker で検証）。
- **UI 受け入れテスト**: `make test-e2e` — 実ブラウザ（Playwright）＋実スタック＋実 bag 再生で `e2e/tests/*.spec.ts`
  を回す。専用ポート・専用 `ROS_DOMAIN_ID`・専用 data dir なので `make up` のスタックを壊さない。
  **イメージは build しない**（`up` と同じ規則）— `services/` を変えたら先に `make build`。古いイメージのまま
  緑になると受け入れゲートが嘘をつく。初回はネットワークが要る（npm + chromium）。詳細は [`e2e/README.md`](e2e/README.md)。**UI/挙動を変えるラウンドは `test-fe` だけでなくこれも回す**（回さず進めて 3 スペックが静かに赤化した実績あり）。
- **Lint / format**: `uvx ruff check libs services` / `uvx ruff format libs services`。
- **CI**（`.github/workflows/ci.yml`、`develop` / `main` への push・PR）はローカルと同じ検証を回す —
  各 Python パッケージの pytest、frontend の build/test/lint、`ruff check` と **`ruff format --check`**、
  全 compose ファイルの `config -q`。ROS ツールチェーンを要する bag 収録の往復は `ros-integration.yml`。
- **ビルド**: 各サービスは自身の `Dockerfile` で 1 イメージ。全体は `make build`、起動は `make up`。compose ファイルは `compose/` 配下のため、素の docker compose を使うなら `docker compose --project-directory . -f compose/compose.yaml …` と明示する（相対パスをリポジトリルートに固定するため）。
- **結合テスト（実データ再生）**: テスト用に **rosbag2 を再生 + 可視化するコンテナ**を用意済み。
  - 定義は `deploy/test/`。`data/` を read-only で `/data` に共有し、収録済み MCAP を ROS 2 グラフへ流す。
  - **`ROS_DOMAIN_ID`** はスタックと同じ `.env` の値に追従（既定 0）、`network_mode: host` / `ipc: host`（ホストの DDS グラフ・SHM を共有）。
  - 2 つを**別ターミナルで併用**する: `make table`（流れている全 topic の Hz/帯域/件数を定期表示）と
    `make rosbag`（bag を単発再生。`make rosbag-loop` で繰り返し、`BAG=<dir>` で bag を選ぶ）。
  - **スモークテスト（PASS/FAIL を出力）**: スタック起動後に `make smoke`（`make smoke-record` で記録
    start/stop も実行）。health → `GET /api/v1/config` の `default_topics` → topic discovery →
    monitor の live metrics を順に検証して結果を表示する。「何も出ない」を解消する入口。
  - **設定の入口は `config/`**（旧 `deploy/config/`）。`RECORDING_CONFIG` で 1 ファイルを指す。詳細は
    [`config/README.ja.md`](config/README.ja.md)。
  - 検証済みの結合手順（要点）:
    - **Stage 1 記録**: `make table` で topic 確立を確認 → orchestrator へ
      `POST /api/v1/record/start {"topics":"all"}` → MCAP が `/data/objects/<capture_id>/` に生成。
      `capture_id` は recorder が発行し、応答には表示名の `run_id` も入る（recorder の `POST /record/start`
      を直接叩くなら `run_id` は必須。採番するのは orchestrator）。`make smoke-record` で確認済み。
    - **Stage 2 監視**: 既定の **`ROBOT=airoa_hsr`** がサンプル bag（HSR）の `/hsrb/*` に一致するので、
      そのまま monitor を起動すれば `GET /metrics` に実 Hz/帯域が出る。別機体の config を選ぶと
      `default_topics` が合わず metrics が空になり得る（Monitor タブ自体は discovery で全 topic を表示）。
    - **Stage 3 検証**: orchestrator 経由の `POST /api/v1/jobs`、または dora_runner 直接の
      `POST /jobs {pipeline:"fast_validation", capture_id, params:{template}}` — どちらも `capture_id` キーで、
      成果物は `report/<pipeline>/<capture_id>/`（形はパイプラインごとに違い、`fast_validation` は
      `summary.json` の `result: pass|fail`）。`fast_validation` / `full_validation` は同梱の `dora` + `bagflow`
      で走るので**ビルド済みイメージ内で実行する**（無いホストでは `400 pipeline_unavailable`）。MCAP を実際に
      デコードするのは `loss_report` など（`mcap` + `mcap-ros2-support`、ROS 不要。`fast_validation` は `metadata.yaml` だけ）。

## Git

- **ユーザーの指示なしにコミットしない。** push・PR 作成・マージも同様。
- 依頼と関係のないファイルを変更しない。既存の未コミット変更を勝手に消さない。
- コミットメッセージは英語（Conventional Commits 準拠: `feat:` / `fix:` / `chore:` …）。
- 既定ブランチは `main`、開発は `develop`。
- **秘匿ロボット名を追跡ファイル・コミットメッセージに書かない。** 対象名は gitignore された
  `config/local/<robot>/` と `deploy/msgs_overlay/<robot>/` から実行時に判る。追跡ファイル側では
  `myrobot` などの一般名を使う。

## ドキュメントの置き場所

- `docs/specs/ja/<service>.md` — 各サービスの仕様（英語ミラー: `docs/specs/en/<service>.md`）。`fig_const/` を基にした**設計の正本**（未記載事項は推奨設計として確定。認証は不要）。共有設定は [`docs/specs/ja/config.md`](docs/specs/ja/config.md)、サービス横断のデータ規約は [`docs/specs/ja/capture_store.md`](docs/specs/ja/capture_store.md)。
- `e2e/README.md` — UI 受け入れテストの範囲と、各シナリオが何を主張しているか。
- `docs/dora/` — dora まわりの利用ガイド。
- `dev_docs/` — 作業ドキュメント（調査・レビュー・設計討議）。索引は [`dev_docs/README.md`](dev_docs/README.md)。
- `issue/` — 作業中に遭遇した問題と解決策の蓄積（1 問題 = 1 エントリ）。
- `CHANGELOG.md` — 変更履歴（Keep a Changelog）。ユーザーに見える変更は `## [Unreleased]` に追記する。**gitignore 済み・ローカル管理**（コミットしない）。
