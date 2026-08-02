# アンチパターン集 — 検出条件と修正先

`scripts/audit_guidance.py` / `detect_conflicts.py` が機械的に検出するもの。各項目は
「何が悪いか → どう検出するか → どこへ移すか」で書く。検出はヒューリスティックであり、
最終判断は必ず人間（またはレビューエージェント）が行う。

## 1. Lint Leakage — リンター規則の散文化

フォーマッター/リンターが強制できる規則を散文で書く。エージェントは散文規則を
不安定にしか守らず、トークンだけ消費する。

悪い例:
```
- 行末の空白を禁止する
- import はアルファベット順に並べる
- ダブルクォートを使う
```

- 検出: 行末空白 / import 順 / クォート / 行長 / インデント / セミコロン / 命名ケースの語彙
- 修正先: `.editorconfig`、ruff/clippy/prettier 等の設定 + CI。ガイダンスからは削除
- 例外: ツールで強制できない規則（例: 「エラーメッセージは日本語で」）は散文のまま残す

## 2. Skill Leakage — 手順書のインライン化

特定の作業でしか使わない長い手順を常時読み込みファイルに書く。

悪い例: AGENTS.md に37ステップのリリース手順。

- 検出: 8ステップ以上の連続番号付きリスト
- 修正先: Skill（オンデマンド読み込み）。常時指示には「リリースは release スキルを使う」の1行
- 例外: 3〜5ステップ程度で毎セッション使う手順（例: ビルド→リント→テスト）は残してよい

## 3. Context Bloat — 常時指示の肥大

歴史・設計思想・API 全仕様・過去の議論など「読み物」を常時指示に置く。

- 検出: 行数（>200 MEDIUM / >400 HIGH）、Codex の project_doc 上限超過、
  History/背景/設計思想/FAQ 見出し
- 修正先: references/・docs/・Skill。概要は3行に要約して残す
- 注意（Claude Code）: `@import` で分割しても起動時に展開されるため削減にならない。
  削減になるのは「常時指示から外し、オンデマンド（Skill / 明示的な Read）に変えること」だけ

## 4. 矛盾する指示

同一スコープチェーン上で排他的なツール・方針が並ぶ。エージェントはどちらかを
無作為に選ぶか、余計な確認を挟む。

- 検出: 排他ツール群（npm/yarn/pnpm/bun、pip/poetry/uv、black/ruff format、
  flake8/pylint/ruff check、jest/vitest/mocha、tabs/spaces）が同一チェーンの複数ファイルに出現。
  同一トピックへの「必ず/always」と「禁止/never」の両極
- 注意: モノレポの兄弟パッケージは別スコープ。別スコープ間の差異は矛盾ではない
- 修正: 正本を1つ決める。パッケージ別の差異はネスト AGENTS.md へ

## 5. 二重管理（AGENTS.md と CLAUDE.md の分岐）

同じ内容を両ファイルへコピーし、片方だけ更新されて分岐する。

- 検出: 正規化した同一行が両ファイルに存在（duplication）、
  AGENTS.md がある階層の CLAUDE.md に `@AGENTS.md` が無い（import-wiring）
- 修正: AGENTS.md を正本、CLAUDE.md は `@AGENTS.md` + Claude 固有差分のみ

## 6. 危険コマンドの常時指示化

エージェントが逐語的に実行しうる破壊的コマンドをガイダンスに書く。

- 検出: `rm -rf`、`sudo`、`git push --force`（--force-with-lease 以外）、
  `curl|bash`、`chmod 777`、`git reset --hard`、`--no-verify`、「確認せずに実行」
- 修正: 強制したい禁止は hooks / permissions / CI へ。手順として必要なら
  Skill 内で前提・確認条件つきで記述

## 7. 秘密情報・ローカルパスの混入

- 検出: AWS/GitHub/OpenAI/Anthropic/Slack キーパターン、秘密鍵ヘッダ、
  credential 代入、`/home/<user>`・`C:\Users\<user>` 等
- 修正: 秘密は即時削除＋ローテーション。パスは相対化または環境変数化
- 公開リポジトリでは git 履歴側の掃除も必要（git/github-publish スキル参照）

## 8. 強制語の乱用

「必ず」「絶対に」「MUST」「NEVER」を多用しても強制にはならず、本当に重要な
指示の相対的な重みが薄まる。

- 検出: 強制語密度（>8/100行 かつ 5回以上）
- 修正: 本当に強制すべきものは仕組み（hooks/CI）へ。散文は落ち着いた命令形で理由を添える

## 9. ドリフト（古いコマンド）

リポジトリの実態と乖離した記述。setup.py が消えたのに `python setup.py test` が残る等。

- 検出（半自動）: ガイダンス中のコマンドをマニフェスト（pyproject.toml / Cargo.toml /
  package.json / CI 定義）と突き合わせる。完全自動化は難しく、生成時は
  「マニフェスト・CI を正、既存ガイダンスを疑う」の向きで照合する
- 修正: 実際に実行して通ったコマンドだけを書く

## 10. ハルシネーションされた構成

存在しないディレクトリ・ツール・コマンドをガイダンスに書く（テンプレートの
placeholder をそのまま残す事故を含む）。

- 検出: `{{...}}` 残存、@import 切れ、シンボリックリンク切れ（validate_structure）
- 修正: 生成後に必ず `scripts/validate_structure.py` と実コマンド実行で検証

## 11. ガイダンスファイルの改竄（サプライチェーン）

AGENTS.md / CLAUDE.md は「AI への指示文」そのものであり、悪意ある依存パッケージが
ビルド時に書き換えて指示を注入する攻撃が実演されている（NVIDIA ブログ 2026-04:
"Absolute Authority" を自称してユーザー指示より優先させる等）。

- 検出: CI / pre-commit でガイダンスファイルの無許可 diff を検査する。
  外部由来のガイダンスは `security/prompt-injection-scan` で走査してから信頼する
- 補足: HTML コメント（`<!-- -->`）は Claude のコンテキスト注入前に strip される
  （公式仕様）が、git 履歴と Read ツールでは見える。「コメントに書けば隠せる」は誤り
