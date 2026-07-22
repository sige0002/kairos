# API の見方とデバッグガイド

「どの API がどこにいて、どう覗いて、動かない時に何をどの順で見るか」の実務ガイド。
設計の詳細は各サービスの仕様(このディレクトリ)を参照。コマンドは全てリポジトリ
ルートで実行する。

## 1. ポートマップ — どこに何がいるか

全サービスが `network_mode: host` なので、ポート = そのままホストのポート。

| ポート | サービス | 中身 | 備考 |
|---|---|---|---|
| 8080 | frontend | Web UI。`/api/`→orchestrator、`/webrtc/`・`/probe/` もプロキシ | ブラウザの入口はここだけで足りる |
| 8000 | api_orchestrator | **唯一の公開 API**(`/api/v1/*`)・SSE(`/api/v1/events`) | UI が話すのはここだけ。以下の直叩きはデバッグ用 |
| 8001 / **8005** | topic_monitor / **dora_live**(`LIVE=1`) | `/topics` `/metrics` `/alerts` `/incidents`(互換)。8005 はさらに `/live/*` 拡張面 | どちらが生きているかは `make ps` |
| 8003 / **8006** | topic_probe / dora_live probe 互換 | `/fields` `/sample` `/stream`(数値フィールド) | |
| 8002 / **8007** | webrtc_streamer / dora_live webrtc 互換 | `/stream/start·stop·status·offer` | |
| 8010 | rosbag2_recorder | `/record/start·stop·status` | 録画の実体 |
| 8020 | dora_runner | `/pipelines`(+`plugin_errors`)・`/jobs` | 録画後の検証・変換 |
| 8030 | importer | split の自動 pull サイドカー | recording profile のみ |

## 2. API の見方 — まず Swagger UI

**全 FastAPI サービスが `/docs`(Swagger UI)と `/openapi.json` を配信している。**
ブラウザで開けばエンドポイント一覧・スキーマ・その場での実行が全部できる:

```
http://localhost:8000/docs   # orchestrator(公開 API の全景はまずここ)
http://localhost:8005/docs   # dora_live(LIVE=1 時)
http://localhost:8020/docs   # dora_runner
```

コマンドラインでは `curl` + `python3 -m json.tool` が基本形:

```bash
curl -s localhost:8000/api/v1/runs | python3 -m json.tool          # run 一覧
curl -s localhost:8000/api/v1/runs/<run_id> | python3 -m json.tool # 詳細(quick_check 込み)
curl -s localhost:8000/api/v1/topics | python3 -m json.tool        # discovery
curl -s localhost:8005/metrics | python3 -m json.tool              # 生メトリクス(直)
curl -s localhost:8020/pipelines | python3 -m json.tool            # パイプライン+plugin_errors
```

SSE(流れ続ける系)は `-N` で:

```bash
curl -N localhost:8000/api/v1/events          # 統合イベント(record_status/alert)
curl -N localhost:8005/metrics/stream         # メトリクスのスナップショット連送
```

ジョブ投入の例(UI の Validation タブ相当):

```bash
curl -s -X POST localhost:8020/jobs -H 'content-type: application/json' \
  -d '{"pipeline":"fast_validation","run_id":"<run_id>","params":{"template":"airoa_hsr"}}'
```

## 3. ヘルスの読み方 — healthz と readyz は別物

- `GET /healthz` = プロセスが生きているか(liveness)。
- `GET /readyz` = **仕事ができる状態か**。orchestrator の readyz は
  `components: {recorder, monitor, streamer}` で**どこが原因か**まで返す。
  dora_live の readyz は dataflow の生死まで畳み込む(`dora run` が死んでいれば 503)。

```bash
curl -s localhost:8000/readyz | python3 -m json.tool   # degraded ならどの component か出る
```

## 4. ログの見方

```bash
make logs orchestrator        # 追尾(service 名は positional)
make logs dora_live           # dora ノードの stderr は「node名:」prefix で混ざって出る
make ps                       # 稼働状態(拡張サイドカー kairos-ext-* も表示)
```

