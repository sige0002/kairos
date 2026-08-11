---
name: agent-guidance-architect
description: リポジトリを調査して AGENTS.md・CLAUDE.md・Skills・検証スクリプトを設計・生成・監査・評価するスキル。「CLAUDE.md / AGENTS.md を作って・整備して・監査して・診断して」「エージェント設定を整えて」「プロジェクト指示が肥大化した・矛盾している」「Claude Code と Codex の両方で使える構成にしたい」と言われたとき、または新規リポジトリのエージェント向け雛形を作るときに使用する。通常のコーディング作業では発動しない。
---

# Agent Guidance Architect

リポジトリのエージェント向けガイダンス（AGENTS.md / CLAUDE.md / Skills / 強制の仕組み）を、
**調査 → 抽出 → 分類 → 生成 → 監査 → 評価** の一連で設計するスキル。対象ツールは
Claude Code と OpenAI Codex の2つに限定する。

## 基本方針

1. **AGENTS.md を共通ルールの正本にする。** CLAUDE.md は `@AGENTS.md` を取り込む薄い
   ラッパーとし、Claude 固有ルールだけを追記する（二重管理の分岐を作らない）
2. **常時読み込み指示は小さく保つ。** 複数ステップの手順は Skill へ、長い知識は
   references/ へ、機械的に強制できる規則はリンター/CI/Hook へ移す
3. **@import は削減にならない。** Claude Code はインポート先も起動時に展開する。
   削減とは「常時指示から外してオンデマンドにすること」（`scripts/measure_context.py` で実測）
4. **記事や通説を鵜呑みにしない。** 知識は検証可能な主張（claim）へ変換して台帳管理し、
   効果は対象リポジトリでの A/B 評価で確認する（`references/evidence-matrix.md` 参照 —
   指示ファイルの効果を否定する研究と肯定する研究が併存している）
5. **生成物は必ず監査・実行検証してから納品する。** 動かないコマンドを常時指示に書かない

## ワークフロー

ケース別（新規リポジトリ / 既存リポジトリの移行 / モノレポ展開）の具体的な
コマンド手順は `references/playbooks.md` にある。以下は共通の流れ。

### Step 1: リポジトリ調査

正とする情報源の優先順位: **マニフェスト・CI 設定 ＞ README ＞ 既存ガイダンス**
（既存の AGENTS.md / CLAUDE.md はドリフトしている前提で照合する）。

- マニフェスト: Cargo.toml / pyproject.toml / package.json / package.xml / go.mod 等
- CI: .github/workflows（実際に回っている検証コマンドの正本）
- 既存ガイダンス: AGENTS.md / CLAUDE.md / .cursorrules / CONTRIBUTING.md
- 既存の強制の仕組み: pre-commit / lint 設定 / .claude/settings.json / hooks

既存ガイダンスがある場合は、生成の前に現状監査を実行して結果を提示する：

```bash
python3 scripts/build_report.py --repo <repo> [--cwd <subdir>] [--budget 3000]
```

### Step 2: ルールの抽出と分類

調査で得た全ルール・手順・事実を `references/decision-rules.md` の判定木で振り分ける：

| 性質 | 行き先 |
|---|---|
| 機械強制できる（フォーマット・リント） | リンター設定 + CI（ガイダンスに書かない） |
| 破ってはならない操作 | hooks / permissions / CI |
| 毎セッション必要・両ツール共通 | AGENTS.md（正本） |
| 毎セッション必要・Claude だけ | CLAUDE.md（@AGENTS.md の下） |
| 毎セッション必要・Codex だけ | .codex/ 配下 |
| 特定作業の複数ステップ手順 | Skill（常時指示にはポインタ1行） |
| 特定ディレクトリだけ | そのディレクトリの AGENTS.md + CLAUDE.md ラッパー |

過剰分割は禁止（1行のビルドコマンドを Skill へ移さない）。迷ったら
「削ったら次のセッションで実際に間違えるか」を evals で測る。

### Step 3: 生成

`templates/` から生成する。placeholder `{{...}}` とテンプレート冒頭のコメントを
必ず解決・削除すること。生成する標準構成：

