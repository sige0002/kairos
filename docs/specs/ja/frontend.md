# frontend 仕様

> ステータス: 設計確定（v1）。`fig_const/frontend.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/frontend.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

backend-driven な軽量 Web UI（Vite + React + TypeScript）。**ユーザビリティ最優先**。各コンテナ機能を**タブ化**し、**簡単に組み替え可能**にする。

## 役割

- 記録操作 / ライブ映像 / トピック健全性 / Run・検証・データセット表示。

## 実装（推奨ライブラリ）

- ベース: **Vite + React + TypeScript**。
- ルーティング: **TanStack Router**。
- 状態管理: **Zustand**（タブ/レイアウト等の UI 状態）+ **TanStack Query**（サーバ状態。SSE イベントを `setQueryData` でキャッシュに反映）。
- API クライアント: **Orval**（orchestrator の OpenAPI から型付きフックを自動生成）。
- チャート: **uPlot**（軽量な時系列）。UI: **Tailwind CSS + radix-ui / shadcn + lucide**。
- ライブ映像: **WebRTC Player**（`webrtc_streamer` の `/stream/offer` に接続）。
- テスト: **Vitest + Testing Library + MSW**。

## 入力

- WebRTC 映像（`webrtc_streamer`。既定は同一オリジン `/webrtc` 経由で frontend の nginx がリバースプロキシ。`WEBRTC_PUBLIC_URL` で上書き可）
- REST / SSE（`api_orchestrator` `/api/v1`）

## 画面構成（タブ）

**タブはレジストリ駆動**（`GET /api/v1/config` の `tabs` 定義で、表示・順序・有効/無効を backend から差し替える）。**UI 表記は英語**。現在のタブ構成は **Live / Graph / Recordings / Validation / Datasets / Config**（tab id はそれぞれ `live` / `graph` / `runs` / `validation` / `dataset` / `config`）:

- **Live** — Record + Stream + Monitor を融合した運用画面。上部に記録ヒーロー（Operator / Task 入力 + Start・Stop）、下に Stream プレビュー（左）と Monitor 健全性パネル（右）。
  - Monitor は購読中トピックを列挙し、各行に **RECORD チェックボックス**を持つ。チェック集合が**次回記録**の対象トピックになる（次回 start の選択であって、記録途中の変更ではない＝`ros2 bag record` は途中変更できない）。設定済みトピックは事前チェック＆上部にソートされる。各行には **status ドット**（`inactive`/`danger`/`warning`/`ok`/`unknown`）と、閾値超過時の **shortfall バッジ**（observed shortfall。真の loss ではない）＋ reason tooltip を表示。
  - Monitor のトピック名をクリックすると、その**トピック単体のライブ健全性グラフ**を Live 内に開く（**Frequency**：実 Hz と expected_hz の参照線、**Shortfall vs expected**：`rate_shortfall` を 2% / 5% の閾値線とともに表示）。記録の **REC / STOP マーカ**を重ね、「今この記録を続けてよいか／開始直後に欠けなかったか」を判断できる。全て raw monitor 由来で**ペイロード decode 不要**。
  - ヘッダに **ROS_DOMAIN_ID** とホストの **CPU / GPU**（`GET /api/v1/system`）を表示。
- **Graph** — メトリクスパネルを追加・削除できる時系列ヘルスビュー（**Frequency / Bandwidth / Max gap / Rate vs expected**）。latency / loss は非破壊 monitor では測れないため**メニューから除外**（per-run の loss は Recordings の事後解析で提供）。
- **Recordings**（旧 Runs） — 収録履歴一覧（run_id / Status / Duration）+ 詳細（`manifest` / `validation` / `dataset_stats` / `loss`）。**「Run loss report」ボタン**と、オンデマンドの **mp4「Video check」プレイヤー**。run の削除も可能。
- **Datasets** — エクスポート済みデータセットを **operator › task › NNN のツリー**で一覧（`GET /api/v1/datasets`）。下段で完了収録を export（個別＋「Export all」で `recorded/` 全件一括）。エクスポートは**移動**で、成功すると収録は `recorded/` と Recordings 一覧から消え、Datasets ツリーに現れる。
- **Config** — 収録設定（`RECORDING_CONFIG` 全体）を UI から編集・永続化する（`PUT /api/v1/config/recording`）。

## データフロー（SSE × キャッシュ）

- 単一の SSE ストリーム（`GET /api/v1/events`）を購読し、イベント種別ごとに TanStack Query キャッシュへ反映する。コンポーネントはキーを購読して再描画。
- SSE 切断は UI に明示し、自動再接続する（`Last-Event-ID`）。

## 出力（呼ぶ API）

- `POST /api/v1/record/start` / `stop`、`GET /api/v1/runs` / `GET /api/v1/runs/{id}`（RunDetail）、`DELETE /api/v1/runs/{id}`、`GET /api/v1/topics/status`、`GET /api/v1/events`（SSE）、`GET /api/v1/system`、`GET/PUT /api/v1/config/recording`、`GET /api/v1/files/{path}`（video_check mp4）、`GET /api/v1/datasets`・`POST /api/v1/datasets/export(-all)`、`POST /api/v1/jobs`（`fast_validation` / `loss_report` / `video_check`）

## 設計方針

- **実パスを持たない / pipeline をハードコードしない / backend が schema・設定を渡す / 軽くまとめて見せる。**
- エンドポイントは `GET /api/v1/config` 取得完了まで描画を待つ（render gate）。ハードコード fallback は dev のみ。
- 記録中は危険操作（二重 start、topic / run_id 変更）を抑止する。
- 共有設定は [config](config.md)。
