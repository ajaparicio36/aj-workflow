---
name: "orchestrator"
description: "Multi-agent coding orchestrator (Claude Code first; Codex and OpenCode through generated role files): Haiku+CodeGraph research, Opus spec and DAG plan, Fable red-team and rescue, parallel Sonnet workers in git worktrees, scripted verification gates. Use for multi-file features, refactors and CRUD modules."
---

# Orchestrator

A tiered pipeline that keeps expensive models on judgment and cheap models on legwork. The lead (you, Opus, the main session) never reads raw code dumps; research is compressed to disk, contracts are written once, workers see only their slice, and scripts do the checking that does not need a model.

Everything the lead produces lives in `.orchestrator/` (`research.md`, `spec.md`, `plan.json`, `state.json`). Disk is the source of truth, so a compaction or crash never loses the plan.

The lead must be the main session. Subagents have limited or no ability to spawn further subagents, and the context rules below assume the lead owns every spawn.

## 0. Route the request

- Single-file or clearly trivial edit (isolated UI tweak, one utility function): spawn `orchestrator-quick` with the task and stop. No research, spec or worktree.
- Anything touching multiple files, a shared contract, a DB schema, or stateful flow: run the full pipeline below.
- If unsure, run Stage 1 with one Haiku and let the result decide; do not guess upward.

## 1. Preflight (once per project, then only re-check what failed)

Run these checks silently, then tell the user in at most 8 lines what is missing and offer to fix it. Do not start Stage 1 until the blocking ones pass.

```bash
claude --version                                   # want >= 2.1.296 (per-agent autoCompactWindow)
git rev-parse --abbrev-ref HEAD && git status --porcelain | head
ls -d .codegraph 2>/dev/null || echo "NO CODEGRAPH INDEX"
grep -s '"baseRef"' .claude/settings.json .claude/settings.local.json ~/.claude/settings.json || echo "NO baseRef"
ls .claude/agents/orchestrator-*.md ~/.claude/agents/orchestrator-*.md .codex/agents/orchestrator-*.toml ~/.codex/agents/orchestrator-*.toml \
   .opencode/agents/orchestrator-*.md ~/.config/opencode/agents/orchestrator-*.md 2>/dev/null
echo "AUTO_COMPACT_WINDOW=${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-unset}"
```