```
repo/
├── AGENTS.md                  # 正本（検証済みの事実のみ。公式目標: 200行未満）
├── CLAUDE.md                  # @AGENTS.md + Claude 固有（数行）
├── <subdir>/
│   ├── AGENTS.md              # ルートとの差分のみ（実例は数行〜20行程度）
│   └── CLAUDE.md              # 「@AGENTS.md」1行
├── .agents/
│   └── skills/<name>/         # スキル本体の正本（Codex が直接読む実ディレクトリ）
├── .claude/
│   ├── skills/<name> -> ../../.agents/skills/<name>   # symlink（Claude 側は公式サポート）
│   └── agents/*.md            # サブエージェント（検証系は read-only ツールに絞る）
└── .codex/
    ├── config.toml            # Codex 固有設定（trusted プロジェクトでチーム共有可）
    └── agents/*.toml          # Codex 側サブエージェント
```

- **スキル正本の向きに注意**: Claude Code のスキル symlink は公式サポートだが、
  Codex 側には symlink されたスキルが読まれない既知バグが複数ある（openai/codex
  #8943, #11314 等）。したがって正本は Codex が直接読む `.agents/skills/` に置き、
  `.claude/skills/` からリンクする。逆方向にしない。Windows は symlink に管理者
  権限が要るため、コピー運用に切り替えて README に同期手順を残す
- Claude 固有の差分が無いリポジトリでは `ln -s AGENTS.md CLAUDE.md` も公式に許容
  される（Windows 以外）。差分を書き足す予定があるなら @import ラッパーにする
- サブエージェントの本文（役割・任務・制約）は共通に書き、Claude 用 .md と
  Codex 用 .toml の器だけ分ける。Codex はスキル/AGENTS.md からの委譲要求を公式
  サポートしている

### Step 4: 監査

生成後（または既存ファイルの監査依頼時）、必ず全スクリプトを通す：

```bash
python3 scripts/build_report.py --repo <repo> --out report.md   # 統合レポート＋評決
```

個別実行: `measure_context.py`（実効コンテキスト量）/ `audit_guidance.py`
（肥大・lint漏れ・危険コマンド・秘密・ローカルパス）/ `detect_conflicts.py`
（ツール矛盾・極性矛盾・重複）/ `validate_structure.py`（import 配線・symlink・frontmatter）。

評決（構造判定。claim 採点の ADOPT/CONDITIONAL とは別スケール）:
REWORK（HIGH あり）→ 修正して再監査。FIX（MEDIUM 3件以上）→ 指摘に対処するか、
対処しない理由をユーザーへ提示。PASS で完了。検出はヒューリスティックなので、
false positive は理由を添えて棄却してよい（黙って無視しない）。

### Step 5: 実行検証

ガイダンスに書いた検証コマンドを実際に実行し、通ることを確認する。
通らないコマンドは書かない（ドリフトの種になる）。

### Step 6: 評価（大きな変更・スキル自身の改修時）

`evals/evals.json` の A/B 比較で効果を測る。回し方は「評価の回し方」節を参照。
日常の生成・監査タスクでは Step 4-5 まででよい。

## マルチペルソナ査定

このスキル自身の更新、または大規模リポジトリの構成刷新では、1エージェントに全判断を
させず、独立したペルソナで査定する（`workflow/multi-agent-coordination` のパターンを併用）：

| ペルソナ | 任務 | 出力 |
|---|---|---|
| Claude 仕様監査 | 公式文書と現行仕様の照合、バージョン依存の確認 | claude-code-spec.md の差分 |
| Codex 仕様監査 | AGENTS.md 探索順・設定・スキル探索先の照合 | codex-spec.md の差分 |
| 相互運用アーキテクト | 共通/固有の切り分け、正本とアダプタの配置 | 構成案 |
| コンテキスト予算監査 | measure_context の実測、重複・肥大の指摘 | 削減案 |
| 保守性・セキュリティ監査 | 危険コマンド・秘密・散文強制の検出 | audit 結果のトリアージ |
| 懐疑的研究評価 | 主張の反証探索、実験条件の確認、A/B 要求 | evidence-matrix.md の差分 |
| 初心者向け説明 | 技術判断をせず、合意結果を表と完成例へ変換 | ユーザー向け説明 |
| 最終裁定 | 各結果を統合し評決（実装者と分離する） | ADOPT/CONDITIONAL/… |

