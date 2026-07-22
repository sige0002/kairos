# 実践例②: 数値トピックの範囲チェック(自作 dora バリデータ)

> 動作実証済み(2026-07-22、敵対検証エージェントが docs だけを頼りに構築→イベント往復まで確認)。
> [grayscale 例](../grayscale/README.ja.md)(画像・frames レーン)の対になる**数値側**の最小テンプレです。

## 何を学ぶ例か

- **公開 API だけで数値バリデーションを外付けする**: ① `GET :8006/fields` + `GET :8006/sample`
  (probe 互換 API)で数値フィールドをポーリング → ② 範囲規則の判定 → ③ verdict を
  `POST :8005/internal/analysis/events` へ → ④ `GET :8005/live/events?since=` で誰でも読める。
  kairos のファイルは一切変更しない(実証済み)。
- **イベントの `t` キー契約**: `/live/events?since=` は各イベントの `t`(epoch 秒)で
  フィルタします。`t` を省略した場合はサーバが受信時刻を自動付与します(それでも
  自分で入れるのが行儀)。

## 動かし方

```bash
docker run --rm --network host \
  -v $PWD/docs/examples/range_check:/example:ro \
  --entrypoint bash kairos-dora-live:jazzy -lc \
  "mkdir -p /tmp/ex && cp /example/dataflow.yml /tmp/ex/ && cd /tmp/ex && \
   /opt/venv/bin/dora run dataflow.yml"
# 別ターミナルで verdict を確認:
curl -s "localhost:8005/live/events?since=0" | python3 -m json.tool
```

env: `TOPIC`(既定 `/left_arm_controller/joint_states`)/ `FIELD`(空=数値フィールド自動選択)/
`LO`,`HI`(許容範囲。既定は必ず発火するデモ値)。

## 注意(grayscale 例と同じ2つの罠+1)

1. dora は `.py` を system python で実行するため `run_node.sh` ラッパー必須
2. `dora run` は dataflow の隣に書くため yml を書込可能な場所へコピー
3. イベントリングは**非永続**(メモリ上 500 件・dora_live 再起動で消える)。恒久記録が
   要る判定は録画後の dora_runner パイプラインで行うのが現行の設計です
