---
name: rosbag-workflow
description: rosbag の記録・再生テストと、開始時の欠落・DDS/QoS・周波数異常を切り分ける。録画済み MCAP の解析だけなら mcap-direct-access を使う。
---

# rosbag の記録・再生

Kairos の入力 bag は `data/` 配下の rosbag2 ディレクトリ（`metadata.yaml` と
1 個以上の MCAP）。ランタイムの bag をコミットしない。
再生が必要な検証では既存のターゲットを使う。

```bash
make rosbag-loop BAG=<bag-directory>
make table
# スタック起動後の疎通判定
make smoke
```

再生側と受信側の `ROS_DOMAIN_ID`、`ROS_DISTRO`、RMW を揃える。
カスタム msg を使う bag は両側に対応する message overlay が必要。
個別診断の `ros2 bag info` / `ros2 bag play --loop` にも bag ディレクトリを指定する。
並列検証は稼働中グラフと分離し、起動した再生プロセスだけを片付ける。

## 記録開始と疎通

Kairos の記録は orchestrator の record API または `make smoke-record` を使う。
recorder は subscription match を待ってから start-paused を解除する。
素の rosbag2 での記録でも購読確立を確認してから開始し、任意の数秒を捨てる方法を
既定の解決にしない。記録開始成功だけでは先頭データの受信を証明できない。

受信しない、またはレートが合わない場合は、症状に合う層から調べる。

- domain と RMW: Kairos の既定は `rmw_fastrtps_cpp`。切替時は再生ハーネスも揃える。
- QoS: `ros2 topic info <topic> -v` で reliability / durability などの互換性を確認する。
- 古いデータ: TRANSIENT_LOCAL の履歴とライブ入力を区別し、必要なら header 時刻と
  明示した鮮度条件で判定する。
- ネットワーク・IPC: ホスト/コンテナの discovery と実データ経路を分けて確認する。
- 帯域: 画像をネットワーク越しに記録する場合は実測し、記録位置や圧縮形式を判断する。

ROS 1 / sqlite3 からの変換は対応ツールと入力型を確認して MCAP へ正規化する。
録画済み bag の読解・変換は `mcap-direct-access` を使い、ライブ ROS 依存を増やさない。
動画プレビューは入力と変換条件が同じ場合にキャッシュを再利用する。
