#!/usr/bin/env python3
"""
detect_conflicts.py — 1つのリポジトリ内のガイダンスファイル群（AGENTS.md /
AGENTS.override.md / CLAUDE.md / CLAUDE.local.md）を横断して、単一ファイルの
監査では見えない矛盾と重複を検出する。

  tool-conflict     同じ役割の排他的ツールが同一 root→leaf スコープチェーン上で
                    複数指定されている（npm vs pnpm、black vs ruff format、
                    pip vs poetry vs uv、tabs vs spaces …）
  polarity-conflict 同じコマンド・トピックが片方で「必ず/always」、
                    もう片方で「禁止/never」になっている
  duplication       ほぼ同一の散文行が複数ファイルに存在 — @AGENTS.md を
                    インポートすべき CLAUDE.md にある場合は純粋な二重管理

スコープを考慮する: 兄弟ディレクトリ（packages/a と packages/b）は別スコープ
であり、モノレポが片方で npm・もう片方で pnpm を使うのは正当。同一 root→leaf
経路上のファイルだけを比較する。

検出はレビュー候補（ヒューリスティック、NLP なし）。重大度 MEDIUM/LOW。

使い方:
    python3 detect_conflicts.py REPO
    python3 detect_conflicts.py --format json REPO
    python3 detect_conflicts.py --fail-on MEDIUM REPO

終了コード: 0 = クリーン（--fail-on 未満）、2 = --fail-on 以上の検出あり、
1 = 使い方エラー。標準ライブラリのみ。
"""
import argparse
import itertools
import json
import os
import re
import sys

