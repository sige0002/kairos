#!/usr/bin/env python3
"""
audit_guidance.py — AGENTS.md / CLAUDE.md の内容を、実在の指示ファイル調査で
頻出するアンチパターンについて監査する。

  lint-leakage     フォーマッタ/リンタで強制すべき規則の散文化
  skill-leakage    長い複数ステップ手順のインライン記述（Skill へ移すべき）
  context-bloat    歴史・設計論の常時読み込み、肥大化ファイル
  dangerous-command  sudo, rm -rf, force push, curl|bash, 確認バイパス指示
  secret           資格情報らしき文字列（キー・トークン・パスワード）
  local-path       ユーザー固有の絶対パス（可搬性・プライバシー）
  enforcement-language  MUST/NEVER/必ず の乱用 — 散文は強制にならない。
                        確実に止めたいものは hooks / CI / リンタへ
  hallucination    未解決の {{placeholder}}・テンプレートコメントの残存

これはヒューリスティックな一次スクリーニング。検出は「レビュー候補」であり
評決ではない。重大度: HIGH = 採用前に修正 / MEDIUM = 修正すべき / LOW = 検討。

使い方:
    python3 audit_guidance.py PATH [PATH ...]        # ファイルまたはディレクトリ（再帰）
    python3 audit_guidance.py --format json REPO
    python3 audit_guidance.py --fail-on HIGH REPO    # HIGH 以上で exit 2
    python3 audit_guidance.py --max-lines 250 REPO   # 肥大判定の閾値変更

終了コード: 0 = クリーン（--fail-on 未満）、2 = --fail-on 以上の検出あり、
1 = 使い方エラー。標準ライブラリのみ。
"""
import argparse
import json
import os
import re
import sys

SEV_ORDER = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}
GUIDANCE_NAMES = {"AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"}
SKIP_DIRS = {".git", "node_modules", "target", ".venv", "venv", "__pycache__",
             "dist", "build", ".ruff_cache"}

# Codex は連結サイズが project_doc_max_bytes（既定 32 KiB）に達すると
# 以降のファイル追加を黙って停止する（openai/codex #7138）。
# 単一ファイルでこの大きさだと予算を食い潰し、ネストの AGENTS.md が読まれなくなる。
CODEX_DOC_MAX_BYTES = 32 * 1024

R = re.IGNORECASE


