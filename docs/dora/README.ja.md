# dora_runner — validation 開発ガイド（現状 / チェック追加 / 単体試験 / デバッグ）

**English: [README.md](README.md)**

> 設計の正本は [docs/specs/ja/dora_runner.md](../specs/ja/dora_runner.md)。本書は**実装の現状**と
> 開発手順をまとめた開発者向けガイド（実装に追従して更新する）。
> 関連: dora そのものの入門は [getting-started.ja.md](getting-started.ja.md)、参考リソース集は
> [resources.ja.md](resources.ja.md)。

## 現状（実装の実態・2026-07-26 更新）
- 有効な pipeline は **`fast_validation` / `full_validation` / `dataset_export` / `loss_report` /
  `video_check` / `signal_report` の 6 本**（`dataset_convert` / `dataset_validation` は
  `enabled=false` のプレースホルダ。`POST /jobs` は `pipeline_unavailable` で拒否）。
- レジストリは **実装済み**: `registry.py` の `build_default_registry()` が同梱 6 本を登録し、
  `plugin_loader.discover_plugins()` が `KAIROS_PLUGINS_DIR`（既定 `services/dora_runner/plugins/`）配下の
  manifest をスキャンして自動登録する（例プラグイン `hello_dora` を同梱）。
- **検証 2 本は実 dora 上の bagflow フロー**（`fast_validation` / `full_validation`）。dora CLI（0.5.0）と
  同梱 bagflow の Rust ノードは **dora_runner イメージに入っている**が、ソースチェックアウト / CI には
  無いので、その環境では 2 本とも `enabled=false` に落ちる（理由は description に出る）。
  プラグインの `executor: dora` は従来どおり **in-process インタプリタ**で実行される
  （`/readyz` の `components.dora` / `components.bagflow` と `/pipelines` の `effective_executor` が
  実行系を誠実に表示する）。
- **`fast_validation` の中身**（`fast_validation.py` + `flows/fast_validation.yml`）:
  - フローは**サービス同梱**（イメージ内 `/opt/kairos/flows/fast_validation.yml`）。
    `config/<robot>/flows/fast_validation.yml` を置けばそちらが優先される。
  - 検査ノードは `bagflow-topic-presence` 1 本（Rust）。**トピックを購読しない**＝ MCAP は読まず、
    `metadata.yaml` のトピック一覧と型だけで照合する（glob = fnmatch、`type` 指定時は型一致も要求）。
  - `bagflow_pipeline.py` が両ゲート共通の実行機構（実体化・タイムアウト・後始末・成果物）。
  - `fast_validation.summarize()` が bagflow の `report.json` を `summary.json`
    （`{template, result, missing, extra, checked_at, engine, checks, metrics}`）へ変換する。
  - `validation.py` に残るのは**テンプレ雛形の生成**（`mcap_loader` / `generate_template`）だけ。
- HTTP（`api_orchestrator` 経由 or 直接）:
  `GET /pipelines` / `POST /jobs` / `GET /jobs/{id}/status` / `GET /jobs/{id}/result` /
  `POST /jobs/{id}/cancel` / `POST /validation/templates/generate` / `GET,POST /validation/templates`。
  **job / template ストアは SQLite 永続化**（`store.py`。再起動時に in-flight ジョブを終端へ確定）。

## validation チェックの追加方法
現状はレジストリが無いので「**関数とモデルを足す**」手順。

### A. 必須トピックの条件を増やすだけ（コード不要）
テンプレに足すだけ。`required_topics` は **glob 名 + 任意 type**:
```yaml
name: hsr_teleop_v1
version: 1
required_topics:
  - { name: "/hsrb/joint_states", type: "sensor_msgs/msg/JointState" }
  - { name: "/hsrb/*/image_raw/compressed" }   # glob 可（type 省略可）
```

### B. 新しいチェック種別を足す（例: expected_hz / min_duration / 画質）
検証は **bagflow のフロー**なので、「チェックを足す＝ノードを足してフローに書く」になる。
1. **既存の同梱ノードで足りる場合はコード不要** — `config/<robot>/flows/*.yml` にノードを 1 つ足す
   （`bagflow-stamp-gap` / `-topic-rate` / `-blur` / `-brightness` / `-freeze` / `-decode`）。
   閾値は `env:` で、kairos config 由来の値は `${KAIROS_EXPECT_HZ}` などのトークンで受ける。
2. **新しいノードを書く場合** — `services/dora_runner/bagflow/crates/bagflow-checks/src/bin/<name>.rs`
   に追加し、`Cargo.toml` の `[[bin]]` と `Dockerfile` の cp 一覧に載せる。ノード契約は
   `BagflowNode::init()` → `next_message()` ループ → `report(json!({"check": …, "ok": …}))` → `close()`。
   判定ロジックは純関数に切り出して `#[cfg(test)]` で単体試験する（`topic_presence.rs` が手本）。
