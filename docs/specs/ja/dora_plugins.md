# dora_runner プラグインシステム / dora dataflow 化 設計

> ステータス: **設計確定（v1 方針）**。日本語が正本（英語ミラー `docs/specs/en/dora_plugins.md` は `/sync-docs` で自動生成、直接編集しない）。
> 親仕様: [dora_runner.md](dora_runner.md)。本書はその「Plugin/Pipeline Registry・dora dataflow」将来像（同 §12〜§15）の**実装方針**を確定する。**認証は不要**（trusted LAN 前提）。

## 決定事項（オーナー方針）

1. **実行モデル: 全 pipeline を dora dataflow 化する**（coordinator/daemon 常駐の統一モデル）。`executor="in_process"` は移行完了後に廃止候補とし、当面は移行期の互換として残す。
2. **プラグイン配布・発見: git submodule + manifest scan**。プラグインは独立 git リポジトリとして `services/dora_runner/plugins/<name>` に submodule で取り込み、起動時に `kairos_plugin.yaml` をスキャンして Pipeline Registry に自動登録する。**pipeline 追加 = submodule 追加（コア改修不要）**。
3. GPU を使う node（自動アノテーション等）は dora node として `--gpus` 付きで実行し、CPU-only 既定から **profile 分離**する（検収レビュー（`dev_docs/arch_review.md`・ローカル作業ドラフト） A3）。

## 全体像

```
                         ┌─────────────────────────────────────────────┐
 POST /jobs ──▶ worker ──▶ Pipeline Registry  (manifest scan で構築)     │
 (api_orchestrator 経由)  │   - 同梱 4本 + plugins/<name> を自動登録      │
                         │   RegisteredPipeline(executor="dora",        │
                         │     runner=make_dora_runner(dataflow, manif))│
                         └───────────────┬─────────────────────────────┘
                                         │ dora start <dataflow.yml>
                         ┌───────────────▼─────────────────────────────┐
                         │ dora coordinator + daemon  (entrypoint で up)│
                         │   MCAP Loader → validator/AI node → Writer   │
                         │   （node 間は Arrow ゼロコピー）              │
                         └───────────────┬─────────────────────────────┘
                                         │ summary.json / artifacts
                              /data/report/<pipeline>/<run_id>/
```

- **Plugin/Pipeline Registry**: `registry.py` の `PipelineRegistry` を拡張。同梱 pipeline に加え `discover_plugins()` が submodule を登録する。
- **Pipeline Executor**: dora coordinator + daemon（dora_runner コンテナ内で常駐）。各 job は dataflow を 1 本 `dora start` して終端を待つ。
- **node I/O 契約**: [dora_runner.md](dora_runner.md) の契約に準拠（入力 = run パス/MCAP 反復子/params、出力 = metrics/artifacts/report 断片）。

## 1. dora dataflow への移行（実行モデル）

### 1.1 継ぎ目はすでにある

現 `registry.py` は pipeline ごとに `runner: async (job, store, data_dir) -> {"summary":…, "artifacts":[…]}` を持ち、`executor` フィールドを差し替え点として用意済み。`fast_validation` も既に **dora 風ノード境界**（`validation.py`: `mcap_loader → validator → result_writer`）で書かれている。したがって移行は **`runner` を「dora dataflow を起動するアダプタ」に差し替える**だけで、`/jobs` 呼び出し側・frontend フォーム（`params_schema` 駆動）は無改修。

### 1.2 汎用 dora ランナー（executor="dora"）

