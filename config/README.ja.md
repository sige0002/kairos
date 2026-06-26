# config — 収録 / 監視の設定（RECORDING_CONFIG）

**English: [README.md](README.md)**

「**どの topic を録る / 監視するか**」を決める YAML を置くフォルダです。bagel の
`configs/` に相当する、設定の入口です。

| ファイル | 役割 |
|---|---|
| [`recording.yaml`](recording.yaml) | **汎用テンプレ（コピー元）**。`default_topics` / `expected_hz_patterns` / QoS / `validation` を備えた、新しいロボット用の出発点。 |
| [`airoa_hsr.yaml`](airoa_hsr.yaml) | 同梱サンプル bag（HSR, `data/airoa-moma-mcap/`）に合わせた**具体設定**。Stage 1–2 のローカル検証用。 |

## 使い方

1 つのファイルを **`RECORDING_CONFIG` 環境変数**で指します。

```bash
# サンプル bag（HSR）を使う場合（.env など）
RECORDING_CONFIG=config/airoa_hsr.yaml
```

- Docker では `config/` が各サービスへ `/config` にマウントされます（`compose.yaml`）。
  既定は `/config/recording.yaml`。サンプル bag を流すときは
  `RECORDING_CONFIG=/config/airoa_hsr.yaml` に切り替えてください
  （テンプレの `default_topics` は `/joint_states` 等で、HSR の `/hsrb/*` には一致しないため、
  そのままだと monitor が何も購読せず `GET /metrics` が空になります）。
- **新しいロボット**: `recording.yaml` をコピーして topic 名・期待 Hz・QoS を編集し、
  `RECORDING_CONFIG` をそのファイルに向けます。

## 反映先（この 1 ファイルを共有する）

- `rosbag2_recorder` … `default_topics`（既定の収録対象）＋ 収録 QoS。
- `topic_monitor` … `expected_hz_patterns`（Late 判定）＋ 購読 QoS。
- `dora_runner` … `validation.required_topics`（収録後の fast_validation）。
- `frontend`（UI）… `GET /api/v1/config` の `defaults.default_topics` を経由して、
  Record タブで**録る topic を事前選択**、Monitor タブで **configured バッジ**表示。

topic はグロブ（fnmatch）対応。パターン列は first-match-wins です。詳細は各 YAML の
コメントと [`docs/specs/ja/config.md`](../docs/specs/ja/config.md) を参照してください。
