---
name: setup-aj-workflow
description: Scaffold the aj-workflow hub (tickets as GitHub issues, Jira mirror, notes, ADRs, orchestrator or solo agent loop) into a workspace of repos. Use on "/setup-aj-workflow", "set up aj-workflow", or when someone wants this workflow for their own project.
---

# /setup-aj-workflow

Creates `<workspace>/<hub>/`, a knowledge-base repo that holds every ticket, decision and lesson for a group of code repos, plus the agent kit that wires it into Claude Code, Codex or OpenCode. The full guide is `GUIDE.md` in https://github.com/ajaparicio36/aj-workflow.

## 1. Interview

Ask the user these in one message, each with its default, and wait for the answers:

1. **Workspace folder**: the folder that holds (or will hold) the code repos side by side. Default: the current folder.
2. **Project name** (display, e.g. `Zeta`) and **GitHub owner** (org or user, e.g. `zeta-labs`).
3. **Hub repo name**. Default: `<owner>-kb`.
4. **Code repos**: `label-key=repo-name` pairs, e.g. `api=zeta-api, mobile=zeta-mobile`. The key becomes the `repo:<key>` label; the hub is added as `kb` automatically.
5. **Ticket key**: 2-10 capital letters, e.g. `ZT`. Branches are `<type>/ZT-<n>-<slug>`. With Jira it must equal the Jira project key.
6. **Jira**: the site URL (`https://<site>.atlassian.net`), or `none`. Without Jira, tickets, labels and the board still sync, but automatic branch cutting and PR-driven status need the Jira key.
7. **Agents** they use: any of `claude` (Claude Code), `codex`, `opencode`.
8. **How work runs**:
   - `orchestrated`: a lead model plans and reviews; a researcher, a red-team, a rescuer and parallel workers in git worktrees do the rest, each on its own model. Best on Claude Code; the Codex and OpenCode role files are generated from their docs and untested.
   - `solo`: one model does research, spec, build and review in one session. Works on any agent.
9. **Models**, per agent they named. Orchestrated asks for five roles (lead, researcher, redteam, rescue, worker); solo asks only for lead. Model ids are free text in the agent's own format (Claude Code aliases like `opus`; OpenCode `provider/model`). Blank means the agent's default. Claude Code defaults: lead `opus`, researcher `haiku`, redteam `fable`, rescue `fable`, worker `sonnet`.

**Done when** every answer is known, or the user accepted its default.

## 2. Write the config

Write the answers to a JSON file outside the workspace (a temp file), in this shape:

```json
{
  "name": "Zeta",
  "owner": "zeta-labs",
  "hub": "zeta-labs-kb",
  "ticketKey": "ZT",
  "repos": { "api": "zeta-api", "mobile": "zeta-mobile" },
  "jira": { "baseUrl": "https://zeta.atlassian.net" },
  "agents": ["claude", "codex"],
  "mode": "orchestrated",
  "models": {
    "claude": { "lead": "opus", "researcher": "haiku", "redteam": "fable", "rescue": "fable", "worker": "sonnet" },
    "codex": { "lead": "", "researcher": "", "redteam": "", "rescue": "", "worker": "" }
  }
}
```

Leave out `jira` when the answer was `none`.

## 3. Run the script

The script sits beside this file, in `scripts/`:

```bash
node <this skill's folder>/scripts/setup.mjs --config <answers.json> --workspace <workspace folder>
```

It needs Node 24+ and git. It copies the hub template (from a checkout of this repo when it runs inside one, otherwise from a shallow `git clone` of it), fills in the names, runs `git init`, then runs the hub's `kit/install.mjs`, which links the skills and writes the role files for each agent. It refuses to write into an existing non-empty hub folder; ask the user before choosing another name.

**Done when** the script printed `setup complete` and, in `<hub>/tools/ticket-sync`, `npm ci && npm test` passes.

## 4. Hand over

Tell the user what was created (the hub path, the agents wired, the mode) and the steps only they can do, from the script's closing list:

1. Create the hub and code repos on GitHub, commit the hub and push it to `main`.
2. Run `bash kit/scripts/bootstrap-github.sh` in the hub (labels, board, variables, secrets). On Windows run it with Git Bash, not WSL.
3. With Jira only: copy `kit/github/ticket-status.yml` into `.github/workflows/` of every code repo. Without Jira, skip it: PR sync needs the Jira key and would fail every PR.
4. With Jira: add an **In Review** status to the Jira board, and install the GitHub for Jira app on the org.
5. Start agent sessions at the workspace root, then try `/ticket new` and `/dev`.
