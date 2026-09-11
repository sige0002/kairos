# dora_runner プラグイン


## 利用者が用意するもの

プラグイン作者は以下の定義・コード・依存を用意し、導入担当者はイメージをビルドして実行環境へ反映する。同じ人が両方を担当してもよい。ホストにpipで入れたパッケージは、コンテナへ自動的には引き継がれない。

| 担当 | 必須／条件付き | 用意・確認するもの |
| --- | --- | --- |
| 作者 | 必須 | `kairos_plugin.yaml`。一意なid、表示名、entrypoint、入力フォームの`params_schema`、versionを記載する |
| 作者 | 必須 | dora形式なら`dataflow.yml`と全ノード、callable形式なら`module:function`の実装。ノードは有限バッチとして終了する |
| 作者 | 必須 | 終端で`KAIROS_REPORT_DIR/summary.json`を出力する。pipeline名・version・判定・metricsを自分の実装に合わせる |
| 作者 | 追加Python依存がある場合 | `requirements.txt`またはインストール可能な`pyproject.toml`。ローカルwheelやヘルパーパッケージも同梱する。固定に使う`uv.lock`はpyprojectと同期する |
| 作者 | OS依存がある場合 | マニフェストの`requires.apt`／`requires.build_apt`。実行時に必要なライブラリをbuild_aptだけに書かない |
| 作者 | モデル・辞書などを読む場合 | 必要なファイルを同梱し、コードから参照する。モデルの取得・配置は依存インストーラが自動では行わない |
| 作者 | GPUを使う場合 | `requires.gpu: true`と、利用するCUDA対応パッケージ等の依存宣言 |
| 導入担当者 | 必須 | 対象CPUアーキテクチャに合ったビルド環境、Docker／Compose、ビルド時の依存取得先への接続、イメージ用の空き容量 |
| 導入担当者 | GPUを使う場合 | NVIDIA GPU・ドライバ・Container Toolkit、`gpus`設定を扱えるCompose、buildとupの両方で`PLUGIN_GPU=1` |
| 作者・導入担当者 | 必須 | kairosで利用可能な検証用captureと、期待する判定・値。実ジョブの完了と成果物を確認する |

`process(inputs, ctx)`だけでは実doraノードとしては動かない。dora形式では`dora.Node`のイベントループと起動入口が必要で、`process`はdoraなしの互換実行を使いたい場合に追加する。コピー元の`hello_kairos/nodes/greet.py`と`writer.py`に両方の実装がある。

## 構成と利用者側の境界

```text
dora_runnerコンテナ
├─ /opt/venv/                 サービス本体・固定済み共通ランタイム
├─ /app/plugins/<name>/      プラグインの定義・コード・同梱ファイル
└─ /opt/plugin-envs/<id>/    追加依存のあるプラグイン専用Python環境
```

Python環境は分けるが、コンテナ・OSライブラリ・データマウントは共有する。信頼できるコードを導入し、入力captureを書き換えず、出力は指定レポート領域へ書く。これはプラグインの権限を分離するサンドボックスではない。

## 1. 対象と実行契約

独自pipelineは `services/dora_runner/plugins/<name>/` に配置し、`make build dora_runner` → `make up dora_runner` で組み込む。マニフェストから起動時に登録され、入力フォームと `summary.json` の結果表示は既存のValidation画面が生成する。コアやfrontendの編集は不要。

これは **ビルド時に依存を組み込む方式**。実行時のpipインストール、外部リポジトリからのダウンロード、プラグインディレクトリのホットリロードは行わない。ネット接続できるビルド環境でイメージを作り、オフラインの実行環境へ搬入できる。

対応する実行形式:

- `executor: dora` と `entrypoint.dataflow`: Pythonスクリプト／実行ファイルのカスタムノードからなるdoraグラフ。実イメージはdora 0.5の専用coordinator/daemonへ接続して完了を待つ。
- `executor: in_process` と `entrypoint.callable`: `module:function`。Python依存を宣言した場合は専用Pythonプロセスで呼び出し、サービス本体にimportしない。
- dora CLIがないソース環境では、グラフをトポロジカル順に実行する互換インタプリタを使用する。依存環境がある場合、この互換処理もその環境の別プロセスで動く。

このプラグイン契約はローカルの `path` を持つカスタムノードを対象とする。リモートURLのnodeやPython operator形式はビルド時に拒否する。実行ファイルはプラグイン内に同梱するか、宣言した依存から提供する。