def _content_rules():
    """行単位で照合する (category, severity, regex, message) のリスト。"""
    rules = []

    def add(cat, sev, pat, msg, flags=R):
        rules.append((cat, sev, re.compile(pat, flags), msg))

    # --- lint-leakage: フォーマッタ/リンタが機械的に強制できる規則 ---
    add("lint-leakage", "MEDIUM",
        r"(trailing\s+whitespace|行末の(空白|スペース))",
        "行末空白の規則 — 散文でなくフォーマッタで強制する")
    add("lint-leakage", "MEDIUM",
        r"(import|インポート).{0,20}(alphabetical|sorted|order|順|ソート)",
        "import 順の規則 — isort/ruff の領分")
    add("lint-leakage", "MEDIUM",
        r"((single|double)[- ]quotes?|(シングル|ダブル)クォート)",
        "クォートスタイルの規則 — フォーマッタの領分")
    add("lint-leakage", "LOW",
        r"(line\s+length|max(imum)?\s+line|1行.{0,6}(80|100|120)文字|characters?\s+per\s+line)",
        "行長の規則 — リンタの領分")
    add("lint-leakage", "LOW",
        r"(indent(ation)?|インデント).{0,20}(tabs?|spaces?|タブ|スペース|\d)",
        "インデントの規則 — フォーマッタの領分")
    add("lint-leakage", "LOW",
        r"(semicolons?|セミコロン).{0,15}(required|always|never|禁止|必ず|付け)",
        "セミコロンの規則 — フォーマッタの領分")
    add("lint-leakage", "LOW",
        r"(camelCase|snake_case|PascalCase|kebab-case).{0,25}(use|prefer|must|使う|使用|統一)",
        "命名ケースの規則 — リンタで強制可能。ツールで強制できない場合のみ残す",
        re.UNICODE)

    # --- dangerous-command: エージェントが逐語的に実行しうる指示 ---
    add("dangerous-command", "HIGH",
        r"\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\b",
        "再帰強制削除の指示")
    add("dangerous-command", "HIGH",
        r"\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b",
        "パイプ実行によるインストール（監査不能なリモートコード）")
    add("dangerous-command", "HIGH",
        r"git\s+push\s+(-f\b|--force\b(?!-with-lease))",
        "--force-with-lease でない force push")
    add("dangerous-command", "MEDIUM",
        r"\bsudo\b",
        "ガイダンス内の sudo — エージェントに root は不要。運用手順書へ移す")
    add("dangerous-command", "MEDIUM",
        r"chmod\s+(-R\s+)?777",
        "誰でも書き込める chmod")
    add("dangerous-command", "MEDIUM",
        r"git\s+(reset\s+--hard|clean\s+-[a-z]*f)",
        "履歴・作業ツリーを破壊する git コマンド — 人間の確認を挟む")
    add("dangerous-command", "MEDIUM",
        r"(--no-verify|確認(せず|しないで|なしで).{0,10}(実行|削除|push)|without\s+asking)",
        "検証・確認をバイパスさせる指示")

    # --- secret: 資格情報らしきリテラル ---
    add("secret", "HIGH", r"\bAKIA[0-9A-Z]{16}\b", "AWS アクセスキー ID のパターン")
    add("secret", "HIGH", r"\b(ghp|gho|ghu|ghs)_[A-Za-z0-9]{36,}\b", "GitHub トークンのパターン")
    add("secret", "HIGH", r"\bgithub_pat_[A-Za-z0-9_]{22,}\b", "GitHub fine-grained PAT")
    add("secret", "HIGH", r"\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b", "OpenAI/Anthropic API キーのパターン")
    add("secret", "HIGH", r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b", "Slack トークンのパターン")
    add("secret", "HIGH", r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "秘密鍵そのもの")
    add("secret", "MEDIUM",
        r"(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[\"'][^\"'\s]{8,}[\"']",
        "資格情報らしき代入（リテラル値つき）")

    # --- local-path: ユーザー固有のマシンパス ---
    add("local-path", "MEDIUM",
        r"(?:^|[\s\"'`(=])(/(?:home|Users)/[A-Za-z0-9._-]+|C:\\Users\\[A-Za-z0-9._-]+|/mnt/c/Users/[A-Za-z0-9._-]+)",
        "ユーザー固有の絶対パス — 他マシンで壊れ、個人情報が漏れうる",
        re.UNICODE)

    # --- hallucination: 出荷してはならない生成残骸 ---
    add("hallucination", "HIGH",
        r"\{\{[^{}]*\}\}",
        "未解決のテンプレート placeholder {{...}} — 生成後に記入されていない")
    add("hallucination", "MEDIUM",
        r"<!--\s*agent-guidance-architect:",
        "テンプレートの説明コメントが生成物に残っている — 削除する")
    return rules


def iter_guidance_files(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
        elif os.path.isdir(p):
            for root, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                # インストールされたスキルは意図的に壊れた fixtures/templates を
                # 同梱している — プロジェクトのガイダンスとして監査しない
                if os.path.basename(root) in (".claude", ".agents"):
                    dirs[:] = [d for d in dirs if d != "skills"]
                for name in sorted(files):
                    if name in GUIDANCE_NAMES:
                        yield os.path.join(root, name)


def split_prose_and_code(text):
    """行番号を保ったまま (lineno, line, in_code) を返す。"""
    in_fence = False
    for i, line in enumerate(text.splitlines(), 1):
        if re.match(r"^(```|~~~)", line.strip()):
            in_fence = not in_fence
            yield i, line, True
            continue
        yield i, line, in_fence


def audit_file(path, max_lines, rules):
    findings = []

    def add(cat, sev, lineno, msg, excerpt=""):
        findings.append({"file": path, "line": lineno, "category": cat,
                         "severity": sev, "message": msg,
                         "excerpt": excerpt.strip()[:120]})

    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            text = f.read()
    except OSError as e:  # 壊れた symlink・権限 — 報告して続行（クラッシュしない）
        add("unreadable", "HIGH", 1,
            f"ガイダンスファイルを読めない（{e.__class__.__name__}: {e}）— "
            "壊れた symlink か権限の問題")
        return findings
    lines = text.splitlines()

    # 行単位のパターン規則（secret/dangerous はコードブロック内も照合する —
    # ガイダンスのコードブロックこそエージェントが実行するコマンドだから）
    prose_only = {"lint-leakage"}
    for lineno, line, in_code in split_prose_and_code(text):
        for cat, sev, rx, msg in rules:
            if in_code and cat in prose_only:
                continue
            if rx.search(line):
                add(cat, sev, lineno, msg, line)

    # context-bloat: サイズ
    n = len(lines)
    if n > max_lines * 2:
        add("context-bloat", "HIGH", 1,
            f"{n} 行（> {max_lines * 2}）の常時読み込みファイル — 分割する: "
            "毎セッション必要な事実だけ残し、他は Skill / references へ")
    elif n > max_lines:
        add("context-bloat", "MEDIUM", 1,
            f"{n} 行（> {max_lines}）— 毎セッション不要な内容を含んでいる可能性が高い")
    size = len(text.encode("utf-8"))
    if size > CODEX_DOC_MAX_BYTES:
        add("context-bloat", "HIGH", 1,
            f"{size} バイトは Codex の project_doc_max_bytes 既定値 "
            f"（{CODEX_DOC_MAX_BYTES}）超 — Codex は連結がこのサイズに達すると"
            "黙って追加を止め、ネストの AGENTS.md が読み落とされる")

    # secret: .env の貼り付け跡（KEY=value が5行以上連続）
    run = start = 0
    for lineno, line in enumerate(lines + [""], 1):
        if re.match(r"^[A-Z][A-Z0-9_]{1,40}=\S", line):
            if run == 0:
                start = lineno
            run += 1
        else:
            if run >= 5:
                add("secret", "MEDIUM", start,
                    f"KEY=value が {run} 行連続 — .env の貼り付けに見える。"
                    "実際の値をガイダンスに書かない")
            run = 0

    # context-bloat: references/ に置くべき読み物セクション
    for lineno, line in enumerate(lines, 1):
        if re.match(r"^#{1,4}\s", line) and re.search(
                r"(history|歴史|背景|設計思想|philosophy|過去の議論|アーキテクチャの変遷|FAQ)",
                line, R):
            add("context-bloat", "LOW", lineno,
                "常時読み込みファイル内の読み物セクション — references/ か Skill へ移す",
                line)

    # skill-leakage: 長い番号付き手順
    run_start, run_len = None, 0

    def flush(end_line):
        nonlocal run_start, run_len
        if run_len >= 8:
            add("skill-leakage", "MEDIUM", run_start,
                f"{run_len} ステップの番号付き手順がインライン — Skill へ移し"
                "（オンデマンド読み込み）、ここには1行のポインタだけ残す")
        run_start, run_len = None, 0

    for lineno, line in enumerate(lines, 1):
        if re.match(r"^\s*\d+[.)]\s", line):
            if run_start is None:
                run_start = lineno
            run_len += 1
        elif line.strip() == "" or re.match(r"^\s{2,}\S", line):
            continue  # 空行・継続行では手順の連続を切らない
        else:
            flush(lineno)
    flush(n)

    # enforcement-language の密度
    strong = sum(len(re.findall(r"(必ず|絶対に|禁止|厳守|\bMUST\b|\bNEVER\b|\bALWAYS\b|\bIMPORTANT\b)",
                                l)) for l in lines)
    if n > 0 and strong / max(n, 1) * 100 > 8 and strong >= 5:
        add("enforcement-language", "MEDIUM", 1,
            f"{n} 行中 {strong} 個の MUST/NEVER/必ず 系指示 — 散文は強制にならない。"
            "本当に強制すべき規則は hooks / CI / リンタへ移し、散文は落ち着いた命令形にする")
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("paths", nargs="*", default=["."], help="ファイルまたはディレクトリ")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    ap.add_argument("--fail-on", choices=["LOW", "MEDIUM", "HIGH"], default=None)
    ap.add_argument("--min-severity", choices=["LOW", "MEDIUM", "HIGH"], default="LOW")
    ap.add_argument("--max-lines", type=int, default=200,
                    help="context-bloat の行数閾値（既定 200。2倍で HIGH）")
    args = ap.parse_args()

    paths = args.paths or ["."]
    missing = [p for p in paths if not os.path.exists(p)]
    if missing:  # パスの打ち間違いを「クリーン」と読ませない
        print(f"エラー: パスが存在しない: {', '.join(missing)}", file=sys.stderr)
        return 1
    rules = _content_rules()
    files = list(iter_guidance_files(paths))
    if not files:
        print("AGENTS.md / CLAUDE.md が見つからない", file=sys.stderr)
        return 0

    findings = []
    for path in files:
        findings.extend(audit_file(path, args.max_lines, rules))
    # --fail-on の判定は --min-severity の表示フィルタより前に行う
    # （--min-severity HIGH --fail-on MEDIUM でも隠れた MEDIUM で失敗させる）
    fail = args.fail_on and any(
        SEV_ORDER[f["severity"]] >= SEV_ORDER[args.fail_on] for f in findings)
    findings = [f for f in findings
                if SEV_ORDER[f["severity"]] >= SEV_ORDER[args.min_severity]]
    findings.sort(key=lambda f: (-SEV_ORDER[f["severity"]], f["file"], f["line"]))

    if args.format == "json":
        print(json.dumps({"files_scanned": len(files), "findings": findings},
                         ensure_ascii=False, indent=2))
    else:
        for f in findings:
            print(f"[{f['severity']}] {f['category']}: {os.path.relpath(f['file'])}:{f['line']}")
            print(f"    {f['message']}")
            if f["excerpt"]:
                print(f"    > {f['excerpt']}")
        counts = {}
        for f in findings:
            counts[f["severity"]] = counts.get(f["severity"], 0) + 1
        print(f"\n{len(files)} ファイル走査、{len(findings)} 件検出: "
              + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) if findings
              else f"\n{len(files)} ファイル走査、検出なし")

    return 2 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
