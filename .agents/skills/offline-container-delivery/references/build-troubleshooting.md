# 持ち込み前のビルド障害

配備先での起動と、ネットワークのある開発機でのビルドを分けて調べる。
以下は症状に合う項目だけを使い、環境変更を一括で適用しない。

## Proxy / DNS

- RUN 内の DNS と Docker デーモンによる base image pull は別経路。
  ビルド引数の proxy がデーモンの pull に効くとは限らない。
- RUN の名前解決がホストとの差に起因する場合、必要な build network を選ぶ。
  `network: host` を診断/構成の選択肢として扱い、既定の全権限化にしない。
- proxy は環境変数や既存の build args で渡し、組織固有ホスト名・認証値を
  tracked Compose / Dockerfile へ書かない。デーモン設定変更は別途認可範囲を確認する。
- 実行時に不要な proxy を引き継ぐと LAN 通信が遠回りになる。
  実際の経路に応じて `NO_PROXY` とランタイム環境を確認する。
- shell 環境が `.env` を上書きし得る。選ばれた ROS distro / base image を確認し、
  機密値を含む環境全体をログへ出さない。

## ビルドコンテキスト

`.dockerignore` がホストの `node_modules/`、`.venv/`、生成物、`.git/`、
ランタイム `data/` を除外しているか確認する。後続の `COPY` がコンテナ内で
インストールした依存を上書きすると、クロスアーキテクチャで native binary が壊れる。
プロジェクトが入力として必要なファイルまで一律に除外しない。

## Python multi-stage venv

builder の venv を runtime にコピーする場合、editable install の `.pth` が
builder 専用パスを参照していないか確認する。配備成果物には wheel / non-editable
install を使う。

既存システム Python を使う構成では、uv の Python 自動取得を抑止し、実在する
インタープリタを選ぶ。rclpy などシステムパッケージを使う venv は対応する Python
系列と必要な `--system-site-packages` を保つ。実際の依存・entrypoint は
`docker-ros2-development` の Dockerfile 参照と現在のイメージ定義に合わせる。
