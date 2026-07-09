# デプロイ構成（配置トポロジ）— 別 PC からロボットを圧迫せずに記録する

> ステータス: 設計確定（v1）。日本語が正本（これを正とする）。英語版 `docs/specs/en/deployment_topology.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

> 別 PC（録画用 PC）から、画像など重いトピックを含む rosbag（MCAP）を記録しつつ、
> **ロボット本体のオンボードシステムを一切圧迫しない**ための配置設計。前提は**有線・同一 LAN**。
> 既存の単一ホスト構成（`compose.yaml`）は変更なしでそのまま動く（本構成は追加の「分割デプロイ」）。

## 1. 問題：リモート DDS 購読がロボットを圧迫する

kairos の 4 つの ROS サービス（`rosbag2_recorder` / `topic_monitor` / `topic_probe` / `webrtc_streamer`）は
DDS でトピックを**購読**する。これらを**ロボットとは別の PC**で動かすと、各サービスが
ロボットの DDS グラフ上の**リモート・リーダ**になる。画像（数 MB/フレームの `sensor_msgs/Image`）や
点群のような重いトピックでは、これがロボット側に次のコストを強いる:

- **NIC を重いペイロードが通過**するだけで、カーネル/UDP/IP フラグメンテーションの CPU と割込が発生
  （同一ホストの共有メモリ記録なら発生しない）。
- multicast が効かない経路では**リーダごとのユニキャスト送出コピー**が増える。
- **RELIABLE QoS のオーバーヘッド**（heartbeat / ACKNACK / 再送）が**リーダごと**に、しかも
  **パケットロス下では青天井**で増える。画像は publisher 側が RELIABLE 既定のことが多く、最悪値を踏む。

要点（codex・調査で確認）: ロボット側の主コストは「リーダ数ぶんの再シリアライズ」ではない（シリアライズは
sample あたり 1 回で、ローカル記録と同じ）。**重いデータがロボットの NIC を出ること自体**と、
**リーダごとの RELIABLE 再送**が効く。したがって、**重いデータがロボットの DDS から network に出る設計は
すべてロボットを圧迫する**（素のリモート購読、重トピックの domain_bridge、ロボット側 image_transport 圧縮も同様）。

> 競合 OpenLUTRA はこの問題を持つ: co-located 前提で、monitor が画像を含む全メッセージを**デコード**し、
> QoS を publisher に合わせる（画像で RELIABLE を継承）。別 PC 化すると重ストリームを二重に引き、再送嵐を誘発する。
> kairos の monitor は元から非侵襲（`raw=True`・非デコード・best_effort 自動整合）だが、**recorder は
> `ros2 bag record` でトピックを購読する**ため、別 PC 化では同じ問題に晒される。これが本設計の動機。

## 2. 設計方針：配置を明示して「境界」で分割する（既定 = Option A）

サービスを、DDS に触れるか否かの**自然な境界**で 2 群に分ける。

| サービス | DDS 購読 | 配置 | 理由 |
|---|---|---|---|
| `rosbag2_recorder` | ✓（`ros2 bag record`、`--all` で全トピック） | **ロボット** | 最大の負荷源。ローカル購読なら network 流出なし |
| `webrtc_streamer` | ✓（カメラ全フレーム→再エンコード） | **ロボット** | 大帯域。ロボット内で取得し、軽量化した映像だけ送る |
| `topic_probe` | ✓（選択トピックを decode） | **ロボット** | decode はフルペイロードを要する |
| `topic_monitor` | ✓（`raw`・非デコード） | **ロボット** | 最軽量だが、サイズ計測のため全バイトは受信する |
| `api_orchestrator` | ✗（httpx + SQLite + /data 読取） | **録画 PC** | DDS に一切参加しない |
| `dora_runner` | ✗（MCAP を `mcap` ライブラリで読む。CPU 重い） | **録画 PC** | 検証/変換は重い。ロボットでは回さない |
| `frontend` | ✗（nginx 静的 + リバプロ） | **録画 PC** | ブラウザの単一オリジン |

- **ロボット側 4 サービス**は、ロボットの DDS グラフを **host-networking + ipc:host の共有メモリ**で
  ローカル購読する（**追加の network 流出ゼロ**）。
- **録画 PC 側 3 サービス**は **DDS に一切参加しない**。よって別 PC で動かしても**ロボットを圧迫し得ない**。
- **境界を越えるのは軽量データだけ**: monitor のメトリクス/アラート（JSON/SSE, KB/s）、streamer の
  **既にエンコード済みの WebRTC プレビュー**（低レート）、記録済み **MCAP のファイル同期**（DDS ではない）。

> 保証の本質は「**録画 PC 側に DDS リーダを 1 つも置かない**」こと。重いデータがリモート DDS フローに
> ならない。これは imitation-learning 用のデータ収集（フル解像度で記録し、後で確認）に最適。

### 2.1 単一ホスト SHM の成立条件（重要 / 一部 **TBD**）

上の「ipc:host の共有メモリでローカル購読＝追加 network 流出ゼロ」は、**SHM が実際に効いているときだけ**成立する。効くかどうかは RMW ベンダで決まる:

- **Fast DDS（kairos 既定 `rmw_fastrtps_cpp`）**: SHM トランスポートが既定で有効。ロボット側 publisher も Fast DDS なら、`ipc: host`（設定済み）で同一ホスト購読は SHM に乗る。**追加作業なし。**
- **Cyclone DDS（`rmw_cyclonedds_cpp` に切替時）**: Cyclone の SHM は **Iceoryx（iox-roudi 常駐 + `<SharedMemory>` 設定、一般に SHM 有効のソースビルド）が別途必要**で、**kairos には同梱していない**。したがって Cyclone のロボットでは、**同一ホストでも各ローカルリーダが loopback UDP のフルコピー**を受け、大きなサンプル（画像等）は IP フラグメント化される。負荷でフラグメントが欠けると、受信側の decode で `sequence size exceeds remaining buffer`（CDR 長超過）系のエラーが出得る。
- 実測での確認: kairos 起動＋購読中にホストで `lo` の受信帯域を見る（例 `sar -n DEV 1`）。購読サービスを増やすたびにカメラ帯域×N で増えるなら SHM は効いていない。Fast DDS の SHM セグメントは `ls /dev/shm` で確認できる。

**Cyclone のまま（SHM なしで）緩和する — kairos 単独で可能:**

1. **受信バッファの拡大**（フラグメント欠落対策の第一手）: ホストで `sysctl -w net.core.rmem_max=67108864`（`rmem_default` も引き上げ）＋ `CYCLONEDDS_URI` の XML で `<Internal><SocketReceiveBufferSize min="16MB"/></Internal>` を指定（`/config` マウント経由で全 ROS サービスに届く。[config](config.md) の `CYCLONEDDS_URI`）。
2. **同時リーダの削減**: teleop など負荷が厳しい間は recorder 以外のリーダを減らす（monitor の `POST /metrics/pause`・プレビューを閉じる〔60s idle で自動停止〕・probe を使わない）。フルコピーの本数そのものを減らす。
3. **カメラは compressed のみ購読**（既定どおり）。raw の兄弟トピックを `--all` 等で巻き込まない。

**TBD**: Cyclone + Iceoryx の正式対応（iox-roudi の compose 同梱・XML 整備。ただし**ロボット側ノードにも SHM 有効化が必要**で kairos 単独では完結しない）は高工数のため未定。両側を Fast DDS に統一できる環境では、それが最小工数で SHM を成立させる。

**TBD（構成変更・要ユーザ判断・2026-07-09 追記）: kairos 自身の重複購読を 1 本に集約する。** 上の②「同時リーダの削減」は負荷が厳しい間だけ一部リーダを止める運用対策だが、恒常的な対策として recorder / topic_monitor / webrtc_streamer / topic_probe が同じ画像トピックを個別に購読している構成そのものを、1 プロセスが 1 回だけ購読しプロセス内で 4 用途に配る設計に変えれば、SHM の有無に関わらず kairos 側のフルコピー本数を最大 1/4 に減らせる（Iceoryx 対応を待たずに効く、kairos 単独で完結する）。ただし現行の「1 folder = 1 container」（4 コンテナ独立、[README](../../../README.md) 参照）を崩す規模の変更になるため要ユーザ判断。**ROS 2 コンポジション（`rclcpp_components` / component container）はこの用途には使えない**（調査済み: rclpy はコンポジション/intra-process comms 未実装〔`ros2/rclpy#575`, `#599`〕。また仮に対応していても、コンポジションは publisher と subscriber を同一プロセスに置ける場合にのみゼロコピーが効く仕組みで、publisher であるロボット側カメラドライバは kairos の管轄外の既存プロセスのため、そもそも合流できない）。