```python
def make_dora_runner(dataflow_yml: Path, manifest: PluginManifest) -> Runner:
    async def _run(job: JobRecord, store: RunnerStore, data_dir: Path) -> dict:
        report_dir = data_dir / "report" / manifest.id / job.run_id
        report_dir.mkdir(parents=True, exist_ok=True)
        env = {
            **os.environ,
            "KAIROS_RUN_ID": job.run_id,
            "KAIROS_DATA_DIR": str(data_dir),
            "KAIROS_REPORT_DIR": str(report_dir),
            "KAIROS_PARAMS_JSON": json.dumps(job.params),
        }
        proc = await asyncio.create_subprocess_exec(
            "dora", "start", str(dataflow_yml), "--name", job.job_id,
            env=env, stdout=PIPE, stderr=STDOUT,
        )
        # 進捗/ログは stdout を読みつつ store に流す（SSE へ）
        rc = await _pump_logs_and_wait(proc, job, store)
        if rc != 0:
            raise ApiError(status_code=500, code="pipeline_failed",
                           message=f"dora dataflow exited {rc}", details={"pipeline": manifest.id})
        summary = json.loads((report_dir / "summary.json").read_text())
        artifacts = [str(p) for p in sorted(report_dir.glob("**/*")) if p.is_file()]
        return {"summary": summary, "artifacts": artifacts}
    return _run
```

- **有限バッチ前提**: validation/変換は終端のある dataflow なので `dora start`（非 detach）が dataflow 停止で返る。
- **params 受け渡し**: source node が `KAIROS_*` 環境変数を読む（dataflow YAML の `env:` でも可）。動的 input が要るケースは後続課題（TBD）。
- **timeout / リソース上限**: job ごとに `dora` プロセスへ timeout を掛ける（[dora_runner.md](dora_runner.md) §「Pipeline Executor」）。

### 1.3 daemon ライフサイクル

- dora_runner コンテナ entrypoint で `dora up`（coordinator+daemon をローカル起動）を 1 回。`/readyz` に daemon 死活を含める（現状 readyz は dora_runner 自体を見ていない＝検収レビュー（`dev_docs/arch_review.md`・ローカル作業ドラフト） M/論点3 を併せて解消）。
- CPU-only 単一ホストでも daemon は 1 プロセスのみ。node はジョブ実行中だけ立ち上がる。

### 1.4 dataflow / node の例（同梱 fast_validation の dataflow 版）

`dataflow.yml`:
```yaml
nodes:
  - id: mcap_loader
    path: nodes/mcap_loader.py
    env: { KAIROS_RUN_ID: "${KAIROS_RUN_ID}", KAIROS_DATA_DIR: "${KAIROS_DATA_DIR}" }
    outputs: [ loaded ]
  - id: validator
    path: nodes/validator.py
    env: { KAIROS_PARAMS_JSON: "${KAIROS_PARAMS_JSON}" }
    inputs:  { loaded: mcap_loader/loaded }
    outputs: [ summary ]
  - id: result_writer
    path: nodes/result_writer.py
    env: { KAIROS_REPORT_DIR: "${KAIROS_REPORT_DIR}" }
    inputs:  { summary: validator/summary }
```

node（Python）:
```python
from dora import Node
import pyarrow as pa
node = Node()
for event in node:
    if event["type"] == "INPUT" and event["id"] == "loaded":
        summary = validate(event["value"])           # 既存 validator() 相当
        node.send_output("summary", pa.array([json.dumps(summary)]), event["metadata"])
```

> 既存の `mcap_loader` / `validator` / `result_writer`（`validation.py`）はほぼそのまま node 本体に流用できる。これが「node 契約 → registry → dora-ready」の狙い。

## 2. プラグイン契約（submodule + manifest scan）

### 2.1 プラグイン・リポジトリの構成

プラグイン 1 個 = 独立 git リポジトリ:
```
kairos-validator-<robot>/            # 例: github.com/<org>/kairos-validator-hsr
├─ kairos_plugin.yaml                # マニフェスト（必須）
├─ dataflow.yml                      # dora dataflow（executor: dora）
├─ nodes/                            # dora node 群
│  ├─ mcap_loader.py
│  ├─ check_joint_limits.py
│  └─ result_writer.py
├─ pyproject.toml                    # 依存・パッケージ宣言（任意。Docker build で pip install）
└─ tests/                            # プラグイン側の単体試験
```

kairos 側の取り込み:
```
services/dora_runner/plugins/
└─ kairos-validator-hsr/             # ← git submodule（commit ピン留め）
```

### 2.2 マニフェスト `kairos_plugin.yaml`

