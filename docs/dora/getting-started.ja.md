# dora 入門ガイド（kairos `dora_runner` 向け）

> 対象: dora を初めて触る人。dora の概念 → 最小 Python node → dataflow 実行 までを一通りなぞり、最後に kairos の `dora_runner` 設計へどう写像されるかを示す。
> 確認日: 2026-06-24。コマンド・API は公式（[dora Book](https://dora-rs.ai/dora/)）で裏取り済み。dora は活発に更新されるため、相違時は公式を正とする。
> 関連: [resources.ja.md](resources.ja.md)（実在確認済みリソース集）、[dora_runner 仕様](../specs/ja/dora_runner.md)。

## 1. dora とは

**dora（dora-rs / Dataflow-Oriented Robotic Architecture）** は、ロボティクス・AI アプリを **データフロー（有向グラフ＝パイプライン）** として組み立てるためのミドルウェア。中核は Rust 製で、node 間のデータは **Apache Arrow** 形式で受け渡し、共有メモリによる **zero-copy** で低レイテンシを狙う。

kairos にとっての要点は次の 2 つ:

- **処理を node（部品）に分割し、YAML で配線するだけでパイプラインになる** → 検証 / 変換 / AI 処理を差し替え・連結しやすい。
- **Python で node を書ける** → kairos の backend（Python 前提）と相性が良い。

公式: https://github.com/dora-rs/dora / https://dora-rs.ai/

## 2. コア概念

| 概念 | 説明 |
| --- | --- |
| **Dataflow（YAML）** | アプリ全体の定義。どの node を、どんな入出力で繋ぐかを宣言的に書く。kairos では 1 pipeline = 1 dataflow YAML。 |
| **Node** | 独立したプロセスとして動く処理単位（Python スクリプト等）。`inputs` を購読し、`outputs` を発行する。 |
| **Operator** | dora ランタイム内で動く軽量版の処理単位。プロセスを分けない分だけ軽い。まずは node から入るのが分かりやすい。 |
| **Input / Output** | node 同士は名前付きの入出力で接続する。入力側は `<node-id>/<output-name>` で「どの node のどの出力を購読するか」を指定する。 |
| **Apache Arrow** | node 間でやり取りするデータの形式。Python では PyArrow（`pa.array(...)` 等）を使う。 |

Dataflow YAML の記法: https://dora-rs.ai/dora/concepts/dataflow-yaml

## 3. インストール

```bash
# dora CLI（dora コマンド本体）
cargo install dora-cli

# Python の node/operator API
pip install dora-rs        # PyPI パッケージ名は dora-rs。import 名は dora
```

ワンライナーインストーラ（CLI のみ、cargo 不要）:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/dora-rs/dora/releases/latest/download/dora-cli-installer.sh | sh
```

確認:

```bash
dora --version
dora status
```

出典: https://dora-rs.ai/dora/getting-started/installation

## 4. 最小の Python node 例（Hello World）

送信 node と受信 node を 1 本の dataflow で繋ぐ最小構成。

**sender.py** — 0〜99 を順に送る:

```python
import pyarrow as pa
from dora import Node

node = Node()
for i in range(100):
    node.send_output("message", pa.array([i]))
```

**receiver.py** — 受け取って表示する（イベントループ）:

```python
from dora import Node

node = Node()
for event in node:
    if event["type"] == "INPUT":
        values = event["value"].to_pylist()
        print(f"Received {event['id']}: {values}")
    elif event["type"] == "STOP":
        break
```

**dataflow.yml** — 2 つの node を配線:

```yaml
nodes:
  - id: sender
    path: sender.py
    outputs:
      - message

  - id: receiver
    path: receiver.py
    inputs:
      message: sender/message      # sender の "message" 出力を receiver の "message" 入力に繋ぐ
```

ポイント:

- node は `from dora import Node` → `node = Node()` で起動し、`for event in node:` でイベントを受ける。
- イベントは種別を持つ（`INPUT`=入力到着、`STOP`=停止要求）。`event["id"]` でどの入力かを判別、`event["value"]` が Arrow データ。
- 出力は `node.send_output("<output 名>", <pyarrow 配列>)`。

出典: https://dora-rs.ai/dora/getting-started/quickstart

## 5. dataflow の実行（dora CLI）

ローカルで 1 本動かす最短手:

```bash
dora run dataflow.yml
```

分散・常駐実行する場合（運用寄り）:

```bash
dora up                      # coordinator / daemon を起動
dora start dataflow.yml      # dataflow を開始
dora stop                    # 停止
```

> node ごとに依存環境を分けたい場合は、YAML の `build:` 指定や `--uv` による per-node 環境管理が使える（`examples/python-dataflow` に実例あり）。dora 自体の記録/再生は `.drec` 形式（dora 独自）であり、**MCAP ではない**点に注意。

## 6. kairos `dora_runner` への写像

前節までのコマンドは単体のdora入門用。kairosでは専用coordinator/daemonとビルド時の依存管理を使うため、プラグイン導入は[利用者向け手順](../../services/dora_runner/plugins/README.ja.md)に従う。

kairos の `dora_runner` は「記録済み MCAP を入力に、検証 / 変換 / AI を非同期ジョブで実行する」コンテナ。dora の概念は次のように対応する（詳細は [dora_runner 仕様](../specs/ja/dora_runner.md)）。

| dora | kairos `dora_runner` |
| --- | --- |
| Dataflow（YAML） | dora形式のpipeline。組み込みbagflow検証と独自プラグインに使用する。Python callable形式のpipelineもある。 |
| Node | データフロー内のローカルカスタムノード。kairosが自動登録する単位はノード個別でなく`kairos_plugin.yaml`を持つpipeline。 |
| Input / Output | `KAIROS_CAPTURE_ID` / `KAIROS_DATA_DIR` / `KAIROS_REPORT_DIR` / `KAIROS_PARAMS_JSON`をノードへ渡す。作者がMCAP読み込み・ノード間通信を実装し、終端でsummaryを出力する。 |
| Operator | kairosの現在のプラグイン契約では非対応。ローカル`path`のカスタムノードを使う。 |

### MCAP の読み込み（重要）

入力は **記録済み MCAP**。dora の ROS2 bridge（ライブ DDS 向け）や `.drec` 再生は使わず、**`mcap` + `mcap-ros2-support` で MCAP を直接読む（`rclpy` 不要）**。topic フィルタ・時間範囲は `read_ros2_messages()` の引数でそのまま指定できる:

```python
# MCAP Loader node 内のイメージ（概念例）
from mcap_ros2.reader import read_ros2_messages

for msg in read_ros2_messages(
    "/data/objects/<capture_id>/<capture_id>_0.mcap",
    topics=["/joint_states", "/camera/head/image_raw"],  # 必要 topic だけ
    # start_time / end_time で時間範囲も指定可
):
    decoded = msg.ros_msg          # decode 済み ROS2 メッセージ
    topic = msg.channel.topic
    t = msg.log_time
    # ... validator / converter / AI node へ Arrow 化して送る
```

メタ情報だけ（topic 一覧・型・時刻・サイズ）が欲しい場合は decode 不要の低レベルリーダー（`mcap` パッケージ）で走査する。kairosの`fast_validation`はbagflowの`topic-presence`ノードが`metadata.yaml`のトピック名・型を照合し、MCAP本体をデコードしない。

出典: https://mcap.dev/docs/python/mcap-ros2-apidoc/mcap_ros2.reader

### AI node を一級市民として差し込む

推論 / 自動アノテーション / 品質スコアリング / 学習用データセット変換（例: **LeRobot** 形式）を **AI dora node** として配線する。手本は dora-hub の推論 node（`dora-yolo` 等）と `examples/python-yolo-detection`、データセット変換は `dora-lerobot`（[resources.ja.md](resources.ja.md) 参照）。

独自AIプラグインで作者が用意するもの:

- モデルは差し替え前提（`params.model` 等）。
- モデルファイルとPython／OS依存を用意する。GPUは`requires.gpu: true`と`PLUGIN_GPU=1`、ホストのGPU環境が必要。
- 再現性のため、`report` に pipeline / node / モデルのバージョンを記録する。

### kairosで現在使えるもの

組み込みpipelineは`fast_validation` / `full_validation` / `loss_report` / `clock_check` / `video_check` / `signal_report`。例として`hello_dora` / `hello_kairos`を同梱し、独自プラグインは依存を含めてビルド・登録できる。`dataset_convert` / `dataset_validation`は未実装で、任意のLeRobot exporterは別サービス。

依存の分離範囲、Python 3.12の前提、実ジョブの確認は[プラグイン仕様](../specs/ja/dora_plugins.md)を参照。

---

## まとめ

1. dora = node を YAML で配線するデータフロー基盤。Python node が書ける。
2. node は `Node()` + `for event in node:` + `send_output(...)` の 3 点で書ける。
3. `dora run dataflow.yml` で動く。
4. kairosはpipeline単位でプラグインを登録し、dataflow内のノード入出力とsummaryを契約として扱う。**MCAP は dora 機能でなく `mcap` 系ライブラリで直接読む**。AI node を一級市民として扱う。
