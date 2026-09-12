---
name: tdd-python
description: Python の新しい振る舞いや回帰修正をテスト先行で実装する。TDD の依頼と pytest のテスト設計に使う。
---

# Python のテスト先行実装

要求する振る舞いを失敗するテストで表し、失敗理由を確認してから実装する。
既存のテスト配置と fixture の流儀を使い、クラス化やヘルパー形式を一律に強制しない。
正常系に加え、変更が影響する境界値と失敗・復旧経路を選ぶ。
実装を写しただけのアサーションや、一律のカバレッジ目標は追加しない。

Kairos の Python テストは各パッケージの `tests/` に置く。
対象パッケージからの実行例:

```bash
uv run --extra test pytest -q tests/test_<module>.py
uv run --extra test pytest -q
```

対象テストが通ったら、変更の範囲に応じてパッケージ全体または `make test-py` で
回帰を確認する。Ruff と format-check は [AGENTS.md](../../../AGENTS.md) の入口を使う。
型チェックとカバレッジ閾値はリポジトリに設定済みのものだけをゲートにする。
Kairos に mypy は導入されていない。

時刻・外部 API・ファイル・DB をテストごとに制御し、実サービスや共有データへ
依存しない fixture を使う。公開 I/F の型と docstring は既存の規約に合わせる。
SQLite の FTS5 / Upsert / `sqlite3` の型を扱う場合だけ
[sqlite-patterns.md](references/sqlite-patterns.md) を読む。
