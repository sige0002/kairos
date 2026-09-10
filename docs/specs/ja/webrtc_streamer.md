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

同一 stream の start は 1 つの lifecycle transaction として直列化する。重複 start は live のみ再利用し、starting は同じ完了を待つ。source / peer factory・ROS spin-up・SDP offer の失敗や start/stop 競合では registry entry、PeerConnection、source を必ず rollback し、次の start を再試行可能にする。停止時は peer close が失敗しても source stop を実行する。

## 設定 / 挙動

- ICE / ネットワーク到達性:
  - 既定は `ice_servers = []`（host candidate のみ。同一 LAN 内で直接到達）。NAT / WiFi クライアント分離 / インターネット越えが必要な場合のみ `WEBRTC_ICE_SERVERS`（STUN/TURN の JSON 配列）を設定する。値はブラウザと streamer の両方に `/api/v1/config` 経由で配布される。空/不正値は「ICE なし」に安全に縮退する（サービスは落とさない）。
  - answer 前の ICE gathering 待ちは `WEBRTC_ICE_GATHER_TIMEOUT_S`（既定 `5.0`）。超過時は部分 answer を送る（LAN では host candidate で足りる）が、TURN 経由では relay candidate を欠いた部分 answer が「接続はするが映像が黒い」族の原因になるため、遅い uplink の TURN 構成ではこの値を上げる（超過は WARNING でログされる。2026-08-11, sweep S4）。
  - answer SDP から **IPv6 候補を既定で除外**する（`WEBRTC_KEEP_IPV6=1` で無効化）。断片化した IPv6 データグラムは WireGuard/Tailscale でブラックホール化されるため、ICE が v6 ペアを選ぶとメディアが届かずプレビューが黒くなる。到達可能な経路（LAN の v4 host 候補・Tailscale の `100.x`）はすべて v4 なので候補集合が空になることはない。
  - RTP ペイロード上限を `WEBRTC_PACKET_MAX`（既定 `1150`）で縮小する。aiortc は 1300B 固定で ~1350B(v4)/~1370B(v6) のデータグラムを作り、MTU 1280 のトンネル（Tailscale/WireGuard）では毎パケットが断片化する。1150 なら RTP/SRTP/UDP/IP ヘッダ込みで 1280 に収まり断片化しない。MTU 1500 の同一 LAN では 1300 に戻して overhead を減らしてもよい。
- CORS: 既定（`WEBRTC_PUBLIC_URL=/webrtc`）では frontend の nginx 経由の同一オリジンになるため CORS は不要。絶対 URL を設定してブラウザから直接 offer する旧方式の場合のみ `CORS_ORIGINS`（[config](config.md)）を streamer に適用する。
- `stream_id` は topic から決定的に生成し、同一 topic への重複 start は既存 stream を返す。
- 無参照ストリームは `idle_timeout_s`（既定 `60`）で自動停止。client disconnect 時に cleanup。
- frontend は既定で同一オリジンの `/webrtc`（frontend の nginx が streamer にリバースプロキシ）経由で signaling する（orchestrator は経由しない）。`WEBRTC_PUBLIC_URL` に絶対 URL を設定すると streamer へ直接接続する旧方式になる。なお signaling が同一オリジンでも、WebRTC メディア（ICE/SRTP）はブラウザ ↔ streamer 間を UDP で流れる。同一 LAN・Tailscale など直接到達できる経路なら `ice_servers` は不要（上記の v4 固定＋パケット上限が既定で効く）。NAT 越え・WiFi クライアント分離・UDP が通らない環境では `WEBRTC_ICE_SERVERS`（STUN、必要なら TURN リレー）を設定する。
- 複数 client: stream ごとに 1 つの映像ソース（最新フレーム）を共有し、**client ごとに PeerConnection** を作る。client 切断で当該 PC を破棄する。

### デコード前の最新画像保持

- ROS の画像 callback は `Image` / `CompressedImage` の最新メッセージを1件だけ保持する。JPEG/PNG のデコード・色変換・縮小は、WebRTC track が送信周期に画像を要求した時に worker thread で行う。ROS executor と Web のイベントループには画像変換を置かない。ROS メッセージ自体のデシリアライズと DDS 受信は従来どおり。
- 未処理画像は新しい受信で置換する。変換中の1件と待機中の1件が上限で、準備済み画像は既存の最新フレームバッファで共有する。同じ入力を複数 client が要求しても再デコードしない。client の送信位相が異なれば、その間に到着した新しい入力を追加で変換する場合があるため、全 client 合算で必ず `max_fps` 回に制限する仕組みではない。
- `/stream/status` の `fps` は ROS callback の受信レートであり、変換成功・送信・ブラウザ表示 FPS の証明ではない。不正画像の変換はログに残し、最後の正常画像を維持して次の入力で復旧する。停止は待機入力を破棄し、進行中の変換完了を待って、停止後の画像公開を防ぐ。
- 初回の実画像待ち、出力解像度、送信 `max_fps`、codec、接続単位の encoder、録画経路は変更しない。帯域削減やGPU化を目的とする変更ではない。

