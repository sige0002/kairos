# config — ロボット別の収録 / 監視 / 検証設定

**English: [README.md](README.md)**

「**どの topic を録る / 監視するか**」などを決める YAML を**機体（ロボット）ごと**に置くフォルダ。
収録・監視・検証設定の入口です。

## レイアウト（機体先頭）

```
config/
├─ <robot>/                  # 機体ごと（committed）
│  ├─ recording/<option>.yaml     # 収録/監視（default.yaml がアクティブ）
│  ├─ stream/<option>.yaml        # Stream タブの初期レイアウト
│  ├─ monitoring/alerts.yaml      # topic_monitor のアラート定義（任意・ALERT_CONFIG_PATH）
│  ├─ validation/<option>.yaml    # fast_validation テンプレ
│  └─ validators/loss_report.yaml # validator パラメータ
├─ airoa_hsr/               # 同梱サンプル機体（HSR, data/airoa-moma-mcap/）
├─ template/                # 新機体の出発点（airoa_hsr を参考にコピー）
└─ local/<robot>/           # 自分の機体（gitignored）
```

各 aspect は複数 option（`*.yaml`）を持て、`default.yaml` が既定のアクティブ。

## 使い方（単一 ROBOT で全部切替）

```bash
make up ROBOT=airoa_hsr      # 同梱 HSR サンプル（既定）
make up ROBOT=<robot>        # config/local/<robot>/（gitignored・自分のロボット）
```

- `ROBOT` を選ぶと recording / stream / validation / validators が**一括**で切り替わる。
  Makefile が `config/<robot>/`（committed）と `config/local/<robot>/`（gitignored）を自動解決し、
  各サービスへ渡す（`docker compose` もネスト補間で `ROBOT` を尊重する）。
- **Config タブ**でも機体 → aspect → option を選択・編集できる
  （`GET /api/v1/config/options`・`POST /api/v1/config/select`）。local 機体（gitignored）も
  一覧に出て、その recording 編集は gitignored ファイルに書き戻す（committed を汚さない）。
- **Settings > Data quality** から、選択式ではない単一ファイル設定を編集できる:
  `monitoring/alerts.yaml`（アラート規則。`GET/PUT /api/v1/config/alerts`。topic_monitor 再起動時に反映）。
  アクティブ機体のファイルへアトミックに書き戻す（詳細は `docs/specs/ja/api_orchestrator.md`）。
- **新しいロボット**: `config/template/` をコピーして `config/<robot>/`（公開可）または
  `config/local/<robot>/`（非公開）に置き、topic 名・期待 Hz・QoS を編集する。

> ⚠️ `.env` に `RECORDING_CONFIG=...` を直書きしていると `ROBOT` 派生より優先される。
> 通常は `ROBOT=` だけ設定し、明示パス行は消すこと（`.env.example` が新しい形を示す）。

## 反映先

- `rosbag2_recorder` … recording の `default_topics`（既定の収録対象）＋ 収録 QoS。
- `topic_monitor` … recording の `expected_hz_patterns`（Late 判定）＋ 購読 QoS ＋ `monitoring/alerts.yaml`（アラート定義。任意。空＝アラート無効）。
- `dora_runner` … validation の `required_topics`（fast_validation）＋ validators（loss_report）。
- `frontend`（UI）… `GET /api/v1/config` 経由で Record / Monitor の事前選択・バッジ、Stream の初期ペイン。

topic はグロブ（fnmatch）対応・first-match-wins。詳細は各 YAML のコメントと
[`docs/specs/ja/config.md`](../docs/specs/ja/config.md)、`config/local/README.md` を参照。
