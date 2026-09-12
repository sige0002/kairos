# Claim Ledger — 取り込んだ知識の台帳

研究や外部知見の採否を評価するときに、検証可能な主張（claim）と確認日を記録する。
既存エントリは当時の採否の履歴でもあり、全更新で実行すべき手順ではない。
今回の判断で利用する claim だけを必要に応じて再検証する。

## 登録形式

```yaml
claim_id: C-<PRODUCT>-<連番>    # C-CLAUDE-001 / C-CODEX-001 / C-BOTH-001 / C-RESEARCH-001
title: 一行の主張
source_type: official | oss-example | issue | article | research
product: claude-code | codex | both
source_date: 元情報の日付
verified_date: 最後に現行仕様へ照合した日付
claim: 検証可能な形の主張本文
evidence: 根拠（引用・実測・Issue 番号）
conditions: 適用条件
exceptions: 例外
verdict: ADOPT | CONDITIONAL | EXPERIMENT | REJECT | OBSOLETE
destination: 反映先ファイル
test_cases: evals.json のケース id
```

評決は ADOPT（適用）、CONDITIONAL（条件付き）、EXPERIMENT（未実証の評価候補）、
REJECT（不採用）、OBSOLETE（現行判断には使わない）。根拠・適用条件・反証を記録し、
一律の点数で安全性や仕様を相殺しない。再現可能な不具合回避策は Issue 番号と
対象バージョンを示して CONDITIONAL とできる。

---

## 台帳

```yaml
claim_id: C-BOTH-001
title: 常時読み込み指示は小さく保ち、手順は Skill へ分離する
source_type: official
product: both
source_date: 2026-07
verified_date: 2026-07-31
claim: >
  AGENTS.md / CLAUDE.md には毎セッション必要な事実のみを書き、
  複数ステップの手順・詳細知識はオンデマンド読み込み（Skill / references）へ移す。
evidence: >
  Anthropic・OpenAI 双方の公式ガイダンスが簡潔さを推奨
  （references/claude-code-spec.md / codex-spec.md の該当節を参照）。
  実証面は混在しており evidence-matrix.md 参照 — 「短いほどよい」の定量的裏付けは弱く、
  「不要な内容は害になりうる」までが言えること。
conditions: [常時読み込まれるプロジェクト指示]
exceptions: [セキュリティ上毎回提示すべき注意, 組織の管理ポリシー]
verdict: ADOPT
destination: references/decision-rules.md
test_cases: [1, 7]
```

```yaml
claim_id: C-BOTH-002
title: AGENTS.md を正本、CLAUDE.md を @AGENTS.md ラッパーにする
source_type: official
product: both
source_date: 2026-07
verified_date: 2026-07-31
claim: >
  共通ルールは AGENTS.md に置き、CLAUDE.md は @AGENTS.md + Claude 固有差分のみとする。
  これで Codex（AGENTS.md 連結）と Claude Code（CLAUDE.md チェーン）の両方が
  同一の正本を読む。
evidence: >
  references/claude-code-spec.md（AGENTS.md への対応方法の公式案内）と
  references/codex-spec.md（探索順序）。二重管理の分岐は detect_conflicts.py の
  duplication / import-wiring 検出で防ぐ。
conditions: [Claude Code と Codex を併用するリポジトリ]
exceptions: [どちらか一方しか使わないなら、そのツールのネイティブ形式だけでよい]
verdict: ADOPT
destination: templates/, references/decision-rules.md
test_cases: [8, 12]
```

```yaml
claim_id: C-BOTH-003
title: AGENTS.md は最小3セクション（Overview/Commands/Boundaries）から始めて段階的に育てる
source_type: article
product: both
source_date: 2026-03-24
verified_date: 2026-07-31
claim: >
  新規の AGENTS.md は Project Overview / Commands / Boundaries の最小構成から始め、
  初期ルールは5〜10個に絞り、必要が実証されたセクション（Code Style / Testing / Git /
  Where things are）だけを追加する。コマンドはオプション込みの全体を書き、単一テスト
  実行コマンドを必ず含める。規約は文章よりコード例で示す。
evidence: >
  Qiita「AGENTS.md完全入門」(@nogataka, 2026-03-24,
  https://qiita.com/nogataka/items/ad15bfa383c98ae5cc36)。記事の一次ソースは
  GitHub Blog「How to write a great agents.md — lessons from over 2500 repositories」
  （原典未精読 — 数値引用はしない）。「書きすぎは遵守率を下げる」は
  Gloaguen 論文の「無関係な内容は害」（C-RESEARCH-002）と整合。
  Boundaries セクション（.env 不可侵・確認要求）は Claude Code Issue #2142 の
  失敗事例とも整合（ただし散文は強制でない — hooks 併用が前提）。
conditions: [新規に AGENTS.md を書き起こすとき]
exceptions: [破壊的変更コストが高い基盤系では最初から厚い規定が正当（openai/codex 322行の実例）]
verdict: CONDITIONAL   # C層実践記事のため。テンプレート構成として採用済み
destination: templates/AGENTS.template.md, templates/nested-AGENTS.template.md, references/playbooks.md
test_cases: [1, 3]
```

