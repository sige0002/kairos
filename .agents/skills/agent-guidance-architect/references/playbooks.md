# 適用プレイブック — 新規/既存リポジトリへの具体的な適用手順

SKILL.md のワークフローを、ケース別のコピー可能な手順に落としたもの。
`$SKILL` はこのスキルの実体ディレクトリを指す（例: 対象リポジトリの
`.agents/skills/agent-guidance-architect`、または `~/skill_store/agents-config/agent-guidance-architect`）。

## 0. スキル自体の導入

以下の3方式は**排他**（どれか1つを選ぶ）:

```bash
# 方式1: 全プロジェクト共通・Claude Code だけで使う
cp -r ~/skill_store/agents-config/agent-guidance-architect ~/.claude/skills/

# 方式2: 特定プロジェクト・Claude Code だけで使う
mkdir -p /path/to/repo/.claude/skills
cp -r ~/skill_store/agents-config/agent-guidance-architect /path/to/repo/.claude/skills/

# 方式3: Claude Code と Codex の両方で使う — 正本は .agents/skills（実体）に置く
mkdir -p /path/to/repo/.agents/skills /path/to/repo/.claude/skills
cp -r ~/skill_store/agents-config/agent-guidance-architect /path/to/repo/.agents/skills/
ln -s ../../.agents/skills/agent-guidance-architect /path/to/repo/.claude/skills/agent-guidance-architect
```

---

## ケースA: 新規リポジトリ（ガイダンスがまだ無い）

### A-1. 調査（正とする情報源を先に読む）

```bash
ls Cargo.toml pyproject.toml package.json package.xml go.mod 2>/dev/null
# CI が回している検証コマンド（.yml と .yaml の両方を見る）
cat .github/workflows/*.yml .github/workflows/*.yaml 2>/dev/null | grep -E "run:" | sort -u
ls .pre-commit-config.yaml Justfile Makefile 2>/dev/null
```

ここで得た**実在する**コマンドだけがガイダンスに書ける候補。README の宣伝文や
推測で概要を書かない（LLM 生成の汎用概要は成功率を下げる — evidence-matrix.md）。

### A-2. 生成

1. `$SKILL/templates/AGENTS.template.md` → `AGENTS.md`（{{...}} を全置換、コメント削除。
   **最小構成は Project Overview + Commands + Boundaries の3セクション**で、
   必要が実証されたら Code Style / Testing / Git を足す。行数目標でなく
   「検証済みの事実だけ」を書く — 公式の警告ラインは200行）
2. `$SKILL/templates/CLAUDE.template.md` → `CLAUDE.md`（Claude 固有ルールが無ければ `@AGENTS.md` 1行＋見出しだけでよい）
3. パッケージ固有ルールがある場合のみ、そのディレクトリへ nested-AGENTS / nested-CLAUDE テンプレートを展開

記入例（Rust workspace の最小形）:

```markdown
# Project Instructions
## Repository overview
Rust workspace。crates/core がライブラリ、crates/cli が CLI。
## Required commands
- `cargo fmt --all -- --check`
- `cargo clippy --workspace --all-targets`
- `cargo test -p <changed-crate>`
## Change policy
- 関係のないファイルを変更しない
- 推測だけで修正せず、実装を確認する
```

### A-3. 書いたコマンドを実行して検証

```bash
cargo fmt --all -- --check && cargo clippy --workspace --all-targets   # 例
```

**通らないコマンドは書かない**（最初からドリフトさせない）。

### A-4. 監査 → コミット

```bash
python3 $SKILL/scripts/build_report.py --repo . --budget 3000
```

Verdict が PASS になったらコミット。REWORK / FIX なら指摘を潰して再実行。

### A-5.（必要になってから）Skill・強制の追加

- リリース手順などが生えてきたら `$SKILL/templates/skill-template/` を
  `.agents/skills/<name>/` へ展開し、`.claude/skills/<name>` を symlink にする。
  AGENTS.md にはポインタ1行だけ足す
- 「絶対に止めたい操作」が出てきたら散文でなく `.claude/settings.json` へ:
  ```json
  {"permissions": {"deny": ["Bash(git push --force*)", "Bash(sudo *)"]}}
  ```

---

## ケースB: 既存リポジトリ（CLAUDE.md / AGENTS.md が既にある）

### B-1. 現状監査（書き換える前に必ず・結果をユーザーへ提示）

```bash
python3 $SKILL/scripts/build_report.py --repo . --out /tmp/guidance-report.md
python3 $SKILL/scripts/measure_context.py --repo . --cwd <よく作業するサブディレクトリ>
```

レポートを見せてから着手する。既存記述には「ユーザーが過去の失敗から足した意図」が
埋まっていることがあるため、**削る行は理由を添えて確認を取る**。

