#!/usr/bin/env python3
"""
validate_structure.py — リポジトリのエージェントガイダンスの「ファイルシステム
構造」を検証する（本スキルが生成する 正本＋アダプタ 構成の妥当性チェック）。

チェック項目:
  import-wiring    AGENTS.md のある各ディレクトリ: 同階層の CLAUDE.md
                   （./CLAUDE.md または ./.claude/CLAUDE.md）が存在し
                   @import しているか（ラッパー欠落 = Claude Code が共通
                   ルールを読まない。`ln -s AGENTS.md CLAUDE.md` は配線済み扱い）
  import-targets   すべての CLAUDE.md の @import が実在ファイルへ解決するか
  symlinks         .claude/skills/* と .agents/skills/* の symlink 検証。
                   .agents/skills 側の symlink は Codex が follow しない
                   既知バグ（openai/codex #8943, #11314）のため向きも検査
  skill-frontmatter  SKILL.md に name（小文字ハイフン・64字以内）と
                   description（1024字以内）があるか、本文が推奨サイズ内か
  claude-subagents .claude/agents/*.md の frontmatter に name + description
  codex-agents     .codex/agents/*.toml がパースでき name + description を持つか

使い方:
    python3 validate_structure.py REPO
    python3 validate_structure.py --format json REPO
    python3 validate_structure.py --fail-on HIGH REPO

終了コード: 0 = クリーン（--fail-on 未満）、2 = --fail-on 以上の検出あり、
1 = 使い方エラー。標準ライブラリのみ（TOML 検証は Python 3.11+ の tomllib。
旧バージョンでは通知の上スキップ）。
"""
import argparse
import json
import os
import re
import sys

SEV_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
SKIP_DIRS = {".git", "node_modules", "target", ".venv", "venv", "__pycache__",
             "dist", "build", ".ruff_cache"}
IMPORT_RE = re.compile(r"(?:^|(?<=\s))@([~./\w][\w./~-]*)")
NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

try:
    import tomllib
except ImportError:  # Python < 3.11
    tomllib = None


def strip_code(text):
    # HTML コメントはコンテキスト注入前に strip される（公式仕様）ため、
    # その中の @token は無効 — 先に除去する
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    out, in_fence = [], False
    for line in text.splitlines():
        if re.match(r"^(```|~~~)", line.strip()):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(re.sub(r"`[^`]*`", "", line))
    return "\n".join(out)


def looks_like_import(target):
    """ファイルインポートでない @-言及（npm の @scope/pkg、@ハンドル名）を除外。
    実際のインポートはパスらしい: ~ / ./ ../ で始まるか、ドットを含む。
    拡張子なしの @README は取りこぼすが、散文への HIGH 誤検出を避ける方を取る。"""
    return target.startswith(("~", "/", "./", "../")) or "." in target


def parse_frontmatter(text):
    """最小限の1階層 YAML frontmatter パーサ。(dict|None, body) を返す。"""
    text = text.lstrip("﻿")  # UTF-8 BOM（Windows エディタ）
    if not text.startswith("---"):
        return None, text
    lines = text.splitlines()
    fm, body_start = {}, None
    for i, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            body_start = i + 1
            break
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            value = m.group(2).strip().strip("\"'")
            if value in {">", "|", ">-", "|-", ">+", "|+"}:
                value = ""  # YAML ブロックスカラー記号 — 値は次行以降
            fm[m.group(1)] = value
        elif line.startswith((" ", "\t")) and fm:
            last = list(fm)[-1]
            fm[last] = (fm[last] + " " + line.strip()).strip()
    if body_start is None:
        return None, text
    return fm, "\n".join(lines[body_start:])


