# 仕様 docs（日本語・正本）

サービス別の仕様。`fig_const/` の各図を基に、未記載事項を推奨設計として確定した **設計の正本**（これを正とする）。**日本語が正本**、英語版は [`docs/specs/en/`](../en/README.md)（`/sync-docs` スキルによる自動生成ミラー）。**認証は不要。**

| ドキュメント | 役割 |
|---|---|
| [config](config.md) | 共有設定（`ROS_DOMAIN_ID` / ポート / パス等の外出しと実行時設定） |
| [deployment_topology](deployment_topology.md) | デプロイ構成（配置トポロジ）。別 PC からロボットを圧迫せず記録する分割デプロイ |
| [rosbag2_recorder](rosbag2_recorder.md) | ROS 2 topics → MCAP 記録（正本）。QoS 選択 / 画像対応 |
| [topic_monitor](topic_monitor.md) | 軽量リアルタイム監視（Hz / Late / Gap / Loss / 帯域） |
| [topic_probe](topic_probe.md) | 数値フィールドのライブプロット（decode を隔離。異トピック重畳） |
| [webrtc_streamer](webrtc_streamer.md) | カメラ映像の低遅延配信（プレビュー） |
| [api_orchestrator](api_orchestrator.md) | ジョブ管理 / 状態管理 / API ハブ（単一入口 `/api/v1`） |
| [dora_runner](dora_runner.md) | 記録後の検証・変換・AI 処理（dora 拡張、stage3。検証 v1 = 必須トピック + テンプレ） |
| [frontend](frontend.md) | タブ化 Web UI（backend-driven、組み替え可能） |