### B-2. ドリフト照合

ガイダンス中の全コマンドをマニフェスト・CI と突き合わせ、実行して確認する。
消えたコマンド（`python setup.py test` 等）は正しい現行コマンドに置換。

### B-3. 正本化マイグレーション（3パターン）

**CLAUDE.md しか無い** → 共通ルール（概要・コマンド・変更方針）を AGENTS.md へ移し、
CLAUDE.md は `@AGENTS.md` ＋ Claude 固有ルールだけ残す:

```bash
git mv CLAUDE.md AGENTS.md 2>/dev/null || mv CLAUDE.md AGENTS.md  # 未追跡でも動くように
printf '@AGENTS.md\n' > CLAUDE.md   # Claude 固有ルールがあれば下へ追記
# その後 AGENTS.md から Claude 固有記述（Plan Mode 等）を CLAUDE.md 側へ移す
```

**AGENTS.md しか無い** → ラッパーを足すだけ:

```bash
printf '@AGENTS.md\n' > CLAUDE.md
# Claude 固有差分を書く予定が無いなら ln -s AGENTS.md CLAUDE.md でも可（Windows 不可）
```

**両方ある（二重管理）** → まず差分を取る（sh でも動く形）:

```bash
sort AGENTS.md > /tmp/_a.txt; sort CLAUDE.md > /tmp/_b.txt; diff /tmp/_a.txt /tmp/_b.txt
python3 $SKILL/scripts/detect_conflicts.py .
```

- 共通部分 → AGENTS.md に一本化
- CLAUDE.md 側にしか無い記述 → Claude 固有なら CLAUDE.md へ残し、共通なら AGENTS.md へ
- **矛盾している行 → どちらが現行かをユーザーに確認**（勝手に選ばない）
- 最後に CLAUDE.md を `@AGENTS.md` ＋固有差分だけへ縮める

### B-4. 肥大への対処（監査で context-bloat / skill-leakage が出た場合）

1. `measure_context.py` で現状トークンを記録（before）
2. 判定木（decision-rules.md）で各セクションを振り分け:
   - 長い手順 → `.agents/skills/<name>/SKILL.md` へ移し、元の場所にポインタ1行
   - 読み物（歴史・設計思想・API 詳細）→ `docs/` or Skill の references/
   - リンター規則の散文 → リンター設定へ移して削除
3. `measure_context.py` を再実行し before/after をユーザーへ提示
   （@import への分割だけでは削減にならない点に注意）

### B-5. 危険ルール・秘密への対処（HIGH 検出時）

- 秘密情報: 即削除。**ローテーションと `git log -p -S<秘密の断片>` での履歴確認を案内**
  （public リポジトリなら `git/github-publish` スキルの機密スキャン手順で履歴側も掃除）
- 危険コマンド指示: 手順として本当に必要なら Skill 内へ前提・確認条件つきで移す。
  禁止したい操作なら permissions.deny / PreToolUse hook へ

### B-6. 再監査 → 完了報告

PASS になるまで B-2〜B-5 を繰り返す。完了報告には (1) 変更したファイル一覧
(2) before/after のトークン実測 (3) 削除した行と理由 (4) 残した false positive と理由、を含める。

### B-7.（任意）効果の A/B 確認

移行前後で普段のタスクを数件、`claude -p` / `codex exec --json` で流し、
時間・トークン・修正回数を比較する（1試行で結論しない）。

---

## ケースC: モノレポへの展開

1. ルートには**全パッケージ共通の方針だけ**を置く
2. パッケージ固有ルールは「本当に文脈が変わる境界」にだけ nested AGENTS.md を置く
   （2026-07-31 の gh api 実測で openai/codex は 2 個、vercel/turborepo は 3 個 —
   1パッケージ1ファイルを機械生成しない）
3. 各 nested AGENTS.md の隣に `@AGENTS.md` 1行の CLAUDE.md を置く
4. スコープ確認: `measure_context.py --cwd packages/<pkg>` で、そのパッケージで
   作業するときに何が読まれるかを実測する
5. Codex の連結32KiB上限に注意 — ルートが肥大するとネストが黙って読み落とされる
6. 無関係チームの CLAUDE.md が混ざる大規模リポジトリでは `claudeMdExcludes` を案内

## 共通の注意

- 生成・移行のどちらでも、最後に必ず `validate_structure.py` を通す
  （placeholder 残存・import 切れ・symlink 切れの検出）
- Windows 環境では symlink 運用を避け、`@AGENTS.md` import ＋スキルはコピー運用にする
- 適用後、`references/*.md` の verified_date が3か月以上古いままなら仕様を再確認してから使う
