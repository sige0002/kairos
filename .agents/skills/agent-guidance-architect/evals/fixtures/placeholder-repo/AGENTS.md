<!-- agent-guidance-architect: 共通ルールの正本テンプレート（リポジトリルート用）。
     {{...}} を実際の値へ置換し、該当しないセクションは削除、このコメントも削除する。
     最小構成は Project Overview + Commands + Boundaries の3セクション — まず小さく
     始め、必要が実証されたセクション（Code Style / Testing / Git / Where things are）
     だけを足す。初期ルールは5〜10個程度に絞る（書きすぎは遵守率を下げる）。
     原則: 毎セッション必要な・検証済みの事実だけを書く。手順書は Skill へ、
     ツールで強制できる規則はリンタ/CI へ。ツール固有機能（@import・Plan Mode 等）は
     ここに書かず CLAUDE.md / .codex/ へ。
     サイズ: 公式（Anthropic）の目標は200行未満。Codex は連結32KiBで打ち切る。 -->
# Project Instructions

## Project Overview

{{1〜3行。何のリポジトリか・主要言語/フレームワーク・構成。検証できた事実のみ書く。
例: TypeScript + React 18 の Web アプリ。バックエンドは Node.js + Express、
DB は PostgreSQL + Prisma ORM、テストは Vitest + Playwright。}}

## Commands

<!-- コマンドは省略せずオプション込みの全体を書く。実際に実行して通ったものだけ -->
- 依存導入: {{例 `pnpm install`}}
- リント / 型検査: {{例 `pnpm lint` / `pnpm typecheck`}}
- 全テスト: {{例 `pnpm test`}}
- 単一テスト: {{例 `pnpm test -- path/to/test.ts` — 変更箇所だけ回せる形で必ず書く}}
- ビルド: {{例 `pnpm build`}}

## Code Style

<!-- リンタ/フォーマッタで強制できる規則（インデント・クォート・import順 等）は
     ここに書かず設定ファイルへ。ツールで強制できない設計上の規約だけを、
     できれば短いコード例つきで書く -->
- {{例: 状態管理は useState/useReducer を優先。グローバル状態は Zustand}}
- {{例: API 呼び出しは src/lib/api/ 配下に集約する}}

## Testing

- {{例: テストファイルは対象と同一ディレクトリに *.test.ts で配置}}
- {{例: 外部 API は必ずモック化する（vi.mock()）。E2E は tests/e2e/ に Playwright}}

## Git

- {{例: コミットメッセージは Conventional Commits（feat:/fix:/docs:/refactor:/test:/chore:）}}
- {{例: ブランチ名は feature/xxx・fix/xxx。PR はテストを通してから作成}}

## Boundaries

<!-- エージェントがやってはいけないこと。破られると危険な操作はここの宣言に加えて
     hooks / permissions / CI でも止める（散文は強制にならない） -->
- `.env*` ファイルを変更・コミットしない
- 関係のないファイルを変更しない。既存のユーザー変更を削除しない
- 推測だけで修正せず、実装を確認する
- {{例: vendor/・自動生成ディレクトリを編集しない}}
- {{例: DB マイグレーションを自動実行しない。本番設定の変更は必ず確認を求める}}

## Where things are

<!-- エージェントが毎回探し直す場所だけを表で。全ディレクトリの説明は書かない -->
| 場所 | 役割 |
|---|---|
| {{例 config/}} | {{例 3層設定（default → env → local）。ハードコード禁止}} |
| {{例 .agents/skills/}} | {{例 リリース・マイグレーション等の詳細手順スキル}} |