## 3. Option A（既定）: エッジ記録（recorder をロボットに置く）

### 3.1 構成ファイル
- `compose.robot.yaml` … ロボット側 4 サービスのみ（`compose.yaml` から `extends` で定義を再利用）。
- `compose.recording.yaml` … 録画 PC 側 3 サービスのみ。
- **profiles ではなく 2 ファイルに分けている**: 1 ファイル + profiles だと「DDS リーダを誤って録画 PC で
  起動」しやすい。**録画 PC のファイルにはそもそも DDS サービスが含まれない**ので、事故が起きない。

### 3.2 手順
ロボット:
```bash
# ロボットに本リポジトリを配置し、.env でロボットの ROS 2 グラフに合わせる
cp .env.split.example .env   # ROS_DOMAIN_ID / RMW_IMPLEMENTATION / ROS_DISTRO を編集
make robot-up                # または: docker compose --env-file .env -f compose.robot.yaml up -d --build
```
- `.env.split.example` に **「ROS 2 graph (robot side)」セクション**があり、`ROS_DOMAIN_ID` /
  `RMW_IMPLEMENTATION` / `ROS_DISTRO`（および任意の `CYCLONEDDS_URI` / `FASTRTPS_DEFAULT_PROFILES_FILE` /
  `MSGS_OVERLAY_DIR` / `BIND_HOST`）をここで設定する。`ROS_DISTRO` は **.env の値が Makefile 既定
  （jazzy）に勝つ**（イメージのタグ/ベースも切り替わる）。
