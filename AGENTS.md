# Kairos

共通指示はここに置く。[CLAUDE.md](CLAUDE.md) は `@AGENTS.md` の薄いラッパー。概要は [README.ja.md](README.ja.md)、設計とAPI契約は [docs/specs/ja/](docs/specs/ja/) を正本とする。バックエンドはPython（Monitorの受信・集計のみC++）、frontendはReact / TypeScript、サービスは1フォルダ=1コンテナイメージ。現行のAPIは trusted LAN・認証なしを前提とする。

## 作業と公開の境界

- 依頼範囲、必要な検証、そこから見つかった問題を完了する。大きな挙動変更はユーザーと決め、未確定事項はTBDにする。並列作業はworktreeで隔離し、ROS検証も専用の`ROS_DOMAIN_ID`とデータ領域を使う。
- commit、push、PR、merge、サービス起動は明示依頼または既存の認可があるときだけ行う。認可済み工程は繰り返し確認しない。既存の未コミット変更を上書き・削除しない。
- 秘匿ロボット名を追跡ファイル・コミットメッセージ・公開文に書かない。実名と機体固有設定はgitignoredの`config/local/<robot>/`、`deploy/msgs_overlay/<robot>/`、`.env`へ置き、追跡側は`ROBOT`、`<robot>`、`myrobot`を使う。編集・公開前は [no-confidential-names](.agents/skills/no-confidential-names/SKILL.md) を実行する。

## 文書とデータ

- 文書は日本語が正本。`*.ja.md`と`docs/specs/ja/`を編集し、英語ミラーは [sync-docs](.agents/skills/sync-docs/SKILL.md) で再生成する。`AGENTS.md` / `CLAUDE.md`は日本語のみ。コード、コメント、識別子、Conventional Commitsのメッセージは英語。
- `dev_docs/`は調査・設計討議、`issue/`は問題と解決策の記録。ユーザーに見える変更はローカルの`CHANGELOG.md`の`Unreleased`へ記録し、コミットしない。
- データ配置、ID、削除を扱う前に [capture_store.md](docs/specs/ja/capture_store.md) を読む。MCAPとディスク上のサイドカーが正本、`kairos.db`は再構築可能な索引。`capture_id`は唯一のキーで、`run_id`は表示用だけに使う。
- 実体は`objects/<capture_id>/`。`.incoming/`と`.trash/`は同一FSに置き、削除はledger追記→atomic rename→墓標を残す。`instance.json`は再生成しない。v1配置は廃止済みでmigrationは持たない。`data/`のMCAP・サンプル・ランタイムデータはコミットしない。

## ビルドと検証

コマンドの正本は [Makefile](Makefile) と [.github/workflows/](.github/workflows/)。`ROBOT`からMakeが設定パスを導出する。

- `make up`は起動のみでbuildしない。コード反映は`make build` / `make rebuild <svc>`、設定反映は`make config-reload`、オフライン持込は`make images-save` / `make images-load`。
- Pythonは対象パッケージで`uv run --extra test pytest -q`、横断は`make test-py`。Ruffは`make lint`と`uvx ruff format --check libs services deploy/perf`。公開Python I/Fに型を付け、未導入のmypyをゲートにしない。
- UI・挙動の変更は`make test-fe`、影響サービスのimage build、`make test-e2e`を実行する。E2Eは自動buildしないため、実スタック・browser・bag再生を専用port/domain/data dirで隔離する。実行できない必須検証は理由を報告し、単体テストを代替証拠としない。
- ROSノードはrclpyを遅延importする。rclpy経路の変更はROS imageまたは結合ハーネスで確認する。Composeを直接使う場合は`docker compose --project-directory . -f compose/compose.yaml …`で相対パスを固定する。文書だけの変更に実スタック検証を追加せず、同じ状態の全検査を無目的に反復しない。

## 作業別の参照

- Console v2: [v2-screen-work](.agents/skills/v2-screen-work/SKILL.md)。Collectの新ロジックは`v2/collect/hooks/`、純粋な状態遷移は`machine/`に置き、`useBatchMachine.ts`本体に積み増さない。
- 記録・再生・DDS: [rosbag-workflow](.agents/skills/rosbag-workflow/SKILL.md)。設定は [config/README.ja.md](config/README.ja.md)、共有契約は [config.md](docs/specs/ja/config.md)。
- 検証・変換: [dora-rs](.agents/skills/dora-rs/SKILL.md)。`fast_validation` / `full_validation`は同梱doraとbagflowを持つimage内で実行する。
- オフライン配備: [offline-container-delivery](.agents/skills/offline-container-delivery/SKILL.md)。スキル実体は`.agents/skills/`、Claude側は`.claude/skills/`からのsymlink。作業に必要なスキルと参照だけを読む。
