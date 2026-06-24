# dora（dora-rs）参考リソース集

> 用途: kairos の `dora_runner` サービス（記録済み MCAP を入力に、検証 / 変換 / AI 処理を dora dataflow として実行する後処理パイプライン）を設計・実装するための、**実在を確認済みの** dora エコシステム資料リスト。
> 確認日: 2026-06-24。各 URL は web 取得で実在を確認した。dora は活発に開発されており、API・ドキュメント構成は変わりうる（特に Node Hub は unstable 扱い）。リンク切れ時は [dora-rs org](https://github.com/dora-rs) を起点に辿ること。
> 関連: [getting-started.ja.md](getting-started.ja.md)、[dora_runner 仕様](../specs/ja/dora_runner.md)。

## 1. 公式リポジトリ / ドキュメント

| リソース | URL | kairos での使いどころ |
| --- | --- | --- |
| dora 本体リポジトリ | https://github.com/dora-rs/dora | dora の正本。CLI・各言語 API・examples・ROS2 bridge などが 1 リポジトリに集約。`apis/python/node` が Python node API の実装。 |
| dora 公式サイト（ランディング） | https://dora-rs.ai/ | 概要・性能比較（"zero-copy shared memory" / Apache Arrow）・各種ドキュメントへの入口。 |
| dora Book（公式ガイド本体） | https://dora-rs.ai/dora/ | 現在の正本ガイド。Getting Started / Concepts / Language APIs / Operations / Advanced / Dora Hub / Development の章立て。kairos 実装時の一次情報源はここ。 |
| インストール手順 | https://dora-rs.ai/dora/getting-started/installation | `cargo install dora-cli` + `pip install dora-rs`、ワンライナーインストーラ、ソースビルド手順。`dora_runner` の Dockerfile を書く際の根拠。 |
| Quick Start | https://dora-rs.ai/dora/getting-started/quickstart | sender/receiver の最小 Python node + dataflow.yml + `dora run`。最初の動作確認に直結。 |
| Dataflow YAML 概念 | https://dora-rs.ai/dora/concepts/dataflow-yaml | node の `id` / `path` / `inputs` / `outputs` 記法。kairos の Pipeline Registry が管理する dataflow YAML の書式根拠。 |
| Rust node API リファレンス | https://docs.rs/dora-node-api | Rust 側 node API。kairos の backend は Python 前提だが、性能が必要な node を Rust 化する場合の参照。 |

> 注意: ドキュメントには `dora-rs.ai/dora/...`（Book 本体・正本）と `dora-rs.ai/docs/...`（別系統のガイド/ノード一覧サイト）の 2 系統が存在する。情報が食い違う場合は **Book（`/dora/`）を優先**し、最終的にはリポジトリのソース/README を正とする。

## 2. Python node の例（kairos の MCAP Loader / validator / converter node の雛形）

| リソース | URL | kairos での使いどころ |
| --- | --- | --- |
| python-dataflow 例 | https://github.com/dora-rs/dora/tree/main/examples/python-dataflow | `sender.py` / `transformer.py` / `receiver.py` + `dataflow.yml`。複数入力・PyArrow 配列・StructArray・イベント種別（INPUT/STOP）処理の最小実例。kairos の node I/O 契約（`metrics` / `artifacts` / `report` を後段へ渡す）の雛形に最適。 |
| examples ディレクトリ全体 | https://github.com/dora-rs/dora/tree/main/examples | 実在を確認した例: `python-dataflow` / `rust-dataflow` / `benchmark` / `ros2-bridge` / `ros2-comparison` / `multiple-daemons` / `python-yolo-detection` / `cuda-benchmark`。パイプライン構成パターンのカタログ。 |
| Python YOLO 検出例 | https://github.com/dora-rs/dora/tree/main/examples/python-yolo-detection | 画像入力 → 推論 → 検出結果出力という AI node の典型構成。kairos の「AI node を一級市民として差し込む」設計の最小手本。 |

## 3. Node Hub（再利用可能 node カタログ）

| リソース | URL | kairos での使いどころ |
| --- | --- | --- |
| dora-hub（コミュニティ node 集） | https://github.com/dora-rs/dora-hub | 既製 node を 1 行 YAML（`hub: <node>@<version>`）で取り込む仕組み。dora 本体とは別リポジトリ。kairos の Plugin Registry が参照しうる「外部 node の供給元」。 |
| Dora Hub 概要（Book） | https://dora-rs.ai/dora/hub/overview | Node Hub の使い方・node manifest・再現ビルド・publish 手順。kairos が独自 node を配布形態に乗せる場合の設計参照。 |

主な既製 node（dora-hub で確認、kairos の AI node 候補として有用）:

- **AI/ML**: `dora-yolo`（物体検出）、`dora-sam2`（セグメンテーション）、`dora-distil-whisper`（音声→テキスト）、`dora-qwen` / `dora-qwen2-5-vl`（LLM / VLM）、`dora-rdt-1b`（robotic diffusion transformer）。
- **センサ/カメラ**: PyRealsense、PyOrbbecSDK、OpenCV Video Capture、Kornia GST/V4L Capture。
- **可視化**: `opencv-plot`、Rerun（`dora-rerun`）。
- **学習データ収集**: `llama-factory-recorder`（LLM/VLM 学習用データの記録）。

> kairos の入力は**記録済み MCAP**なので、カメラ等のライブ取得 node はそのままは使わない。一方、`dora-yolo` / `dora-sam2` 等の **推論 node は、MCAP から取り出した画像を入力に流す形で再利用できる**（自動アノテーション / 品質スコアリング node の土台）。

## 4. ROS2 連携

| リソース | URL | kairos での使いどころ |
| --- | --- | --- |
| dora ROS2 bridge（本体内） | https://github.com/dora-rs/dora/tree/main/libraries/extensions/ros2-bridge | dora ⇔ ROS2 の双方向ブリッジ（実験的）。Apache Arrow ネイティブ変換・QoS マッピング。**ライブの ROS2 トピック（DDS）**を dataflow に取り込む用途。 |
| 旧 dora-ros2-bridge リポジトリ（archived） | https://github.com/dora-rs/dora-ros2-bridge | 上記に統合・アーカイブ済み。歴史的経緯の参照のみ。新規参照は本体内の方を見ること。 |
| ROS2 Bridge 解説（discussion） | https://github.com/orgs/dora-rs/discussions/306 | bridge の設計意図・DDS 経由の受信方針などの背景。 |

> 重要: **dora の ROS2 bridge は「ライブの ROS2 トピック」を対象**であり、**記録済み MCAP ファイルを読む機能ではない**。kairos の `dora_runner` は仕様どおり、ブリッジを使わず **`mcap` + `mcap-ros2-support` でファイルを直接読む**（`rclpy` 不要）。本ブリッジは kairos では「将来ライブ取り込みを足す場合の選択肢」に留まる。

## 5. MCAP 読み込み（kairos の MCAP Loader が直接使うライブラリ）

| リソース | URL | kairos での使いどころ |
| --- | --- | --- |
| MCAP Python リーダー（汎用） | https://mcap.dev/docs/python/mcap-apidoc/mcap.reader | `mcap` パッケージの低レベルリーダー。topic / 型 / 時刻 / サイズの取得など、decode 不要のメタ走査に使う（`fast_validation` の土台）。 |
| mcap-ros2-support リーダー | https://mcap.dev/docs/python/mcap-ros2-apidoc/mcap_ros2.reader | `read_ros2_messages(source, topics=..., start_time=..., end_time=...)` で ROS2 メッセージを decode しつつ反復。topic フィルタ・時間範囲指定が引数で可能 = kairos の node I/O 契約「MCAP メッセージ反復子（topic フィルタ・時間範囲指定可）」をそのまま満たす。 |

> dora 自体の記録/再生は **`.drec` 形式**（dora 独自の record/replay node）であり、**MCAP ではない**。kairos は正本記録を MCAP に固定しているため、dora の record/replay には依存せず、上記 `mcap` 系ライブラリで読む。

## 6. AI / 学習用データセット変換（LeRobot 連携）

| リソース | URL | kairos での使いどころ |
| --- | --- | --- |
| dora-lerobot | https://github.com/dora-rs/dora-lerobot | dora で LeRobot 互換ハードウェア（アーム・カメラ）を操作・記録・再生し、**LeRobot dataset 形式**で扱うパイプライン群。robots/ 配下に Aloha・Reachy 等の構成例。kairos の `dataset_convert`（MCAP → LeRobot 形式）node の最有力参考実装。 |
| HuggingFace LeRobot 本体 | https://github.com/huggingface/lerobot | LeRobot dataset 形式・学習（ACT 等）・推論の本家。kairos が出力する「学習用データセット形式」の正本仕様。 |
| dora-record → LeRobot 変換 PR（#197, **closed**） | https://github.com/huggingface/lerobot/pull/197 | dora-record データを LeRobot 形式へ変換するスクリプトの初期 PR。**マージされず #201 に置き換え**。当時の変換アプローチの参考（実装そのものは追従先を確認すること）。 |

> kairos での位置づけ: `dataset_convert` パイプラインは「MCAP（正本） → LeRobot 形式」を担う。LeRobot 形式の正は HuggingFace 本家、変換の dora 実装パターンは dora-lerobot を参照する。`params.model` 差し替え・GPU 利用・report へのバージョン記録という kairos の AI node 契約に合わせて作る。

## 7. 補助・コミュニティ資料（一次情報ではないが理解の助け）

| リソース | URL | 注意 |
| --- | --- | --- |
| DeepWiki: dora-rs/dora | https://deepwiki.com/dora-rs/dora | 自動生成の解説 wiki。全体像把握に便利だが**一次情報ではない**。実装判断は公式 Book / ソースで裏取りすること。 |
| DeepWiki: node-hub | https://deepwiki.com/dora-rs/node-hub | node 開発の流れの俯瞰。同上の注意。 |
| FOSDEM 2024 スライド | https://archive.fosdem.org/2024/events/attachments/fosdem-2024-3225-dora-rs-simplifying-robotics-stack-for-next-gen-robots/slides/22303/dora-fosdem_05S0HAi.pdf | dora の設計思想プレゼン（2024）。背景理解用。内容は当時時点。 |

---

## kairos `dora_runner` への対応まとめ

- **node 雛形** → `examples/python-dataflow` をベースに、入力（run パス / MCAP 反復子 / params）→ 出力（metrics / artifacts / report）の契約を被せる。
- **MCAP 読み込み** → dora 機能ではなく `mcap` + `mcap-ros2-support`（[セクション 5](#5-mcap-読み込みkairos-の-mcap-loader-が直接使うライブラリ)）。ROS2 bridge は使わない。
- **AI node** → dora-hub の推論 node（`dora-yolo` 等）と `python-yolo-detection` 例を手本に、`params.model` 差し替え可能な node として実装。
- **dataset_convert** → dora-lerobot + HuggingFace LeRobot を参照。
- **dataflow 接続** → Dataflow YAML 概念ページの記法に従い、Pipeline Registry が YAML を管理。
