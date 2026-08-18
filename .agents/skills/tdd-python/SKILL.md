---
name: tdd-python
description: テスト駆動開発（TDD）で Python モジュールを実装するための標準手順。新しいモジュールを作るとき、テストを先に書きたいとき、pytest でのテスト設計パターンやカバレッジ目標が必要なときに使用する。SQLite（sqlite3 標準ライブラリのみ・FTS5・Upsert）の TDD パターンは references/sqlite-patterns.md を参照。
---

# TDD Python モジュール実装

## 概要

テスト駆動開発（TDD）で Python モジュールを新規実装するときの標準手順。テストを先に書くことで、実装の仕様が明確になり、リグレッションを防げる。

SQLite で DB 層を TDD 実装する場合（FTS5 全文検索・Upsert・sqlite3 の型付け）は `references/sqlite-patterns.md` を参照せよ。

## 手順

### Step 1: テストファイルを先に作成

リポジトリの既存テスト配置に従う。kairos では各 Python パッケージの
`tests/test_{module_name}.py` に置く。

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
- public interface に型アノテーションを付ける
- ログ: `logger = logging.getLogger(__name__)` で統一的なログ出力
- docstring: 全 public 関数に記述

### Step 3: 検証

AGENTS.md、CI、pyproject.toml から正準コマンドを確認し、対象テストから
パッケージ全体へ広げる。型チェックはプロジェクトに設定済みの場合だけ行う。

kairos では対象サービスのディレクトリから次を実行する：

```bash
uv run --extra test pytest -q tests/test_{module_name}.py
uv run --extra test pytest -q
# From the repository root:
uvx ruff check <changed-python-paths>
```

横断的な変更では `make test-py` と `uvx ruff format --check libs services`
も実行する。kairos は mypy を導入していないため、mypy をゲートにしない。

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

## カバレッジ

リポジトリに閾値が設定されていれば従う。閾値がなければ、正常系、境界値、
失敗・復旧経路をテストし、根拠のない一律パーセンテージを完了条件にしない。

## チェックリスト

- [ ] テストが先に書かれている
- [ ] 全テストがパスする
- [ ] リグレッションなし（全テスト）
- [ ] リポジトリで設定済みの型チェックがパスする
- [ ] public interface が既存のdocstring規約に従う
