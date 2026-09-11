# 仕様 docs（日本語・正本）

サービス別の仕様。`fig_const/` の各図を基に、未記載事項を推奨設計として確定した **設計の正本**（これを正とする）。**日本語が正本**、英語版 `docs/specs/en/README.md` は `/sync-docs` による自動生成ミラー（直接編集しない）。**認証は不要。**

| ドキュメント | 役割 |
|---|---|
| [config](config.md) | 共有設定（`ROS_DOMAIN_ID` / ポート / パス等の外出しと実行時設定） |
| [capture_store](capture_store.md) | 収録データの同一性・配置・耐久性（`objects/<capture_id>` / サイドカー / 削除 / rebuild）。サービス横断の土台 |
| [deployment_topology](deployment_topology.md) | デプロイ構成（配置トポロジ）。別 PC からロボットを圧迫せず記録する分割デプロイ |
| [rosbag2_recorder](rosbag2_recorder.md) | ROS 2 topics → MCAP 記録（正本）。QoS 選択 / 画像対応 |
| [topic_monitor](topic_monitor.md) | 軽量リアルタイム監視（Hz / Late / Gap / Loss / 帯域） |
| [topic_probe](topic_probe.md) | 数値フィールドのライブプロット（decode を隔離。異トピック重畳） |
| [webrtc_streamer](webrtc_streamer.md) | カメラ映像の低遅延配信（プレビュー） |
| [api_orchestrator](api_orchestrator.md) | ジョブ管理 / 状態管理 / API ハブ（単一入口 `/api/v1`） |
| [dora_runner](dora_runner.md) | 収録後の組み込み検証・ジョブ管理・専用dora実行と拡張処理 |
| [dora_plugins](dora_plugins.md) | 独自プラグイン作者・導入担当者の必須作業、Python／OS依存、GPU、入出力・実行確認 |
| [frontend](frontend.md) | 役割タブ Web UI（Console v2: Collect / Review / Datasets / Validation / Monitor / Settings） |

導入全体は[ルートREADME](../../../README.ja.md)、プラグイン追加は[利用者向け手順](../../../services/dora_runner/plugins/README.ja.md)、組み込みチェックの変更は[dora開発ガイド](../../dora/README.ja.md)から始める。
