#!/usr/bin/env python3
"""
build_report.py — 1つのリポジトリに対してガイダンス監査一式（measure_context /
audit_guidance / detect_conflicts / validate_structure）を実行し、評決つきの
単一 markdown レポートへ統合する。

評決スケール（SKILL.md の claim 採点 ADOPT/CONDITIONAL とは別物 —
こちらはリポジトリのガイダンス構造を判定する）:
  PASS    HIGH なし・MEDIUM 2 以下  — 構造は健全
  FIX     HIGH なし・MEDIUM 3 以上  — MEDIUM に対処すれば使える
  REWORK  HIGH あり                — 修正するまでこのファイル群に依存しない

使い方:
    python3 build_report.py --repo /path/to/repo
    python3 build_report.py --repo . --cwd packages/backend --out report.md
    python3 build_report.py --repo . --budget 3000 --format json

終了コード: 0 = PASS、2 = FIX または REWORK、1 = サブツールの異常終了。
標準ライブラリのみ。同ディレクトリのスクリプトを現在の Python で起動する。
"""
import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run_tool(script, argv):
    """兄弟スクリプトを --format json で実行し、パース済み dict か None を返す。"""
    cmd = [sys.executable, os.path.join(HERE, script), "--format", "json"] + argv
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode not in (0, 2):  # 2 = 検出あり（JSON は有効）
        print(f"エラー: {script} が失敗:\n{proc.stderr}", file=sys.stderr)
        return None
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"エラー: {script} の JSON 出力が不正", file=sys.stderr)
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--repo", default=".", help="リポジトリルート")
    ap.add_argument("--cwd", default=None, help="repo からの相対の作業ディレクトリ")
    ap.add_argument("--budget", type=int, default=None,
                    help="measure_context へ渡すトークン予算")
    ap.add_argument("--out", default=None, help="レポートの出力先ファイル（既定: stdout）")
    ap.add_argument("--format", choices=["md", "json"], default="md")
    args = ap.parse_args()

    repo = os.path.abspath(args.repo)
    mc_args = ["--repo", repo] + (["--cwd", args.cwd] if args.cwd else []) \
        + (["--budget", str(args.budget)] if args.budget else [])
    measure = run_tool("measure_context.py", mc_args)
    audit = run_tool("audit_guidance.py", [repo])
    conflicts = run_tool("detect_conflicts.py", [repo])
    structure = run_tool("validate_structure.py", [repo])
    if None in (measure, audit, conflicts, structure):
        return 1

    # 測定パス由来の findings: 予算超過と Codex が黙って落とすファイルは、
    # 表示するだけでなく評決へ反映する
    measure_findings = []
    for view in measure["views"]:
        if args.budget and view["total_tokens_est"] > args.budget:
            measure_findings.append({
                "severity": "MEDIUM", "category": "context-budget",
                "file": view["tool"], "line": 0,
                "message": f"{view['tool']} の起動コンテキストが約 "
                           f"{view['total_tokens_est']} トークンで予算 "
                           f"{args.budget} を超過"})
        for f in view["files"]:
            if "DROPPED" in f.get("via", ""):
                measure_findings.append({
                    "severity": "HIGH", "category": "context-budget",
                    "file": f["path"], "line": 0,
                    "message": "Codex がこのファイルを黙って落とす — 連結後の"
                               "プロジェクト文書が project_doc_max_bytes を超過"})

    all_findings = (audit.get("findings", []) + conflicts.get("findings", [])
                    + structure.get("findings", []) + measure_findings)
    counts = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    for f in all_findings:
        counts[f["severity"]] += 1
    if counts["HIGH"]:
        verdict = "REWORK"
    elif counts["MEDIUM"] > 2:
        verdict = "FIX"
    else:
        verdict = "PASS"

    if args.format == "json":
        report = json.dumps({"verdict": verdict, "counts": counts,
                             "measure": measure, "audit": audit,
                             "conflicts": conflicts, "structure": structure},
                            ensure_ascii=False, indent=2)
    else:
        lines = [f"# Guidance audit report — {os.path.basename(repo)}", "",
                 f"**Verdict: {verdict}**  "
                 f"(HIGH={counts['HIGH']}, MEDIUM={counts['MEDIUM']}, LOW={counts['LOW']})",
                 "", "## 起動コンテキストのコスト", ""]
        for view in measure["views"]:
            lines.append(f"### {view['tool']}")
            if not view["files"]:
                lines.append("- （ガイダンスファイルは読み込まれない）")
            for f in view["files"]:
                rel = os.path.relpath(f["path"], repo) if f["path"].startswith(repo) \
                    else f["path"]
                lines.append(f"- `{rel}` ~{f['tokens_est']} tok, {f['lines']} 行 "
                             f"({f['via']})")
            lines.append(f"- **合計 ~{view['total_tokens_est']} トークン**")
            lines.append("")

        if measure_findings:
            for f in measure_findings:
                lines.append(f"- **{f['severity']}** {f['category']} — {f['message']}")
            lines.append("")

        def section(title, data, fmt):
            lines.append(f"## {title}")
            lines.append("")
            items = data.get("findings", [])
            if not items:
                lines.append("- 検出なし")
            for f in items:
                lines.append(fmt(f))
            lines.append("")

        section("内容監査（ファイル別）", audit,
                lambda f: f"- **{f['severity']}** {f['category']} "
                          f"`{os.path.relpath(f['file'], repo)}:{f['line']}` — {f['message']}")
        section("ファイル間の矛盾", conflicts,
                lambda f: f"- **{f['severity']}** {f['category']} — {f['message']} "
                          f"({', '.join(os.path.relpath(l['file'], repo) + ':' + str(l['line']) for l in f['locations'][:3])})")
        section("構造検証", structure,
                lambda f: f"- **{f['severity']}** {f['check']} "
                          f"`{os.path.relpath(f['file'], repo)}` — {f['message']}")
        report = "\n".join(lines)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(report + "\n")
        print(f"レポートを {args.out} に書き出した")
    else:
        print(report)
    return 0 if verdict == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
