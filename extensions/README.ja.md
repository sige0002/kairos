# extensions/ — ユーザー拡張の置き場(非破壊・drop-in)

kairos 本体のコードを**一切変更せずに**、自作の処理を 2 つの側面に組み込むための
ディレクトリです。`extensions/` 直下は(この README と `_template/` を除き)
**gitignore 済み**なので、自分のリポジトリをそのまま置けます:

```bash
git clone https://github.com/you/my-ext extensions/my_ext
```

`git submodule add` を使う場合は 2 点注意(gitignore 対象パスのため):
`-f` が必要で、`.gitmodules` + gitlink が **kairos 側のコミット履歴に入ります**
(自分の fork なら問題なし。kairos の履歴を汚したくなければ plain clone を推奨)。

はじめ方: `cp -r extensions/_template extensions/my_ext` → 中の README に従って
編集(`_` で始まるフォルダはテンプレ扱いで**ロードされません**)。

## 2 つの組み込み面

| 面 | 実行場所 | 契約 | 反映方法 |
|---|---|---|---|
| ① ライブ(dora_live 側) | **自分のコンテナ**(`live/compose.yaml`) | frames pull(`GET :8005/live/frames` 索引 + `GET /live/frame?topic=` ETag/304)と汎用イベント intake(`POST :8005/internal/analysis/events` → `GET /live/events`) | `make ext-live EXT=my_ext` |
| ② 録画後検証(dora_runner 側) | dora_runner コンテナ内(マウントされた `/extensions` から読み込み) | `kairos_plugin.yaml` マニフェスト + dora `dataflow.yml` + `nodes/`(`docs/specs/ja/dora_plugins.md` の kairos.plugin/v1 契約) | **初回のみ** `make rebuild dora_runner`(または `make up`)— mount と env をコンテナに反映するため。**以後の追加/更新は `make restart dora_runner` だけ**(リビルド不要) |

### ① ライブ面(サイドカー方式)の設計根拠と配置

ロボット側の dora_live には手を入れず、**LAN 内の別コンテナが pull で購読**します
(push 不採用 = ロボットが消費側のアドレスを知る依存を作らない、というユーザー裁定)。
サイドカーが落ちても録画・監視には一切影響しません。イベント本文は自由形式
(`t` = epoch 秒だけ予約、未指定なら受信時刻が自動付与)。

**配置は任意の有線 LAN ホスト**(それが pull 契約の狙い)。split 構成では
録画 PC 側から `DORA_LIVE_URL=http://<robot>:8005 make ext-live EXT=my_ext`
で起動する(既定はローカルホスト=単一ホスト開発向け)。

### ② 検証面(プラグイン方式)の設計根拠

dora_runner は起動時に `KAIROS_EXTENSIONS_DIR=/extensions`(compose がリポジトリの
`extensions/` を read-only マウント)を追加スキャンします。同梱プラグインと id が
衝突した場合は**同梱側が勝ち**ます(先勝ち)。壊れたプラグインはスキップされ、
他のパイプラインは動き続けます。UI(Validation タブ)はマニフェストの
`params_schema` からフォームを自動生成するため、フロントエンドの変更も不要です。

**出てこない時の診断**: `GET :8020/pipelines` の `plugin_errors`(読込失敗の
フォルダと理由)を見る。コンテナログ側は `make logs dora_runner` で
`plugin load failed` を探す。

## セキュリティ(正直な前提)

拡張は **dora_runner プロセス内で実行される任意の Python コード**です(/data へ
書き込み可)。さらに `entrypoint.callable` 型プラグインは**起動時の discovery の
時点で import = 実行**されます(ジョブ未実行でも)。「壊れたプラグインはスキップ」
は事故への耐性であって、悪意への防御ではありません — **信頼できるコードだけを
置いてください**。

## 制約(正直な注意書き)

- ライブ面の frames は `frames.sample_hz`(既定 2Hz)で間引かれた**圧縮ペイロード**
  です。全フレーム・生画素が必要な処理はライブではなく録画後(②)へ。
- `dora run` はデータフロー YAML の**隣に書き込む**ため、テンプレの compose は
  拡張フォルダを writable な場所へコピーしてから起動します(read-only
  マウント直指定は失敗します)。
- ライブ面のイベントはリング(直近 500 件)保持で**永続化されません**。
- dora_runner に dora CLI が無いホストでは、②は同一 `dataflow.yml` を
  in-process インタプリタで実行します(`process(inputs, ctx)` が必須な理由)。
- **`git clean -fdx` はここに置いた未 push の拡張ごと消します**(gitignore 対象
  のため)。リポジトリ全体のクリーンをかける前に退避を。

## テンプレの内容

```
_template/
├─ kairos_plugin.yaml   # ②のマニフェスト(コピー後に id を変える)
├─ dataflow.yml         # ②の dora データフロー
├─ nodes/report.py      # ②のノード(dual-mode: process() + main()・split録画対応)
├─ live/
│  ├─ compose.yaml      # ①のサイドカー定義(kairos-dora-live イメージ流用)
│  ├─ dataflow.yml      # ①の 1 ノードデータフロー(tick 駆動)
│  ├─ node.py           # ①のノード: frames pull → 平均輝度 → events POST
│  └─ run_node.sh       # venv python で exec するラッパー(必須の罠対策)
└─ README.ja.md / README.md
```