3. **総合 pass/fail は kairos 側のアダプタが決める**（`bagflow_summary.summarize` /
   `fast_validation.summarize`）。`ok: false` のチェックが 1 つでもあれば fail、`incomplete` があれば fail。
4. **テンプレ項目を増やす場合**は `models.py` の `ValidationTemplate` を拡張し、
   `bagflow_pipeline`（`required_topics` / `topic_expectations`）から新トークンとしてフローへ渡す。

### C. 新しい pipeline を足す（fast_validation 以外）
1. **同梱として足す**: `registry.py` の `build_default_registry()` に `RegisteredPipeline(id=..., runner=...,
   enabled=True, schema=...)` を追加する。`runner` は `async (job, store, data_dir) -> {"summary":…,
   "artifacts":[…]}` の契約（`validation.py` / `loss_report.py` などと同じ in/out）。`runner=None` にすると
   プレースホルダ（`enabled=false`）になり `POST /jobs` は `pipeline_unavailable` を返す。
2. **プラグインとして足す**（コア改修不要）: `KAIROS_PLUGINS_DIR` 配下に manifest（`kairos_plugin.yaml`）と
   実装を置く。`discover_plugins()` が起動時に自動登録する（`hello_dora` を参照）。
3. summary には再現性のため `pipeline` / `version` を含める（同梱 4 本と同じ規約）。
4. dora daemon 上で実行する dataflow 化は将来像（[dora_plugins.md](../specs/ja/dora_plugins.md)）。現状は
   in-process インタプリタで動く。

## 単体試験の方法
```bash
cd services/dora_runner && uv run --extra test pytest -q          # Python 側
# Rust ノード（同梱 bagflow）— ホストに rust が無ければコンテナで
cargo test -p bagflow-checks --manifest-path services/dora_runner/bagflow/Cargo.toml
```
- **判定ロジック（glob / 型照合 / 0 件許容）は Rust 側のテスト** — `bagflow-checks` の
  `topic_presence.rs` 内 `#[cfg(test)]`（MCAP も dora も不要・最速の反復単位）。
- **report → summary アダプタ** — `tests/test_fast_validation_summary.py`。bagflow の `report.json` を
  手で組み立てて `summary.json` の契約（`missing` / `extra` / `result`）を確認する。dora 不要。
- **フローの実体化** — `tests/test_bagflow_flow.py`（`${KAIROS_*}` 展開・path 解決・探索順・同梱フロー）。
- **実 MCAP のフロー試験** — `tests/test_fast_validation.py`。`data/recorded/<RUN_ID>` の実収録
  **と bagflow/dora バイナリ**に依存し、どちらか欠ければ自動 skip（＝イメージ内でのみ走る）。

## デバッグ / 反復（でバックしやすい使い方）
- **ローカル CLI**（HTTP サーバ不要で即実行）。実 dora を使うので**イメージの中で**動かす:
  ```bash
  # テンプレ自動生成して実行（run の topic から雛形を作り照合）
  docker compose exec dora_runner python -m dora_runner.cli <run_id> --data-dir /data
  # テンプレやフローを差し替えて何度も試す
  docker compose exec dora_runner python -m dora_runner.cli <run_id> --data-dir /data --template my.yaml
  docker compose exec dora_runner python -m dora_runner.cli <run_id> --data-dir /data --json  # 生 summary
  ```
  - pass/fail を **exit code（0/1）** に反映。出力は `/data/report/fast_validation/<run_id>/summary.json`。
  - バイナリが無いホストで実行すると**その旨を出して exit 2**（黙って別実装に落ちない）。
- **フローが落ちたとき**: ジョブ失敗の `details.node_logs` が
  `data/report/<pipeline>/<run_id>/flow/.bagflow/out/<uuid>/log_<node>.txt` を指す。
  実際に走ったフローは同じディレクトリの `flow/flow.yml`（`${KAIROS_*}` 展開後）。
- **bagflow を直接叩く**（kairos を挟まない最小再現）:
  ```bash
  docker compose exec dora_runner bagflow run --no-attach \
    --bag /data/recorded/<run_id> --report /tmp/report.json /opt/kairos/flows/fast_validation.yml
  ```
- **注意**: dora_runner は自前の coordinator/daemon（既定 127.0.0.1:6112）を持つ。`dora list` などを
  手で叩くときは `--coordinator-port 6112` を付けること（既定 6012 は dora_live 側）。

## 未実装 / 仕様との差分
- **プラグインの `executor: dora` は依然 in-process インタプリタ**。実 dora を使うのは検証 2 本だけで、
  プラグインの dataflow を載せ替えるのは別作業。
- **bagflow の Python チェックノードと CUDA デコーダは同梱しない**（理由は
  `services/dora_runner/bagflow/VENDOR.md`）＝フローで使えるのは同梱 Rust バイナリか、
  運用者が別途入れたものの絶対パスのみ。
- `dataset_convert` / `dataset_validation` は I/F だけ（`enabled=false`）。
- AI node / LeRobot 変換は未実装。
