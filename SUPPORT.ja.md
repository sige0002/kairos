# サポート

kairos は alpha software です。保守は best effort で、応答時間や長期サポート期間は保証しません。
セキュリティ報告を含む秘密情報は公開 issue に書かないでください。

不具合報告には次を含めてください。

- `VERSION` と `git rev-parse HEAD`、dirty worktree の有無
- host OS / CPU architecture / Docker Engine / Compose の版
- `ROS_DISTRO` / `RMW_IMPLEMENTATION` / `ROS_DOMAIN_ID` と単一・分割構成
- 再現手順、期待結果、実結果、最小の設定（秘密を除く）
- `make smoke`、`docker compose ... ps`、対象 service の直近 log
- データ破損の疑いがある場合は、操作を止めて sidecar と `lifecycle.jsonl` を保全した事実

対応対象は既定の対応環境と最新 release です。未検証 platform、独自 message overlay、site-provided
plugin/converter、実機固有 network は再現可能な最小例がある場合に限り best effort で扱います。
