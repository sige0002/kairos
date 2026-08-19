# topic_monitor 仕様

> ステータス: 設計確定（v1）。`fig_const/topicmonitor.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/topic_monitor.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

ROS 2 トピックの **軽量・非破壊なリアルタイム監視**コンテナ。**ペイロードは原則 decode しない**（header / serialized size / arrival time のみ）。重い decode・映像生成はしない（それらは `dora_runner` / `webrtc_streamer`）。

## 役割

- 監視対象 topic を軽量 subscribe し、Hz / Late / Gap / Loss / Bandwidth / Sensor preview を配信する。
- ROS 2 グラフの discovery（topic 一覧・QoS）を提供し、`api_orchestrator` の topic 情報源になる。

## 入力

- 監視対象 topics（**allowlist**。`RECORDING_CONFIG` の `default_topics` と整合）
- topic ごとの `expected_hz`（`RECORDING_CONFIG`、任意）
- alert 定義（`{ topic, metric, op, threshold }` のリスト、`cooldown_s` / `clear_after_s` / `severity` を含む）
  - **アラートは incident 単位**（key = `(topic, metric)`）: 発火中は現在値を更新しながら保持し、解消時に `cleared` を明示送出（確実な配達のため約 60s 保持）。UI は 1 incident = 1 行に集約する。
  - **自動導出ルール（derived）**: `expected_hz` を持ち、その hz を監視する config ルールが無いトピックは、実測 hz の割れから hz incident を **1 件だけ**自動生成する — `hz < 0.8×expected` 持続で WARNING、`hz < 0.5×expected` で DANGER に昇格。比率・ヒステリシスは alerts.yaml の任意ブロック `derived_rules:`（`enabled` / `warn_ratio` / `danger_ratio` / `sustain_s` / `clear_after_s` / `cooldown_s`。既定は有効・0.8・0.5・10s・3s・10s）で上書きする。
  - **既定 DANGER ルール（default）**: `expected_hz` を**持たない**（= 学習ベースライン基準）トピックでも、monitor 自身の `danger` 分類が約 10 秒持続すれば既定 incident を発火する — テーブルの DANGER と Events が矛盾しない。
  - **優先順位（同一トピックの hz は 1 機構のみが担当。二重 incident は出ない）**: config ルール > derived ルール > default 合成。config の `(topic, hz)` ルールは derived / default を、derived ルールは default を上書きする。
  - **来歴（provenance）**: 各 incident は発生元 `rule_origin`（`config` / `derived` / `default`）と `severity`（`warning` / `danger`）を持ち、`/alerts` / SSE / `/incidents` の payload に載る（UI が出所を表示できる）。
  - **incident 履歴**: 発火→解消の各エピソードを上限付きリングバッファ（直近 500 件）に保持する。ライブの 60s 解消保持より長く残し、`GET /incidents?since_ns=` で「録画ウィンドウ内に発火/解消した incident」を stop 時に後から確定できる。

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
- publisher endpoint・type・QoS の fingerprint を discovery 周期ごとに比較し、publisher の再起動、消失、QoS 変更時は古い subscription を executor thread 上で破棄して再生成する。初回 QoS を永続利用しない。

## メトリクス定義

- **Hz**: ウィンドウ内のメッセージ数 / 秒。
- **Bandwidth**: serialized bytes / 秒。
- **Gap**: 受信間隔の最大、および閾値超過回数。
- **Late**: 2 種類に分ける — `inter_arrival_late_ratio`（`expected_hz` 由来の期待周期を超えた割合）、`stamp_delay_ms`（`header.stamp` が安全に取れる場合のみ）。
- **Jitter**: 受信時刻（monotonic）の間隔から `interarrival_p50_ms` / `interarrival_p95_ms`。decode 不要の「ちらつき」シグナル（p95 / 最大 gap が stall の前兆）。
- **Loss**: ROS 2 では一般化困難なため既定 `null`（seq が取れる特殊型のみ算出）。真の loss は出さない（seq 無し、DDS の sample-lost は監視側購読の取りこぼしで publisher/rosbag のロスではない）。
- **DDS sample-lost**: `dds_samples_lost`（rmw の `message_lost` イベントの累積数）。**seq 無しで唯一誠実に取れる「実際に落ちたサンプル数」**。decode 不要・非破壊。`rate_shortfall`（観測不足）とは別物として明示する。
- **Message count**: `messages_total`（subscribe 以降の**累積**受信数。ウィンドウで evict されない）。start/stop の 2 点差分で録画ウィンドウ全体の平均レートが取れる。
- **Observed shortfall**: `rate_shortfall`（= `max(0, 1 - count / (expected_hz × window)）`）と `deficit_per_s`（= `max(0, expected_hz - hz)`）。**真の loss ではなく**、静的 `expected_hz` に対する観測不足（監視自身の best_effort 取りこぼし・executor 遅延・publisher 停止を混ぜた量。naive な count 比と同条件）。`rosbag loss` と誤読させない命名。`expected_hz` 未設定なら `null`。
- **Status**: 粗い topic 健全度 `status` + `status_reason`。優先度 `inactive > danger > warning > ok > unknown`。`inactive`=無受信（silent）、`unknown`=`expected_hz` 未設定で判定不能、`danger`/`warning`=`rate_shortfall` が閾値（既定 5% / 2%）超過、それ以外 `ok`。低期待レート（expected が窓あたり `min_status_count` 未満）の topic は % でなく**絶対欠落数**で判定し誤検知を防ぐ。さらに**時間ヒステリシス**（既定 escalate 2s / recover 1s）で 1 tick の悪化では赤化しない。閾値・ヒステリシスは `RECORDING_CONFIG` の monitor ブロックで設定可。observed shortfall 由来であり真の loss 判定ではない。
- `expected_hz` 未設定の topic は Hz / Bandwidth / Gap のみ。Late / shortfall は `null` + reason、`status` は `unknown`（メッセージが無ければ `inactive`）。

## API

- `GET /topics` — ROS 2 グラフ discovery（`name` / `type` / `publisher_count` / `subscriber_count` / `qos` / `last_seen`）。`api_orchestrator` の `GET /api/v1/topics` の情報源。
- `GET /metrics` — 周期 snapshot（全 topic）。
- `GET /metrics/stream` — SSE。**topic 差分ではなく周期 snapshot** を配る（UI が単純になる）。
- `POST /metrics/pause` / `POST /metrics/resume` — 監視の一時停止 / 再開（記録中など負荷を下げる）。
- `GET /alerts` / `GET /alerts/stream` — 現在発火中 / 直近解消の incident（`rule_origin` / `severity` を含む）。
- `GET /incidents?since_ns=<int>` — incident 履歴（上限付きリング、直近 500 件）。`fired_at_ns` **または** `cleared_at_ns` が `since_ns` 以上のエピソードを返す（`since_ns` 省略 = 全件）。`api_orchestrator` が録画 stop 時に「そのウィンドウで何が発火したか」を確定する情報源。時刻は wall-clock UNIX ナノ秒。
- `GET /healthz` / `GET /readyz`
- `GET /diagnostics` — executor thread の生存、subscription 数、各 topic の解決 QoS / publisher 数 / subscription age / last sample age。thread が死亡した場合 `/readyz` は ready を返さない。
- API 共通規約（エラー形式・型・時刻）は [config](config.md) に従う。

## 出力スキーマ（例、WebSocket / SSE / JSON）

```json
// GET /metrics（および /metrics/stream の各 tick）
{
  "ts": "2026-06-24T01:23:45.123Z",
  "window_s": 5,
  "topics": [
    { "name": "/cam/image_raw", "type": "sensor_msgs/msg/Image",
      "hz": 29.8, "bandwidth_bps": 51200000, "gap_max_ms": 80,
      "inter_arrival_late_ratio": 0.01, "stamp_delay_ms": 12,
      "interarrival_p50_ms": 33, "interarrival_p95_ms": 41,
      "messages_total": 8940, "loss_rate": null, "dds_samples_lost": 0,
      "rate_shortfall": 0.007, "deficit_per_s": 0.2,
      "status": "ok", "status_reason": null, "sensor_preview": null }
  ],
  "alerts": [
    { "topic": "/cam/image_raw", "metric": "hz", "op": "lt", "threshold": 15.0,
      "value": 9.2, "state": "firing", "since": "2026-06-24T01:23:40.000Z",
      "rule_origin": "derived", "severity": "danger" }
  ]
}
```

```json
// GET /incidents?since_ns=<int> — 発火→解消の履歴エピソード
{
  "incidents": [
    { "id": "/cam/image_raw|hz|7",
      "topic": "/cam/image_raw", "metric": "hz",
      "severity": "danger", "rule_origin": "derived",
      "fired_at_ns": 1750000000000000000, "cleared_at_ns": null,
      "message": "/cam/image_raw hz < 15 (value=9.2)" }
  ]
}
```

## 設計ポイント / 非機能

- 非破壊・軽量を最優先。負荷は **allowlist（監視対象の明示）**で抑える（全 topic 一括 subscribe はしない）。`max_topics` / `max_bytes` による上限は将来枠（現状未実装）。
- メトリクスは `api_orchestrator` が集約し frontend に中継する（[api_orchestrator](api_orchestrator.md)）。
- 共有設定は [config](config.md)。
