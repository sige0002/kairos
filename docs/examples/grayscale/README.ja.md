# 実践例: dora_live のカメラ画像をグレースケール化する自作 dora ノード

> 動作実証済み(2026-07-22、HSR サンプル bag 再生中のスタックに対して)。
> 「dora_live に自分の処理を足したい」時の最小テンプレートです。

## 何を学ぶ例か

- **dora_live 側は一切改造しない。** 消費側は live-frames の **pull 契約**
  (`GET :8005/live/frames` 索引 + `GET :8005/live/frame?topic=` ペイロード、ETag/304)に
  接続するだけ — これが公式の拡張シームです(`docs/specs/ja/dora_live.md`)。
  ロボット側はこの消費者の存在を知らず、止めてもロボットのコストはゼロ。
- **自分の dataflow を自分の `dora run` で回す。** kairos が管理する dataflow の外で、
  同梱の dora CLI(dora_live イメージ内)を使って独立に動かします。
- 実運用と同じ**2つの罠**の回避もそのまま教材です(下記「ハマりどころ」)。

## ファイル

| ファイル | 役割 |
|---|---|
| `dataflow.yml` | ノード1個の dataflow(500ms tick で駆動) |
| `grayscale_node.py` | dora ノード本体: frames を pull → cv2 でグレースケール → `/out/latest_gray.jpg` |
| `run_node.sh` | venv python で node を exec するラッパー(必須 — 下記参照) |

## 動かし方

前提: kairos スタックが LIVE=1 で稼働し、カメラトピックが流れていること
(`curl -s localhost:8005/live/frames` に索引が出る状態。bag なら `make rosbag-loop`)。

```bash
mkdir -p /tmp/gray_out
docker run --rm --network host \
  -v $PWD/docs/examples/grayscale:/example:ro \
  -v /tmp/gray_out:/out \
  --entrypoint bash kairos-dora-live:jazzy -lc \
  "mkdir -p /tmp/ex && cp /example/dataflow.yml /tmp/ex/ && cd /tmp/ex && \
   /opt/venv/bin/dora run dataflow.yml"
```

期待ログ(トピックは自動選択。`FRAME_TOPIC` env で固定も可):

```
[grayscale] auto-selected topic: /hsrb/hand_camera/image_raw/compressed
[grayscale] #1 /hsrb/hand_camera/image_raw/compressed 640x480 mean=99.5
```

`/tmp/gray_out/latest_gray.jpg` が単チャンネル(グレースケール)で更新され続けます。
Ctrl-C で停止。

## ハマりどころ(実運用と同じ罠・回避込み)

1. **dora は `.py` ノードを system python で実行し venv を無視する**(`path:` に
   venv python を書いても無視される — ベンチ実証済み)。`run_node.sh` ラッパーで
   venv python を exec するのが正解で、kairos 自身のノードも同じ方式です。
2. **`dora run` は dataflow ファイルの隣に書き込む**ため、read-only マウント上の
   yml を直接指定すると `Read-only file system` で死にます。上記のとおり書込可能な
   場所へ yml をコピーしてから実行してください。

## 拡張のヒント

- 判定結果をライブイベントとして流す: `POST :8005/internal/analysis/events` に
  push すると `GET /live/events` で読めます(イベント intake シーム)。
- ffmpeg(H.264)トピックのペイロードは keyframe AU なので cv2 では復号できません
  (`X-Frame-Codec` ヘッダで判別可)。PyAV での復号は
  `services/dora_live/src/dora_live/video_decode.py` が参考になります。
- 取得レートはロボット側 `live/default.yaml` の `frames.sample_hz`(既定 2.0)が上限です。