```yaml
claim_id: C-CLAUDE-001
title: "@import されたファイルも起動時コンテキストへ展開される"
source_type: official
product: claude-code
source_date: 2026-07
verified_date: 2026-07-31
claim: >
  CLAUDE.md から @path で取り込んだファイルは起動時にコンテキストへ入る
  （公式: "doesn't reduce context, since imported files load at launch"）。
  ファイル分割はコンテキスト削減にならない。削減になるのは常時指示から
  オンデマンド読み込みへ移すことだけ。再帰は最大4ホップ、相対パスは
  インポート元ファイル基準。
evidence: references/claude-code-spec.md（code.claude.com/docs/en/memory 原文引用）。scripts/measure_context.py で実測可能。
conditions: [CLAUDE.md の @import]
exceptions: []
verdict: ADOPT
destination: references/decision-rules.md, scripts/measure_context.py
test_cases: [7]
```

```yaml
claim_id: C-CLAUDE-002
title: サブディレクトリの CLAUDE.md は起動時でなくオンデマンドでロードされる
source_type: official
product: claude-code
source_date: 2026-07
verified_date: 2026-07-31
claim: >
  作業ディレクトリの祖先の CLAUDE.md は起動時に連結ロードされるが、
  作業ディレクトリ配下のサブディレクトリのものは、そのディレクトリの
  ファイルに触れた時点でロードされる。
evidence: references/claude-code-spec.md（メモリ仕様）
conditions: [モノレポでのネスト配置設計]
exceptions: []
verdict: ADOPT
destination: scripts/measure_context.py（root→cwd のみ数える根拠）
test_cases: [12]
```

```yaml
claim_id: C-CODEX-001
title: project_doc_fallback_filenames はチーム標準の代替にならない
source_type: official
product: codex
source_date: 2026-07
verified_date: 2026-07-31
claim: >
  CLAUDE.md を Codex に読ませる fallback 設定は「AGENTS.md が無いディレクトリ」での
  代替でしかなく、ユーザー個人の設定に依存する。チーム標準は AGENTS.md 正本で担保する。
evidence: references/codex-spec.md（設定仕様の確認結果）
conditions: [チームで共有するリポジトリ]
exceptions: [個人リポジトリで CLAUDE.md しか無い場合の暫定運用]
verdict: ADOPT
destination: templates/codex-config.template.toml
test_cases: []
```

```yaml
claim_id: C-CODEX-002
title: Codex は symlink されたスキルフォルダをサポートする
source_type: official
product: codex
source_date: 2026-09-12 確認
verified_date: 2026-09-12
claim: >
  Codex はスキル探索時にフォルダの symlink 先をたどる。
  .agents/skills 実体 / .claude/skills リンクという Kairos の正本配置は維持するが、
  旧不具合を理由に逆方向を普遍的に禁止しない。
evidence: >
  https://learn.chatgpt.com/docs/build-skills の Where Codex loads local skills。
  旧 #8943 / #8369 / #11314 / #9898 は過去の不具合報告として扱う。
conditions: [Codex のスキル探索対象フォルダ]
exceptions: [特定版やリンク形状で問題を再現した場合は、その条件を分けて扱う]
verdict: ADOPT
destination: references/codex-spec.md, references/decision-rules.md
test_cases: [15]
```

```yaml
claim_id: C-RESEARCH-001
title: 指示ファイルの効果は一方向でない — 対象リポジトリで測る
source_type: research
product: both
source_date: 2025-2026
verified_date: 2026-07-31
claim: >
  「AGENTS.md があるほどよい」も「無いほうがよい」も一般には言えない。
  成功率低下・コスト増を報告する研究と、時間・トークン削減を報告する研究が併存する。
  採用判断は対象リポジトリでの A/B 評価（evals/）で行う。
evidence: references/evidence-matrix.md（各研究の実験条件と数値、原典確認状況）
conditions: [効果を主張したいすべての場面]
exceptions: []
verdict: ADOPT
destination: references/evidence-matrix.md, evals/evals.json
test_cases: [全ケース（A/B 比較の設計そのもの）]
```

```yaml
claim_id: C-RESEARCH-002
title: LLM 生成の汎用リポジトリ概要は書かないほうがよい
source_type: research
product: both
source_date: 2026-02
verified_date: 2026-07-31
claim: >
  LLM が自動生成した指示ファイルは成功率を平均約3%下げ、コストを20%超増やす。
  人間が書いたものは平均約4%改善。汎用的な概要記述を除去すると平均+2.7%改善。
  よって生成時は「マニフェスト・CI から検証できた事実だけ」を書き、
  埋め草の概要文を生成しない。
evidence: arXiv:2602.11988（プレプリント・未査読、references/evidence-matrix.md）
conditions: [ガイダンスの自動生成]
exceptions: []
verdict: CONDITIONAL   # プレプリントのため。ただし本スキルの生成方針としては採用
destination: references/decision-rules.md（作業順序）, SKILL.md Step 1
test_cases: [1, 2]
```


```yaml
claim_id: C-CODEX-003
title: 発動条件を短くし、作業に無関係な固定手順を減らす
source_type: official
product: codex
source_date: 2026-09-12 確認
verified_date: 2026-09-12
claim: >
  description は用途と発動場面を短く示す。常時指示には固有の判断材料を残し、
  長いモード別手順を必要時に読む参照へ移す。既存の認可を尊重し、依頼された終点を
  明確にする。行数削減から成功率やコスト改善を断定しない。
evidence: >
  https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra
  および現行 skill-creator の指針。Kairos の本文・参照・構造の前後比較を実施。
conditions: [既存ガイダンスとスキルの整理]
exceptions: [固有の安全条件, ユーザーの意図, 壊れやすい操作の必要な順序]
verdict: ADOPT
destination: SKILL.md, references/decision-rules.md, references/playbooks.md
test_cases: []  # 行動の A/B 評価は未実施。構造確認と独立差分レビューのみ。
```
