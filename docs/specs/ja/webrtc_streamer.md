# webrtc_streamer 仕様

> ステータス: 設計確定（v1）。`fig_const/webstremer.png` を基に、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/webrtc_streamer.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

ROS 2 の image トピックをブラウザへ低遅延配信する**プレビュー専用**コンテナ。**正本記録ではない**（記録は `rosbag2_recorder`）。記録パスとは独立。

## 役割

- image topic を購読し、WebRTC でブラウザにライブ配信する（複数カメラ = 複数 stream）。

## 入力

- ROS 2 image topic（`sensor_msgs/Image` / `sensor_msgs/CompressedImage`）
- camera_info（任意）

## 構成コンポーネント

- **ROS2 Subscriber** — 画像トピックを購読。
- **Frame Queue** — **最新フレーム優先**（古いフレームは破棄 = frame drop 前提）。
- **Encoder** — VP8（既定）/ H.264（任意・環境依存。capability は `/stream/status` に出す）。
- **WebRTC Session / Signaling** — SDP / ICE。
- **Stream Status** — 配信状態・接続数。

## ライブラリ

- **aiortc**（WebRTC peer / offer-answer）+ **aiohttp**（signaling HTTP）+ **opencv-python-headless**（フレーム変換）を推奨。

## API

- `POST /stream/start` — `{ topic, encoding?: "vp8"|"h264", max_fps?, max_width?, max_height?, bitrate_kbps? }` → `{ stream_id }`（`bitrate_kbps` は受理するが現状は未適用の予約フィールド）
- `POST /stream/stop` — `{ stream_id }`
- `GET /stream/status` — `{ capabilities: { h264: bool }, streams: [ { stream_id, topic, state, clients, fps } ] }`
- `POST /stream/offer` — `{ stream_id, sdp: { type: "offer", sdp } }` → `{ type: "answer", sdp }`（WHEP 風 HTTP offer/answer。`stream_id` 必須。v1 は non-trickle で候補込みの完全 SDP を交換。トリクルが必要なら WS を追加）
- `GET /healthz` / `GET /readyz`

## 設定 / 挙動

- ICE: LAN 既定は `ice_servers = []`（同一 LAN 内で到達可能）。外部越えが必要な場合のみ STUN/TURN を `/api/v1/config` で配布。
- CORS: 既定（`WEBRTC_PUBLIC_URL=/webrtc`）では frontend の nginx 経由の同一オリジンになるため CORS は不要。絶対 URL を設定してブラウザから直接 offer する旧方式の場合のみ `CORS_ORIGINS`（[config](config.md)）を streamer に適用する。
- `stream_id` は topic から決定的に生成し、同一 topic への重複 start は既存 stream を返す。
- 無参照ストリームは `idle_timeout_s`（既定 `60`）で自動停止。client disconnect 時に cleanup。
- frontend は既定で同一オリジンの `/webrtc`（frontend の nginx が streamer にリバースプロキシ）経由で signaling する（orchestrator は経由しない）。`WEBRTC_PUBLIC_URL` に絶対 URL を設定すると streamer へ直接接続する旧方式になる。なお signaling は同一オリジンでも、WebRTC メディア（ICE/SRTP）はブラウザ ↔ streamer ホスト間の UDP で直接流れるため、同一 LAN かホスト到達性が前提（SSH トンネルのみで UDP が通らない環境では TURN が別途必要）。
- 複数 client: stream ごとに 1 つの映像ソース（最新フレーム）を共有し、**client ごとに PeerConnection** を作る。client 切断で当該 PC を破棄する。

## 設計ポイント

- 低遅延優先・プレビュー専用。低画質を許容する。
- 正本記録ではない（記録の正本は `rosbag2_recorder`）。
