# dora_runner — validation 開発ガイド（現状 / チェック追加 / 単体試験 / デバッグ）

**English: [README.md](README.md)**

> 設計の正本は [docs/specs/ja/dora_runner.md](../specs/ja/dora_runner.md)。本書は**実装の現状**と
> 開発手順をまとめた開発者向けガイド（実装に追従して更新する）。
> 関連: dora そのものの入門は [getting-started.ja.md](getting-started.ja.md)、参考リソース集は
> [resources.ja.md](resources.ja.md)。

## 現状（v1 実装の実態）
- 有効な pipeline は **`fast_validation` の 1 つだけ**（`full_validation` / `dataset_convert` /
  `dataset_validation` は `enabled=false` のプレースホルダ）。`pipelines.py` の `PIPELINES` は**静的リスト**。
- spec が描く Plugin/Pipeline Registry・dora dataflow（YAML）・dora daemon は**未実装**。代わりに
  `fast_validation` は**プロセス内の素の Python 関数**として実装（`validation.py`）:
  - `mcap_loader(run_id, data_dir)` → `/data/recorded/<run_id>/*.mcap` を開き topic 一覧を列挙
    （**ROS デコード不要**、`mcap` + `mcap-ros2-support`）。
  - `validator(loaded, template)` → topic 一覧を `template.required_topics` と照合
    （**glob = fnmatch**、`type` 指定時は型一致も要求）。`{template, result, missing, extra, checked_at}` を返す。
  - `result_writer(summary, data_dir, run_id)` → `/data/report/fast_validation/<run_id>/summary.json` を書く。
  - `run_fast_validation(...)` が上記 3 つを in-process で連結（dora coordinator 無しで CI/テスト可）。
- HTTP（`api_orchestrator` 経由 or 直接）:
  `GET /pipelines` / `POST /jobs` / `GET /jobs/{id}/status` / `GET /jobs/{id}/result` /
  `POST /jobs/{id}/cancel` / `POST /validation/templates/generate` / `GET,POST /validation/templates`。
  **job / template ストアは in-memory**（プロセス再起動で消える）。
- **node 契約**（差し替え・単体試験の鍵）: 各 node は `dict`/モデルの in/out を持つ純関数。
  入力 = `run_id` / `data_dir`・`loaded`(topics)・`template`・`params`、出力 = `summary`(dict) / `artifacts`(パス列)。

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

### B. 新しいチェック種別を足す（例: expected_hz / min_duration / message_count）
1. **モデル拡張**: `models.py` の `RequiredTopicTemplate` / `ValidationTemplate` に項目を追加（例: `min_hz`）。
2. **ロジック追加**: `validation.py` の `validator()` に判定を足す。topic 名/型だけで足りるチェックは
   `loaded["topics"]` で完結。**件数/レート/中身**が要るものは
   `mcap_utils.iter_decoded_ros2_messages(mcap_path, topics=[...])` でデコードして集計する
   （`mcap_loader` に集計を足すか、新 node 関数を作る）。
3. **出力反映**: 失敗詳細を `summary` に含める。
4. **テスト**: `validator()` は純関数 → **合成 `loaded` dict で単体テスト**（後述）。

### C. 新しい pipeline を足す（fast_validation 以外）
1. `pipelines.py` の `PIPELINES` に `PipelineDefinition(id=..., enabled=True, schema=...)` を追加。
2. executor を実装（`run_fast_validation` と**同じ in/out 契約**。`validation.py` か新モジュール）。
3. `main.py`: `create_job` の**ガード**（今は `pipeline != "fast_validation"` を 400）を分岐に拡張し、
   `_execute_job` で pipeline ごとに executor を選ぶ。
4. spec の registry/dataflow に寄せる場合は別途設計（未実装）。

## 単体試験の方法
```bash
cd services/dora_runner && uv run --extra test pytest -q
```
- **`validator()` を直接叩く（MCAP 不要・推奨デバッグ単位）** — `tests/test_validator.py`。
  `loaded = {"topics": [{"name","type"}, ...]}` を手で作って判定を確認。高速・決定的・ローカル収録不要。
- **実 MCAP のフロー試験** — `tests/test_fast_validation.py`。`data/recorded/<RUN_ID>` の実収録に依存し、
  **収録が無いと自動 skip**（`data/` は gitignore）。収録の作り方は [CLAUDE.ja.md](../../CLAUDE.ja.md) の
  結合テストレシピ参照。

## デバッグ / 反復（でバックしやすい使い方）
- **ローカル CLI**（HTTP サーバ不要で即実行 → いろいろ試すのに最適）:
  ```bash
  cd services/dora_runner
  # テンプレ自動生成して実行（run の topic から雛形を作り照合）
  uv run python -m dora_runner.cli <run_id> --data-dir ../../data
  # テンプレを差し替えて何度も試す
  uv run python -m dora_runner.cli <run_id> --data-dir ../../data --template my.yaml
  uv run python -m dora_runner.cli <run_id> --data-dir ../../data --json   # 生 summary
  ```
  - pass/fail を **exit code（0/1）** に反映。出力は `/data/report/fast_validation/<run_id>/summary.json`。
  - インストール後は `dora-validate <run_id> ...` でも実行可（console script）。
- **部品単位で試す**: node は純関数なので REPL/テストで `mcap_loader`→`validator`→`result_writer` を個別に
  呼べる。`validator()` はテンプレを差し替えて何通りも即試せる。
- **注意**: job/template ストアは in-memory（再起動で消える）。永続が要るなら今後 DB 化（spec 参照）。

## 既知のギャップ（spec との差・TODO）
- Plugin/Pipeline Registry、dora dataflow（YAML）、dora daemon は**未実装**（spec は将来像）。
- `full_validation` / `dataset_convert` / `dataset_validation` は I/F だけ（`enabled=false`）。
- AI node / LeRobot 変換、job/template の永続化は未実装。
