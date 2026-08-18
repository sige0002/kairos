<!-- agent-guidance-architect: サブディレクトリ（パッケージ）用 AGENTS.md テンプレート。
     ルートに書いた内容は繰り返さない — Codex はルートからこのディレクトリまでを
     連結して読むため、ここには「このパッケージで上書き・追加する差分」だけを書く。
     セクション名はルートと同じ語彙（Commands / Code Style / Testing / Boundaries）を
     使い、差分のないセクションは置かない。実例のネストファイルは数行〜20行程度。
     このコメントは削除する。 -->
# {{package-name}}

## Commands

- {{このパッケージ固有の検証コマンド: 例 `cargo test -p backend` / `pnpm --filter frontend test`}}

## Boundaries

- {{このパッケージ固有の制約: 例 このクレートは no_std を維持する}}