| Check | Blocking | If it fails |
| :-- | :-- | :-- |
| **CodeGraph index** (`.codegraph/` exists and `mcp__codegraph__*` tools are loaded) | Yes | Advise the user to generate it, and offer to run it: `npx @colbymchenry/codegraph` (installer; writes the MCP config, then **restart Claude Code**), then in the project root `codegraph init -i` (indexing can take a few minutes on large repos). Without the index, Haiku falls back to blind grep loops, which defeats Stage 1. Only continue in degraded mode if the user says so, and mark `research.md` as `DEGRADED`. If the folder exists but `codegraph_status` reports it stale, re-run `codegraph index`. |
| **On a feature branch**, tree clean | Yes | Worktrees merge back into this branch. If on main/master/the default branch, create `feat/<slug>`. Commit or stash unrelated changes. |
| **`worktree.baseRef: "head"`** in `.claude/settings.local.json` (or settings.json) | Yes | Without it, worktrees branch from the remote default branch, so workers never see earlier tasks' commits or your feature branch. Offer to add `{"worktree": {"baseRef": "head"}}`; a session restart may be needed. |
| **Role files** installed for this agent | Yes | Run `node <skill-dir>/scripts/roles.mjs --agent <claude, codex or opencode>` (user-level; add `--project .` for this repo only, `--model worker=<id>` to change a role's model). They carry the model, effort, compaction window and worktree settings; a spawn without them silently inherits the wrong model. |
| **`CLAUDE_CODE_AUTO_COMPACT_WINDOW` unset** | Yes | That variable overrides every per-agent window and `/autocompact`. Ask the user to unset it. |
| **Local excludes** | No | Append `.orchestrator/`, `.codegraph/`, `.claude/worktrees/` to `.git/info/exclude` so nothing is committed or shows as dirty. |
| **Lead window** | No | Tell the user once: run `/autocompact 300k` for the Opus lead (see section 3). |

On Codex or OpenCode, skip the `claude --version`, `baseRef`, `AUTO_COMPACT_WINDOW` and lead-window checks. Misspelled frontmatter fields are ignored silently. After installing, the first time through, confirm with `/tasks` that each subagent shows the model you expect, and `claude --debug` shows `invalid autoCompactWindow` if a window was rejected.

## 2. Roles

| Tier | Agent (definition) | Model / effort | Compaction window | Output |
| :-- | :-- | :-- | :-- | :-- |
| Research | `orchestrator-researcher` | Haiku 5.5 / high | 100000 | `.orchestrator/research.md` |
| Lead | main session | Opus 5.5 / user-set | `/autocompact 300k` | `spec.md`, `plan.json`, `state.json` |
| Red-team | `orchestrator-redteam` | Fable 5.2 / xhigh | none (single shot) | numbered findings |
| Rescue | `orchestrator-rescue` | Fable 5.2 / high | none (single shot) | one directive |
| Workers | `orchestrator-worker` | Sonnet 5.5 / high | 150000 | branch + commit per task |

These are the Claude Code defaults. Other agents use their own default model per role unless you pin one with `scripts/roles.mjs --model <role>=<id>`.

Why Fable runs as subagents and not through the advisor: the advisor tool receives the caller's **entire transcript** and is invoked at the caller's discretion. That gives a second opinion with the author's reasoning attached, which is the confirmation bias the red-team exists to remove, and it cannot be forced at a pipeline gate. Keep the advisor enabled as a bonus for the lead's own hard calls, but never substitute it for Stages 4 and 5.

## 3. Context and compaction

All three 5.5 models have 1M windows, so defaults would let a worker drift to hundreds of thousands of tokens. The numbers above are chosen like this:

- **Haiku, 100000.** Haiku 5.5 bills prompts over 100K tokens at a 5x higher rate, so research should compact before that line. 100000 is also the lowest value Claude Code accepts, and it reserves a buffer below the window, so it should fire in the 70-85k range. Verify on the first run with `/context`. Parallel per-domain researchers and incremental writes to disk are the real defense; compaction is the backstop.
- **Sonnet, 150000.** A well-scoped task (2-5 files) should finish under ~70k. Reaching 150k means the task was too big or the worker is thrashing. Treat that as a plan defect, not something to compact through.
- **Opus lead, `/autocompact 300k`.** The lead carries audit, spec, plan, red-team fixes and worker reports across one feature, but every artifact is on disk. Set it per model with `/autocompact`; do not use `autoCompactWindow` in settings.json (applies to all models) or the env var (overrides everything).
- **After any compaction**, re-read `.orchestrator/state.json` and `plan.json` before dispatching anything, and re-read only the spec sections you need.

Do not use `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` for this. It is global, it is ignored in some versions when set in settings.json `env`, and a value low enough for Haiku would make the Opus lead compact at ~80k.

Context rules between stages:

| Transition | Rule | Why |
| :-- | :-- | :-- |
| Haiku to Opus | Reset; hand over `research.md` on disk, reply is 8 lines | Keeps AST noise out of the lead |
| Opus audit, spec, plan, red-team fix | Share (main session) | Architectural continuity |
| Anything to Fable | Reset (fresh subagent per call) | No inherited bias; small payload |
| Plan to Sonnet workers | Reset (fresh subagent per task) | No cross-task pollution |

## 4. Pipeline

Create the task list from these stages and mark them off as you go.

### Stage 1: Bounded research
Spawn `orchestrator-researcher` (one per domain in parallel when backend and frontend are decoupled; each writes `.orchestrator/research.<domain>.md`). Prompt it with the goal, known entry points, and the output path. It must use the citation grammar in its definition, since Stage 2 parses it.

### Stage 2: Two-step research gate
1. **Script gate (zero tokens):** `python3 <skill-dir>/bin/verify_research.py . .orchestrator/research*.md --max-tokens 15000`. On failure, re-spawn the researcher with the `FAIL` lines verbatim and ask it to fix only those. After 2 bounces, read the cited files yourself.
2. **Semantic gate (you):** audit the research against the user's goal before designing anything. Missing interfaces, callers, or DB side effects: output only a `MISSING_CONTEXT` block of 1-3 targeted CodeGraph queries and send it to the researcher. Max 2 loops, then read the specific files directly.

### Stage 3: Spec and plan
Write two separate files in the same thread.

`.orchestrator/spec.md` is the contract. Use numbered section headings (`## 2.1 ...`) so tasks can reference slices. Contents: Goal and Non-Goals; exact contracts (verbatim TypeScript interfaces, DTOs, Zod schemas, SQL/ORM migrations, API payloads); behavioral rules as `Input -> Output / Error` including validation, idempotency, transactions and race handling; acceptance criteria as runnable assertions.

`.orchestrator/plan.json` is the DAG (schema in the header of `validate_plan.py`). Rules that make parallelism safe:
- 2-5 files per task, so a worker never needs compaction.
- Shared types, migrations, lockfiles, `package.json` and barrel `index.ts` files belong to a single early task (usually `T1`), never to parallel tasks.
- Every task has `read_files`, `write_files` (its exclusive locks), `depends_on`, `spec_refs`, and an exact `verify` command (e.g. `pnpm test src/x.test.ts && pnpm typecheck`). Tests count as write files.

Then run `python3 <skill-dir>/bin/validate_plan.py .orchestrator/plan.json`. Fix every `ERROR`; consider every `WARN`. Its wave listing is your execution order.

### Stage 4: Red-team (one call per feature)
Spawn `orchestrator-redteam` with only the three file paths in the prompt; it reads them itself, so your context stays clean. Apply BLOCKER and MAJOR findings to `spec.md` and `plan.json`, re-run `validate_plan.py`, and note any finding you reject with a one-line reason under a `## Decisions` heading in the spec. Do not loop the red-team; one extra call is justified only if a fix changed a contract.

### Stage 5: Execute in waves
Initialize `.orchestrator/state.json` (per task: `status`, `retry_count`, `branch`, `worktree`, `commit`). For each wave from `validate_plan.py`:

1. Spawn every task in the wave in a single turn (parallel `orchestrator-worker` calls). Each prompt contains only: the task node, the **inlined text** of its spec slice (worktrees are branched from git, so untracked `.orchestrator/` files are not there), and the base branch name.
2. As each worker returns:
   - `DONE`: verify ownership with `git diff --name-only <base>...<branch>`; every path must be in that task's `write_files`, otherwise send it back. Then merge into the feature branch (`git merge --no-ff <branch>`). Merging **per wave, before the next wave starts** is what lets dependent tasks see their dependencies' code.
   - `BLOCKED` (the worker stops itself after two identical failures): circuit breaker below.
3. After merging a wave, run the repo's typecheck once to catch integration breaks between parallel tasks. A failure becomes a small fix task in the next wave.
4. Update `state.json`.

**Circuit breaker.** A running subagent cannot be frozen from outside, so the stop is built into the worker: two identical verification failures end its turn with `BLOCKED`, and `maxTurns` is the backstop. You then send `orchestrator-rescue` a fresh-context payload: the spec slice, `git -C <worktree> diff`, and the stderr tail. Resume the same worker with the directive via SendMessage (keeps its context); if it cannot be resumed, spawn a new `orchestrator-worker` told to continue in that worktree. One rescue per task. `SPEC_DEFECT` goes back to you: amend the spec, re-validate, tell the user. A second `BLOCKED` stops the pipeline for that task; report it instead of looping.

### Stage 6: Final gate
Run the full suite with the repo's own scripts (`typecheck`, `lint`, `test`). Then review compliance against `spec.md` using `git diff --stat <base>...HEAD` plus the specific files named in the acceptance criteria. Never read the whole diff. Walk the acceptance criteria one by one and report which pass. Remove worktrees and branches of merged tasks; keep blocked ones.

Finish with a short report: what shipped, acceptance criteria status, anything blocked or rejected from the red-team, and the feature branch name. Do not push or open a PR unless asked.

---

## Files beside this skill

- `roles/orchestrator-*.md`: the subagent definitions (Claude Code format). `scripts/roles.mjs` turns them into `.claude/agents/*.md`, `.codex/agents/*.toml` or `.opencode/agents/*.md`. Change a prompt here, then re-run it; it rewrites only files it generated.
- `bin/validate_plan.py`, `bin/verify_research.py`: zero-token gates, run with `python3` (on Windows `python` or `py -3` if `python3` is the Store alias). `<skill-dir>` is the folder this SKILL.md was loaded from.

## Running on Codex, OpenCode and other agents

The pipeline is the same; three Claude Code features are not:
- **Worktree isolation.** Claude Code's `isolation: worktree` creates the worker's worktree for it. Elsewhere the worker creates its own (`git worktree add .claude/worktrees/<id> -b orch/<id> <base>`); the generated role file says so.
- **Per-agent compaction windows** (`autoCompactWindow`, `/autocompact`). Elsewhere, keep tasks to 2-5 files so a worker never needs one.
- **Resuming a worker** after a rescue (SendMessage). Elsewhere, spawn a fresh worker told to continue in the same worktree.

Spawn roles by the names in `roles/` (Codex: `spawn_agent` with that agent type; OpenCode: the task tool with that subagent). If your agent cannot spawn subagents with their own model, run the same stages yourself in one session: research, spec and plan through the same gates, then build the tasks in wave order and red-team your own spec before the final gate.
