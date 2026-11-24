# The aj-workflow guide

How the hub pattern works, how to set it up for your project, and how to bend it to your team. Commands assume the hub is called `my-kb`, the GitHub owner `my-org`, and the ticket key `MY`.

## 1. The idea

Coding agents are good at a well-scoped ticket and bad at remembering. So the workflow gives them three things they can always find:

1. **One backlog.** Every ticket is a GitHub issue in the hub, whatever repo the code lands in. `repo:<key>` labels say where. Status is one `status:*` label, and automation keeps the board, Jira and branches in step with it.
2. **One memory.** `CONTEXT.md` (the words the product uses), `docs/adr/` (why things are the way they are) and `notes/` (what broke and why, how to do recurring chores). Agents read them before touching an area and add to them after a surprise.
3. **One loop.** `/dev` takes a ticket from claim to PR in one session, with a single "yes" from you at the plan.

The hub is a sibling of your code repos inside a plain workspace folder. `kit/install.mjs` links its `AGENTS.md` into the workspace root and its skills into each agent's skills folder, so an agent started at the workspace root sees all of it.

## 2. What is in the hub

| Path | What it is for |
|---|---|
| `AGENTS.md` | The workspace rulebook: repo map, ticket rules, how work runs, QA, notes, house rules. Linked to the workspace root. |
| `CLAUDE.md` | `@AGENTS.md` plus pointers, for Claude Code (Codex and OpenCode read `AGENTS.md` directly). |
| `workflow.config.json` | The single place for names: owner, hub, repos, ticket key, Jira URL, agents, mode, models. |
| `CONTEXT.md` | Domain glossary. One term per entry, with the synonyms to avoid. |
| `docs/adr/` | Decisions. 0001-0005 explain this workflow (hub repo, one-way Jira, branch on claim, branch names, status labels); add yours from 0006. |
| `docs/workflow.md` | The ticket flow, manual moves, one-time setup, troubleshooting. |
| `docs/agents/` | How skills should use the tracker, triage labels and domain docs. |
| `notes/` | `trap/`, `pattern/`, `runbook/`, `log/`. `notes/README.md` says when to write each. |
| `tools/notes/` | `notes.ts new | find | check`. `check` runs in the pre-commit hook and CI and blocks token-shaped strings. |
| `tools/ticket-sync/` | The automation (Node 24, no runtime dependencies, 120 tests). |
| `.github/` | `ticket-sync.yml` (issue events), `pr-lifecycle.yml` (reusable, called from code repos), tests, notes check, issue forms. |
| `kit/skills/` | `dev`, `ticket`, `ship`, `orchestrator` (with `roles/` and `bin/`). |
| `kit/install.mjs` | Wires the hub into the workspace. Re-run after editing the config or pulling kit changes. |
| `kit/scripts/bootstrap-github.sh` | One-time GitHub setup: labels, board, variables, secrets. |
| `kit/github/ticket-status.yml` | The workflow each code repo copies so its PRs move tickets. |

## 3. Set it up

### 3.1 Scaffold

Run `/setup-aj-workflow` in your agent (after `npx skills add ajaparicio36/aj-workflow`), or `node skills/setup-aj-workflow/scripts/setup.mjs` from a clone. It asks:

| Question | Notes |
|---|---|
| Workspace folder | Where your code repos live side by side. The hub is created inside it. |
| Name, owner, hub | Owner is the GitHub org or user. Hub defaults to `<owner>-kb`. |
| Code repos | `key=repo` pairs. The key is the `repo:<key>` label. The hub joins as `kb`. |
| Ticket key | 2-10 capitals. Branches are `<type>/MY-<n>-<slug>`. With Jira, it must be the Jira project key. |
| Jira site | `https://<site>.atlassian.net`, or none. |
| Agents | `claude`, `codex`, `opencode`, any mix. |
| Mode | `orchestrated` or `solo` (section 6). |
| Models | Per agent and role. Free text in the agent's own format; blank means the agent's default. |

