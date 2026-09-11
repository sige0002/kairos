# dora_runner プラグインの追加手順

独自プラグインは、定義・実装・依存宣言をこのディレクトリの子フォルダへ置き、イメージを再ビルドして導入する。Validation画面のフォームと結果表示は自動生成される。

## 作者が用意するもの

- `kairos_plugin.yaml`: 他と重複しないid、表示名、version、entrypoint、`params_schema`。
- dora形式なら`dataflow.yml`と全ノード。`dora.Node`のイベントループを実装し、有限バッチとして終了する。callable形式なら`module:function`の実装。
- `summary.json`を指定されたレポート出力先へ書く終端処理。
- 追加Python依存は`requirements.txt`またはインストール可能な`pyproject.toml`。`uv.lock`を使う場合はpyprojectとの整合性も維持する。
- OS依存は`requires.apt`、ビルド専用依存は`requires.build_apt`。モデル・辞書・ローカルwheel等の必要なファイルも用意する。

基準環境はPython 3.12。追加Python依存はプラグイン別venvへ入るが、OSとデータ領域は共有する。入力captureを変更せず、出力は`KAIROS_REPORT_DIR`へ書く。

## 導入担当者が行うこと

リポジトリのルートから実行する。`my_plugin`は未使用の名前に置き換える。

```bash
cp -R services/dora_runner/plugins/hello_kairos services/dora_runner/plugins/my_plugin
```

コピー後、`kairos_plugin.yaml`のid・version・outputsと、`nodes/greet.py`の`PIPELINE_ID`・`VERSION`を自分の値へ変更する。フォーム・判定処理・依存宣言を編集してからビルドする。同じidのままではビルドできない。

```bash
make build dora_runner
make up dora_runner
make logs dora_runner
```

ビルド環境には依存の取得先への接続と、対象CPUアーキテクチャに合う環境が必要。ホストにpipで依存を入れるだけでは反映されない。実行時に依存をダウンロードする必要はない。

GPUを使う場合は`requires.gpu: true`、ホストのNVIDIA GPU・ドライバ・Container Toolkitを準備し、buildとupの両方に`PLUGIN_GPU=1`を付ける。

## 完了の確認

1. Validation画面に自分のpipelineと入力フォームが表示される。
2. 検証用captureを選び、期待値が分かる入力で実行する。hello系もcaptureの選択が必要。
3. ジョブが終了し、summaryの判定・metricsと成果物が期待どおりになる。
4. コード・依存を変更した場合は再ビルド・再作成する。

`make test-plugin-dependencies`は同梱の依存テスト用例を確認する。自分のプラグインは別途上記の手順で検証する。

必須ファイル、ノードの入出力、依存の分離範囲、非対応形式、エラー時の確認先は[プラグイン仕様](../../../docs/specs/ja/dora_plugins.md)を参照。