- ネットワークはロボット側 4 サービスとも `network_mode: host` + `ipc: host`（`compose.yaml` から
  `extends` 継承）。HTTP API は `BIND_HOST`（既定 `0.0.0.0`）で bind し、録画 PC から LAN 越しに
  届く必要がある（信頼 LAN 前提。絞る場合はロボットの LAN インタフェース IP に）。
- gitignored な `config/local/<robot>/` を使うロボットは、各サービスが**起動時に committed →
  local の順で実在パスへ解決**するため、`make` を介さない素の `docker compose` でも解決される。
  ただしロボットのクローンに local ツリーそのものが無い場合は、録画 PC から `make push-config` で
  配布する（下記）。

録画 PC:
```bash
cp .env.split.example .env
# .env の ROBOT_IP をロボットの LAN IP に。*_HOST はそれを参照する。
docker compose -f compose.recording.yaml up -d --build    # または: make recording-up
```

### 3.3 コード上の継ぎ目（既定 localhost、後方互換）
- orchestrator: 下流サービスの **ホストを env 化**（`RECORDER_HOST` / `TOPIC_MONITOR_HOST` /
  `WEBRTC_HOST` / `TOPIC_PROBE_HOST` / `DORA_RUNNER_HOST`、既定 `localhost`）。
  実装 `libs/kairos_common/settings.py` + `services/api_orchestrator/app_factory.py`。
- nginx: アップストリーム **ホストを env 化**（`API_HOST` / `WEBRTC_HOST` / `PROBE_HOST`、既定 `127.0.0.1`）。
  `services/frontend/default.conf.template`。録画 PC では `WEBRTC_HOST` / `PROBE_HOST` をロボット IP に。
- `DORA_RUNNER_HOST` は録画 PC ローカルのまま（dora は重く、orchestrator と同居）。

### 3.4 MCAP の境界（重要）: NFS ではなく **記録後 rsync**
recorder は MCAP を**ロボットのディスク**に書く。dora（CPU 重い）は録画 PC で **PC ローカルの複製**を読む。

- **NFS で robot:/data をマウントして dora に直接読ませない**。dora が大きな MCAP を走査すると、
  ロボットがディスク/network を供給することになり、**記録中ならロボットを圧迫する**（本設計の趣旨に反する）。
- 既定は `make import-runs`（`deploy/sync/import_runs.sh`）: **finalise 済み（`metadata.yaml` がある）run のみ**を
  ロボットから rsync（`--partial --append-verify`、`BWLIMIT` で帯域制限可）。idempotent でタイマー実行も可。
  in-progress の run は半端にコピーされない。
- recorder にファイル POST はさせない（アップロード失敗が記録ライフサイクルに結合するのを避ける）。
- 注意: `dora_runner` の `dataset_export` は `recorded/` からファイルを **move** する
  （`dataset_export.py`）。**PC ローカルの複製に対しては安全**だが、**ロボット storage や read-only NFS を
  指すと破壊的**。必ず import 済みの PC ローカル複製に対して実行すること。

## 4. Option B（代替）: ロボット側 Zenoh ゲートウェイ（別 PC からライブ全データ記録）

別 PC で**ライブにフルデータ**を扱いたい（recorder を別 PC に置きたい）場合のみ。Option A より複雑で、
ロボット側に重いリーダ/ゲートウェイを 1 つ置くトレードオフがある。

- ロボットに `zenoh-bridge-ros2dds` を 1 つ置き、**ロボットの DDS を localhost に固定**する
  （CycloneDDS の `cyclonedds.xml` で `NetworkInterfaceAddress=lo`・`AllowMulticast=false`、または
  ROS 2 Iron+ の `ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST`）。
