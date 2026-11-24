#!/usr/bin/env python3
# orchestrator-skill v1 | Gate 1: deterministic research verification (zero model tokens)
# Usage: verify_research.py <repo_root> <research.md> [more.md ...] [--max-tokens 15000] [--tolerance 2]
# Citation grammar (what the researcher must emit):
#   `SymbolName` @ path/to/file.ts:12-40        (range)   or   `SymbolName` @ path/to/file.ts:12   (single line)
#   ```ts
#   // verbatim: path/to/file.ts:12-40
#   <exact copy of those lines>
#   ```
import argparse
import math
import re
import sys
from pathlib import Path

CITE = re.compile(r"`([^`\n]+)`\s*@\s*([^\s:`]+):(\d+)(?:-(\d+))?")
VERB = re.compile(r"```[\w-]*\n// verbatim: ([^\s:]+):(\d+)-(\d+)\n(.*?)\n```", re.S)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("docs", nargs="+")
    ap.add_argument("--max-tokens", type=int, default=15000)
    ap.add_argument("--tolerance", type=int, default=2)
    a = ap.parse_args()

    root = Path(a.root).resolve()
    text = "\n".join(Path(d).read_text(encoding="utf-8") for d in a.docs)
    cache: dict[str, list[str] | None] = {}
    fails: list[str] = []

    def lines_of(rel: str) -> list[str] | None:
        if rel not in cache:
            p = (root / rel).resolve()
            ok = p.is_file() and (root == p or root in p.parents)
            cache[rel] = p.read_text(encoding="utf-8", errors="replace").splitlines() if ok else None
        return cache[rel]

    cites = CITE.findall(text)
    for sym, rel, s, e in cites:
        start, end = int(s), int(e or s)
        src = lines_of(rel)
        if src is None:
            fails.append(f"FAIL {rel}:{start} `{sym}` file does not exist")
            continue
        if start < 1 or end < start or end > len(src):
            fails.append(f"FAIL {rel}:{start}-{end} `{sym}` range outside file ({len(src)} lines)")
            continue
        base = re.sub(r"\(.*\)$", "", sym)
        names = {sym, base, re.split(r"[.:#]+", base)[-1]} - {""}
        window = "\n".join(src[max(0, start - 1 - a.tolerance): end + a.tolerance])
        if not any(n in window for n in names):
            fails.append(f"FAIL {rel}:{start}-{end} `{sym}` symbol not found in cited range (+/-{a.tolerance} lines)")

    blocks = VERB.findall(text)
    for rel, s, e, body in blocks:
        start, end = int(s), int(e)
        src = lines_of(rel)
        if src is None or end > len(src) or start < 1 or end < start:
            fails.append(f"FAIL verbatim {rel}:{start}-{end} file or range invalid")
            continue
        want = [ln.rstrip() for ln in src[start - 1:end]]
        got = [ln.rstrip() for ln in body.split("\n")]
        if want != got:
            fails.append(f"FAIL verbatim {rel}:{start}-{end} block differs from file (copy the lines exactly)")

    tokens = math.ceil(len(text) / 3.5)  # conservative for code-heavy text
    if tokens > a.max_tokens:
        fails.append(f"FAIL size ~{tokens} tokens exceeds cap {a.max_tokens}: cut prose, keep citations and verbatim types")
    if not cites:
        fails.append("FAIL no citations found: use `Symbol` @ path:line-range")

    for f in fails:
        print(f)
    print(f"{'FAILED' if fails else 'OK'}: {len(cites)} citations, {len(blocks)} verbatim blocks, ~{tokens} tokens, {len(fails)} problems")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