基準PythonはイメージのPython 3.12。別のPythonメジャー／マイナーバージョンやOSを要求するプラグインを自動的に別コンテナへ配置する機能はない。

## 2. 最小構成

```text
plugins/my_validator/
  kairos_plugin.yaml
  dataflow.yml
  nodes/check.py
  requirements.txt             # Python依存を追加するとき
```

```yaml
apiVersion: kairos.plugin/v1
id: my_validator
name: My validator
description: Check one capture.
executor: dora
version: 0.1.0
required_inputs: [capture_id]
params_schema:
  type: object
  properties:
    threshold: {type: number, default: 0.5}
outputs:
  - "report/my_validator/<capture_id>/summary.json"
entrypoint:
  dataflow: dataflow.yml
requires:
  gpu: false
  apt: []
  build_apt: []
```

`id` は `^[a-z0-9_]+$` で、他のプラグインや同梱pipelineと重複させない。未認識のマニフェスト項目・依存要件はエラーにする。

```yaml
nodes:
  - id: check
    path: nodes/check.py
    inputs:
      tick: dora/timer/millis/100
```

ソースノードにはtimer等のトリガーが必要。有限バッチとして結果を書いて終了する。

### ノードへの入力と出力

各ノードの環境変数にジョブごとの値が渡る:

| 変数 | 内容 |
| --- | --- |
| `KAIROS_CAPTURE_ID` | 対象のUUIDv7 |
| `KAIROS_DATA_DIR` | データルートの絶対パス |
| `KAIROS_REPORT_DIR` | このpipeline・captureのレポート出力先 |
| `KAIROS_PARAMS_JSON` | 検証済みパラメータのJSON |

ノードは `objects/<capture_id>/` を読み、終端ノードが `KAIROS_REPORT_DIR/summary.json` を生成する。必須の結果契約は `{pipeline, version, result, metrics, ...}`。判定の `result` は `pass` または `fail`。成果物はレポート配下のファイルとして返す。captureの存在確認はレポートディレクトリ作成より先に行い、削除済みcaptureを再作成しない。

互換インタプリタ用のノード関数は `process(inputs, ctx) -> dict`。`ctx` は `plugin_id / capture_id / data_dir / params / report_dir` を持つ。callableは `(capture_id, data_dir, params, report_dir) -> None` で、同じsummaryを書き出す。

インストール済みプラグインは読み取り専用。dora用descriptorとログはジョブ別の書き込み可能な一時領域へ作り、元のソースを変更しない。ノード相対パスは元のプラグイン配置から解決する。添付した読み取り用ファイルは、作業ディレクトリではなく `Path(__file__)` を基準に参照する。

## 3. Python依存

### requirements.txt

```text
humanize==4.10.0
```

プラグインの `requirements.txt` をビルド時に読み、専用venvへインストールする。相対パスのローカルwheel等はプラグインディレクトリを基準に解決する。再現性が必要な依存はバージョンを固定する。

### pyproject.toml

Pythonパッケージとして配布する場合は、ビルド可能な `pyproject.toml` を配置する。プロジェクト自体とその依存を専用venvにインストールする。

```toml
[build-system]
requires = ["hatchling==1.27.0"]
build-backend = "hatchling.build"

[project]
name = "my-validator-helpers"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["humanize==4.10.0"]

[tool.hatch.build.targets.wheel]
packages = ["my_helpers"]
```

`my_helpers/` にパッケージを置き、ノードからimportできる。`uv.lock` があれば `uv export --locked --no-dev --no-emit-project` で固定済み依存を取り出し、プロジェクトと一緒にインストールする。pyprojectとlockが不一致ならビルドを止める。requirements.txtも存在する場合は、両方を一回の解決に渡すので、不整合はエラーになる。

### 環境分離と互換性

- 追加依存のあるプラグインごとに `/opt/plugin-envs/<id>/` を作成する。異なるプラグインが同じライブラリの異なるバージョンを利用できる。
- 専用venvからイメージの固定済みランタイムパッケージを参照する。追加・上書きされたPythonパッケージはそのvenvだけに入り、サービス本体と他のプラグインを書き換えない。
- doraの通信／共通契約を保つため、`dora-rs`・`pyarrow`・`kairos-common` はランタイムのバージョンを制約として適用する。
- 依存宣言のない同梱hello系等は、既存の共通ランタイムを使用する。
- 解決済みバージョンは各venvの `requirements.resolved.txt` に保存する。宣言のない動的importの完全性までは自動検証できないため、実際のジョブ実行も検証する。
- 依存宣言があるのにビルド済みvenvがないプラグインは、利用可能なpipelineとして登録しない。ソース環境の起動時にも勝手にインストールしない。

