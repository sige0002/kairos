# frontend 仕様

> ステータス: 設計確定（v1）。`fig_const/frontend.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/frontend.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

backend-driven な軽量 Web UI（Vite + React + TypeScript）。**ユーザビリティ最優先**。各コンテナ機能を**タブ化**し、**簡単に組み替え可能**にする。

## 役割

- 記録操作 / ライブ映像 / トピック健全性 / Run・検証・データセット表示。

## 実装（推奨ライブラリ、`../rosbag-view` 準拠）

- ベース: **Vite + React + TypeScript**。
- ルーティング: **TanStack Router**。
- 状態管理: **Zustand**（タブ/レイアウト等の UI 状態）+ **TanStack Query**（サーバ状態。SSE イベントを `setQueryData` でキャッシュに反映）。
- API クライアント: **Orval**（orchestrator の OpenAPI から型付きフックを自動生成）。
- チャート: **uPlot**（軽量な時系列）。UI: **Tailwind CSS + radix-ui / shadcn + lucide**。
- ライブ映像: **WebRTC Player**（`webrtc_streamer` の `/stream/offer` に接続）。
- テスト: **Vitest + Testing Library + MSW**。

## 入力

- WebRTC 映像（`webrtc_streamer`、`WEBRTC_PUBLIC_URL` に直接）
- REST / SSE（`api_orchestrator` `/api/v1`）

## 画面構成（タブ）

各コンテナ機能 = 1 タブ。**タブはレジストリ駆動**（`GET /api/v1/config` の `tabs` 定義で、表示・順序・有効/無効を backend から差し替える）:

- **Record** — Topic 選択 / Topic Health / Alert / 記録 Start・Stop。開始前に推定帯域・保存先空き容量を表示。
- **Monitor** — Hz / Late / Gap / Loss / Bandwidth ダッシュボード + Alert。
- **Stream** — ライブ映像プレビュー（複数カメラ layout、接続失敗時の再試行、codec 非対応表示）。
- **Runs** — 一覧（run_id / Status / Duration）+ 詳細（Preview / Validation / Dataset Stats、manifest の生 JSON view）。
- **Pipelines** — schema-driven 実行フォーム（stage3。既定は無効）。

## データフロー（SSE × キャッシュ）

- 単一の SSE ストリーム（`GET /api/v1/events`）を購読し、イベント種別ごとに TanStack Query キャッシュへ反映する。コンポーネントはキーを購読して再描画。
- SSE 切断は UI に明示し、自動再接続する（`Last-Event-ID`）。

## 出力（呼ぶ API）

- `POST /api/v1/record/start` / `stop`、`GET /api/v1/runs`、`GET /api/v1/topics/status`、`GET /api/v1/events`（SSE）、`POST /api/v1/jobs`（stage3）

## 設計方針

- **実パスを持たない / pipeline をハードコードしない / backend が schema・設定を渡す / 軽くまとめて見せる。**
- エンドポイントは `GET /api/v1/config` 取得完了まで描画を待つ（render gate）。ハードコード fallback は dev のみ。
- 記録中は危険操作（二重 start、topic / run_id 変更）を抑止する。
- 共有設定は [config](config.md)。