```yaml
apiVersion: kairos.plugin/v1          # 互換チェック用
id: hsr_joint_validation              # ^[a-z0-9_]+$。registry / report パスのキー
name: HSR joint validation            # UI 表示名
description: HSR の関節角・速度の妥当性を MCAP から検証する。
executor: dora                        # v1 は dora 固定（in_process は移行互換のみ）
version: 1.2.0                        # report に記録（再現性）
required_inputs: [ run_id ]
params_schema:                        # JSON Schema。frontend が自動フォーム化
  type: object
  properties:
    joint_limit_margin:
      type: number
      title: Joint limit margin
      default: 0.05
      exclusiveMinimum: 0
outputs:
  - "report/hsr_joint_validation/<run_id>/summary.json"
entrypoint:
  dataflow: dataflow.yml              # executor: dora
  # callable: kairos_validator_hsr.run:run   # executor: in_process のとき
requires:                             # 任意。Docker build 時の検査用
  gpu: false
```

- `params_schema` がそのまま `GET /pipelines` 経由で frontend に届き、Pipelines/Validation タブのフォームになる（backend-driven。UI 改修不要）。
- マニフェストの Pydantic モデル `PluginManifest` を `dora_runner` に追加し、**スキーマ検証する**（不正 manifest は登録せずログのみ。サービスは落とさない）。

### 2.3 発見と登録 `discover_plugins()`

`build_default_registry()` の末尾で呼ぶ:
```python
def discover_plugins(registry: PipelineRegistry, plugins_dir: Path) -> list[PluginLoadError]:
    errors = []
    for manifest_path in sorted(plugins_dir.glob("*/kairos_plugin.yaml")):
        try:
            manifest = PluginManifest.model_validate(load_yaml(manifest_path))
            if registry.get(manifest.id) is not None:
                raise PluginLoadError(manifest.id, "duplicate id")
            runner = _build_runner(manifest, manifest_path.parent)   # dora / in_process
            registry.register(RegisteredPipeline(
                id=manifest.id, name=manifest.name, description=manifest.description,
                params_schema=manifest.params_schema, outputs=manifest.outputs,
                executor=manifest.executor, runner=runner,
            ))
        except Exception as exc:                # 1 プラグインの失敗で全体を落とさない
            errors.append(PluginLoadError(str(manifest_path), str(exc)))
            logger.warning("plugin load failed: %s (%s)", manifest_path, exc)
    return errors
```

- **失敗隔離**: 壊れたプラグイン 1 個は skip + warn。健全なプラグインと同梱 pipeline は動く。
- **id 衝突**: 同梱 pipeline / 他プラグインと重複する `id` は登録拒否（先勝ち）。
- 起動ログとオプションで `GET /pipelines` の応答に `load_errors` を出し、検収時に「読めなかったプラグイン」を可視化する（TBD）。

### 2.4 node I/O 契約（プラグイン作者向け）

[dora_runner.md](dora_runner.md) の契約に従う。プラグイン側 node は:

- **入力（source node が `KAIROS_*` env から得る）**: `run_id`, `data_dir`, `params`(JSON)。MCAP は `kairos_common` 提供の loader（`enumerate_topics` / `find_mcap` / メッセージ反復子。topic フィルタ・時間範囲指定可）で読む。**rclpy 不要**。
- **出力**: 最終 node（result_writer）が `${KAIROS_REPORT_DIR}/summary.json` を書く。形は `{ pipeline, version, result?: "pass"|"fail", metrics?, missing?, extra?, checked_at }`。追加生成物は同 report dir 配下に置く（`artifacts` として収集される）。
- **再現性**: summary に `pipeline` / `version`（manifest.version）/ 主要 node・モデルの版を必ず入れる。

> `kairos_common` に **plugin SDK**（loader・summary スキーマ・`send_summary()` ヘルパ）を切り出し、プラグイン作者が定型を書かなくて済むようにする（TBD: SDK の公開 API を確定）。

## 3. submodule ワークフロー

### 3.1 追加・更新・固定