The script copies `template/`, swaps the sample names for yours, writes `workflow.config.json`, runs `git init`, then runs `kit/install.mjs`. Check it worked: `cd my-kb/tools/ticket-sync && npm ci && npm test`.

To change an answer later, edit `workflow.config.json` and run `node my-kb/kit/install.mjs` again.

### 3.2 GitHub

1. Create the hub repo and your code repos under the owner. Commit the hub and push `main`; workflows only run from the default branch.
2. `gh auth refresh -h github.com -s project`, then in the hub: `bash kit/scripts/bootstrap-github.sh`. It creates the labels, the Project board (Status: To Do / In Progress / In Review / Done), repo variables, Actions access to the hub's reusable workflow, and prompts for three secrets, set **per repo** (GitHub Free orgs cannot share org secrets with private repos):
   - `KB_BOT_TOKEN`: a maintainer's PAT. Fine-grained: the owner, the hub and code repos, Contents RW, Issues RW, Pull requests R, Metadata R, org Projects RW. Classic: `repo` and `project`.
   - `JIRA_EMAIL`, `JIRA_API_TOKEN`: an Atlassian account that can edit the project (token from id.atlassian.com, Security, API tokens).
3. Copy `kit/github/ticket-status.yml` into `.github/workflows/` of every code repo and push it.

On Windows, run the bootstrap with Git Bash (`& "C:\Program Files\Git\bin\bash.exe" kit/scripts/bootstrap-github.sh`); plain `bash` in PowerShell is WSL's.

### 3.3 Jira (optional)

1. Add an **In Review** status (and column) between In Progress and Done.
2. Install the **GitHub for Jira** app on the org, so branches, commits and PRs show in each issue's dev panel.

Without Jira, labels and the board still sync, but two features stay off because they are keyed on the Jira key: cutting branches on claim, and PRs moving the ticket. Cut branches by hand (`<type>/MY-<n>-<slug>`) and move the `status:*` label yourself. Skip copying `ticket-status.yml` into your code repos (step 3.2.3): without Jira the PR sync exits with an error and every PR would show a red check. A Jira-less key (from the GitHub issue number) is the obvious first change if you fork without Jira.

## 4. The daily loop

| Step | You or the agent | Automation |
|---|---|---|
| Log | `/ticket new <notes or transcript>`: splits it into tickets, dedupes against issues and merged PRs, estimates, asks you once | Creates Jira `MY-<k>`, writes the key into the issue, sets `status:todo`, adds the card to the board |
| Claim | `/ticket claim <n>` (assign yourself) | `status:in-progress`, cuts `<type>/MY-<k>-<slug>` in every `repo:*` repo, comments the branches |
| Build | `/dev <n>`: reads ticket, glossary, ADRs, notes and code; writes a plan; after your yes builds, tests and QAs | |
| Review | `/ship`: push and open `MY-<k>: <title>` with `Fixes` (one repo) or `Refs` (several) | `status:in-review` (draft PR stays In Progress) |
| Done | You merge | Single-repo ticket closes, `status:done`, Jira Done. Multi-repo: close it after the last merge (`/ticket done`) |

Rules that keep it honest:
- No work without a claimed ticket. One assignee per ticket.
- A label you set always wins, even backwards. Dragging a board card alone is undone on the next sync.
- Jira is read-only for people.
- A QA failure is a bug in this ticket, not a follow-up.

## 5. Notes: the hub's memory

```bash
node my-kb/tools/notes/notes.ts find worktree node_modules
node my-kb/tools/notes/notes.ts new trap stale-deps-after-merge "TS2307 after merging worker branches: main checkout node_modules is stale"
```

- **trap**: something broke and the cause was not obvious. Symptom, Cause, Fix, How to check.
- **pattern**: an approach that worked and will be reused.
- **runbook**: a recurring task with steps (rotate a token, reset a device).
- **log**: state the next session needs.

