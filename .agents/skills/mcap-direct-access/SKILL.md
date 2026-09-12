---
name: mcap-direct-access
description: ROS を使わず MCAP を読解・検証・変換する。動的メッセージ復号、トピック選択、分割 bag、Arrow 変換を扱うときに使う。
---

# MCAP を ROS 無しで扱う

録画済み bag の解析をライブ ROS 接続から分離する。MCAP の schema data と対応
decoder があればカスタム型も動的復号できるが、schema record は必須ではなく、
欠落・未知 encoding を扱う必要がある。MCAP は入れ物であり、ROS 1 / ROS 2 は
`ros1msg` / `ros2msg` などのスキーマから判別する。

## 読み取り

Python の ROS 2 例:

```python
from mcap.reader import make_reader
from mcap_ros2.decoder import DecoderFactory

with open("bag_0.mcap", "rb") as source:
    reader = make_reader(source, decoder_factories=[DecoderFactory()])
    for schema, channel, message, ros_msg in reader.iter_decoded_messages(
        topics=["/camera/color/image_raw/compressed"]
    ):
        ...
```

必要トピックのフィルタはデコード前に掛ける。件数・レート・サイズなど復号不要の
検査は summary/metadata または `iter_messages()` を使い、不要な展開を避ける。

期待トピックの存在と件数を `metadata.yaml` / MCAP 内容に照合し、対象がゼロ件なのに
検証成功としない。分割 bag は複数 MCAP すべてを扱う。
解釈不能なトピックを raw CDR bytes / Arrow LargeBinary で保持する場合、件数と
未展開であることを結果へ明示する。復号が必要な検証を成功扱いで飛ばさない。

## 時刻と Arrow 変換

`log_time` と `publish_time` は異なる。遅延・レート・欠落を論じるときは使った時計、
順序、分母を明示する。圧縮 chunk の解凍が必要な計測と metadata だけで済む計測を分ける。

Arrow バッチには行数とバイト数の上限を持たせる。トピック別バッチのフラッシュ順は
全体の時刻順を保証しないため、時刻順が必要なら目的に合う時刻列で明示的に整列する。
ネスト値は Struct / List、バイナリは対応する Arrow 型で保持する。

Kairos の capture ID・配置・削除は [capture store](../../../docs/specs/ja/capture_store.md)
に従う。処理を dora node に分ける場合は `dora-rs`、記録/再生の実グラフ検証は
`rosbag-workflow` を使う。