```bash
# 追加
git submodule add https://github.com/<org>/kairos-validator-hsr \
    services/dora_runner/plugins/kairos-validator-hsr
git commit -m "feat(dora): add hsr_joint_validation plugin (pinned)"

# 更新（プラグイン側の新コミットへポインタを上げる）
git -C services/dora_runner/plugins/kairos-validator-hsr fetch
git submodule update --remote services/dora_runner/plugins/kairos-validator-hsr
git commit -am "chore(dora): bump hsr validator to <sha>"

# クローン時
git clone --recurse-submodules <kairos>
# 既存 clone なら
git submodule update --init --recursive
```

- **commit ピン留め＝再現性**（spec のバージョン記録要件に直結）。private リポジトリ可。オフライン・単一ホスト納品と相性良い。
- `.gitmodules`（committed）が submodule マッピングの正。

### 3.2 ビルド（イメージに焼く）

`services/dora_runner/Dockerfile`:
```dockerfile
# build context に submodule が checkout 済みであること（CI/make で submodule update --init）
COPY services/dora_runner/plugins/ /app/plugins/
# 各プラグインの依存と node を image に入れる（pyproject があれば）
RUN for d in /app/plugins/*/; do \
      [ -f "$d/pyproject.toml" ] && pip install --no-cache-dir "$d" || true; \
    done
ENV KAIROS_PLUGINS_DIR=/app/plugins
```

- **トレードオフ**: 「プラグイン追加 = イメージ再ビルド」。drop-in（再ビルド不要）が要るなら将来 mount 方式を別途検討（本 v1 は採らない）。
- `make` に `submodule update --init` を前置して build context を保証する（`make build dora` 等）。

## 4. CPU-only / GPU profile / リソース

- daemon 常駐は 1 プロセス。軽量 validator dataflow は短命 node のみで CPU-only PC に収まる。
- **GPU node**（自動アノテーション等）は manifest `requires.gpu: true` を宣言し、dora node を `--gpus` 付きで起動する別 compose profile（`profiles: [gpu]`）に隔離。**CPU-only 既定構成には GPU プラグインを含めない**。
- 重い job（`video_check` / 将来の `dataset_convert`）を録画中に走らせない運用は試験/検収の受け入れ条件（`dev_docs/check.md` / `dev_docs/arch_review.md`・ローカル）に従う。job ごと timeout・並行度上限を Executor に持たせる。

## 5. 段階移行プラン

1. **executor=dora の足場**: entrypoint で `dora up`、`make_dora_runner()` と `PluginManifest` を追加。`/readyz` に daemon 死活を追加。
2. **同梱 pipeline を 1 本 dataflow 化**: `fast_validation` を `validation.py` の node を流用して dataflow 化し、in_process 版と出力一致をテストで担保（golden summary 比較）。
3. **残り同梱 pipeline を移行**: `loss_report` / `video_check` / `dataset_export`。`dataset_export` はファイル移動なので node 1 個 dataflow。
4. **discover_plugins() + manifest scan** を有効化し、`plugins/` 空でも回ることを確認。
5. **サンプルプラグインを submodule 化**して E2E（discover → `/jobs` → summary.json）を通す。
6. **placeholder（full_validation/dataset_convert/dataset_validation）** を、プラグイン or 同梱 dataflow のどちらで埋めるか決めて実装（検収レビュー（`dev_docs/arch_review.md`・ローカル作業ドラフト） M4 の方針に従い、未実装枠は既定非表示）。

## 6. 未決事項（TBD）

- **plugin SDK の公開 API**（`kairos_common` 側 loader / summary スキーマ / ヘルパの確定）。
- **動的 params の渡し方**: 大きい params や run 中の対話が要る場合の dora dynamic node 採用可否。
- **plugin 信頼境界**: submodule は任意コードを実行する。署名・許可リスト等を入れるか（trusted LAN 前提なら据置でも可）。
- **drop-in（再ビルド不要）方式**の要否（本 v1 は submodule baked-in のみ）。
- **`/pipelines` の `load_errors` 露出**と UI 表示の有無。
- **in_process executor の廃止時期**（移行完了の判定基準）。