The `summary` is what people will search, so write the symptom in the words someone would type. `AGENTS.md` tells agents to search notes before working an area and to write one after a non-obvious fix. Decisions go in ADRs, terms in `CONTEXT.md`, work in tickets. Never secrets or personal data: `notes.ts check` blocks token-shaped strings in the hook and in CI. [examples/notes/trap/](examples/notes/trap/) has real ones.

## 6. How work runs: orchestrated or solo

**Solo** (any agent): one model does research, spec, build, self-review and the final gate in one session, task by task. Simple, portable, cheapest to reason about.

**Orchestrated** (the `orchestrator` skill): the session you talk to is the lead. It never reads raw code dumps; everything goes through files in `.orchestrator/`.

| Stage | Who | Output |
|---|---|---|
| Research | `orchestrator-researcher` (cheap, fast model) with CodeGraph | `research.md` with checkable citations; `bin/verify_research.py` gates it |
| Spec and plan | lead | `spec.md` (contracts, rules, acceptance criteria) and `plan.json` (a DAG of 2-5 file tasks with exclusive file locks); `bin/validate_plan.py` gates it |
| Red-team | `orchestrator-redteam` (strongest model, fresh context) | numbered findings; the lead fixes blockers |
| Build | `orchestrator-worker` per task, in parallel git worktrees, in waves | one commit per task; the lead merges each wave |
| Rescue | `orchestrator-rescue` (strong model, fresh context) | one directive for a worker that failed twice |
| Final gate | lead | full typecheck, lint, tests; acceptance criteria one by one |

Why the roles split this way: the expensive model only judges, cheap models do the legwork, and the reviewer never sees the author's reasoning (that is the point of a fresh context).

Claude Code defaults: lead `opus`, researcher `haiku`, redteam and rescue `fable`, workers `sonnet`. Pick your own per agent in `workflow.config.json`.

Orchestrated preflight, once per code repo: a CodeGraph index (`npx @colbymchenry/codegraph`, then `codegraph init -i` in the repo root), and `.orchestrator/`, `.codegraph/`, `.claude/worktrees/` in `.gitignore`.

## 7. Agents

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Rules file | `CLAUDE.md` (`@AGENTS.md`) | `AGENTS.md` | `AGENTS.md` |
| Skills linked to | `<workspace>/.claude/skills/` | `<workspace>/.agents/skills/` | `.claude/skills/` if you also use Claude Code, else `.agents/skills/` |
| Orchestrator roles | `.claude/agents/*.md` | `.codex/agents/*.toml` | `.opencode/agents/*.md` |
| Tested here | Yes, this is where the workflow was built | Workspace `AGENTS.md` and the 4 skills load (checked with `codex debug prompt-input` at a non-git workspace root). Role files are generated from Codex docs and unconfirmed: Codex reads `.codex/` only in a trusted project. No ticket run yet. | `opencode agent list` shows the 5 roles as subagents and `opencode debug skill` the 4 skills. No ticket run yet. |

Parts of the orchestrator that are Claude Code-only: automatic worktree isolation for workers (other agents get an instruction to `git worktree add` themselves), per-role compaction windows, and resuming a worker after a rescue. If your agent cannot spawn subagents with their own model, use solo mode.

Start sessions at the workspace root. Claude Code reads `worktree.baseRef: head` only from the folder the session started in (the installer writes it there); Codex looks for `AGENTS.md` from the project root down, so a Codex session started inside a code repo may not see the workspace copy above it.

Skills `/dev`, `/ticket`, `/ship` are plain Markdown; any agent that reads `SKILL.md` can follow them. They call `gh`, so log in once with `gh auth login`.

## 8. Make it yours

Everything is plain files in your hub; change them in a ticket like any other work.

