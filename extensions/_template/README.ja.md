# 拡張テンプレート(copy-me)

`cp -r extensions/_template extensions/<your_name>` してから編集してください。
`_` で始まるフォルダはロードされません(このテンプレ自身は動きません)。
機構の全体像は [`extensions/README.ja.md`](../README.ja.md) を参照。

このテンプレは 2 レーンを両方実装しています。**どちらか片方だけでも成立**します
(不要な側のファイルは消して構いません)。

## ① ライブ面(`live/`): 平均輝度ウォッチャ

dora_live の frames pull 契約から間引きフレームを取得し、平均輝度が閾値を
下回ったら `dark_frame` イベント、~10 秒毎に `brightness_heartbeat` を
`POST /internal/analysis/events` へ送ります。確認は:

```bash
make ext-live EXT=<your_name>          # 起動(リポジトリルートで)
curl -s localhost:8005/live/events | python3 -m json.tool   # イベント確認
make ext-live-down EXT=<your_name>     # 停止
```

書き換えるのは `live/node.py` の判定ロジックだけ。イベント本文は自由形式です
(`t` = epoch 秒のみ予約・省略時は受信時刻が自動付与)。

制限: 自動選択は `codec: image`(JPEG/PNG)のトピックを優先します。**ffmpeg
レーン(H.264/HEVC)のペイロードは cv2 では復号できない**ため(要 PyAV)、
image コーデックのカメラが無い環境ではその旨がログに出ます。split 構成では
`DORA_LIVE_URL=http://<robot>:8005 make ext-live EXT=<your_name>` で起動。

## ② 検証面(ルート): topic_census パイプライン

録画済み MCAP のトピック別メッセージ数を数え、最多トピックが
`min_messages` 未満なら fail を返します。手順:

1. `kairos_plugin.yaml` の `id`(と `name`)を自分のものへ変更
2. `nodes/report.py` の `build_summary()` を実装し直す
3. `make restart dora_runner` → Validation タブに新パイプラインが出現
   (**既存スタックで初めて拡張機構を使う場合のみ**、先に一度
   `make rebuild dora_runner` が必要 — mount/env の反映のため)

ジョブ実行は UI からでも、API 直でも:

```bash
curl -s -X POST localhost:8020/jobs -H 'content-type: application/json' \
  -d '{"pipeline":"topic_census","run_id":"<run_id>","params":{"min_messages":10}}'
```

結果は `/data/report/<id>/<run_id>/summary.json`(`result: pass|fail` が契約)。

## 注意

- ノードは **dual-mode 必須**: `process(inputs, ctx)`(in-process 実行の実体)+
  `main()`(dora CLI 実行用)。dora CLI の無いホストでは前者だけが走ります。
- 依存を増やす場合、②は dora_runner イメージに入っているもの
  (mcap / mcap-ros2-support / numpy 等)に限るか、自前イメージ化が必要です。
  ①は `live/compose.yaml` の `image:` を自分のイメージに差し替え可能です。
