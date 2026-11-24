#!/usr/bin/env python3
# orchestrator-skill v1 | Plan validator: DAG shape, file-ownership locks, execution waves (zero model tokens)
# Usage: validate_plan.py .orchestrator/plan.json
# plan.json: {"feature": str, "base_branch": str, "tasks": [
#   {"id": "T1", "title": str, "depends_on": [ids], "read_files": [paths], "write_files": [paths],
#    "spec_refs": ["§2.1"], "verify": "pnpm test <file> && pnpm typecheck"}]}
import json
import sys
from itertools import combinations
from pathlib import PurePosixPath

HOT_NAMES = {"pnpm-lock.yaml", "package-lock.json", "yarn.lock", "package.json", "index.ts", "index.tsx"}


def main() -> int:
    plan = json.load(open(sys.argv[1], encoding="utf-8"))
    tasks = plan.get("tasks", [])
    errors: list[str] = []
    warns: list[str] = []
    by_id = {t.get("id"): t for t in tasks}

    if not tasks:
        errors.append("plan has no tasks")
    if len(by_id) != len(tasks):
        errors.append("duplicate or missing task ids")
    for t in tasks:
        tid = t.get("id", "?")
        for key in ("title", "verify"):
            if not str(t.get(key, "")).strip():
                errors.append(f"{tid}: missing {key}")
        writes, reads = t.get("write_files", []), t.get("read_files", [])
        if not 1 <= len(writes) <= 5:
            errors.append(f"{tid}: write_files has {len(writes)} entries, want 1-5 (split the task)")
        if len(set(reads) | set(writes)) > 8:
            warns.append(f"{tid}: touches {len(set(reads) | set(writes))} files, worker context may balloon")
        for d in t.get("depends_on", []):
            if d not in by_id or d == tid:
                errors.append(f"{tid}: bad dependency {d}")

    # Kahn layering gives execution waves and detects cycles.
    indeg = {i: len([d for d in t.get("depends_on", []) if d in by_id]) for i, t in by_id.items()}
    waves: list[list[str]] = []
    done: set[str] = set()
    while len(done) < len(by_id):
        ready = sorted(i for i in by_id if i not in done and all(d in done for d in by_id[i].get("depends_on", []) if d in by_id))
        if not ready:
            errors.append(f"dependency cycle among: {sorted(set(by_id) - done)}")
            break
        waves.append(ready)
        done.update(ready)

    def ancestors(i: str, seen: set[str] | None = None) -> set[str]:
        seen = seen if seen is not None else set()
        for d in by_id[i].get("depends_on", []):
            if d in by_id and d not in seen:
                seen.add(d)
                ancestors(d, seen)
        return seen

    if not any("cycle" in e for e in errors):
        anc = {i: ancestors(i) for i in by_id}
        for a, b in combinations(by_id, 2):
            if a in anc[b] or b in anc[a]:
                continue  # ordered, cannot run in parallel
            both = set(by_id[a].get("write_files", [])) & set(by_id[b].get("write_files", []))
            if both:
                errors.append(f"{a} and {b} can run in parallel but both write {sorted(both)}")
            for w, r in ((a, b), (b, a)):
                hazard = set(by_id[w].get("write_files", [])) & set(by_id[r].get("read_files", []))
                if hazard:
                    warns.append(f"{r} reads {sorted(hazard)} which parallel task {w} writes; add depends_on")

    owners: dict[str, list[str]] = {}
    for t in tasks:
        for f in t.get("write_files", []):
            owners.setdefault(f, []).append(t.get("id", "?"))
    for f, ids in owners.items():
        if PurePosixPath(f).name in HOT_NAMES and len(ids) > 1:
            warns.append(f"hot file {f} is written by {ids}; give it a single owner or a final integration task")

    for i, w in enumerate(waves, 1):
        print(f"wave {i}: {', '.join(w)}")
    for e in errors:
        print(f"ERROR {e}")
    for w in warns:
        print(f"WARN  {w}")
    print(f"{'INVALID' if errors else 'VALID'}: {len(tasks)} tasks, {len(waves)} waves, {len(errors)} errors, {len(warns)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