- ログは JSON 構造化(`logger` 名でサービス内のどこかが分かる)。
- dora_live 内の Rust ログを増やす(`RUST_LOG=...`)は **`make restart` では反映されない**
  — env の変更は recreate(`make up-nobuild LIVE=1` 等)が必要。

## 5. 症状別プレイブック

### 「何も出ない」— 最初の一手は常に smoke

```bash
bash deploy/test/smoke.sh     # health → config → discovery → metrics を順に PASS/FAIL
```

### Monitor に Hz が出ない

1. `make table`(replay ハーネスの topic 表)— **kairos 抜きで** DDS 上に何が流れているか見る。
2. 流れているのに出ない → `ROS_DOMAIN_ID` 不一致か `ROBOT` 不一致
   (`ROBOT` は **make のコマンドライン引数**で渡す。`.env` が shell 環境変数に勝つ)。
3. `LIVE=1` なら `curl -s localhost:8005/live/status`:
   - `dataflow_alive: false` → `make logs dora_live` でノードのクラッシュを見る
   - `pending: [...]` → その型が AMENT に無い(カスタム msg overlay 未ビルド)
   - `discovery_source` → `dora_graph` が正常(`rclpy` はフォールバック=要調査)

### 映像が出ない・遅い(fps の連鎖)

実効 fps は連鎖の**最小値**で決まる:

```
ソースレート(カメラドライバ or bag の収録レート)
  → max_fps キャップ(LIVE_CONFIG video_defaults / クライアント指定)
    → 消費追従(視聴側が受け取れる速さ)
```

1. **ソース**: Monitor でそのトピックの Hz を見る。それ以上は絶対に出ない
   (bag 再生なら収録時のレートが上限。kairos 側に上げる設定は無い)。
2. **配信**: `curl -s localhost:8007/stream/status` — `state: live` と `fps`。
   ここの `fps` は**消費追従値**: 視聴側の接続が死んでいると低く出る(実力指標ではない)。
3. **映らない**: ブラウザ側 ICE(ネットワーク経路)を疑う。`make logs dora_live` の
   webrtc 行に candidate 解決失敗が出る。Tailscale 経由の黒画面は MTU 問題の既知例
   (`WEBRTC_PACKET_MAX`)。

### 拡張(extensions/)が動かない

- **ライブ面**: `make ps` で `kairos-ext-<name>` の状態 → 落ちていれば
  `make ext-live EXT=<name>` でフルエラー表示。イベントが UI に出ない時は
  `curl -s localhost:8005/live/events` で「そもそも届いているか」を切り分け。
- **検証面**: `curl -s localhost:8020/pipelines | python3 -m json.tool` の
  `plugin_errors`(読込失敗の理由が載る)+ `make logs dora_runner` で `plugin load failed`。

### 録画がおかしい

```bash
curl -s localhost:8010/record/status | python3 -m json.tool   # 録画の生状態
curl -s localhost:8000/api/v1/runs/<run_id> | python3 -m json.tool
```

run 詳細の `quick_check.verdict.reasons` に「なぜ needs_review か」が文章で入る。
`integrity` が `dropped/failed` なら recorder キャッシュ溢れ(`max_cache_size_mb`)。

### 負荷が高い

```bash
make load          # CPU(%/コア・%/マシン)+ LAN 帯域 + DDS 帯域 + ディスク
docker stats       # コンテナ別(拡張は kairos-ext-* で分離表示される)
```

## 6. データの場所(ディスクで直接見る)

| パス | 中身 |
|---|---|
| `data/recorded/<run_id>/` | 録画 MCAP(正本)+ metadata.yaml |
| `data/report/<pipeline>/<run_id>/summary.json` | 検証結果(`result: pass\|fail`) |
| `data/<operator>/<task>/<NNN>/` | エクスポート済みデータセット |
