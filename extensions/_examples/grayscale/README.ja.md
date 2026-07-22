# 実動サンプル: grayscale(ライブレーン)

dora_live のカメラフレームを pull してグレースケール変換し、結果画像をホストへ
書き出しつつ、進捗イベントを Web UI(Monitor → Events → Extension events)に
流す**そのまま動く**拡張です。

```bash
cp -r extensions/_examples/grayscale extensions/grayscale
make up LIVE=1        # 以後はスタックと同じライフサイクル(down/ext-reload/ps)
ls /tmp/kairos_ext_grayscale/   # latest_gray.jpg が更新され続ける
```

UI 確認: Monitor タブ → Events → 「Extension events」に
`grayscale_heartbeat`(frames_done 付き)が約 10 秒ごとに現れます。
フロントエンドの変更は一切不要です。

- 入力: frames pull 契約(`codec: image` のトピックを自動選択)
- 出力先の変更: `EXT_OUT_DIR=/path make up LIVE=1`
- split 構成: 録画 PC 側で `make recording-up` すればロボットの :8005 へ自動接続
