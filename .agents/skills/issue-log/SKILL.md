---
name: issue-log
description: 作業で得た問題と解決策をローカルの issue/ に短く記録・更新する。既知の解決策を探すときにも使う。
---

# Issue log

`issue/issue_N.md` はコミットしないローカル知識ベース。既存の問題は更新し、
新しい問題は最新ファイルの末尾へ追記する。1 エントリ = 1 問題。

まず見出し・タグや具体的なキーワードで候補を探し、必要な本文だけを読む。

```bash
rg -n '^## |^area:|^kind:' issue/issue_*.md
rg -n -i '<keyword>' issue/issue_*.md
```

## 形式

各ファイルの冒頭に `# Issue log (issue_N)` と
`area 一覧: <component names>, infra, repo` を置く。
`area` はリポジトリの区画名から選ぶ統制語彙。新しい語は一覧へ先に追加する。

```markdown
## <エラー・関数・仕組みなどで検索できるタイトル> (YYYY-MM-DD)

**問題**: <2行以内>

**解決**: <原因と対処を5行以内>

area: <冒頭一覧から1つ以上、カンマ区切り>
kind: <下記から1つ>
```

`kind`: `bug` / `perf` / `build` / `config` / `test` / `git` / `experiment` / `docs`。
固有の検索語はタイトルか本文に置き、タグを増やさない。
未解決なら暫定対処と未解決である旨を「解決」へ書く。

最新ファイルが 200 行を超えたら次の `issue_(N+1).md` に分け、area 一覧を引き継ぐ。
初回は保存先が gitignored であることを確認する。リポジトリ設定の変更が依頼範囲に
なければ、ログ作成のためだけに `.gitignore` を書き換えない。
