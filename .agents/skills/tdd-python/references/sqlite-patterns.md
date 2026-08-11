# SQLite + TDD パターン（Python 標準ライブラリのみ）

外部 ORM 依存なしで、sqlite3 標準ライブラリのみを使った DB 層の TDD パターン。ORM を使わない理由は、軽量さと透明性にある。SQL を直接書くことでクエリの意図が明確になり、デバッグも容易になる。

## スキーマ設計テンプレート

Database クラスの初期化で WAL モードと外部キー制約を有効化する。WAL モードは並行読み取り性能を向上させ、外部キー制約はデータ整合性を保証する。

```python
class Database:
    def __init__(self, db_path: Path | str | None = None) -> None:
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row  # dict-like アクセス
        self.conn.execute("PRAGMA journal_mode=WAL")  # 並行読み取り性能
        self.conn.execute("PRAGMA foreign_keys=ON")  # 外部キー制約有効化
        self._create_tables()
```

## FTS5 全文検索パターン

FTS5 は SQLite 組み込みの全文検索エンジン。content-sync モードを使うと、元テーブルとの同期をトリガーで自動化できる。

```sql
-- 仮想テーブル（content-sync モード）
CREATE VIRTUAL TABLE {table}_fts USING fts5(
    col1, col2, content={table}, content_rowid=id
);

-- 同期トリガー（INSERT）
CREATE TRIGGER {table}_ai AFTER INSERT ON {table} BEGIN
    INSERT INTO {table}_fts(rowid, col1, col2)
    VALUES (new.id, new.col1, new.col2);
END;

-- 同期トリガー（DELETE: 'delete' コマンドで FTS インデックスから除去）
CREATE TRIGGER {table}_ad AFTER DELETE ON {table} BEGIN
    INSERT INTO {table}_fts({table}_fts, rowid, col1, col2)
    VALUES ('delete', old.id, old.col1, old.col2);
END;

-- UPDATE 用は DELETE + INSERT の組み合わせで実装する
CREATE TRIGGER {table}_au AFTER UPDATE ON {table} BEGIN
    INSERT INTO {table}_fts({table}_fts, rowid, col1, col2)
    VALUES ('delete', old.id, old.col1, old.col2);
    INSERT INTO {table}_fts(rowid, col1, col2)
    VALUES (new.id, new.col1, new.col2);
END;
```

## Upsert パターン（ID 保持型）

既存レコードがあれば更新、なければ挿入する。既存レコードの ID を保持することで、外部キー参照が壊れない。

```python
def upsert(self, entity) -> int:
    """INSERT or UPDATE。既存レコードの ID を保持。"""
    with self.conn:
        row = self.conn.execute(
            "SELECT id FROM table WHERE unique_col = ?", (entity.key,)
        ).fetchone()
        if row is not None:
            self.conn.execute(
                "UPDATE table SET ... WHERE unique_col = ?", (...)
            )
            return int(row["id"])
        else:
            cursor = self.conn.execute(
                "INSERT INTO table (...) VALUES (...)", (...)
            )
            assert cursor.lastrowid is not None  # mypy 対策
            return cursor.lastrowid
```

## テストパターン

テストは `tmp_path` フィクスチャを使い、テストごとに独立した DB ファイルを作成する。これにより、テスト間の干渉を完全に排除できる。

```python
class TestDatabase:
    def test_init_creates_tables(self, tmp_path):
        db = Database(tmp_path / "test.db")
        conn = sqlite3.connect(tmp_path / "test.db")
        tables = {r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "expected_table" in tables

    def test_upsert_deduplicates(self, tmp_path):
        db = Database(tmp_path / "test.db")
        id1 = db.upsert(entity)
        id2 = db.upsert(entity)  # same key
        assert id1 == id2  # ID 保持

    def test_fulltext_search(self, tmp_path):
        db = Database(tmp_path / "test.db")
        db.upsert(entity_with_keyword)
        results = db.search("keyword")
        assert len(results) == 1
```

## mypy 注意点

sqlite3 の型情報は不完全なため、以下のパターンで対処する：

- `sqlite3.Row["col"]` は `Any` を返す → `int(row["id"])` でキャスト
- `cursor.lastrowid` は `int | None` → `assert cursor.lastrowid is not None`
- `dict[str, Any]` パラメータは JSON シリアライズ: `json.dumps(params)`