## 4. OSライブラリとGPU

```yaml
requires:
  apt: [libmagic1]          # ビルド時と実行時の両方に必要
  build_apt: [gcc]         # Python拡張等のビルド時だけ必要
  gpu: false
```

OS依存はDebianパッケージ名（必要ならバージョン・アーキテクチャ付き）で宣言する。インストール不能ならDocker buildを失敗させる。OSライブラリはイメージ共通であり、Pythonのvenvのようなバージョン分離はしない。競合するOS要件は同じイメージに同居できない。任意のaptリポジトリ追加やホストへのパッケージインストールは行わない。

GPUプラグインは `requires.gpu: true` とし、明示的に次を実行する:

```bash
make build dora_runner PLUGIN_GPU=1
make up dora_runner PLUGIN_GPU=1
```

Makeは `compose/plugins.gpu.yaml` を追加し、GPU依存のビルドを許可、実行時はdora_runnerに `gpus: all` を指定する。継続使用する場合は `.env` に `PLUGIN_GPU=1` を設定する。通常構成にはGPU要求を追加しない。GPUプラグインを含むビルドでopt-inがなければ、理由を示して止める。

これはNVIDIA GPUとNVIDIA Container Toolkitがホストに導入済みであることを前提とする。CUDA対応のPythonパッケージ等はプラグイン側で宣言する。GPUハードウェア・ドライバの導入やGPUモデル間の互換性を自動解決するものではない。

## 5. ビルド・実行・失敗時

1. マニフェスト、ノード、依存宣言をフォルダへ配置。
2. `make build dora_runner`。依存のインストール、整合性チェックまで成功させる。
3. `make up dora_runner`。Validation画面にプラグインが追加される。
4. 検証用captureを選んで実行し、結果・入力値・成果物を確認。

エラーを `|| true` で無視するインストールは行わない。Python依存の解決失敗はプラグイン名を含むエラーでビルドを止める。実行時のプラグインプロセスにはtimeout／cancelを適用し、doraのcleanupはそのジョブ名だけを対象にする。他のプラグインや録画をまとめて停止しない。

同梱例 `hello_kairos` は最小の挨拶、`hello_dora` はMCAPのトピック別件数集計。依存付きのテスト用例は `services/dora_runner/tests/fixtures/dependency_plugins/` に置く。通常イメージへテスト用例を含める必要はない。

`make test-plugin-dependencies` は依存付きのテスト用イメージをビルドし、ネットワークなし・一時データ領域のコンテナで、異なるPython依存バージョン・OSライブラリ・パッケージ化したヘルパーを実行検証する。

## 6. 導入後の確認とトラブル対応

1. `make logs dora_runner`で起動・プラグイン登録エラーを確認する。
2. Validation画面で自分のpipelineを選び、指定したフォーム項目が表示されることを確認する。
3. 検証用captureへ期待値が分かる入力で実行する。hello系も有効なcaptureの選択は必要。
4. ジョブ完了、summaryの判定・metrics、画像等の成果物を確認する。検査で異常を見つけた`result: fail`と、例外・timeoutによるジョブ自体の失敗を区別する。
5. コードや依存を変えたら、再度`make build dora_runner` → `make up dora_runner`を行う。再起動だけではイメージに取り込まれない。

| 症状 | 利用者が確認すること |
| --- | --- |
| ビルド中に依存解決が失敗 | ログのプラグイン名、パッケージ名・固定版、Python 3.12との互換性、requirementsとpyprojectの矛盾を確認する |
| uv.lockが古い | 意図した依存変更を確認して作者の環境でlockを更新し、pyprojectと一緒に配置して再ビルドする |
| pipelineが表示されない | 配置が直下の子フォルダか、manifestの項目・idが有効か、イメージを再ビルド・再作成したか、登録エラーがないかを確認する |
| `ModuleNotFoundError`／共有ライブラリ不足 | Python依存の宣言漏れ、OS実行用依存の宣言漏れ、同梱ファイルの参照先を確認する |
| summaryがない／ジョブが終了しない | doraイベントループ・timer・終端処理、出力先環境変数、ノードの例外を確認する |
| GPUを要求するエラー | manifestだけでなくbuild／upのopt-inとホスト側のGPU準備を確認する |

`make test-plugin-dependencies`は同梱の依存テスト用例を検証するコマンドであり、追加したユーザープラグインを自動で網羅するものではない。自分のプラグインは上記の実ジョブ確認を行う。
