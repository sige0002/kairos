#!/usr/bin/env python3
"""
measure_context.py — リポジトリのガイダンスファイル（CLAUDE.md / AGENTS.md）が
Claude Code / OpenAI Codex の起動時コンテキストを実際にどれだけ消費するかを測る。

背景: Claude Code は @import を起動時に展開するため、巨大な CLAUDE.md を
インポートに分割してもコンテキストは減らない。Codex はリポジトリルートから
cwd まで、1ディレクトリ1ファイルを連結する。本ツールは両方のローダを
シミュレートし、「実際に何が読み込まれるか」をファイル別・合計で報告する。

シミュレートする挙動（検証済み仕様は references/claude-code-spec.md /
codex-spec.md を参照。本ファイルはそれらと同期を保つこと）:
  Claude Code: root→--cwd の経路上の CLAUDE.md / .claude/CLAUDE.md /
               CLAUDE.local.md を連結。@import は再帰解決（公式仕様の最大
               4ホップ）、コードブロック・インラインコード内は不解析。
               トークン見積りは HTML コメントを除外（注入前に strip される仕様）。
               --cwd 配下のサブディレクトリの CLAUDE.md はオンデマンド読み込み
               のため、ここでは正しく数えない。
  Codex:       root→--cwd の各ディレクトリで AGENTS.override.md → AGENTS.md →
               --fallback 名の順に1つ採用（空ファイルはスキップ）。連結サイズが
               project_doc_max_bytes（32 KiB）に達すると以降は黙って落とされる
               — 落ちるファイルを DROPPED として表示する。

トークン数は概算（ASCII 4文字/トークン + その他 1.5文字/トークン）。
リファクタ前後の比較には十分だが、課金計算には使えない。

使い方:
    python3 measure_context.py --repo /path/to/repo
    python3 measure_context.py --repo . --cwd packages/backend --format json
    python3 measure_context.py --repo . --fallback CLAUDE.md   # Codex fallback
    python3 measure_context.py --repo . --budget 3000          # 超過で警告

終了コード: 0 = 正常、2 = --budget 超過、1 = 使い方エラー。標準ライブラリのみ。
"""
import argparse
import json
import os
import re
import sys

# `@path` インポート: '@' の直前が行頭か空白（メールアドレスを除外）。
# パスは相対・絶対・~ を許容 — Claude Code のメモリインポートに合わせる。
IMPORT_RE = re.compile(r"(?:^|(?<=\s))@([~./\w][\w./~-]*)")
FENCE_RE = re.compile(r"^(```|~~~)")
# Codex は連結サイズがこの値（project_doc_max_bytes 既定）に達すると
# 以降のファイル追加を黙って停止する（openai/codex #7138）
CODEX_DOC_MAX_BYTES = 32 * 1024


def looks_like_import(target):
    """ファイルインポートでない @-言及（npm の @scope/pkg、@ハンドル名）を除外。
    実際のインポートはパスらしい: ~ / ./ ../ で始まるか、ドットを含む。
    拡張子なしの @README は取りこぼすが、散文への HIGH 誤検出を避ける方を取る。"""
    return target.startswith(("~", "/", "./", "../")) or "." in target


def estimate_tokens(text: str) -> int:
    """トークナイザ不要の概算: ASCII は約4文字/トークン、CJK 等は約1.5文字/トークン。"""
    ascii_chars = sum(1 for c in text if ord(c) < 128)
    other_chars = len(text) - ascii_chars
    return int(ascii_chars / 4 + other_chars / 1.5)


def strip_code(text: str) -> str:
    """HTML コメント（公式仕様で注入前に strip される）、フェンスコードブロック、
    インラインコードスパンを除去する（そこにある @import は無効のため）。"""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    out, in_fence = [], False
    for line in text.splitlines():
        if FENCE_RE.match(line.strip()):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(re.sub(r"`[^`]*`", "", line))
    return "\n".join(out)


