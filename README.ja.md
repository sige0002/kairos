# kairos

**English: [README.md](README.md)**

ROS 2 のロボットデータを **収録・監視・検証・変換** するシステムです。収録の正本フォーマットは
**MCAP** であり、ライブ映像・ライブメトリクス・事後検証はすべてこの「正本」を中心に構成されます。

> **ステータス:** グリーンフィールド / 設計前。以下のアーキテクチャは `fig_const/` の図を転記した
> ものです。実装・ディレクトリ構成・ツール類はまだ何も決まっていません。

## アーキテクチャ

```
                ROS 2 Robot / Sim  ──►  ROS 2 Topics
                                          │
        ┌──────────────┬──────────────────┼──────────────────────────┐
        ▼              ▼                   ▼                          ▼
  webrtc_streamer  topic_monitor    rosbag2_recorder            (選択されたトピック)
   (ライブ映像)     (ライブ監視)      ──► MCAP  /data/recorded/run_xxxx.mcap  ◄── 正本
        │              │                   │
        ▼              ▼                   ▼  (収録後)
     Browser  ◄──  api_orchestrator  ──►  dora_runner ──► レポート / 変換済みデータセット
                  (ジョブ・状態ハブ)        (検証・変換パイプライン)
                         ▲
                         │ REST / WebSocket / SSE
                      frontend (Vite + React + TS)
```

## サービス構成

| サービス | 役割 |
|---|---|
| [rosbag2_recorder](docs/specs/ja/rosbag2_recorder.md) | 選択した ROS 2 トピックを **MCAP** に記録する。唯一の正本（source of truth）。 |
| [topic_monitor](docs/specs/ja/topic_monitor.md) | 軽量・非破壊なライブ健全性メトリクス（Hz / 遅延 / 欠落 / ロス / 帯域）。ペイロードは**デコードしない**。 |
| [webrtc_streamer](docs/specs/ja/webrtc_streamer.md) | 低遅延のカメラ**プレビュー**（ROS 2 image → ブラウザ）。記録パスではない。 |
| [api_orchestrator](docs/specs/ja/api_orchestrator.md) | 単一の API ハブ。ジョブのライフサイクル・状態・設定・結果集約を担う。 |
| [dora_runner](docs/specs/ja/dora_runner.md) | 収録後の**検証・変換**パイプライン（dora ベース）。 |
| [frontend](docs/specs/ja/frontend.md) | backend-driven な Web UI。記録操作・ライブ映像・トピック健全性・Run/検証/データセット表示。 |

## 仕様ドキュメント

各サービスの詳細仕様は [docs/specs/ja/](docs/specs/ja/README.md) を参照してください。`fig_const/` を基にした**設計の正本**です（未記載事項は推奨設計として確定。認証は不要）。

## 始め方

> ディレクトリ構成・ツール・ビルド/実行手順はまだ決まっていません。設計が固まり、各サービスの
> 実装が入るのに合わせて追記します。

## ドキュメントの言語ルール

**日本語が正本**です。日本語ファイル（`*.ja.md`）を編集し、英語版（`*.md`）は `/sync-docs` スキルで
再生成します。英語版は手で編集しないでください。

## コントリビュート

- コード・コメント・コミットメッセージは英語で記述します。
- 作業上の取り決め・規約は [CLAUDE.ja.md](CLAUDE.ja.md) を参照してください。
