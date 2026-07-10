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

**決定（要実装・2026-07-09 追記）: Iceoryx は追わず、`rmw_zenoh_cpp` を 3 つ目の RMW 選択肢として一般化する。** ロボット側の汎用化（機種ごとに RMW ベンダが異なりうる）を優先し、Cyclone + Iceoryx 統合ではなく、Zenoh 自前の共有メモリトランスポートで同一ホスト SHM を狙う方針に決定。
- パッケージは Jazzy（Noble）向けに apt から入手可能と確認済み（`ros-jazzy-rmw-zenoh-cpp`, packages.ros.org、`ros-jazzy-zenoh-cpp-vendor` 同梱）。既存の `rmw_fastrtps_cpp` / `rmw_cyclonedds_cpp` と同列の `RMW_IMPLEMENTATION` 選択肢として、ROS 側 4 サービスの Dockerfile に追加する必要がある（現状 Cyclone のみ同梱、`services/*/Dockerfile` の `ros-${ROS_DISTRO}-rmw-cyclonedds-cpp` 相当行）。
- **Zenoh も「env 切替だけ」では済まない**: DDS と異なり自動ピア探索ではなく、Iceoryx の `iox-roudi` に相当する**ルータプロセス（`rmw_zenohd`）が別途常駐している必要がある**。compose に 1 サービス追加する規模の作業で、Iceoryx（外部ソースビルド + XML 整備）よりは軽いが「追加作業なし」ではない。
- 上記§4 の Option B で使っている `zenoh-bridge-ros2dds`（DDS↔Zenoh の**ゲートウェイ**、クロスホスト用）とは別物。今回追加するのは `rmw_zenoh_cpp`（**RMW 実装そのもの**、DDS を介さない同一ホスト内トランスポート）で、両者は独立に共存できる。
- 未確認（実装前に潰す）: kairos のコンテナ構成（`network_mode: host` / `ipc: host`）で Zenoh の SHM プラグインが実際にゼロコピーに乗るか、ルータをどのコンテナに同梱するか、`RMW_IMPLEMENTATION=rmw_zenoh_cpp` 時に既存の `CYCLONEDDS_URI` / `FASTRTPS_DEFAULT_PROFILES_FILE` 相当の設定点（`ZENOH_ROUTER_CONFIG_URI` 等）をどう `.env`/`config/` に載せるか。
- 検証計画: [[record_start_two_phase_report]] の再現実験を拡張し、airoa サンプル bag をスケール（新規 OSS bag は探さない）した上で、Fast DDS / Cyclone DDS / Zenoh の 3 方式を横並びで計測する（Iceoryx は対象外のまま）。

**TBD（構成変更・要ユーザ判断・2026-07-09 追記）: kairos 自身の重複購読を 1 本に集約する。** 上の②「同時リーダの削減」は負荷が厳しい間だけ一部リーダを止める運用対策だが、恒常的な対策として recorder / topic_monitor / webrtc_streamer / topic_probe が同じ画像トピックを個別に購読している構成そのものを、1 プロセスが 1 回だけ購読しプロセス内で 4 用途に配る設計に変えれば、SHM の有無に関わらず kairos 側のフルコピー本数を最大 1/4 に減らせる（Iceoryx 対応を待たずに効く、kairos 単独で完結する）。ただし現行の「1 folder = 1 container」（4 コンテナ独立、[README](../../../README.md) 参照）を崩す規模の変更になるため要ユーザ判断。**ROS 2 コンポジション（`rclcpp_components` / component container）はこの用途には使えない**（調査済み: rclpy はコンポジション/intra-process comms 未実装〔`ros2/rclpy#575`, `#599`〕。また仮に対応していても、コンポジションは publisher と subscriber を同一プロセスに置ける場合にのみゼロコピーが効く仕組みで、publisher であるロボット側カメラドライバは kairos の管轄外の既存プロセスのため、そもそも合流できない）。
**2026-07-10 追記: この TBD は §5（Option C 審査）で裁定済み** — 集約は**非 recorder 3 消費者
（monitor/streamer/probe）に限り条件付き採用（任意）**、**recorder は構成的に集約外**（独立コンテナ・
独立 1 ホップ購読を維持）。現行の圧縮帯域では実測上急がない（購読 4 でもロス 0）。非圧縮化が実在化した時に
§5.3 の確定設計に従う。

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

## 5. Option C（審査済み・条件付き）: 境界ブリッジ 1 本化 — 恒久アーキテクチャとしては**棄却**、ゲート付き残余のみ採用

