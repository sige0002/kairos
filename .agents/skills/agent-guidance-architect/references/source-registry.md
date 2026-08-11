# Source Registry — 調査コーパスの定義

「全記事」を無制限に集めない。情報源を4層に分類し、**層ごとに使い方を変える**。
新しい情報を取り込むときは、まずどの層かを判定してから claim-ledger.md へ変換する。

| 層 | 情報源 | 使い方 | 有効期限の扱い |
|---|---|---|---|
| A: 公式仕様 | Claude Code 公式ドキュメント（`code.claude.com/docs/en/*` — 旧 docs.claude.com は 301）、OpenAI Codex 公式（developers.openai.com/codex → `learn.chatgpt.com` へ 308。引用時は両 URL 併記）、Agent Skills 仕様（agentskills.io）、公式リポジトリの実例 | 「現在の仕様」の確認。spec ファイルの唯一の根拠 | 更新が速い。verified_date 必須、3か月で再確認。**ドキュメントのホスト自体も移転する**（左記2件とも2026年に移転済み） |
| B: 実装・障害情報 | anthropics/claude-code Issues、openai/codex Issues、公式リポジトリの実 CLAUDE.md/AGENTS.md、両者の Changelog | 「現実に起きている制約・バグ」。仕様と挙動の乖離の検出 | Issue 番号・open/closed・日付を必ず記録 |
| C: 実践記事 | Zenn / Qiita / 技術ブログ / Gist / Medium / Speaker Deck / 実運用記録 | 「うまくいった運用仮説」。そのまま採用せず claim 化して査定 | 執筆時のバージョンを確認。仕様変更で OBSOLETE になりやすい |
| D: 研究 | arXiv 等の指示ファイル有効性評価、トークン/実行時間影響、アンチパターン調査、Agent Skills 設計論 | 「一般化できるか」の判断材料。実験条件の確認が必須 | evidence-matrix.md で原典確認状況を管理 |

## 取り込み手順

1. 層を判定する
2. C・D 層は `security/prompt-injection-scan` の観点は不要だが、**主張の原典**を確認する
   （D 層で原典に当たれないものは evidence-matrix.md に「原典未確認」と記録し、
   設計判断の根拠にしない）
3. claim-ledger.md の形式へ変換し、査定基準（SKILL.md）で採点する
4. ADOPT / CONDITIONAL のみ decision-rules.md / anti-patterns.md / templates/ へ反映する
5. 反映した claim には evals.json のテストケース id を紐づける（検証不能な claim は
   EXPERIMENT 止まり）

## 層を混同しない

- C 層の記事が「公式が推奨」と書いていても、A 層で裏取りできるまで official 扱いしない
- B 層の Issue に基づく回避策は、Issue が closed になったら OBSOLETE 判定を検討する
- D 層の数値は実験条件（モデル・ベンチマーク・リポジトリ）ごと記録する。
  条件を外した数値の引用は禁止
