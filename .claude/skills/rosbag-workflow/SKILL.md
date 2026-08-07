---
name: rosbag-workflow
description: rosbag（mcap）を使った記録・再生・ループ再生テストと、DDS/QoS 起因の疎通トラブル切り分けの定型手順。「rosbagをループ再生してテスト」「bagを流してもトピックが受信できない」「録画データの周波数がおかしい」「record開始直後のデータが欠けている」ときに使用する。
---

# Rosbag Workflow（記録・再生テストと DDS/QoS 切り分け）

rosbag を使った開発テストループの定型と、頻出のハマりどころ。

## 再生テストループ

開発中の受信側（バックエンド・可視化 UI）をテストする定番構成：

```bash
# bag の中身を確認してから使う
ros2 bag info data/sample.mcap

# ループ再生（テスト用に流しっぱなしにする）
ros2 bag play data/sample.mcap --loop

# 受信確認（別ターミナル/コンテナ）
ros2 topic list
ros2 topic hz /camera/image_raw/compressed
```

- コンテナ構成では、bag 再生専用コンテナを立てて `data/` を volume 共有すると再現性が高い
- `make rosbag-loop` のような Makefile ターゲットに包んでおくと毎回のタイプが減る（docker compose + bag play + msgs ビルドを薄くラップする）
- カスタム msg を使う bag は、再生側・受信側の両方に msg パッケージのビルドが必要

## 記録（record）の注意点

- **開始直後のデータ欠け**: `ros2 bag record` は開始直後、全トピックの購読が完了するまでラグがあり、序盤のメッセージが欠ける。対策：
  - 記録開始から数秒間のデータは使わない前提で運用する（変換時に先頭を捨てる）
  - `--start-paused` で購読を確立してから再生/記録を始める
- 画像トピックをロボット外のネットワーク越しに記録すると帯域圧迫で周波数が落ちる。記録はロボット側ホストで行うか compressed topic を使う

## DDS/QoS トラブル切り分け

「トピックは流れているはずなのに受信できない/周波数が出ない」ときの確認順：

1. **`ROS_DOMAIN_ID` の一致** — 全コンテナ・ホストで同一か。既定は 0
2. **DDS 実装の統一** — CycloneDDS と FastDDS の混在を避ける。`RMW_IMPLEMENTATION=rmw_cyclonedds_cpp` で統一（迷ったら CycloneDDS）
3. **QoS の不一致** — `ros2 topic info /topic -v` で配信/購読の QoS を突合。BEST_EFFORT vs RELIABLE、depth 設定を確認
4. **TRANSIENT_LOCAL の残留** — durability が TRANSIENT_LOCAL のトピックは、購読開始時に**過去の古いメッセージが届く**。タイムスタンプ（header.stamp）で閾値フィルタして古いフレームを捨てる
5. **コンテナ間の DDS 発見** — network_mode、`/dev/shm` 共有、マルチキャスト可否を確認

## bag ファイル形式

- 入力は **mcap に正規化**すると扱いやすい。ROS 1 の `.bag` や sqlite3 形式は `rosbags-convert` で事前変換する
- Python から読む場合は `mcap` パッケージの reader を使う（トピック・時刻でフィルタしながら streaming 読みできる）
- プレビュー動画が欲しいときは image topic を ffmpeg で mp4 化する。**一度変換した mp4 はキャッシュして再利用**する（毎回の再変換は時間の無駄）