def walk(repo):
    for root, dirs, files in os.walk(repo, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        yield root, dirs, files


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("repo", nargs="?", default=".", help="リポジトリルート")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--fail-on", choices=["LOW", "MEDIUM", "HIGH"], default=None)
    ap.add_argument("--skill-max-lines", type=int, default=500,
                    help="SKILL.md 本文の推奨サイズ（既定 500）")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    if not os.path.isdir(repo):
        print(f"エラー: ディレクトリでない: {repo}", file=sys.stderr)
        return 1
    findings = []

    def add(sev, check, path, msg):
        findings.append({"severity": sev, "check": check,
                         "file": path, "message": msg})

    def read(path):
        """読めない場合は None（壊れた symlink・権限 — HIGH として記録済み）。"""
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                return f.read()
        except OSError as e:
            add("HIGH", "unreadable", path,
                f"ファイルを読めない（{e.__class__.__name__}: {e}）— "
                "壊れた symlink か権限の問題")
            return None

    def in_skill_payload(path):
        """インストール済みスキル配下・その fixtures/templates のガイダンスは
        意図的に変則的 — プロジェクトのガイダンスではない。
        判定は repo からの相対パスで行う（絶対パスだと、fixture リポジトリ
        自体を監査するときに親側のパス成分で誤除外される）。"""
        p = "/" + os.path.relpath(path, repo).replace(os.sep, "/")
        return ("/.claude/skills/" in p or "/.agents/skills/" in p
                or "/evals/fixtures/" in p or "/templates/" in p)

    agents_files, claude_files, skill_files = [], [], []
    for root, dirs, files in walk(repo):
        if "AGENTS.md" in files:
            agents_files.append(os.path.join(root, "AGENTS.md"))
        if "CLAUDE.md" in files:
            claude_files.append(os.path.join(root, "CLAUDE.md"))
        if "SKILL.md" in files:
            skill_files.append(os.path.join(root, "SKILL.md"))
    def rel(p):
        return "/" + os.path.relpath(p, repo).replace(os.sep, "/")
    agents_files = [p for p in agents_files if not in_skill_payload(p)]
    claude_files = [p for p in claude_files if not in_skill_payload(p)]
    skill_files = [p for p in skill_files
                   if "/evals/fixtures/" not in rel(p)
                   and "/templates/" not in rel(p)]

    # --- import-wiring: AGENTS.md には @import する CLAUDE.md ラッパーが要る ---
    for agents in agents_files:
        d = os.path.dirname(agents)
        # ./CLAUDE.md と ./.claude/CLAUDE.md はどちらも公式のプロジェクトスコープ
        candidates = [os.path.join(d, "CLAUDE.md"),
                      os.path.join(d, ".claude", "CLAUDE.md")]
        claude = next((c for c in candidates if os.path.isfile(c)), None)
        if claude is None:
            broken = next((c for c in candidates if os.path.islink(c)), None)
            if broken:
                add("HIGH", "import-wiring", broken,
                    f"CLAUDE.md が壊れた symlink -> {os.readlink(broken)}")
            else:
                add("MEDIUM", "import-wiring", agents,
                    "AGENTS.md の同階層に CLAUDE.md が無い — Claude Code はこの"
                    "ルールを読まない。'@AGENTS.md' と書いた CLAUDE.md を足す")
            continue
        if os.path.islink(claude) and \
                os.path.realpath(claude) == os.path.realpath(agents):
            continue  # 公式の `ln -s AGENTS.md CLAUDE.md` 構成 — 配線済み
        text = read(claude)
        if text is None:
            continue
        imports = [m.group(1) for m in IMPORT_RE.finditer(strip_code(text))
                   if looks_like_import(m.group(1))]
        if not any(os.path.basename(i) == "AGENTS.md" for i in imports):
            add("MEDIUM", "import-wiring", claude,
                "同階層に AGENTS.md があるのに CLAUDE.md が @import していない — "
                "Claude Code と Codex でルールが分岐する")

    # --- import-targets: すべての @import が解決するか ---
    for claude in claude_files:
        base = os.path.dirname(claude)
        text = read(claude)
        if text is None:
            continue
        for m in IMPORT_RE.finditer(strip_code(text)):
            if not looks_like_import(m.group(1)):
                continue  # @scope/pkg や @ハンドル — 散文でありインポートではない
            target = os.path.expanduser(m.group(1))
            if not os.path.isabs(target):
                target = os.path.normpath(os.path.join(base, target))
            if target.startswith(os.path.expanduser("~")) and not target.startswith(repo):
                continue  # ユーザースコープのインポート — 存在はマシン依存
            if not os.path.isfile(target):
                add("HIGH", "import-targets", claude,
                    f"@{m.group(1)} が解決しない（探索先: {target}）")

    # --- スキル探索ルート配下の symlink ---
    for rel in (".claude/skills", ".agents/skills"):
        droot = os.path.join(repo, rel)
        if not os.path.isdir(droot):
            continue
        if rel == ".agents/skills" and os.path.islink(droot):
            add("MEDIUM", "symlinks", droot,
                ".agents/skills 自体が symlink — Codex はこれを通してスキルを"
                "ロードしない（openai/codex #11314）。実ディレクトリにする")
        for name in sorted(os.listdir(droot)):
            p = os.path.join(droot, name)
            if os.path.islink(p) and not os.path.exists(p):
                add("HIGH", "symlinks", p,
                    f"壊れた symlink -> {os.readlink(p)}")
            elif rel == ".agents/skills" and os.path.islink(p):
                add("MEDIUM", "symlinks", p,
                    ".agents/skills 配下のスキルが symlink — Codex は symlink "
                    "されたスキルを follow しない（openai/codex #8943, #11314）。"
                    "実体をここに置き、.claude/skills 側から symlink する（向きが逆）")
            elif os.path.isdir(p) and not os.path.isfile(os.path.join(p, "SKILL.md")):
                add("MEDIUM", "symlinks", p, "SKILL.md の無いスキルディレクトリ")

    # --- SKILL.md frontmatter ---
    for skill in skill_files:
        text = read(skill)
        if text is None:
            continue
        fm, body = parse_frontmatter(text)
        if fm is None:
            add("HIGH", "skill-frontmatter", skill,
                "YAML frontmatter（--- name/description ---）が無い")
            continue
        name = fm.get("name", "")
        desc = fm.get("description", "")
        if not name:
            add("HIGH", "skill-frontmatter", skill, "frontmatter に 'name' が無い")
        elif not NAME_RE.match(name) or len(name) > 64:
            add("MEDIUM", "skill-frontmatter", skill,
                f"name '{name}' は小文字ハイフン・64字以内にする")
        elif name != os.path.basename(os.path.dirname(skill)):
            add("LOW", "skill-frontmatter", skill,
                f"name '{name}' がディレクトリ名 "
                f"'{os.path.basename(os.path.dirname(skill))}' と一致しない")
        if not desc:
            add("HIGH", "skill-frontmatter", skill, "frontmatter に 'description' が無い")
        elif len(desc) > 1024:
            add("MEDIUM", "skill-frontmatter", skill,
                f"description が {len(desc)} 文字（1024 超）")
        body_lines = body.count("\n") + 1
        if body_lines > args.skill_max_lines:
            add("LOW", "skill-frontmatter", skill,
                f"本文が {body_lines} 行（推奨 {args.skill_max_lines} 超）— "
                "詳細を references/ に分割する")

    # --- .claude/agents/*.md サブエージェント定義 ---
    agents_dir = os.path.join(repo, ".claude", "agents")
    if os.path.isdir(agents_dir):
        for name in sorted(os.listdir(agents_dir)):
            if not name.endswith(".md"):
                continue
            p = os.path.join(agents_dir, name)
            text = read(p)
            if text is None:
                continue
            fm, _ = parse_frontmatter(text)
            if fm is None or not fm.get("name") or not fm.get("description"):
                add("MEDIUM", "claude-subagents", p,
                    "サブエージェント定義には name + description の frontmatter が必要")

    # --- .codex/agents/*.toml ---
    codex_agents = os.path.join(repo, ".codex", "agents")
    if os.path.isdir(codex_agents):
        for name in sorted(os.listdir(codex_agents)):
            if not name.endswith(".toml"):
                continue
            p = os.path.join(codex_agents, name)
            if tomllib is None:
                add("LOW", "codex-agents", p,
                    "tomllib が無い（Python < 3.11）— TOML 未検証")
                continue
            try:
                with open(p, "rb") as f:
                    data = tomllib.load(f)
            except Exception as e:  # tomllib.TOMLDecodeError / OSError
                add("HIGH", "codex-agents", p, f"TOML パースエラー: {e}")
                continue
            for field in ("name", "description"):
                if field not in data:
                    add("MEDIUM", "codex-agents", p, f"'{field}' が無い")

    findings.sort(key=lambda f: (-SEV_ORDER[f["severity"]], f["file"]))
    if args.format == "json":
        print(json.dumps({"findings": findings}, ensure_ascii=False, indent=2))
    else:
        for f in findings:
            print(f"[{f['severity']}] {f['check']}: "
                  f"{os.path.relpath(f['file'], repo)}\n    {f['message']}")
        print(f"\n{len(findings)} 件検出 "
              f"（AGENTS.md {len(agents_files)}、CLAUDE.md {len(claude_files)}、"
              f"SKILL.md {len(skill_files)} を検査）")

    if args.fail_on and any(SEV_ORDER[f["severity"]] >= SEV_ORDER[args.fail_on]
                            for f in findings):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
