---
name: offline-container-delivery
description: ネットワークの無い/制約された現場へ Docker Compose のスタックを持ち込んで動かすための設計と手順。「オフラインで起動できない」「現場にイメージを持ち込みたい」「up が毎回 build して失敗する」「proxy 環境で docker build が通らない」「イメージにホストの node_modules が入る」ときに使用する。
---

# オフライン／制約ネットワークへのコンテナ配備

実機・工場・顧客先など、**外に出られない環境でスタックを起動する**ための型。
開発機では起きない失敗が、現場で初めて出るのを防ぐ。

## kairos の正準入口

kairosではイメージ名を手で列挙せず、Makefileの対象一覧を正本にする：

```bash
# ネットワークのある側
make images-save IMAGES_FILE=kairos-images.tar.gz

# ファイルとリポジトリを搬送した後、オフライン側
make images-load IMAGES_FILE=kairos-images.tar.gz
make up
```

分割構成では `make robot-images-save` または `make recording-images-save` を使う。
以下の `docker save` / `docker load` は同等の入口がない一般プロジェクト向け。

## 原則: build と up を分離する

**「変更ゼロのビルド」でもネットワークを掴む。** ここが最大の落とし穴。

- BuildKit は `# syntax=docker/dockerfile:1` をレジストリに解決しに行く。キャッシュが
  完全でも往復が発生する（実測 1.1 秒）。**digest でピン留めすれば 0 になる**
- したがって **`up` に `--build` を付けてはいけない。** 付けた瞬間、ネットワークの
  無い現場ではスタックが起動できなくなる。`build` / `rebuild` は別コマンドに分ける

`up --no-build` にすれば安全、とはならない：

- ローカルに無いイメージを **registry へ pull しに行く**（自前ビルドのイメージなら
  `pull access denied` で止まる）
- したがって **compose に判断させず、起動前にローカルでイメージの存在を確認して
  自分で止める**。エラーメッセージも「ネットワークが無い」ではなく
  「イメージが無い。持ち込み手順はこれ」と出す

## 持ち込み: イメージをファイルで運ぶ

```bash
# 出す側（ネットワークのある機械）
docker save <img1> <img2> ... | gzip > stack-images.tar.gz

# 入れる側（現場）
gunzip -c stack-images.tar.gz | docker load
```

- 実測例: 4 イメージで 384MB / 35 秒（内容次第で大きく変わる）
- 圧縮の有無はトレードオフ。USB で運ぶなら圧縮、時間が惜しいなら無圧縮

**イメージだけでは足りない。** 現場で必ず要るものをチェックリストにする：

- [ ] イメージ（`docker load` 済み）
- [ ] リポジトリ本体（compose ファイル・スクリプト・Makefile）
- [ ] `.env`（**gitignore されているので clone では来ない**）
- [ ] gitignore されたローカル設定（機体固有の config 等）
- [ ] 独自メッセージ／プラグインのオーバーレイ
- [ ] 永続データのディレクトリと**その所有者**（root 所有のマウントが生えると詰む）

この「クローンしても来ないもの」の取りこぼしが、現場での典型的な足止め要因。

## ビルド時のネットワーク（proxy / DNS）

現場に持ち込む前、**社内 proxy 越しにビルドする**段階でも詰まる。

- **ビルドコンテナがホストの DNS に届かない** → compose の `build` に `network: host`
  を指定すると、`RUN` がホストのネットワークスタック（DNS 含む）を使う
- **proxy 経由でしか外に出られない** → `build.args` に `HTTP_PROXY` / `HTTPS_PROXY` /
  `NO_PROXY` を宣言する。`docker build` はこれらを事前定義 build-arg として認識するので、
  **値を省略すればホストの同名環境変数がそのまま渡る**（`--build-arg http_proxy` のように）
- **ベースイメージの pull はビルドではなくデーモンが行う。** ビルド引数の proxy は
  効かないので、デーモン側の設定（`/etc/systemd/system/docker.service.d/` 配下）が別途要る
- proxy のホスト名・ポートは環境依存。**コミットする設定ファイルに書かない**
  （環境変数で渡す）
- 実行そのものは外に出ないなら、`docker run` 側に proxy 設定は不要。むしろ入れると
  LAN 内のホストへのアクセスが proxy に吸われてハングする。`NO_PROXY` に LAN を入れる

## ビルドコンテキスト衛生（.dockerignore）

**`.dockerignore` が無いと、`COPY` でホストの生成物がイメージに入る。**

- `COPY <app>/ ./` がホストの `node_modules` / `.venv` を持ち込み、`npm ci` や
  `uv pip install` の成果を**上書きする**
- とくに**クロスアーキ**で壊れる。arm64 の機械で作った木を x86 でビルドすると、
  native バイナリが arm64 のまま入り `MODULE_NOT_FOUND` 等で落ちる。原因が
  「なぜかこの機械だけ動かない」に見えるので切り分けが高くつく

最低限これを除外する（ビルドコンテキストも小さくなる）：

```
node_modules/
.venv/
dist/
build/
__pycache__/
.git/
data/
```

## multi-stage の Python 仮想環境

builder で作った venv を runtime へ丸ごと持っていく構成で頻出：

- **ローカルパスの install が editable になる。** `.pth` が builder 側のパスを指すため、
  runtime に該当パスが無く `ModuleNotFoundError`。**`--no-editable` を明示する**
  （wheel として venv 内にコピーされる）
- **uv が勝手に Python を取りに行く。** バージョン指定によっては GitHub から
  python-build-standalone を落とそうとしてオフラインで失敗する。
  `UV_PYTHON_PREFERENCE=only-system` で抑止し、`--python python3` のように
  **イメージに実在するバイナリ名**で指定する（`python3.12` は無いことがある）
- システムのパッケージ（ROS の rclpy 等）を使うなら `--system-site-packages` が要る。
  この場合、venv はシステム Python と同じ系列でなければならない

## 現場に出る前のチェックリスト

- [ ] ネットワークを切って `up` が通るか、**手元で実際に切って**確認した
- [ ] `# syntax=` を digest 固定した
- [ ] イメージ以外の持ち物（上のリスト）を揃えた
- [ ] イメージ不在時のエラーが、対処手順を示す文言になっている
- [ ] 現場で「再ビルドしないと直らない」変更が残っていないか

## 落とし穴

- **手元で動いた ≠ 現場で動く。** 手元にはイメージキャッシュ・DNS・proxy 設定・
  gitignore されたファイルが揃っている。切って試すまで検証したことにならない
- **CI は現場と条件が違う。** CI が緑でもオフライン起動の保証にはならない
- シェルの環境変数（`ROS_DISTRO` など）が `.env` の値を上書きし、意図しない
  ベースイメージでビルドされることがある。ビルド時に**実際に使われた値を表示**する

## 関連

- ROS 2 特有の Docker 構成は `docker-ros2-development`
