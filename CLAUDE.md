@AGENTS.md

# Claude Code 固有ルール

共通ルールは [AGENTS.md](AGENTS.md) にだけ書く。
`.claude/skills/` は `.agents/skills/` の実体を参照する。

- `.claude/rules/` に適用対象のルールがあれば従う。
- `.claude/settings.json` の許可・拒否設定に従う。
  `*.pem` / `*.key` / `secrets/**` は読まない。
