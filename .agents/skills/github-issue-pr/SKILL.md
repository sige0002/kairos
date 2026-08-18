---
name: github-issue-pr
description: ユーザーが「このバグ/機能リクエスト/改善点/ドキュメント不備を issue にして対処して」と明示的に指示したときだけ発火する、GitHub issue → worktree ブランチ → 実装 → PR → 独立エージェントレビュー → squash マージ → 後始末の一気通貫フロー。種類は問わない（バグ限定ではない） — 発火条件は「issue にして」という明示指示の有無であり、種類はラベル（bug / documentation / enhancement）の判定に使う。issue には必ずラベル（bug / documentation / enhancement を軸に区別）を付ける。操作は gh CLI（認証済み）を基本とし、GitHub MCP server が接続されていればそのツールでもよい。自分がバグを見つけただけでは発動しない（報告して指示を待つ）。
---

# github-issue-pr

GitHub issue を起点に PR マージまでを一気通貫でやるときの標準手順。
2026-08-12 の clock_check 出荷（issue #6 → PR #7）で確立・実証済みのフロー。

## 発火条件（重要）

- **ユーザーの明示的な指示があるときだけ**発火する。例:
  「この問題を issue にして対処して」「この機能が欲しい。issue にして実装まで」
  「issue 作成 → PR → レビュー → マージまでやって」。
- **種類は問わない** — バグ・機能リクエスト・改善提案・ドキュメント不備のどれでも、
  「issue にして」という指示があれば発火する。種類は手順 1 のラベル判定にだけ使う。
- 作業中に自分がバグや改善点を**見つけただけでは発動しない** — 見つけたものは
  ユーザーに報告し、指示を待つ（勝手に issue を作らない。public リポジトリへの
  書き込みは公開行為）。
- issue 作成だけ・PR だけなど、指示が一部の工程に限られる場合はそこまでで止める。

## 使うツール

- 基本は認証済みの **`gh` CLI**。接続済みGitHubアプリ／MCPの利用可能なツールが
  あればissue・PRの読み書きに使ってよい。特定環境のツール名は前提にしない。
- リポジトリは **public**。issue・PR・コミットの全テキストが即座に公開される —
  **no-confidential-names を issue 本文・タイトル・PR・ブランチ名にも適用**する
  （機体は「the local robot」等の一般名で書く）。文章は英語（コード・コミット規約と同じ）。

## 手順

### 1. ラベルを決めてから issue を作る

issue には**必ず 1 つ以上のラベル**を付ける。軸は次の 3 つ（GitHub 既定ラベル）:

| ラベル | 判定基準 |
| --- | --- |
| `bug` | 実装の動作が仕様・ユーザーの期待と食い違う（クラッシュ・誤動作・嘘の表示） |
| `documentation` | 仕様書 / README / ミラー / コメントの欠落・誤り・陳腐化（コードの動作は正しい） |
| `enhancement` | 新機能・新しい検証・既存機能の改善（壊れてはいない） |

- **bug と documentation は必ず区別する**。「仕様と実装が食い違う」場合は
  どちらが正か先に裁定してからラベルを選ぶ（実装が正 → documentation、仕様が正 → bug）。
- 複合なら複数ラベル可。`gh label list` で確認し、無いラベルは `gh label create` してから使う。
- 本文の骨子: Problem（何がどう困るか・再現/根拠）→ Proposal（対処案）→ Acceptance（完了条件）。

```bash
gh issue create --title "..." --label bug --body "..."
```

### 2. worktree + ブランチ

並列セッションと衝突させないため、実行環境のworktree機能または
`git worktree add` で隔離し、ブランチを **origin/developから**作る：

```bash
kairos_worktree_root=$(mktemp -d)
kairos_worktree_path="$kairos_worktree_root/worktree"
git worktree add -b <prefix>/<slug> "$kairos_worktree_path" origin/develop
cd "$kairos_worktree_path"
```

prefix はラベルに合わせる: `bug`→`fix/`、`documentation`→`docs/`、`enhancement`→`feat/`。

### 3. 実装 + ゲート

- AGENTS.md の規約どおり（テスト先行・変更最小・仕様は ja 正本 + `/sync-docs` で en ミラー）。
- 該当パッケージの pytest / frontend gate / `uvx ruff check` + `format --check` を通す。
- コミット前に正規ゲートを実行する。スクリプトは全worktreeからgitignoredの
  名前候補を導出するため、リンクworktree内からそのまま実行できる：

```bash
bash .agents/skills/no-confidential-names/check.sh origin/develop..HEAD
```

### 4. PR

```bash
git push -u origin <branch>
gh pr create --base develop --title "..." --body "... Closes #N ..."
gh pr edit <PR> --add-label <issueと同じラベル>
```

- base は **develop**（main へは別途 promote）。
- `Closes #N` は **develop へのマージでは auto-close されない**（後で手動 close）。

### 5. 独立エージェントレビュー

利用可能な協調ツールで**クリーンコンテキストのレビュワー**を起動し、敵対レビューさせる。
プロンプトの骨子:

- 「PR を**反証**しにいけ（褒めるな）」。worktree パスと `gh pr diff <N>` を渡す。
- read-only（編集・commit・push 禁止）。テスト実行は許可。
- 出力: severity 順の所見（file:line + 具体的な失敗シナリオ + verified/conjecture）、
  「攻めたが破れなかった項目」、**MERGE / FIX-FIRST の明示 verdict**。
- FIX-FIRST の間は: 修正 → 全ゲート → commit/push → **同じレビュワーに SendMessage で
  再検証依頼**（コンテキストが残っているので独自ハーネスで再実証できる）。
  MERGE が出るまで繰り返す。所見への対応は PR にコメントで記録する。

### 6. マージ + 後始末

```bash
gh pr merge <N> --squash        # --delete-branch は付けない（下記）
gh api -X DELETE repos/<owner>/<repo>/git/refs/heads/<branch>   # リモートブランチ削除
gh issue close <issue> --comment "Implemented in #<PR> (squash <sha>)."
```

- `--delete-branch` は **base（develop）が別 worktree でチェックアウト済みだと
  ローカル操作で失敗する**（リモートのマージ自体は成功している）ので、ブランチ削除は
  API で行う。マージ状態は `gh pr view <N> --json state,mergeCommit` で確認。
- マージ状態、push済み、worktreeがcleanであることを確認してから、実行環境の
  worktree削除機能または `git worktree remove <path>` で作業treeを外す。
- 本体チェックアウトで `git pull` → 必要なサービスを `make rebuild <svc>` → 可能なら
  実データ/実 UI で 1 回動かして着地を実証する。
- CHANGELOG（ローカル・コミットしない）の `## [Unreleased]` に追記。

## しないこと

- 指示なしの issue 作成・PR 作成・マージ（各工程とも Git 規則が優先）。
- レビュワー verdict が FIX-FIRST のままのマージ。
- ラベル無し issue。bug / documentation の未裁定のままのラベル付け。
