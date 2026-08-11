---
name: tdd-python
description: テスト駆動開発（TDD）で Python モジュールを実装するための標準手順。新しいモジュールを作るとき、テストを先に書きたいとき、pytest でのテスト設計パターンやカバレッジ目標が必要なときに使用する。SQLite（sqlite3 標準ライブラリのみ・FTS5・Upsert）の TDD パターンは references/sqlite-patterns.md を参照。
---

# TDD Python モジュール実装

## 概要

テスト駆動開発（TDD）で Python モジュールを新規実装するときの標準手順。テストを先に書くことで、実装の仕様が明確になり、リグレッションを防げる。

SQLite で DB 層を TDD 実装する場合（FTS5 全文検索・Upsert・sqlite3 の mypy 対応）は `references/sqlite-patterns.md` を参照せよ。

## 手順

### Step 1: テストファイルを先に作成

```
tests/test_{module_name}.py
```

テストの構成（この順序で書くことで、正常系の理解 → 境界の把握 → 異常系の網羅と段階的に検証できる）：

- `_make_{entity}(**kwargs)` ヘルパー関数でテストデータ生成（fixture より柔軟に個別テストでパラメータを変更できる）
- クラスベースのテストグループ（`class Test{Feature}:`）で関連テストをまとめる
- **正常系 → 境界値 → 異常系** の順で網羅

### Step 2: 実装ファイルを作成

```
{package}/{module_name}.py
```

実装の原則：

- `from __future__ import annotations` を先頭に（型アノテーションの前方参照を有効化）
- 型アノテーション必須（mypy strict 対応）
- ログ: `logger = logging.getLogger(__name__)` で統一的なログ出力
- docstring: 全 public 関数に記述

### Step 3: 検証（3段階）

段階的に検証する理由は、問題の切り分けを容易にするため。

```bash
# 1. 対象テストのみ（実装の正しさを確認）
uv run pytest tests/test_{module_name}.py -v --tb=short

# 2. 全テストでリグレッション確認（他モジュールへの影響がないことを確認）
uv run pytest tests/ -v --tb=short

# 3. 型チェック（型の整合性を確認）
uv run mypy {package}/{module_name}.py --ignore-missing-imports
```

## よく使うフィクスチャパターン

### tmp_path ベースの DB

テストごとに独立した一時ディレクトリが提供されるため、テスト間の干渉がない。

```python
@pytest.fixture
def db(tmp_path):
    return MyDatabase(tmp_path / "test.db")
```

### Mock API クライアント

外部サービスへの依存をモックで切り離し、テストを高速かつ安定にする。

```python
@patch("module.path.ExternalClient")
def test_with_mock(MockClient, tmp_path):
    mock = MockClient.return_value
    mock.method.return_value = expected_data
```

### ファイル I/O（副作用のモック化）

ネットワークアクセスやファイルダウンロードをモック化し、テスト環境内で完結させる。

```python
@patch("module.urllib.request.urlretrieve")
def test_download(mock_retrieve, tmp_path):
    def fake(url, filename):
        Path(filename).write_bytes(b"content")
        return filename, {}
    mock_retrieve.side_effect = fake
```

## カバレッジ目標

- 新規モジュール: **90% 以上**（新しいコードは十分にテストされるべき）
- プロジェクト全体: **80% 以上**（既存コードとの総合バランス）

## チェックリスト

- [ ] テストが先に書かれている
- [ ] 全テストがパスする
- [ ] リグレッションなし（全テスト）
- [ ] mypy 0 エラー
- [ ] docstring 完備