| You want to | Change |
|---|---|
| Add or rename a repo | `repos` in `workflow.config.json`, the `repo:` dropdowns in `.github/ISSUE_TEMPLATE/*.yml`, re-run `bootstrap-github.sh` (labels, project links) and copy `ticket-status.yml` into the new repo |
| Change ticket types | `TICKET_TYPES` and `JIRA_TYPE` in `tools/ticket-sync/config.ts`, `type:*` labels in `bootstrap-github.sh`, the Type dropdown in `task.yml` |
| Change statuses | `STATUSES` and `STATUS_META` in `config.ts` (with the Jira and board names), the labels and board options in `bootstrap-github.sh`, ADR 0005 |
| Switch mode or models | `mode` and `models` in `workflow.config.json`, then `node kit/install.mjs` |
| Change a role's prompt | `kit/skills/orchestrator/roles/<role>.md`, then `node kit/install.mjs` (it rewrites only the files it generated) |
| Add a skill for the whole team | a folder in `kit/skills/` with a `SKILL.md`, then `node kit/install.mjs` |
| Add house rules | the "Code rules" section of `AGENTS.md`, one line per rule with its reason |
| Record a decision | `docs/adr/00NN-<slug>.md`: Context, Decision, Consequences |

Run `npm test && npm run typecheck` in `tools/ticket-sync` after touching it. Its tests read their own fixture config (`test.config.json`), so renaming your project never breaks them.

Keeping up with this repo: your hub is a copy, not a fork with shared history. To pull improvements, diff `template/` between two versions of aj-workflow and port what you want. If you want a true fork of the workflow itself, fork this repo, edit `template/` and `skills/`, and point `REPO_URL` in `skills/setup-aj-workflow/scripts/setup.mjs` at your fork so `npx skills add <you>/<fork>` scaffolds your version. `node --test tests/setup.test.mjs` checks the template still scaffolds cleanly.

## 9. Skills worth adding

The workflow leans on a few third-party skill sets. Install them separately; they are not copied here.

| Source | Install | What we use it for |
|---|---|---|
| mattpocock/skills | `npx skills add mattpocock/skills` | `grilling`, `domain-modeling` (writes `CONTEXT.md` and ADRs), `tdd`, `diagnosing-bugs`, `triage`, `code-review`, `writing-for-agents` |
| emilkowalski/skills | `npx skills add emilkowalski/skills` | UI work: `ask-emil`, `apple-design`, `emil-design-eng`, `mobile-native`, animation skills |
| Leonxlnx/taste-skill | `npx skills add Leonxlnx/taste-skill` | Frontend taste for landing pages and redesigns |
| ponytail (Claude Code plugin) | `/plugin marketplace add DietrichGebert/ponytail` | Smallest-change discipline on non-UI tickets |
| CodeGraph | `npx @colbymchenry/codegraph` | Code index the orchestrator's researcher depends on |

Name the ones you adopt in `AGENTS.md` so agents know when to reach for them.

## 10. Traps we already hit

| Trap | What to do |
|---|---|
| Worker worktrees start at `origin/main` | `worktree.baseRef: head` must be in the settings of the folder the session started in (the installer writes the workspace copy) |
| Secrets "not set" in private repos | GitHub Free: set secrets per repo, not per org (the bootstrap does) |
| `bash` in PowerShell runs WSL | Use Git Bash's `bash.exe` for the bootstrap |
| Ticket title starting with `/` becomes a Windows path | In Git Bash, prefix `gh` with `MSYS_NO_PATHCONV=1` |
| Workflow edits do nothing | Workflows run from the default branch; push to `main` |
| `AGENTS.md` copied instead of linked | Windows symlinks need Developer Mode; re-run the installer after editing the hub copy |
| Final gate fails with missing modules after merging worker branches | Install dependencies in the main checkout after a wave that changed the lockfile |
| `python3` opens the Microsoft Store | Run the orchestrator's `bin/` scripts with `python` |
| A board card snaps back | Move the `status:*` label, not the card |

When automation looks wrong: `gh run list --repo my-org/my-kb --workflow ticket-sync.yml`, open the run, read its summary. Runs are idempotent; editing the issue re-triggers one.
