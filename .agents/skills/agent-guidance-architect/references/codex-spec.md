# OpenAI Codex 仕様（確認済み事実）

確認日: スキル探索・symlink は **2026-09-12**、その他の節は **2026-07-31**。
バージョン依存の構成判断では該当する現行公式資料を確認する。
正式ドキュメント: developers.openai.com/codex/* は **learn.chatgpt.com へ 308 リダイレクト**（ドキュメント基盤移行済み）。引用時は両 URL を併記する。

## AGENTS.md の探索と結合

- **グローバル**: `~/.codex/AGENTS.override.md` があればそれ、なければ `~/.codex/AGENTS.md`（どちらか1つ）
- **プロジェクト**: git ルートから現在の作業ディレクトリまで、各階層で `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames` の順にチェックし、**1ディレクトリにつき最大1ファイル**採用
- **結合方式**: root → cwd の順に**連結**（空行区切り）。近いファイルほどプロンプト後方に来るため、矛盾時は事実上近い方が勝つ
  > "Codex concatenates files from the root down, joining them with blank lines."
- `AGENTS.override.md` は同階層の AGENTS.md を**置換**（マージではない）。一時的な上書き用途
- 出典: developers.openai.com/codex/guides/agents-md（→ learn.chatgpt.com/docs/agent-configuration/agents-md）

## サイズ上限と fallback

- `project_doc_max_bytes` 既定 **32 KiB**。空ファイルはスキップ、**結合サイズが上限に達した時点で以降のファイル追加を停止**。TUI 上は警告なしに切り詰められる不満が報告されている（Issue #7138）
- `project_doc_fallback_filenames`（array<string>）: 「**その階層に AGENTS.md が無い場合**に試す追加ファイル名」。AGENTS.md があればフォールバックは参照されない（マージされない）。既定値の公式記載は未発見（非公式には空配列とされる）
- **CLAUDE.md を Codex に読ませる公式手段はこの fallback のみ**。自動読み込みや自動マージは存在しない
- 出典: developers.openai.com/codex/config-reference（→ learn.chatgpt.com/docs/config-file/config-reference）

## スキル（Agent Skills）

- 探索順: **Repo scope**（cwd → リポジトリルートの各階層の `.agents/skills/`）→ User（`~/.agents/skills/`）→ Admin（`/etc/codex/skills/`）→ System（同梱）
  > "Codex scans `.agents/skills` in every directory from your current working directory up to the repository root."
- `.codex/skills/` は openai/codex リポジトリ自身が使う実例があるが、一般ユーザー向けの公式探索パスは `.agents/skills/`
- SKILL.md 必須フィールドは **name / description のみ**。**Anthropic 発のオープン標準 Agent Skills（agentskills.io）に準拠**しており、SKILL.md 自体は Claude Code と同一仕様でポータブル。探索パス・スコープ体系はクライアント固有
- **Codex は symlink されたスキルフォルダをサポートし、探索時にリンク先を読む。**
  [Build skills](https://learn.chatgpt.com/docs/build-skills) を 2026-09-12 に確認。
  旧 #8943 / #8369 / #11314 / #9898 の報告を、現行の一律非対応の根拠にしない。
  問題を再現した場合だけ、対象 CLI 版とリンク形状を明記して回避策を検討する。
- Kairos では保守上の正本を `.agents/skills/<name>/` に置き、`.claude/skills/<name>`
  から symlink する既存構成を維持する。これは Codex の非対応を理由にした逆方向禁止ではない。
- AGENTS.md 単体ファイルの symlink 挙動は公式言及なし＝未確認
- 出典: developers.openai.com/codex/skills（→ learn.chatgpt.com/docs/build-skills）、agentskills.io

## カスタムサブエージェント

- 個人: `~/.codex/agents/*.toml`、プロジェクト: `.codex/agents/*.toml`（1エージェント1ファイル）
- **必須: `name` / `description` / `developer_instructions`**。任意: model, model_reasoning_effort, sandbox_mode, mcp_servers, skills.config, nickname_candidates（省略時は親セッション継承）
- **AGENTS.md やスキルの指示からの委譲要求は公式サポート**:
  > "Local Codex clients delegate via direct requests or when `AGENTS.md` or skill instructions request it."
  実例: openai/codex 自身の `.codex/skills/code-review/SKILL.md` がサブエージェント起動を指示している
- 出典: developers.openai.com/codex/subagents（→ learn.chatgpt.com/docs/agent-configuration/subagents）

## 設定の階層

優先度（高→低）: CLI フラグ / `--config` ＞ **プロジェクト `.codex/config.toml`**（trusted プロジェクトのみ有効。cwd に近いファイルが勝つ）＞ `--profile` ＞ ユーザー `~/.codex/config.toml` ＞ システム `/etc/codex/config.toml` ＞ 既定値

- **プロジェクト `.codex/config.toml` はコミットしてチーム共有する前提の設計**。ただし `openai_base_url`, `model_provider(s)`, `notify`, `profile` 等の機微キーはプロジェクトローカルでは無視＋警告（サプライチェーン悪用防止）
- untrusted マークされたプロジェクトでは `.codex/` のプロジェクトスコープ層（config・hooks・rules）が丸ごとスキップされる
- 注意: `project_doc_fallback_filenames` をチーム標準の前提にしない（fallback は AGENTS.md 不在時のみ・設定依存）
- 出典: developers.openai.com/codex/config-advanced, /config-basic（→ learn.chatgpt.com/docs/config-file/*）

## 非対話実行（evals 用）

- `codex exec "<prompt>"` — CI・パイプライン向け
- `--json`: stdout を JSONL イベントストリーム化（thread.started / turn.completed / item.* 等）
- `--output-schema <schema>`: JSON Schema で構造化最終応答を強制（機械採点に直接使える）
- `--sandbox`: `read-only`（exec 既定）/ `workspace-write` / `danger-full-access`。`-o <path>` で最終メッセージ出力、`codex exec resume --last` でセッション再開、CI では `CODEX_API_KEY`
- モデル指定フラグ（`-m`/`--model`）の正式名は公式ページで未確認（config の `model` キー経由は可）
- 出典: developers.openai.com/codex/noninteractive（→ learn.chatgpt.com/docs/non-interactive-mode）

## サンドボックスと承認（2軸独立）

- **Sandbox mode**（技術的にできること）: `read-only` / `workspace-write`（対話既定）/ `danger-full-access`
- **Approval policy**（いつ確認するか）: `untrusted` / `on-request` / `never` / `auto_review`（レビュアーサブエージェント経由のリスクベース自動判断）。既定プリセット Auto = workspace-write + on-request。旧 `on-failure` は非推奨
- 出典: developers.openai.com/codex/agent-approvals-security（→ learn.chatgpt.com/docs/agent-approvals-security）

## AGENTS.md の公式推奨内容

working agreements、リポジトリの期待値、コードレビュー規則、セットアップ手順、チーム/サービス別の上書き。

## 既知の問題（探索まわり、いずれも closed だが教訓として）

- #4466 / #9836 / #13288: AGENTS.md（特にサブフォルダ・親階層）が読まれない時期が長く存在。根本対応は PR #18035（2026-04）の `AgentsMdManager` リファクタ
- #17111: `~/.agents/skills` は読むが `~/.agents/AGENTS.md` は読まない非対称
- 教訓: 「読まれているはず」を前提にせず、動作確認してから依存する