小規模タスク（1リポジトリの生成・監査）では、最低限
**「実装したエージェントと別のエージェントによる反証レビュー」**の1枚だけは挟む。

## 査定基準（tips・claim の採点）

外部記事や提案を取り込むときは 100 点満点で採点し、`references/claim-ledger.md` へ登録する：

| 項目 | 配点 |
|---|---|
| 現行公式仕様との整合性 | 25 |
| Claude・Codex 間の移植性 | 15 |
| コンテキスト効率 | 15 |
| 実行・検証可能性 | 15 |
| 保守性 | 10 |
| セキュリティ | 10 |
| 初心者への明瞭さ | 5 |
| 実証的根拠 | 5 |

評決: 85+ ADOPT / 70-84 CONDITIONAL / 50-69 EXPERIMENT / 0-49 REJECT。
現行仕様で古くなったものは点数によらず OBSOLETE。公式仕様と異なる記事でも、
再現可能な不具合回避策（Issue 番号つき）は CONDITIONAL で残す。

## 評価の回し方

`evals/evals.json` に 13 ケース（空リポジトリ〜危険ルール検出〜誤発動チェック）を
公式 skill-creator 互換スキーマ（skill_name / evals / expectations）で定義してある。原則：

- **fixture は必ずコピーして使う**（評価実行がフィクスチャを書き換えるため）
- Claude Code: 公式 skill-creator（`/plugin install skill-creator@claude-plugins-official`）の
  Eval / Benchmark モードがそのまま使える（ケース独立実行・採点・あり/なし比較・
  旧新版ブラインド A/B・トリガー率測定）。手動なら `claude -p "<prompt>"`
- Codex: `codex exec "<prompt>" --json`（JSONL イベント）＋ `--output-schema` で
  機械採点可能な構造化出力を強制する
- アサーション判定は人間または別セッションの LLM judge（実装したエージェントに採点させない）
- タスクあたり最低3試行。時間・トークン・人間の修正回数も記録する
  （ベンチ成功率と人間の採用判断は乖離する — `references/evidence-matrix.md`）
- スキル改修時は旧版/新版のブラインド比較を行い、**改善が確認できた変更だけ残す**

## 参照ファイル

| ファイル | 内容 | いつ読むか |
|---|---|---|
| references/playbooks.md | 新規/既存/モノレポ別の適用手順（コピー可能なコマンド付き） | 実際にリポジトリへ適用するとき |
| references/decision-rules.md | 振り分け判定木・対応表・作業順序 | 分類・生成の前に必ず |
| references/anti-patterns.md | 検出条件と修正先の対応 | 監査結果のトリアージ時 |
| references/claude-code-spec.md | Claude Code 側の確認済み仕様 | 構成判断・仕様疑義時 |
| references/codex-spec.md | Codex 側の確認済み仕様 | 構成判断・仕様疑義時 |
| references/evidence-matrix.md | 実証研究の一覧と証拠の強さ | 効果を主張する前 |
| references/claim-ledger.md | 取り込んだ知識の台帳 | 知識の追加・再検証時 |
| references/source-registry.md | 調査コーパスの定義（A〜D層） | 情報収集の開始時 |

## 注意点

- **仕様は腐る。** spec ファイルの `verified_date` が3か月以上古ければ、構成を断定する前に
  公式ドキュメントで再確認する（このスキル最大のリスクは古い仕様での断定）
- 既存ファイルを書き換える前に必ず現状監査の結果をユーザーへ提示し、削る内容に
  ユーザー由来の意図が無いか確認する
- 秘密情報を検出した場合は、ファイル修正だけでなくローテーションと git 履歴の掃除を案内する
- このスキルは Claude Code / Codex 以外のツール（Cursor / Copilot 等）の構成には踏み込まない