SEV_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
GUIDANCE_NAMES = {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"}
SKIP_DIRS = {".git", "node_modules", "target", ".venv", "venv", "__pycache__",
             "dist", "build", ".ruff_cache"}

# 排他的ツール群: 同じ役割のツールが1つのスコープチェーンに2つ以上あれば、
# 少なくとも紛らわしく、多くの場合は実際の矛盾。
TOOL_GROUPS = {
    "js-package-manager": [
        ("npm", r"\bnpm\s+(install|run|ci|test|exec)\b"),
        ("yarn", r"\byarn\b"),
        ("pnpm", r"\bpnpm\b"),
        ("bun", r"\bbun\s+(install|run|test|x)\b"),
    ],
    "python-package-manager": [
        ("pip", r"\bpip3?\s+install\b"),
        ("poetry", r"\bpoetry\s+(install|add|run|lock)\b"),
        ("uv", r"\buv\s+(pip|add|run|sync|lock)\b"),
        ("conda", r"\bconda\s+(install|env|create)\b"),
    ],
    "python-formatter": [
        ("black", r"\bblack\b(?!\s*(list|box))"),
        ("ruff-format", r"\bruff\s+format\b"),
        ("autopep8", r"\bautopep8\b"),
        ("yapf", r"\byapf\b"),
    ],
    "python-linter": [
        ("flake8", r"\bflake8\b"),
        ("pylint", r"\bpylint\b"),
        ("ruff-check", r"\bruff\s+(check|lint)\b"),
    ],
    "js-test-runner": [
        ("jest", r"\bjest\b"),
        ("vitest", r"\bvitest\b"),
        ("mocha", r"\bmocha\b"),
    ],
    "indentation": [
        ("tabs", r"(use|prefer|must use|使用|使う)[^\n]{0,12}\btabs?\b|タブ(で|を使)"),
        ("spaces", r"(use|prefer|must use|使用|使う)[^\n]{0,12}\bspaces\b|スペース(で|を使)"),
    ],
}

POSITIVE_RE = re.compile(r"(必ず|常に|\balways\b|\bmust\b(?!\s+not)|\buse\b|使う|使用する|実行する)", re.I)
NEGATIVE_RE = re.compile(r"(禁止|しない(こと|で)?|不要|避け|\bnever\b|\bdo\s+not\b|\bdon't\b|\bmust\s+not\b|\bavoid\b)", re.I)
# 極性チェックの対象トピック: バッククォートのコマンド + 少数の危険キーワード
TOPIC_KEYWORD_RE = re.compile(
    r"`([^`]{2,40})`|(\bforce[- ]push\b|\bsudo\b|\brebase\b|\bsquash\b|\bmock\b|型ヒント|type\s+hints?)",
    re.I)


def find_guidance_files(repo):
    out = []
    for root, dirs, files in os.walk(repo):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        # インストールされたスキルは意図的に壊れた fixtures/templates を
        # 同梱している — プロジェクトのガイダンスとして扱わない
        if os.path.basename(root) in (".claude", ".agents"):
            dirs[:] = [d for d in dirs if d != "skills"]
        for name in sorted(files):
            if name in GUIDANCE_NAMES:
                out.append(os.path.join(root, name))
    return out


def same_chain(repo, a, b):
    """a と b が1つの root→leaf ディレクトリ経路上（祖先/子孫関係）なら True。"""
    da = os.path.relpath(os.path.dirname(a), repo)
    db = os.path.relpath(os.path.dirname(b), repo)
    pa = [] if da == "." else da.split(os.sep)
    pb = [] if db == "." else db.split(os.sep)
    shorter, longer = (pa, pb) if len(pa) <= len(pb) else (pb, pa)
    return longer[:len(shorter)] == shorter


def prose_lines(path):
    """フェンスコードブロック外の (lineno, line)。フェンス内のコマンドも
    ツール検出には意味があるので別リストで返す。
    読めないファイルは OSError を送出 — 呼び出し側が報告して続行する。"""
    prose, code = [], []
    in_fence = False
    with open(path, encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            line = line.rstrip("\r\n")
            if re.match(r"^(```|~~~)", line.strip()):
                in_fence = not in_fence
                continue
            (code if in_fence else prose).append((i, line))
    return prose, code


def normalize(line):
    """重複比較のために散文を正規化する。"""
    s = re.sub(r"[#>*\-\s`.,:;、。・！!？?（）()\[\]]+", "", line).lower()
    return s


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("repo", nargs="?", default=".", help="リポジトリルート")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--fail-on", choices=["LOW", "MEDIUM", "HIGH"], default=None)
    ap.add_argument("--min-dup-chars", type=int, default=11,
                    help="重複判定の正規化後最小文字数（既定 11 — 1規則1行の"
                         "箇条書きは正規化後 10〜20 文字程度）")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    if not os.path.isdir(repo):  # パスの打ち間違いを「クリーン」と読ませない
        print(f"エラー: ディレクトリでない: {repo}", file=sys.stderr)
        return 1
    files = find_guidance_files(repo)
    findings = []

    def add(cat, sev, msg, locations):
        findings.append({"category": cat, "severity": sev, "message": msg,
                         "locations": locations})

    # ファイル別の抽出パス
    per_file = {}
    for path in list(files):
        try:
            prose, code = prose_lines(path)
        except OSError as e:  # 壊れた symlink・権限 — 報告してスキップ
            add("unreadable", "HIGH",
                f"{os.path.relpath(path, repo)} を読めない"
                f"（{e.__class__.__name__}）— 壊れた symlink か権限の問題",
                [{"file": path, "line": 1, "excerpt": ""}])
            files.remove(path)
            continue
        tools = {}   # group -> {tool -> 初出の (lineno, line)}
        topics = {}  # keyword -> [(lineno, polarity, line)]
        for lineno, line in prose + code:
            for group, entries in TOOL_GROUPS.items():
                for tool, pat in entries:
                    if re.search(pat, line, re.I):
                        tools.setdefault(group, {}).setdefault(tool, (lineno, line))
        for lineno, line in prose:
            pos, neg = bool(POSITIVE_RE.search(line)), bool(NEGATIVE_RE.search(line))
            if not (pos or neg):
                continue
            for m in TOPIC_KEYWORD_RE.finditer(line):
                kw = (m.group(1) or m.group(2) or "").strip().lower()
                kw = re.sub(r"\s+", " ", kw)
                if kw:
                    topics.setdefault(kw, []).append(
                        (lineno, "neg" if neg else "pos", line))
        dup_lines = {}
        for lineno, line in prose:
            n = normalize(line)
            if len(n) >= args.min_dup_chars:
                dup_lines.setdefault(n, (lineno, line))
        per_file[path] = {"tools": tools, "topics": topics, "dups": dup_lines}

    # tool-conflict + polarity-conflict: 同一スコープのファイルペアごと
    for a, b in itertools.combinations(files, 2):
        if not same_chain(repo, a, b):
            continue
        for group in TOOL_GROUPS:
            ta = per_file[a]["tools"].get(group, {})
            tb = per_file[b]["tools"].get(group, {})
            union = {**{t: (a, *loc) for t, loc in ta.items()},
                     **{t: (b, *loc) for t, loc in tb.items()}}
            if len(union) >= 2 and (ta and tb) and set(ta) != set(tb):
                add("tool-conflict", "MEDIUM",
                    f"{group}: 同一スコープチェーン上の複数ファイルで "
                    f"{sorted(union)} が指定されている — スコープごとに1つへ"
                    "統一するか、どこで何を使うかを明記する",
                    [{"file": f, "line": ln, "excerpt": ex.strip()[:100]}
                     for f, ln, ex in union.values()])
        for kw in set(per_file[a]["topics"]) & set(per_file[b]["topics"]):
            pol = {p for _, p, _ in per_file[a]["topics"][kw]} | \
                  {p for _, p, _ in per_file[b]["topics"][kw]}
            if pol == {"pos", "neg"}:
                locs = [{"file": f, "line": ln, "excerpt": ex.strip()[:100]}
                        for f in (a, b)
                        for ln, _, ex in per_file[f]["topics"][kw][:2]]
                add("polarity-conflict", "MEDIUM",
                    f"'{kw}': 片方で必須、もう片方で禁止になっている", locs)

    # ファイル内のツール矛盾（1ファイルが排他的ツールを2つ指定）
    for path in files:
        for group, tools in per_file[path]["tools"].items():
            if len(tools) >= 2 and group in ("indentation",):
                add("tool-conflict", "MEDIUM",
                    f"{group}: {sorted(tools)} が同一ファイル内で両方参照されている",
                    [{"file": path, "line": ln, "excerpt": ex.strip()[:100]}
                     for ln, ex in tools.values()])

    # 同一チェーン上のファイル間の重複
    for a, b in itertools.combinations(files, 2):
        if not same_chain(repo, a, b):
            continue
        shared = set(per_file[a]["dups"]) & set(per_file[b]["dups"])
        if not shared:
            continue
        # 同一ディレクトリの AGENTS.md + CLAUDE.md: コピー行1つでも純粋な
        # 二重管理（ラッパーは @import すべきで、書き写すべきでない）
        sibling_pair = (os.path.dirname(a) == os.path.dirname(b) and
                        {os.path.basename(a), os.path.basename(b)} &
                        {"AGENTS.md"} and
                        {os.path.basename(a), os.path.basename(b)} &
                        {"CLAUDE.md", "CLAUDE.local.md"})
        sev = "MEDIUM" if (len(shared) >= 3 or sibling_pair) else "LOW"
        examples = []
        for n in sorted(shared)[:5]:
            la, ea = per_file[a]["dups"][n]
            lb, _ = per_file[b]["dups"][n]
            examples.append({"file": a, "line": la, "excerpt": ea.strip()[:100],
                             "also": f"{b}:{lb}"})
        add("duplication", sev,
            f"ほぼ同一の行が {len(shared)} 行、両ファイルに存在 — 正本を1つ"
            "（AGENTS.md）にし、CLAUDE.md は @import させる", examples)

    findings.sort(key=lambda f: -SEV_ORDER[f["severity"]])
    if args.format == "json":
        print(json.dumps({"files_scanned": len(files), "findings": findings},
                         ensure_ascii=False, indent=2))
    else:
        for f in findings:
            print(f"[{f['severity']}] {f['category']}: {f['message']}")
            for loc in f["locations"]:
                extra = f"  (also {loc['also']})" if "also" in loc else ""
                print(f"    {os.path.relpath(loc['file'], repo)}:{loc['line']}: "
                      f"{loc['excerpt']}{extra}")
        print(f"\n{len(files)} ファイル比較、{len(findings)} 件検出")

    if args.fail_on and any(SEV_ORDER[f["severity"]] >= SEV_ORDER[args.fail_on]
                            for f in findings):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
