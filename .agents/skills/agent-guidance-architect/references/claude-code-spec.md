# Claude Code 仕様（確認済み事実）

verified_date: **2026-07-31**（3か月以上経過したら公式ドキュメントで再確認してから構成判断に使うこと）
正式ドキュメント: `code.claude.com/docs/en/*`（旧 docs.claude.com/en/docs/claude-code/* は 301 リダイレクト）

## メモリファイル（CLAUDE.md）

- **スコープ4層**: Managed policy（`/etc/claude-code/CLAUDE.md` 等）→ User（`~/.claude/CLAUDE.md`）→ Project（`./CLAUDE.md` **または** `./.claude/CLAUDE.md` の両方サポート）→ Local（`./CLAUDE.local.md`）。broadest → specific の順にロード
- **チェーンは連結**: 作業ディレクトリから root へ遡って発見された CLAUDE.md / CLAUDE.local.md は**上書きでなく連結**。filesystem root 側が先、作業ディレクトリ側が後。各ディレクトリ内では CLAUDE.local.md が CLAUDE.md の後
  > "All discovered files are concatenated into context rather than overriding each other."
- **サブディレクトリは遅延ロード**: 作業ディレクトリ**配下**の CLAUDE.md は起動時に読まれず、そのサブディレクトリのファイルに触れた時点でロードされる
- **モノレポ除外**: `claudeMdExcludes` 設定（glob、各スコープでマージ）で無関係チームの CLAUDE.md を除外できる。Managed policy のものだけは除外不可
- 出典: code.claude.com/docs/en/memory

## @import

- 相対パスは**インポートを書いたファイル自身**基準（作業ディレクトリ基準ではない）
- 再帰は**最大4ホップ**
- コードスパン・フェンスコードブロック内の `@path` は解析されない
- **インポート先も起動時に展開されてコンテキストに入る** — 分割は整理にはなるがトークン削減にならない
  > "Splitting into `@path` imports helps organization but doesn't reduce context, since imported files load at launch."
- 作業ディレクトリ外を指す project-level インポートは初回に承認ダイアログ
- 出典: code.claude.com/docs/en/memory

## AGENTS.md との関係

- **Claude Code は AGENTS.md をネイティブに読まない**
  > "Claude Code reads `CLAUDE.md`, not `AGENTS.md`."
- 公式の共存方法は2つ: (1) CLAUDE.md に `@AGENTS.md` と書いてインポート、(2) シンボリックリンク `ln -s AGENTS.md CLAUDE.md`（Claude 固有の追記が不要な場合）。**Windows は symlink に管理者権限/Developer Mode が要るため import 推奨**と公式明記
- `CLAUDE_CODE_NEW_INIT=1` 環境変数下の `/init` は AGENTS.md や他ツールの rules ファイルも読んで取り込める
- 出典: code.claude.com/docs/en/memory

## Agent Skills

- 探索場所: Enterprise（managed settings）/ Personal `~/.claude/skills/` / Project `.claude/skills/` / Plugin。作業ディレクトリ配下のネストした `.claude/skills/` はオンデマンド。`--add-dir` のスキルは例外的に自動ロード
- **シンボリックリンクは公式サポート**（enterprise/personal/project の `<skill-name>` エントリ）。同一ターゲットへ複数経路があっても1回だけロード
  > "A `<skill-name>` entry ... can be a symlink to a directory elsewhere on disk."
- フロントマター（Claude Code、すべて optional）: name, description, when_to_use, argument-hint, arguments, disable-model-invocation, user-invocable, allowed-tools, disallowed-tools, model, effort, context, agent, background, hooks, paths, shell
- 文字数制限は**2系統ある**ので混同しない:
  - Agent Skills オープン標準（agentskills.io、API/claude.ai 検証ルール）: name ≤64（小文字英数+ハイフン、"anthropic"/"claude" 禁止）、description ≤1024・非空
  - Claude Code のスキル一覧表示: description + when_to_use 合計 **1,536 文字**でトランケート（`skillListingMaxDescChars`）
- 段階的開示3レベル: L1 メタデータ常時（~100 tok/skill）→ L2 SKILL.md 本文（発動時）→ L3 同梱リソース（参照時のみ）
- 使い分けの公式基準: 毎セッション必要な事実 → CLAUDE.md、複数ステップ手順・一部にしか関係しない内容 → Skill / path-scoped rule
  > "If an entry is a multi-step procedure or only matters for one part of the codebase, move it to a skill or a path-scoped rule instead."
- 出典: code.claude.com/docs/en/skills、platform.claude.com/docs/en/agents-and-tools/agent-skills/overview

## 強制の仕組み

- **CLAUDE.md は文脈であって強制ではない**（公式明記）:
  > "Claude treats them as context, not enforced configuration. To block an action regardless of what Claude decides, use a PreToolUse hook instead."
- 確実性の序列: `permissions.deny`（クライアント側で強制、deny 最優先、スコープ間はマージ）≧ PreToolUse hook の `exit 2` ＞ hook の `if` 条件マッチャー（best-effort、パース不能時 fail open）＞ CLAUDE.md の散文
- Hooks イベントは 30 種（PreToolUse / PostToolUse / SessionStart / Stop / PreCompact 等）
- settings 優先順位: Managed > Local(settings.local.json) > Project(settings.json) > User
- 出典: code.claude.com/docs/en/hooks、/hooks-guide、/settings、/memory

## サブエージェント

- `.claude/agents/*.md`。フロントマター必須は **name と description のみ**。optional: tools, disallowedTools, model, permissionMode, maxTurns, skills, mcpServers, hooks, memory, background, effort, isolation, color, initialPrompt
- 優先順位: Managed > `--agents` フラグ > project > user > plugin
- built-in の Explore / Plan は読み取り専用（調査と実装の構造的分離）。ただし「実装と検証を別エージェントで」という**一般原則の明文化は公式ドキュメントに見当たらない**（設計思想として示唆されるのみ）— このスキルでは運用ルールとして採用するが、公式出典とは主張しない
- 出典: code.claude.com/docs/en/sub-agents

## 評価（公式 skill-creator）

- `/plugin install skill-creator@claude-plugins-official`（github.com/anthropics/skills）。Create / Eval / Improve / Benchmark の4モード
- evals.json 公式スキーマ:
  ```json
  {"skill_name": "...", "evals": [{"id": 1, "prompt": "...",
    "expected_output": "...", "files": ["..."], "expectations": ["..."]}]}
  ```
- テストケースごとに独立サブエージェント実行（クリーンコンテキスト、トークン・時間記録）、アサーション採点 → grading.json、skill あり/なし比較 → benchmark.json、旧版/新版のブラインド A/B、description の should/should-not トリガー率測定
- 出典: code.claude.com/docs/en/skills、anthropics/skills の references/schemas.md

## 既知の問題（Issue、2026-07-31 時点）

- [#6235](https://github.com/anthropics/claude-code/issues/6235) **open**: AGENTS.md ネイティブサポート要望（リアクション5793・コメント348、1年経過）
- [#2142](https://github.com/anthropics/claude-code/issues/2142) **open**: CLAUDE.md のセキュリティ指示（秘密をコミットするな等)が無視される → 散文でなく hook/permissions で止める
- [#44868](https://github.com/anthropics/claude-code/issues/44868) closed: .env の中身が Read/grep 経由で transcript に露出。.gitignore はコミットを防ぐだけで読み込みは防がない
- 「CLAUDE.md が読まれない/従わない」系の反復報告（#7953, #12331, #17530, #18454, #18660, #26943, #34197, #46724 いずれも closed）→ `/context` でロード状態を確認するのが第一手

## 未確認事項

- `#` ショートカット（メモリ追加）の現行仕様 — 現行 memory ページに記載なし。廃止/変更の可能性（#14868）
- SKILL.md の `license` / `metadata` フィールドの Claude Code 側での扱い（オープン標準側には存在、Claude Code のフィールド一覧には未掲載）
- HTML コメントはコンテキスト注入前に strip される（公式明記）が、コードブロック内のコメントは保持。git 履歴・Read ツールでは見えるため「コメントに書けば隠せる」は誤り
