---
name: github-issue-pr
description: 明示依頼された GitHub issue の作成・対応から PR・独立レビュー・マージまでを扱う。issue だけなど限定された依頼はその工程で止める。
---

# GitHub issue / PR 対応

ユーザーが issue 作成・対応を明示的に依頼したときに使う。自分で問題を見つけただけでは公開issueを作らない。依頼された工程と既存の認可を確認し、commit・push・PR・merge・サービス起動を勝手に追加しない。一気通貫の依頼では認可済み工程を繰り返し確認せず完了まで進める。

認証済み`gh`または利用可能なGitHubツールを使う。認証は`gh auth status --hostname <remote-host>`で確認し、Gitの認証失敗だけで未ログインと判断しない。HTTPSのgithub.com remoteでhelperが失敗した場合は、認可済みpushに限り`gh auth git-credential`を使う一度だけの再試行をしてよい。永続的な認証設定変更、トークン表示、根拠のない再ログイン要求はしない。

Kairosはpublic。本文・タイトル・ブランチ名・コミットメッセージに [no-confidential-names](../no-confidential-names/SKILL.md) を適用し、公開文章は英語で書く。複数行本文は構造化引数、または本文ファイルを`--body-file`へ渡す。

## issue の分類

issueには1つ以上のラベルを付ける。

| ラベル | 意味 |
|---|---|
| `bug` | 実装が正しい仕様・期待と食い違う |
| `documentation` | 実装は正しく、文書・コメントが誤りまたは欠落 |
| `enhancement` | 新機能や既存機能の改善 |

仕様と実装が違う場合、どちらを正とするか根拠を確認してラベルを選ぶ。複合なら複数ラベルを使う。既存ラベルを確認し、必要なラベルがなければissue作成の認可範囲で用意する。本文には問題の根拠、対処案、完了条件を含める。

## 実装と PR

- 並列作業はworktreeで隔離し、`origin/develop`から作業ブランチを作る。prefixは`fix/`、`docs/`、`feat/`をラベルに合わせる。
- 依頼の実装と関連ゲートを完了し、必要な日英文書を同期する。commit/push前のstaging・機密検査は [review-publish-run](../review-publish-run/SKILL.md) の該当工程を使う。
- PRのbaseは`develop`、ラベルはissueと合わせる。`Closes #N`は残すが、`develop`へのマージでは自動closeに頼らない。

## 独立レビュー

PRの対象diffとタスクを独立したread-onlyレビュワーへ渡す。編集・commit・pushは任せず、必要な検証だけを許可する。所見は重大度順にfile:line、失敗シナリオ、実証済みか仮説かを示し、`MERGE` / `FIX-FIRST`のverdictを求める。

修正後は影響する検証と同じレビュワーの再確認を行う。未解決のblocking findingがある間はマージせず、証拠不足や同じ失敗で進めなくなったら理由を報告する。独立レビュー不能なら、マージゲート未完了としてその制約を明示する。

## 認可されたマージと後始末

`gh pr merge <N> --squash`後、`gh pr view <N> --json state,mergeCommit`で確認する。`--delete-branch`はbaseが別worktreeにあるとローカル操作だけ失敗するため、マージ成功を確認してから対象のリモートブランチを別途削除する。issueはPRとsquash SHAを示して明示的にcloseする。

worktreeは対象変更がpush済み・マージ済み・cleanであることを確認してから外す。本体checkoutの更新やサービスのrebuild / 起動は、その操作も依頼されている場合だけ行う。ローカル`CHANGELOG.md`に必要な変更を記録し、完了した工程とURL / SHAを報告する。
