# topic_probe 仕様

> ステータス: 設計確定（v1）。frontend の OL-3.3（汎用フィールドプロッタ）として先行実装されたものを仕様化し、未記載事項を推奨設計として確定。日本語が正本（これを正とする）。英語版 `docs/specs/en/topic_probe.md` は自動生成ミラー（直接編集しない）。**認証は不要。**

ROS 2 トピックの**数値フィールドをライブにプロットする**汎用プロッタコンテナ。`topic_monitor` が**ペイロードを decode しない**のと対照的に、topic_probe は**選択トピックを decode する**。decode を専用コンテナに隔離することで、その負荷が `rosbag2_recorder` / `topic_monitor`（＝録画周波数・監視）に波及しないことを保証する。

ロボット非依存: トピックは ROS 2 グラフに実際に流れているものから取り、フィールドはライブメッセージ型から introspect する（機体固有のトピック名・フィールド名を**ハードコードしない**）。

## 役割

- 選択トピックを軽量に subscribe & decode し、指定された数値フィールドの時系列サンプルを配信する。
- トピック discovery と、トピック型ごとの**数値フィールド introspection**を提供する。

## 入力

- プロット対象トピック（ROS 2 グラフ discovery から選択。allowlist の制約はなく、グラフ上の任意トピックを対象にできる）
- トピックごとの数値フィールドパス（introspection 結果から選択。配列は展開、下記）
- サンプルレート Hz（既定 10、**パネル毎に選択可**。サーバ側で上限固定）

## 構成コンポーネント

- **ROS2 Subscribers** — rclpy ノードで購読し、各メッセージを decode する。**複数トピックを同時購読**できる（下記「同時購読モデル」）。
- **Field Introspection** — decode 済みメッセージの数値リーフを走査して dotted パスを列挙する。固定長の数値配列は `position[0]`〜`position[N]` のように**インデックス展開**し、UI が個別系列として選べるようにする。
- **Sampler** — 各 stream 接続ごとに、指定 Hz で最新 decode 済みメッセージから対象フィールド値を抽出して送る（スロットリング）。
- **Sample Publisher** — SSE で配信。

## 同時購読モデル / コスト方針

- **ref-count 購読**: stream 接続が張られたトピックを購読し、そのトピックを使う**最後の接続が切れたら購読解除**する。同一トピックに複数接続（複数フィールド・複数パネル）が来ても購読は 1 本に集約され、1 メッセージの decode を共有する。
- **異トピック重畳を許可**: 右腕 / 左腕のように別トピックの系列を 1 チャートに重ねるため、複数トピックを**同時に**購読・decode できる（旧 v0 の「同時に 1 トピックのみ」制約を撤廃）。
- **ハード上限なし・警告のみ**: decode コストは `同時購読トピック数 × Hz` で増える。これに**ハード上限は設けず**、目安（既定 6 トピック）を超えたら UI に**警告**を出す（追加は拒否しない）。重いトピックを多数重ねると probe コンテナ自身がもたつき得るが、**録画・監視には波及しない**（隔離。下記「設計ポイント」）。劣化するのは preview の応答性のみ。

## API

> probe のエンドポイントは**リバースプロキシ下の `/probe/`** に位置し、orchestrator の `/api/v1` 配下**ではない**（frontend の nginx / Vite dev サーバが topic_probe コンテナへ直接プロキシする）。

- `GET /probe/topics` — ROS 2 グラフ discovery（`name` / `type`）。
- `GET /probe/fields?topic=<name>` — そのトピック型の数値フィールドパス一覧（ライブ introspection）。配列はインデックス展開。メッセージ未受信・数値フィールド無しのときは空配列 + `reason`。
- `GET /probe/stream?topic=<name>&fields=<a,b,c>&hz=<n>` — SSE サンプルストリーム。**1 接続で 1 トピックの複数フィールド**を多値で配る（旧 v0 の単一 `field` を `fields` に拡張。単一フィールドはその特殊形）。`hz` はサーバ側 max でクランプ。
- `GET /healthz` / `GET /readyz`
- `/readyz` は rclpy node / executor thread の起動成功後だけ ready。部分初期化の失敗は全 resource を破棄して再試行可能にし、thread 死亡後は ready を返さない。
- API 共通規約（エラー形式・型・時刻）は [config](config.md) に従う。

## 出力スキーマ（例、SSE / JSON）

```json
{
  "topic": "/right_arm/joint_states",
  "t": 1719446625.123,
  "values": {
    "position[0]": 0.12,
    "position[1]": -0.04,
    "velocity[0]": 0.0
  }
}
```

- メッセージ未受信のフィールドは `null`（接続直後から keep-alive サンプルを出すため）。

## 設計ポイント / 非機能

- **隔離が最優先。** topic_probe は別コンテナ（1 フォルダ = 1 イメージ）で、`rosbag2_recorder` / `topic_monitor` とは別プロセス。購読は best_effort、monitor は非 decode。probe が何トピックを decode しても**録画周波数・監視メトリクスには一切波及しない**（[topic_monitor](topic_monitor.md) の非破壊方針と同じ理屈）。増えるのは probe コンテナ自身の CPU のみ。
- 上限はハードに張らず**警告のみ**（運用で自由に重ねられることを優先）。劣化は preview 応答性に閉じ、録画データは無傷。
- 配列フィールドの展開数や stream の Hz 上限など具体値は実装側の保護パラメータとして調整可（TBD）。
- フロントエンドでの消費（Live Scope への統合・add 式パネル・重畳・REC/STOP マーカ）は [frontend](frontend.md) を参照。
- 共有設定は [config](config.md)。
