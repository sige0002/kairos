# topic_monitor 仕様

> ステータス: 設計確定（v1）。`fig_const/topicmonitor.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/topic_monitor.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

ROS 2 トピックの **軽量・非破壊なリアルタイム監視**コンテナ。**ペイロードは原則 decode しない**（header / serialized size / arrival time のみ）。重い decode・映像生成はしない（それらは `dora_runner` / `webrtc_streamer`）。

## 役割

- 監視対象 topic を軽量 subscribe し、Hz / Late / Gap / Loss / Bandwidth / Sensor preview を配信する。
- ROS 2 グラフの discovery（topic 一覧・QoS）を提供し、`api_orchestrator` の topic 情報源になる。

## 入力

- 監視対象 topics（**allowlist**。`RECORDING_CONFIG` の `default_topics` と整合）
- topic ごとの `expected_hz`（`RECORDING_CONFIG`、任意）
- alert 定義（`{ topic, metric, op, threshold }` のリスト、`cooldown_s` / `clear_after_s` を含む）

## 構成コンポーネント

- **ROS2 Subscribers** — rclpy ノードの監視スレッドで購読。**allowlist のみ** subscribe（全 topic 一括 subscribe はしない）。
- **Window Stats** — スライディングウィンドウ（既定 `1s` / `5s`、設定可）で集計。
- **Alert Rules** — 閾値判定。ヒステリシス（`cooldown_s`、`clear_after_s`）。
- **Sensor Preview** — **decode allowlist（既定 無効）。** UI で有効化した小型・固定型（`std_msgs/*` 数値、`sensor_msgs/Imu`・`NavSatFix`・`BatteryState` 等）のみ軽量 decode。
- **Metrics Publisher** — SSE / JSON で配信。

## QoS 自動マッチ

- `get_publishers_info_by_topic()` で各 publisher の offered QoS を取得して購読を生成する（取りこぼし防止）。
- 複数 publisher で QoS が異なる場合は互換側に寄せる: いずれかが `best_effort` なら `best_effort`、`durability` は `volatile`、`depth` は小（`keep_last`）。
- `RECORDING_CONFIG` の `topic_qos_overrides`（パターン一致）が**最優先**。取得不能時のフォールバックは `best_effort` / `keep_last`。

## メトリクス定義

- **Hz**: ウィンドウ内のメッセージ数 / 秒。
- **Bandwidth**: serialized bytes / 秒。
- **Gap**: 受信間隔の最大、および閾値超過回数。
- **Late**: 2 種類に分ける — `inter_arrival_late_ratio`（`expected_hz` 由来の期待周期を超えた割合）、`stamp_delay_ms`（`header.stamp` が安全に取れる場合のみ）。
- **Loss**: ROS 2 では一般化困難なため既定 `null`（seq が取れる特殊型のみ算出）。
- `expected_hz` 未設定の topic は Hz / Bandwidth / Gap のみ。Late / Loss は `null` + reason。

## API

- `GET /topics` — ROS 2 グラフ discovery（`name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`）。`api_orchestrator` の `GET /api/v1/topics` の情報源。
- `GET /metrics` — 周期 snapshot（全 topic）。
- `GET /metrics/stream` — SSE。**topic 差分ではなく周期 snapshot** を配る（UI が単純になる）。
- `POST /metrics/pause` / `POST /metrics/resume` — 監視の一時停止 / 再開（記録中など負荷を下げる。`../rosbag-view` の pause/resume 相当）。
- `GET /alerts` / `GET /alerts/stream`
- `GET /healthz` / `GET /readyz`
- API 共通規約（エラー形式・型・時刻）は [config](config.md) に従う。

## 出力スキーマ（例、WebSocket / SSE / JSON）

```json
{
  "ts": "2026-06-24T01:23:45.123Z",
  "window_s": 5,
  "topics": [
    { "name": "/cam/image_raw", "type": "sensor_msgs/msg/Image",
      "hz": 29.8, "bandwidth_bps": 51200000, "gap_max_ms": 80,
      "inter_arrival_late_ratio": 0.01, "stamp_delay_ms": 12, "loss_rate": null,
      "sensor_preview": null }
  ],
  "alerts": []
}
```

## 設計ポイント / 非機能

- 非破壊・軽量を最優先。`max_topics` / `max_bytes` で負荷上限を設ける（全 topic subscribe で負荷が跳ねるのを防ぐ）。
- メトリクスは `api_orchestrator` が集約し frontend に中継する（[api_orchestrator](api_orchestrator.md)）。
- 共有設定は [config](config.md)。