- すると**ロボットの publisher はローカルのリーダ（ブリッジ）1 つだけ**を見る。重いデータは**単一の
  TCP/QUIC セッションで LAN を 1 回だけ**渡る（リモート・リーダごとのファンアウトも RTPS 再送嵐も無い）。
- ブリッジの allow/deny でトピックを絞り、`--max-frequency "<regex>=<hz>"` で**カメラだけ間引く**（例: ロボットは
  フル、リモートは 10Hz）。圧縮は**リンクがボトルネックの時だけ**（ロボット CPU を食うので既定 off。間引きの方が安い）。
- スケルトン: `config/zenoh/`（ブリッジ設定）と `config/cyclonedds-localhost.xml` を雛形として用意（要環境調整）。
- **やってはいけない（隠れた圧迫）**: 重トピックの素のリモート購読 / 重トピックの domain_bridge /
  リモート記録のためだけのロボット側 image_transport 圧縮 / republisher ノード。

## 5. 注意点（pitfalls）

- **時刻同期**: ロボットと PC で chrony/PTP/NTP を。メッセージ stamp はロボット由来だが、UI/イベント時刻・
  転送・検証レポートの時刻は各ホスト時計に依存する。
- **WebRTC**: 本設計の前提（同一 LAN・有線）では動く。nginx が中継するのは**シグナリングのみ**で、
  RTP メディアは P2P。ブラウザは**ロボット IP に直接到達**する必要がある（同一 LAN なら満たす）。
  NAT/VPN 越えは別途 STUN/TURN が要る（aiortc は現状 host candidate のみ）。
- **config の同期**: orchestrator の Config タブ編集は**録画 PC の /config**に書く。一方 recorder/monitor は
  **ロボットの /config**を読む（recorder の `start_paused` / `max_cache_size_mb` / QoS はロボット側 config 由来。
  記録トピックの選択は start ペイロードで渡るので別）。**recorder の挙動を変えるにはロボットの config/ を
  編集して `make robot-config-reload` する**。gitignored な `config/local/<robot>/` は git で運ばれないため、
  録画 PC のコピーを **`make push-config`**（`deploy/sync/push_config.sh`、PC→ロボットの一方向 rsync、
  `DELETE=1` で削除も同期）でロボットのクローンへ配布する。config/ はデプロイ時資産として扱うのが安全。
- **プロキシ**: 録画 PC が corporate proxy 配下だと、Docker が全コンテナに `HTTP(S)_PROXY` を注入し、
  ロボット向け LAN 呼び出しやヘルスチェックがプロキシへ吸われて失敗する。kairos の HTTP は全て LAN 内部
  なので、compose が全サービスに `NO_PROXY`（既定 `localhost,127.0.0.1`、`.env.split.example` は
  `ROBOT_IP` も含む）を配り、orchestrator の内部 httpx クライアントは `trust_env=False` でプロキシ環境
  変数を一切見ない。
- **ロボットの電源断**: ホスト（録画 PC）側は落ちない。Recordings / Validation / Datasets / Config は
  ローカル完結で動き続け、Live/Graph は「robot offline」を明示する（orchestrator が monitor SSE ブリッジの
  up/down を `bridge` イベントとして UI に流す。ヘッダーの緑「DDS connected」はブリッジ up が条件）。
  ロボット向き呼び出しは connect 1s の fail-fast（/topics は約 2s で 503、nginx の /webrtc・/probe は
  `proxy_connect_timeout 3s`）。ノート PC を持ち出して後からデータ確認する運用を想定している。
  注意: Recordings 一覧は DB 参照のため、**別の orchestrator が録画した run** を `make import-runs` で
  持ち込んでも一覧には出ない（同じ PC の orchestrator で録画した run は出る）。
- **権限**: recorder が作る MCAP は root 所有。import 側（rsync ユーザ）が読めるよう UID/GID/umask を揃える。
- **セキュリティ**: 全サービスは信頼 LAN 前提で無認証。分割で公開面が増える点に注意（インターネット非公開）。

## 6. まとめ

「ロボットを圧迫しない」唯一の構造的解は、**重いデータをロボットの DDS から network に出さない**こと。
既定の **Option A（エッジ記録 + 配置分割）**は、録画 PC 側に DDS リーダを一切置かないことでこれを保証する。
別 PC からライブ全データが必要なときだけ **Option B（ロボット側 Zenoh ゲートウェイ + DDS localhost 固定）**を使う。
単一ホスト構成（`compose.yaml`）は従来どおり何も変えずに動く。
