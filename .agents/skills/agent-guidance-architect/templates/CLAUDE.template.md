<!-- agent-guidance-architect: ルート CLAUDE.md テンプレート。
     共通ルールは書かない — @AGENTS.md で正本を取り込み、ここには
     Claude Code でしか意味を持たないルールだけを置く。
     注意: @import されたファイルも起動時コンテキストに展開される。
     ここを短くしても AGENTS.md が肥大なら削減にならない。このコメントは削除する。 -->
@AGENTS.md

# Claude Code 固有ルール

- {{例: 複雑な変更では実装前に Plan Mode を使う}}
- {{例: 調査量が多いタスクはサブエージェント（Explore）へ分割する}}
- {{例: 実装したエージェントとは別のエージェントに検証させる}}
<!-- Hooks / permissions で強制できるものはここに書かず .claude/settings.json へ。
     CLAUDE.md は文脈であって強制ではない。 -->
