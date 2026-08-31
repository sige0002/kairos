# kairos へのコントリビュート

提案前に issue を検索し、挙動変更や大きな設計変更は先に合意してください。通常の変更先は
`develop` です。コード・コメント・識別子・コミットメッセージは英語で記述します。

1. `AGENTS.md` と変更対象の `docs/specs/ja/` を読む。
2. 変更を最小化し、失敗を再現するテストを先に追加する。
3. Python は `make test-py` と `make lint`、frontend は `make test-fe` を実行する。
4. UI/挙動を変えた場合は image を再 build して `make test-e2e` を実行する。
5. 日本語仕様を変更したら英語ミラーを再生成する。

PR には目的、利用者への影響、検証コマンドと結果、未検証領域、互換性注意を記載してください。
MCAP、`data/`、秘密情報、機体固有設定、秘匿ロボット名を commit しないでください。

公開 API は alpha です。互換性を壊す変更は、移行方法と Release notes の記載を伴う場合だけ受け付けます。
vendored source の追加には、由来、固定 revision、再配布可能な license と必要な notices が必須です。
