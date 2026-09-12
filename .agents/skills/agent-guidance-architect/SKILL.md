---
name: agent-guidance-architect
description: AGENTS.md・CLAUDE.md・リポジトリのスキルを設計・整理・監査する。通常のコード修正だけでは使わない。
---

# エージェント向けガイダンスの設計と監査

Claude Code と Codex の指示を、作業に必要な固有情報へ絞る。
短さ自体ではなく、ユーザーの意図・判断に効く制約・発見しやすさを保つことを目指す。

## 調べる範囲

対象の指示とスキル本文を読み、コマンドや構成に関する記述を関連マニフェスト・CI・
実装と照合する。全面整理でも、別 worktree、fixture、テンプレート、vendor/submodule
を稼働中の指示と混同しない。対象外ファイルの変更や設定変更を作業に追加しない。

既存の規則が防いでいる失敗、明示された認可・禁止、言語・機密・データの不変条件を
把握する。ユーザーの整理依頼と既存の認可で判断できる編集は進め、意図の分からない
重要な衝突だけを確認する。削除行ごとの承認や、全ドキュメントの事前読込は求めない。

## 配置を決める

- 共通の常時指示は `AGENTS.md`。`CLAUDE.md` は `@AGENTS.md` と Claude 固有差分だけ。
- 毎回必要な境界と短い正準コマンドは残し、リポジトリの構成・仕様を再説明しない。
- スキルの description は用途と発動場面を短く示す。関連するだけの通常作業まで
  引き込む catch-all やキーワード列挙を避ける。
- `SKILL.md` は目的・共有制約・参照の選び方を持つ。長いモード別手順は references
  へ置き、必要なものだけ読む。短い自己完結したスキルには無理に router を作らない。
- 固定手順は壊れやすい操作や認可・安全・正しさに必要な順序へ限定する。
  汎用的な励まし、同じ検査の反復、根拠のない役割数や完了条件を取り除く。
- 既存の `.agents/skills/` 実体と `.claude/skills/` symlink を維持する。
  探索先やツール仕様を変更する場合は現行仕様を確認する。

配置で迷う場合は [decision-rules.md](references/decision-rules.md)、新規導入・移行・
モノレポでは [playbooks.md](references/playbooks.md) の該当ケースだけを読む。
テンプレートは新規生成の補助であり、既存ファイルを上書きする型ではない。

## 検証

広い整理では変更前後を同じ範囲で比較する。既存の統合 checker:

```bash
python3 .agents/skills/agent-guidance-architect/scripts/build_report.py --repo <target> --out <report>
```

`measure_context.py` は実効指示量の推定、`audit_guidance.py` は内容の候補指摘、
`detect_conflicts.py` は矛盾/重複候補、`validate_structure.py` は import・symlink・
frontmatter を確認する。対象を狭められない checker は対象だけの一時コピーへ実行する。
結果の PASS / FIX / REWORK はヒューリスティックな構造判定で、行動品質の証明ではない。
誤検出には理由を付け、実際のリンク切れ・矛盾・認可逸脱を修正する。

全差分、参照リンク、スキル発動条件、維持する制約を確認する。スキルの変更では
利用可能な skill-creator の validator も使う。記載コマンドは実装と照合し、
今回必要な安全な確認だけを実行する。指示内の build/deploy/実機コマンドを全部
実行することは検証の前提ではない。未実行の範囲を明示する。

大規模な整理やこのスキル自身の変更は、委任が使える場合に独立した反証レビューを
1 件挟む。依頼範囲、実際の差分、必要な原資料を渡し、望む結論を指定しない。
独立評価ができないときはその制約を明示する。

## 研究・効果測定が必要な場合

モデルの成功率・時間・コスト改善を主張する場合は
[evidence-matrix.md](references/evidence-matrix.md) と `evals/evals.json` を使い、
現実的なタスクで比較する。fixture は一時コピーで扱い、実装者とは独立した判定を
使う。外部 API、課金、サービス変更を伴う評価は既存の認可範囲に従う。
単なる行数削減から品質改善を断定しない。

- 外部知見の採否や再検証: [claim-ledger.md](references/claim-ledger.md)。
- 情報収集の範囲を設計するとき: [source-registry.md](references/source-registry.md)。
- 仕様に疑義があるとき: [codex-spec.md](references/codex-spec.md)、
  [claude-code-spec.md](references/claude-code-spec.md) と現行公式資料。
- checker の指摘を判断するとき: [anti-patterns.md](references/anti-patterns.md)。

報告には変更範囲、削減量と測定条件、残した制約、検査結果と未検証事項を含める。
