# 振り分け判定ルール — 「どの知識をどこに書くか」

このスキルの中核。リポジトリから抽出した各ルール・手順・事実を、以下の判定木で配置先へ振り分ける。

## 判定木

各項目について上から順に判定し、最初に該当した行き先へ置く。

```
1. 機械的に強制できるか？（フォーマット・リント・型・テスト）
   → リンター/フォーマッター設定 + CI。ガイダンスには書かない
     （書くと Lint Leakage。散文は強制力を持たない）

2. 破ってはならない操作か？（force push 禁止、本番 DB 接続禁止など）
   → Claude: hooks / settings.json permissions（deny）
   → Codex: sandbox / approval 設定 + CI ガード
   → ガイダンスには「なぜ禁止か」の1行だけ残してよい

3. 毎セッション必要な事実か？（リポジトリ概要・検証コマンド・変更方針）
   → 両ツール共通なら AGENTS.md（正本）
   → 片方のツールでしか意味を持たないなら:
      Claude だけ → CLAUDE.md（@AGENTS.md の下に追記）
      Codex だけ → .codex/ 配下
   目安: 「これを知らないエージェントは最初の10分で必ず間違えるか？」
   Yes なら常時指示。No なら次へ

4. 特定の作業でだけ必要な複数ステップ手順か？（リリース、マイグレーション、環境構築）
   → Skill（SKILL.md + 必要なら scripts/）。常時指示には1行のポインタのみ
     （インラインに書くと Skill Leakage）

5. 特定の話題でだけ必要な長い知識か？（API 仕様、設計経緯、FAQ）
   → Skill の references/ または docs/。常時指示に書くと Context Bloat

6. 特定のディレクトリでだけ必要か？
   → そのディレクトリの AGENTS.md（+ CLAUDE.md ラッパー）
   ルートに書くと全作業でコンテキストを消費する
```

## ツール間の対応表

| 目的 | Claude Code | Codex | 共通化 |
|---|---|---|---|
| 常時プロジェクト指示 | CLAUDE.md（チェーン＋@import、最大4ホップ） | AGENTS.md（root→cwd 連結、計32KiB上限） | AGENTS.md を正本、CLAUDE.md は `@AGENTS.md` ラッパー（Claude 固有差分が無ければ `ln -s AGENTS.md CLAUDE.md` も公式に可・Windows 除く） |
| ディレクトリ別指示 | サブディレクトリの CLAUDE.md | サブディレクトリの AGENTS.md | 両方置く（CLAUDE.md は1行ラッパー） |
| オンデマンド手順 | .claude/skills/（symlink 公式サポート） | .agents/skills/（symlink に既知バグ #8943 等） | **正本を .agents/skills/ に置き、.claude/skills/ から symlink**（逆方向は Codex で読まれない恐れ） |
| 操作の強制 | hooks / permissions | sandbox / approval + CI | CI・pre-commit が最も移植性が高い |
| サブエージェント | .claude/agents/*.md | .codex/agents/*.toml | 役割定義の本文を共有し、フロントマター/TOML はツール別に生成 |
| 個人ローカル設定 | CLAUDE.local.md / settings.local.json | ~/.codex/config.toml | 共有しない（コミットしない） |

## 「常時指示に残してよいもの」のサイズ目安（出典つき）

行数の**公式数値は Anthropic の「200行未満を目標」のみ**（code.claude.com/docs/en/memory、
2026-07-31 確認）。OpenAI 公式に行数推奨はなく、あるのは連結 32KiB の打ち切り上限だけ。
audit_guidance.py の機械閾値（200行 MEDIUM / 400行 HIGH）はこの公式値と
Configuration Smells 調査（arXiv:2606.15828 の 200 行閾値）に合わせてある。

- 生成時は行数を目標にせず、**「マニフェスト・CI から検証できた事実」だけを書く**。
  その結果は実例だと小さくなることが多い（実測: anthropic-sdk-typescript 9行、
  claude-agent-sdk-python 27行、turborepo 76行）が、破壊的変更コストが高い
  基盤系では重量級も実在する（openai/codex 自身は322行、rustfs 約307行）
- 200行を超えたら振り分け判定をやり直す（公式警告ライン）
- ネスト AGENTS.md: ルートとの重複は削除し差分のみ（Codex は連結して読む。
  実例のネストファイルは数行〜20行程度）
- 「短いほど良い」の実証的根拠は弱い（サイズの統制実験は null result —
  evidence-matrix.md）。判定基準は行数でなく「毎セッション必要か」
- 合計トークン: `scripts/measure_context.py --budget` で測る。数千トークンを超えたら要分割
- Codex は連結後 32KiB で黙って打ち切る（超えるとネストの AGENTS.md が読まれなくなる）
- ただし行数は代理指標にすぎない。判定基準はあくまで「毎セッション必要か」。
  「短いほど良い」の実証的根拠は弱く、支持されるのは「無関係な内容を書かない」
  （特に LLM 生成の汎用リポジトリ概要は成功率を下げる — evidence-matrix.md）
- 大規模モノレポで無関係チームの CLAUDE.md が混ざる場合は `claudeMdExcludes` 設定で除外できる

## 過剰分割の禁止

分割自体が目的ではない。以下は常時指示に残す：

- 1行で書けるビルド/テストコマンド（Skill へ移すと逆に発見性が下がる）
- 変更方針の短い箇条書き
- セキュリティ上、毎回必ず提示すべき注意（例外として明示的に許す）

判定に迷ったら: 「このルールを削ったら、次のセッションでエージェントは実際に間違えるか？」
実測で答える（evals/ の A/B 比較）。想像で答えない。

## 生成時の作業順序

1. リポジトリ調査: マニフェスト（Cargo.toml / pyproject.toml / package.json / package.xml）、
   CI 設定（.github/workflows）、既存ガイダンス、README を読む
2. 「実際に動く」検証コマンドを特定する（マニフェスト・CI に書かれているものを正とし、
   既存ガイダンスの記述はドリフトしている前提で照合する）
3. 抽出した各ルールを判定木で振り分ける
4. templates/ から生成し、`scripts/build_report.py` で監査する
5. 監査が REWORK / CONDITIONAL なら修正して再監査
6. 生成物のコマンドを実際に実行して検証する（動かないコマンドを常時指示に書かない）
