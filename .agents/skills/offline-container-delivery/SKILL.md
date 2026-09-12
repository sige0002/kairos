---
name: offline-container-delivery
description: ネットワーク制約のある現場へ Docker スタックを持ち込み、既存イメージで起動する。オフライン配備や持ち込み前のビルド障害に使う。
---

# オフラインのコンテナ配備

Kairos のイメージ一覧と入口は Makefile を正本にする。
ネットワークのある側で必要なイメージを準備し、配備先へ搬送する。

```bash
make images-save IMAGES_FILE=kairos-images.tar.gz
# 搬送先:
make images-load IMAGES_FILE=kairos-images.tar.gz
make up
```

分割構成では `make robot-images-save` / `make recording-images-save` を使う。
適用する構成・アーキテクチャ・イメージ版が搬送先と一致することを確認する。

## 起動の不変条件

`make up` に build を追加しない。キャッシュがあっても build はネットワークを
必要とし得る。build / load / start / restart / config reload の役割を分離する。
`--no-build` だけでは不足イメージの pull を防げないため、既存の起動前検査を保ち、
不足時には持ち込み手順を示して止める。

イメージに加えて、次の現場固有物が揃っているか確認する。

- compose・スクリプト・Makefile を含むリポジトリ。
- clone には含まれない `.env` と gitignored の機体設定。
- 独自 message / plugin overlay。
- 永続データの場所と書き込み所有者。

機体名・proxy・認証値を持ち運びのために追跡ファイルへ移さない。

## 検証とトラブルシュート

オフライン対応を主張するには、イメージと設定を読み込んだ隔離対象で、ネットワークが
利用できない条件の起動を検証する。実行中のホストの接続を勝手に切らない。
開発機のキャッシュや CI の成功だけを現場起動の証拠にしない。

搬送前の proxy/DNS、ビルドコンテキスト、Python venv の障害は
[build-troubleshooting.md](references/build-troubleshooting.md) を必要に応じて読む。
ROS の network/IPC/device 構成は `docker-ros2-development` を使う。
