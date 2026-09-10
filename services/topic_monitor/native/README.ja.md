# Monitorのnative受信・集計

同じMonitorプロセス内で、rclcppがserialized messageの受信と窓集計を担当し、
Pythonがgraph/QoS、API/SSE、status、baseline learning、alertsを担当する。
payloadのdecodeやPythonへの転送は行わない。対象の削減・受信間引きはしない。

## ビルド

通常の `make build monitor` が共有ライブラリをビルドしてimageに同梱する。
起動時のコンパイル・ダウンロードは不要。独自メッセージは従来の
`make msgs-build` が生成する `install/` をそのまま使う。

既定バックエンドは `native`。保守目的の切り戻しは `.env` に
`KAIROS_MONITOR_BACKEND=python` を設定し、Monitorコンテナを再作成する。
共有ライブラリの欠落・ABI不一致を黙ってPythonへフォールバックしない。

## 配布imageの検証

ビルド後、リポジトリルートから実行する。テストは固定乱数によるPythonとの数値比較、
実ROS受信、追加トピック、QoS変更、pause/resume、再起動、ABI・失敗経路を検証する。
通常運用でpauseを使う必要はない。DDS discoveryの成立を確認してからpublishする。

```bash
docker run --rm --network none \
  -e ROS_DOMAIN_ID=97 -e ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST \
  -e RMW_IMPLEMENTATION=rmw_fastrtps_cpp \
  -v "$PWD/services/topic_monitor/native:/tests:ro" \
  "kairos-topic-monitor:$(cat VERSION)-jazzy" \
  python /tests/verify_native.py
```

同じ試験を `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp` でも実行する。
ROS integration CIもこのコマンドを使い、配布するimage内のライブラリを検証する。

## 観測値の意味

- `messages_total` は受信累積数、Hzは既存と同じ受信窓の件数÷窓幅。
- `dds_samples_lost` はmiddlewareのlostイベント。publisherやrosbagの全欠損を保証する測定ではない。
- Python callback処理時間は測れないためself-loadのcallback値は `null`。
- stamp delayとsensor previewは `null`。測っていない値を生成しない。
- C++/ctypes間はABI版とsnapshot構造サイズを照合する。同一ビルドの成果物を使う。

詳しい契約は [topic_monitor仕様](../../../docs/specs/ja/topic_monitor.md) を参照。