def file_stats(path: str, strip_html_comments: bool = False) -> dict:
    """strip_html_comments=True は Claude Code のトークン見積り用 — HTML コメントは
    コンテキスト注入前に strip される（公式仕様）。Codex の挙動は未検証のため
    Codex 側は生バイトのまま数える。`bytes` は常にディスク上のサイズ。"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return {"path": path, "bytes": 0, "lines": 0, "tokens_est": 0,
                "unreadable": True}
    counted = re.sub(r"<!--.*?-->", "", text, flags=re.S) if strip_html_comments \
        else text
    return {
        "path": path,
        "bytes": os.path.getsize(path),
        "lines": text.count("\n") + (1 if text and not text.endswith("\n") else 0),
        "tokens_est": estimate_tokens(counted),
    }


def resolve_imports(path: str, max_hops: int, _seen=None, _depth=0) -> list:
    """`path` 配下の @import ツリーを [(path, depth, exists)] で返す。"""
    if _seen is None:
        _seen = set()
    real = os.path.realpath(path)
    if real in _seen or _depth >= max_hops:
        return []
    _seen.add(real)
    results = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError:
        return []
    base = os.path.dirname(path)
    for m in IMPORT_RE.finditer(strip_code(text)):
        if not looks_like_import(m.group(1)):
            continue  # @scope/pkg や @ハンドル — 散文であってインポートではない
        target = os.path.expanduser(m.group(1))
        if not os.path.isabs(target):
            target = os.path.normpath(os.path.join(base, target))
        exists = os.path.isfile(target)
        results.append({"path": target, "depth": _depth + 1, "exists": exists})
        if not exists:
            continue
        if _depth + 1 >= max_hops:
            # 公式のホップ上限を超えて再帰する場合 — 隠さず表示する
            try:
                with open(target, encoding="utf-8", errors="replace") as tf:
                    if any(looks_like_import(mm.group(1))
                           for mm in IMPORT_RE.finditer(strip_code(tf.read()))):
                        results.append({"path": target + " (its imports)",
                                        "depth": _depth + 2, "exists": False,
                                        "truncated": True})
            except OSError:
                pass
        else:
            results.extend(resolve_imports(target, max_hops, _seen, _depth + 1))
    return results


def dirs_root_to_cwd(repo: str, cwd: str) -> list:
    """リポジトリルートから cwd までのディレクトリ列（両端含む）。"""
    rel = os.path.relpath(cwd, repo)
    dirs = [repo]
    if rel != ".":
        acc = repo
        for part in rel.split(os.sep):
            acc = os.path.join(acc, part)
            dirs.append(acc)
    return dirs


def claude_view(repo: str, cwd: str, max_hops: int) -> dict:
    """Claude Code が起動時にロードするファイル: CLAUDE.md チェーン + @import 展開。
    トークン見積りは HTML コメントを除外（注入前に strip される）。"""
    loaded, seen = [], set()

    def add(path, via):
        real = os.path.realpath(path)
        if real in seen:
            return
        if os.path.islink(path) and not os.path.exists(path):
            loaded.append({"path": path, "bytes": 0, "lines": 0,
                           "tokens_est": 0, "via": "BROKEN SYMLINK (not loaded)"})
            return
        if not os.path.isfile(path):
            return
        seen.add(real)
        entry = file_stats(path, strip_html_comments=True)
        entry["via"] = via
        loaded.append(entry)
        for imp in resolve_imports(path, max_hops):
            if imp.get("truncated"):
                loaded.append({"path": imp["path"], "bytes": 0, "lines": 0,
                               "tokens_est": 0,
                               "via": "import (TRUNCATED at max hops)"})
                continue
            if not imp["exists"]:
                loaded.append({"path": imp["path"], "bytes": 0, "lines": 0,
                               "tokens_est": 0, "via": "import (MISSING)"})
                continue
            r = os.path.realpath(imp["path"])
            if r in seen:
                continue
            seen.add(r)
            e = file_stats(imp["path"], strip_html_comments=True)
            e["via"] = f"import depth {imp['depth']}"
            loaded.append(e)

    for d in dirs_root_to_cwd(repo, cwd):
        add(os.path.join(d, "CLAUDE.md"), "memory chain")
        add(os.path.join(d, ".claude", "CLAUDE.md"), "memory chain (.claude/)")
        add(os.path.join(d, "CLAUDE.local.md"), "memory chain (local)")
    return {"tool": "claude-code", "files": loaded,
            "total_tokens_est": sum(f["tokens_est"] for f in loaded),
            "total_bytes": sum(f["bytes"] for f in loaded)}


def codex_view(repo: str, cwd: str, fallbacks: list) -> dict:
    """Codex が連結するファイル: root→cwd の各ディレクトリで空でないファイルを
    1つずつ。連結サイズが project_doc_max_bytes に達した以降は黙って落とされる
    — 何が失われるかをレポートで見せるためにここでモデル化する。"""
    candidates = ["AGENTS.override.md", "AGENTS.md"] + fallbacks
    loaded, combined = [], 0
    for d in dirs_root_to_cwd(repo, cwd):
        for name in candidates:
            p = os.path.join(d, name)
            if not os.path.isfile(p):
                continue
            size = os.path.getsize(p)
            if size == 0:
                continue  # 仕様: 空ファイルはスキップ — 次の候補名を試す
            # 保守的なモデル: 連結サイズを上限超えさせるファイルは「失われる」
            # と数える（実際の切り詰めの境界挙動は未検証 — 警告側に倒す）。
            if combined + size > CODEX_DOC_MAX_BYTES:
                e = {"path": p, "bytes": 0, "lines": 0, "tokens_est": 0,
                     "via": "DROPPED (over project_doc_max_bytes)"}
            else:
                e = file_stats(p)
                combined += e["bytes"]
                e["via"] = "project doc chain"
            loaded.append(e)
            break  # 1ディレクトリにつき1ファイル
    return {"tool": "codex", "files": loaded,
            "total_tokens_est": sum(f["tokens_est"] for f in loaded),
            "total_bytes": sum(f["bytes"] for f in loaded)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--repo", default=".", help="リポジトリルート")
    ap.add_argument("--cwd", default=None,
                    help="--repo からの相対の作業ディレクトリ（既定: ルート）")
    ap.add_argument("--fallback", action="append", default=[],
                    help="Codex の project_doc_fallback_filenames 相当（複数指定可）")
    ap.add_argument("--max-hops", type=int, default=4,
                    help="Claude Code の @import 再帰上限（公式仕様: 4）")
    ap.add_argument("--budget", type=int, default=None,
                    help="いずれかのツールがこのトークン見積りを超えたら警告 + exit 2")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    if not os.path.isdir(repo):
        print(f"エラー: ディレクトリでない: {repo}", file=sys.stderr)
        return 1
    cwd = os.path.abspath(os.path.join(repo, args.cwd)) if args.cwd else repo
    # startswith でなく commonpath: /repo-evil を /repo の内側と誤認しない
    if not os.path.isdir(cwd) or os.path.commonpath([repo, cwd]) != repo:
        print("エラー: --cwd は --repo 内の実在ディレクトリを指定する",
              file=sys.stderr)
        return 1

    result = {"repo": repo, "cwd": cwd,
              "views": [claude_view(repo, cwd, args.max_hops),
                        codex_view(repo, cwd, args.fallback)]}

    over = False
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for view in result["views"]:
            print(f"\n== {view['tool']} (startup context from {os.path.relpath(cwd, repo)}) ==")
            if not view["files"]:
                print("  (ガイダンスファイルは読み込まれない)")
            for f in view["files"]:
                rel = os.path.relpath(f["path"], repo) if f["path"].startswith(repo) else f["path"]
                print(f"  {f['tokens_est']:>6} tok  {f['lines']:>5} ln  {rel}  [{f['via']}]")
            print(f"  TOTAL ~{view['total_tokens_est']} tokens / {view['total_bytes']} bytes")
    for view in result["views"]:
        if args.budget and view["total_tokens_est"] > args.budget:
            print(f"警告: {view['tool']} は約 {view['total_tokens_est']} トークンで "
                  f"予算 {args.budget} を超過", file=sys.stderr)
            over = True
    return 2 if over else 0


if __name__ == "__main__":
    sys.exit(main())
