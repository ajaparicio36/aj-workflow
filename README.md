# aj-workflow

A ticket-driven way to build software with coding agents (Claude Code, Codex, OpenCode), packaged so you can run it on your own project.

One **hub repo** sits beside your code repos and holds everything that is not code: every ticket (as GitHub issues), the domain glossary, decisions (ADRs), lessons (traps, patterns, runbooks), and the agent kit. Automation mirrors tickets to a GitHub Project board and Jira and cuts a branch in each repo when someone claims a ticket. Agents work one ticket per session: claim, plan, build (one model, or a lead with cheaper workers in parallel git worktrees), QA, ship.

```
my-workspace/              (a plain folder, not a repo)
├── AGENTS.md -> my-kb/AGENTS.md
├── my-kb/                 the hub: tickets, CONTEXT.md, docs/adr, notes, kit, tools
├── my-api/                your code repos, side by side
└── my-app/
```

## Quick start

With the [skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add ajaparicio36/aj-workflow
```

Then, in your agent, from the workspace folder: `/setup-aj-workflow` (or ask it to "set up aj-workflow"). It asks for your names, repos, Jira site, which agents you use, whether one model does everything or a lead orchestrates others, and which models; then it scaffolds the hub.

Without the CLI:

```bash
git clone https://github.com/ajaparicio36/aj-workflow
node aj-workflow/skills/setup-aj-workflow/scripts/setup.mjs --workspace ./my-workspace
```

Needs Node 24+, git, and `gh` (GitHub CLI) for the GitHub side.

## Just the orchestrator

No hub, no tickets: the multi-agent pipeline on its own, for any repo.

```bash
npx skills add ajaparicio36/aj-workflow --skill orchestrator
node <skills folder>/orchestrator/scripts/roles.mjs --agent claude
```

`roles.mjs` writes the five subagent definitions (researcher, red-team, rescue, worker, quick) to your agent's user folder. Use `--agent codex` or `--agent opencode` for those agents (repeatable), `--project .` to keep them in one repo, and `--model worker=<id>` to pin a role's model. Then ask your agent to use the orchestrator on a multi-file change: it researches with CodeGraph, writes a spec and a task DAG, has a fresh-context model attack them, builds the tasks in parallel git worktrees, and runs a final gate. One-file edits take its quick path. The preflight in [skills/orchestrator/SKILL.md](skills/orchestrator/SKILL.md) lists what it checks first (CodeGraph index, feature branch, Claude Code's `worktree.baseRef`).

## Read next

- [GUIDE.md](GUIDE.md): how the pattern works, the one-time GitHub and Jira setup, the daily loop, agents and models, and how to make your fork your own.
- [template/](template/): the empty hub that setup copies (sample project name `acme`).
- [examples/notes/](examples/notes/): real trap notes, so you can see what a good one looks like.

## This repo

| Path | What |
|---|---|
| `skills/setup-aj-workflow/` | The setup skill and its zero-dependency script |
| `skills/orchestrator/` | The standalone orchestrator: `SKILL.md`, `roles/` (subagent prompts), `bin/` (plan and research gates), `scripts/roles.mjs`. Setup copies it into each hub's `kit/skills/` |
| `template/` | The hub template: docs, ADRs 0001-0005, notes tool, ticket-sync, workflows, kit (skills `dev`, `ticket`, `ship`) |
| `LICENSE` | MIT |
| `examples/` | Sample notes |
| `tests/` | `node --test tests/setup.test.mjs` scaffolds a hub from `template/` and checks it |
