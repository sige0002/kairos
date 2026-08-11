@AGENTS.md

# CLAUDE.md — Claude Code 固有ルール

共通ルール（プロジェクト概要・ディレクトリ構成・スタック・コード規約・ビルド/テスト/実行コマンド・Git）は
上の `@AGENTS.md` で読み込む [`AGENTS.md`](AGENTS.md) が**正本**。ここには Claude Code 固有の事項だけを書く。
共通ルールを本ファイルに書き足さないこと（二重管理になる）。

## 作業の進め方

- 複雑な変更では、実装前に**対象ファイルと変更方針**を整理してから着手する（必要なら plan mode）。
- 大規模な調査・横断検索はサブエージェント（Explore など）に任せ、結論だけを持ち帰る。
- `.claude/rules/` にルールがある場合はそれにも従う（現状は未使用）。

## Skill を優先的に使う

`.claude/skills/` に本リポジトリ用の Skill がある。該当する作業では既定のやり方より Skill を優先する。

- `no-confidential-names` — 追跡ファイルの編集時・**コミット / push / PR 作成 / マージの前**のゲート。
- `sync-docs` — 日本語正本から英語ミラーを再生成する（→ AGENTS.md のドキュメントの言語ルール）。
- `v2-screen-work` / `v2-ui-review` — Console v2 の画面実装と、その完了レビュー。
- `issue-log` — 遭遇した問題と解決策を `issue/` に記録する。
- `github-issue-pr` — **ユーザーが明示的に指示したときだけ**: GitHub issue（ラベル必須・
  bug/documentation を区別）→ ブランチ → PR → 独立エージェントレビュー → マージまでの一気通貫。
- `tdd-python` — Python モジュールをテストから書く。
- `ros2-development` / `docker-ros2-development` / `ros2-web-integration` / `robotics-testing` /
  `robotics-software-principles` — ROS 2・コンテナ・Web 連携・テスト設計の実務指針。
- `mcap-direct-access` / `rosbag-workflow` — ROS 無しでの MCAP 読解と、bag 再生テスト・DDS 疎通の切り分け。
- `offline-container-delivery` — ネットワークの無い現場へスタックを持ち込む。
- `dora-rs` — dora のデータフロー、および `dora_runner` のプラグイン契約。
- `hcd-iso9241-210` / `frontend-design` — UI/UX の修正・設計時。
- `multi-agent-coordination` / `agent-guidance-architect` — 並列エージェントの編成と、
  AGENTS.md / CLAUDE.md 自体の設計・監査。

## 並列セッション

ユーザーは kairos で Claude Code を**並列に走らせる**ことがある。

- 別セッションの作業と衝突させない。git worktree で隔離し、共有ファイルを勝手に上書きしない。
- 稼働中のスタックを壊さない。ROS を使う検証は `ROS_DOMAIN_ID` を分ける（例: 99）。

## 権限

- `.claude/settings.json` に許可・拒否の設定がある。`*.pem` / `*.key` / `secrets/**` は読まない。