## 実験用 native 共有エンコード（opt-in）

`KAIROS_STREAMER_BACKEND=native` を設定して Streamer を再作成すると、同梱 C++ ライブラリを使う。
既定は `python` で従来の配信を維持する。ライブラリ欠落・ABI 不一致・未知の backend を黙って
Python へフォールバックしない。ビルドは通常の `make build streamer` に含まれる。

- C++ が rclcpp の best-effort / keep-last-1 購読、最新画像の保持、送信周期に応じた
  デコード・縮小・YUV 変換・VP8 エンコードを担当する。Python へ渡すのは圧縮済みパケットのみ。
  一つの stream につきエンコーダは一つで、全 client が同じ結果を使う。入力を後から処理する
  キューは作らず、変換中と待機中の入力、最後の正常画像、最新の圧縮済みフレームを保持する。
- Python は API、送信周期のスケジュール、接続ごとの RTP パケット化・暗号化・再送・WebRTC
  セッションを担当する。C++ にも送信周期の下限を設け、処理遅延後の追いつきバーストを防ぐ。
  client がゼロの間は変換・エンコードを停止する。ROS 受信は既存の idle reaper が stream を停止するまで続く。
- 実験版は **VP8 のみ**。native 時の H.264 capability は false。
  `CompressedImage` の JPEG/PNG と、raw `Image` の bgr8/rgb8/bgra8/rgba8/mono8/8UC1 を対象とする。
  raw のその他の形式・不正画像は変換エラーとしてログとカウンタに記録し、最後の正常画像を維持する。
  出力寸法はアスペクト比を維持して cap 内へ縮小し、YUV420 用に偶数へ切り下げる。
- 途中参加・PLI/FIR・フレームを読み飛ばした遅い client はキーフレームを要求する。遅い client のために
  他の client を待たせず、次のキーフレームから復帰させる。停止時は進行中の native 呼び出しを join してから
  ROS/codec を解放する。
- REMB は接続ごとに保持し、共有 encoder には参加 client の最小値を適用する
  （既定 500 kbps、250–1500 kbps に制限）。遅い回線の client が他の client の画質も下げ得る。
  異なる画質を同時に提供する simulcast や、接続ごとの独立した bitrate 最適化は実装しない。
  `bitrate_kbps` は従来どおり予約フィールドで、この実験でも適用しない。
- aiortc の private sender 接点を局所的に使用するため、native は **aiortc 1.14.0 固定**。
  別 version は offer 時に明示的に失敗させる。グローバルな monkeypatch は行わない。
- `/stream/status` の native stream には `processing` を追加する。
  `received` / `decoded` / `encoded` / `conversion_errors` はその source の累積値、
  `input_fps` は直近の ROS 受信率。Python backend の `processing` は null。
  `encoded` は全 client 共通のエンコード回数で、client 別の送信数・表示数ではない。

配布ライブラリの実 ROS・画質・再起動・RTCP 検証は
`services/webrtc_streamer/native/verify_native.py` を使う。Fast DDS と Cyclone DDS のそれぞれで、
通常運用から隔離した domain / network に実行する。共有キュー・遅い client・停止時の join は
`tests/test_shared_packets.py` が検証する。性能比較は同じ実 bag、FPS、画質、client 数を固定し、
同じ実験 image の `python` と `native` を切り替えて行う。

これは実験用バックエンドであり、CPU 削減率・長時間の安定性・全入力での画質同等性を保証しない。
ネイティブ FFmpeg/OpenCV の追加で image サイズが増える点も採否に含める。

### 実験: JPEG の縮小デコード

native backend は JPEG ヘッダーの元寸法から従来と同じ最終出力寸法を計算し、
その寸法を下回らない最大の縮小率（1/2・1/4・1/8）を OpenCV の JPEG デコードに適用する。
必要なら最後に従来どおり `INTER_AREA` で厳密な出力寸法へ縮小する。
元寸法が奇数でも、丸め後のデコード寸法から出力寸法を計算し直さない。
ヘッダー参照には TurboJPEG を使用する。PNG・raw・EXIF を含む画像は従来の経路を維持する。
JPEG ヘッダー不正は変換エラーとし、最後の正常画像を維持する。

送信 FPS・共有エンコード・WebRTC の挙動は変更しない。縮小デコードと全解像度デコード後の
縮小では画素値が異なるため、同画質を保証しない。`native/verify_scaled.py` が別の基準ライブラリと
最終 VP8 画像の寸法・差分を比較する（`BASELINE_LIBRARY` を指定）。

## 設計ポイント

- 低遅延優先・プレビュー専用。低画質を許容する。
- 正本記録ではない（記録の正本は `rosbag2_recorder`）。