> 2026-07-10。発端: 「kairos の各コンテナが ROS トピックを個別購読するのは非効率で、今後 dora で複数の
> バリデーションを足すと通信がパンクするのでは」という懸念。一次評価基準を
> **「rosbag 記録中に、周囲の機能の影響で記録トピック周波数が落ちないこと」**に固定し、
> 敵対的レビュアー / 設計擁護者 / 裁定者（運用視点）の 3 エージェント討論で審査した。
> 定量根拠は単一ホスト・トランスポート実測 330+ セル
> （[sige0002/ros2-transport-bench](https://github.com/sige0002/ros2-transport-bench) の REPORT.md / REVIEW.md、
> および `dev_docs/performance_reports.md` §C）。討論の完全な結論のみをここに固定する。

### 5.1 原提案（審査対象）

ロボット側 egress `zenoh-bridge-ros2dds`（DDS を loopback 固定、Option B と同じ）＋ホスト PC 側 ingress
ブリッジが**ホスト専用 DDS ドメイン（例: 42）に再パブリッシュ**し、既存 4 コンテナ
（recorder/monitor/streamer/probe）は無改造で domain-42 を購読、新規バリデーションは
`ros_bridge` 1 本 → dora dataflow（Arrow+shm）→ validator×N。狙いは「物理リンク常に 1 コピー・
ロボット pub CPU 一定・バリデータ追加の限界コスト CPU のみ・コンテナ統合なし」。

### 5.2 討論の記録（要旨）

**批評の中核（乗算的サバイバルモデル、擁護側も統治原理として受諾）**:
`recorded_freq = source_publish_rate × Π(各ホップ生存率)`、各生存率 ≤ 1。**ホップは周波数を引くことは
できても足すことはできない**。Option A の recorder はカメラ→recorder の 1 ホップ（ローカル SHM）、
原提案 C は 3 ホップ（①robot egress ②LAN zenoh セッション ③domain-42 DDS 再パブリッシュ）で、
②③は未計測・②は TCP 輻輳でありチューニング不能。ゆえに **C の転送寄与は構造上 ≤0** であり、
C が正当化されるのは A が構造的に供給できない別要件（ライブ・クロスホスト消費）のときだけ。

| # | 論点 | 裁定 | 反映 |
|---|---|---|---|
| 1 | LAN zenoh セッションはチューニング不能な律速点（A に無いホップ） | 成立 | Stage-0 実測ゲート必須。`--max-frequency` の間引きは記録の逃げ道にしない（分母を落とす偽装） |
| 2 | domain-42 再パブリッシュは第 2 の DDS shed 点（購読者数非依存: 1MB 63〜71% / 10MB 73〜81% shed 実測） | 条件付き成立 | domain-42 は**圧縮・軽トピック限定**（allow-list を assertion 化）＋UDP 経路固定＋rmem 引き上げ。重・非圧縮は載せない |
| 3 | 計器汚染: ブリッジ越し bag は「ブリッジの出力」を記録し、源の周波数維持を bag から事後検証できない | 条件付き成立 | 受入試験の分母は**独立の publisher achieved レート**（driver 統計 or nominal）。**co-located best_effort 購読者を分母にしない**（それ自身 73% shed → 8Hz/8Hz=100% の偽 PASS を踏む） |
| 4 | ベンチ好成績（Zenoh ロス0）は `rmw_zenoh_cpp`（native RMW）の実測であり、C が使う `zenoh-bridge-ros2dds`（ゲートウェイ）は 1 セルも未計測 | **成立（決定的）** | REPORT の数値を根拠にブリッジを本番投入することを**禁止**。切り分け時も混同しない |
| 5 | 共有 ingress ブリッジが PC 側消費者の SPOF になる＋保証クラスが構成的（compose ファイル分離）→設定依存に格下げ | 成立（一次基準への影響は限定） | recorder はロボット上に残すため記録へは波及しない。loopback 固定は **fail-safe assertion**（落ちたらブリッジ起動拒否）に |
| (a) | ingress シム（DDS-42 再パブリッシュ）は移行足場として要るか | 条件付き成立 | 下記 5.3 の RMW 制約と 3 条件。**ゲートウェイとシムを区別する**ことが裁定の核心 |
| (b) | reliable カメラ publisher × reliable ブリッジ購読の**共有 writer 結合**（ブリッジ下流の詰まりがロボット上の recorder さえ絞る） | **成立（残存リスク中最重要）** | **reliable ingress を構成的に禁止**（検出したらブリッジ起動拒否）。源トピックは必ず best_effort 購読し、ロスなしが要る消費者へは「ブリッジ自身の writer への reliable 購読」で下流に閉じ込める（源のカメラ writer は実機ドライバ単一で構造上共有＝"専用 writer" は源では不可能）。＋ **source-integrity guard**（ブリッジ追加で publisher achieved レートが下がらないこと）を全 Stage の NO-GO ゲートに |

**討論が確定させた基礎制約（両討論者の見落としを裁定者が補完）**:
- **native rmw_zenoh は DDS パブリッシャを消費できない**（同一 RMW 両端の原則）。ロボットの publisher が
  DDS である限り、境界の `zenoh-bridge-ros2dds` は「撤去予定のシム」ではなく**恒久の境界翻訳器**。
  撤去可能なシムは **PC 側 DDS-42 再パブリッシュだけ**（PC 側消費者を rmw_zenoh 化すれば消える）。
- **best_effort 共有 writer は読者間結合を起こさない**（遅い reader は自分向けサンプルを落とすだけ）。
  兄弟が互いを飢えさせる結合は reliable でのみ生じる。
- **ロボット上記録も非圧縮域では無条件安全ではない**: 10MB@30Hz では best_effort ローカル reader も
  SHM リング上書きで ~73% shed する（rmem 非依存）。ロスなし記録には源側ノブが必須 —
  推奨は **rmem チューニング済み UDP 経路**（実測ロス 0%・テール増なし）、reliable QoS は
  p99 100〜222ms を許容できる場合のみ。
- **「終着点 = B native」は源が zenoh の時のみ到達可能**。DDS publisher のロボットにおける終着点は
  「ゲートウェイ（best_effort ingress）＋ PC 側 native rmw_zenoh ピア（DDS-42 全廃）」（same-RMW-both-ends 制約）。
- **ライブ重データ経路のインフラ前提を名指しする**: survival=1.0 の条件は「リンク帯域 > 持続ペイロード」。
  300MB/s なら 10GbE 級 or 送信元圧縮が硬前提。ベンチの 10MB@30Hz フル配送は loopback 値であり、
  実 NIC 越しは Stage-0 で実測するまで未実証。

### 5.3 総合裁定

**Option C（恒久アーキテクチャ）= 棄却。有用な残余のみ修正採用**（実質「A を system of record に固定＋
ゲート付きブリッジをライブ消費専用に限定」への収束）。

> 判断の中心事実: **現行の圧縮カメラ実データ（~5.6MB/s）では、どの構成・配置でも記録周波数は落ちない
> （実測、購読 4 でも全構成ロス 0）。** C の複雑性を正当化するのは非圧縮 10MB@30Hz 想定点だけであり、
> それは現行デプロイの実測ではない仕様値。**今 C を作る根拠はない。** トリガは「非圧縮/大解像度の実在化」
> で、その時ですら一次解は A ＋源側ノブ（rmem/QoS）。ブリッジは「ライブ PC 消費という名指しの硬要件」が
> 立った時のみ、ゲートを 1 段ずつ通して導入する。

**確定設計（修正採用の中身）**:
1. **recorder は常にロボット上（A 配置）**。源非侵襲とロスなし捕捉を両立できる唯一の配置。
   PC 側ブリッジ経由の記録は system of record にしない（作る場合もセカンダリ扱い）
2. 境界ゲートウェイの要否は「ロボット publisher の RMW」で決まる: DDS → ゲートウェイ恒久必須 /
   ロボットを zenoh 化できるなら native end-to-end でゲートウェイ不要
3. PC 側 DDS-42 シムは次の **3 条件が全て**揃うときのみ実装: (i) ロボット publisher が DDS かつ管轄外
   (ii) 再利用したい PC 側消費者が rmw_zenoh 未移植 (iii) **A+rsync で満たせない期日付きの
   live-PC 全データ記録要件が文書化されている**。無ければ作らない
4. 境界ブリッジは重・カメラトピックを **best_effort 購読固定**＋ source-integrity guard を NO-GO ゲート化
5. loopback 固定は fail-safe assertion（net-lo≈0 検査、失敗時はブリッジ起動拒否）＋domain-42 は専用ドメイン隔離
6. dora バリデータは **post-hoc・PC ローカル・finalise 済み run 限定**（§3.4 の rsync 複製を読む）。
   ライブ検証が要件化した時のみ、ブリッジ経路のゲートを通す
7. ロボット上に best_effort 非侵襲のレート監視を 1 本常駐（ブリッジ劣化時に監視まで共倒れさせない）
8. **reliable ingress 禁止を assertion 化**。reliable QoS は必ずブリッジ下流のみ（ブリッジ自 writer への
   reliable 購読）。源カメラ writer へ reliable reader を直付けする構成は起動拒否
9. Stage-0 の計測は**実 LAN（実 NIC・実スイッチ）越し**で、ブリッジ経路と native クロスホスト経路の
   **両方**を運用ペイロードで行う。「リンク帯域 > 持続ペイロード」を GO 条件に含める
10. §2 の TBD（重複購読の集約）は**非 recorder 3 消費者（monitor/streamer/probe）に限り条件付き採用（任意）**:
    ロボットのカメラ購読者 4→2 で recorder の周波数余裕を増やす。ただし **recorder は構成的に集約外**
    （独立コンテナ・独立 1 ホップ購読のまま）。集約ノードの結合（1 クラッシュ 3 停止）は再起動可能な
    プレビュー/監視クラスに閉じるため一次基準に非波及。「1 folder = 1 container」を崩す点は要ユーザ判断

### 5.4 受入条件（全 Stage 共通の測定式）

- `R_pub(T)` = publisher の achieved 発行レート。**出典は driver 統計 or nominal 設定レートに固定**
  （co-located best_effort 購読者を分母に使わない — 偽 PASS 回避）
- `F(T)` = 記録メッセージ数 / (R_pub × 窓長)
- 一次条件: 全記録トピックで **F(T) ≥ 0.99 を 10 分以上持続**、負荷条件
  {recorder 単独 / +monitor / +streamer（実 re-encode）/ +probe（実 decode）/ +dora validator（post-hoc 同時）/ 全同時} の各々で
- 結合条件（本件の懸念そのもの）: **F(全同時) ≥ 0.99 × F(recorder 単独)**
- source-integrity guard: 境界 reader を足しても R_pub 自体が下がらないこと。下がれば当該構成 NO-GO
- 測定は**圧縮 ~5.6MB/s と非圧縮 10MB@30Hz の両方**で行い、どちらで通したか明記

### 5.5 Stage ごとの go/no-go

- **Stage 0（ラボ特性評価、本番なし）**: GO = ブリッジ best_effort 固定＋**reliable ingress 不在（assertion）**で
  source-integrity guard 合格／実部品（zenoh-bridge-ros2dds）・**実 NIC・実スイッチ越し**・実ペイロードで
  through-bridge と native クロスホストの**両経路** F≥0.99（分母は独立 R_pub）／「リンク帯域 > 持続ペイロード」充足
  ／ロボット DDS の loopback 固定をバイトカウンタで検証／rollback を各ホスト 1 コマンドで実演。
  NO-GO = writer が絞られる・F<0.99・DDS が境界外へ漏れる → **A にフォールバック**
- **Stage 1（プレビューのみブリッジ経由、記録はロボット）**: GO = 全同時負荷（egress ブリッジ稼働込み）で
  ロボット bag の F≥0.99／domain-42 は圧縮・軽のみ／**ブリッジ kill 中もロボット bag がフルレート継続**を実演。
  集約ノード（確定設計 10）導入時は「recorder が集約外」を構成確認。
  NO-GO = ブリッジ稼働で recorder の F が単独比 1% 超低下 → プレビューは既存の軽経路に留める
- **Stage 2（PC ライブ全データ記録、名指しの硬要件がある時のみ進入）**: ロボット RMW を握れる →
  native rmw_zenoh に flag-day（DDS-42 シム省略）。ロボットが DDS → ゲートウェイ恒久＋PC 側は
  rmw_zenoh ピア優先、シムは 5.3-3 の 3 条件下のみ。GO = through F≥0.99 ＋ guard 合格＋
  **同時記録した on-robot A bag との忠実性 diff <1%**（両方録って突合）。
  NO-GO = いずれか不合格 → PC ライブ全データは提供せず、**A が system of record のまま**

## 6. 注意点（pitfalls）

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

## 7. まとめ

「ロボットを圧迫しない」唯一の構造的解は、**重いデータをロボットの DDS から network に出さない**こと。
既定の **Option A（エッジ記録 + 配置分割）**は、録画 PC 側に DDS リーダを一切置かないことでこれを保証する。
別 PC からライブ全データが必要なときだけ **Option B（ロボット側 Zenoh ゲートウェイ + DDS localhost 固定）**を使う。
単一ホスト構成（`compose.yaml`）は従来どおり何も変えずに動く。
**Option C（境界ブリッジ 1 本化）は 3 エージェント敵対的討論で審査済み（§5）**: 恒久アーキテクチャとしては
棄却。「記録は常にロボット上（A）、ブリッジはライブ PC 消費の硬要件が立った時のみゲート越しに」が確定。
現行の圧縮データ帯域では記録周波数はどの構成でも落ちない（実測）ため、今は何も作らないのが正解。
