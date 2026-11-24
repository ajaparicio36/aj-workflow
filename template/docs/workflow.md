# Ticket workflow

Why it is shaped this way: `docs/adr/0001` to `0005`.

## The flow

| Step | You (UI or agent) | Automation (`tools/ticket-sync`) |
|---|---|---|
| Log | New issue in `acme-kb` (Task or Bug form), or `/ticket new` | Creates Jira `ACME-<k>` in the active sprint (backlog when none is active), writes the key into the body, sets `status:todo`, adds the card to the "Acme" board |
| Claim | Assign yourself, or `/ticket claim <n>` | `status:in-progress`; cuts `<type>/ACME-<k>-<slug>` in every `repo:*` repo; comments the branches |
| Build | `git fetch origin && git switch <branch>`, then the `orchestrator` skill | |
| Review | Open the PR (`/ship`), title `ACME-<k>: ...` | `status:in-review` (draft PR: stays In Progress) |
| Done | Merge | Single-repo ticket closes -> `status:done`. Multi-repo: comment; close it yourself after the last merge |

Every status change mirrors to the board's Status field and to Jira.

`/dev` runs the whole flow in one session: log or pick, claim, plan (one confirmation), build with the orchestrator, QA on the real surface, ship, close.

Titles that start with `/` (like `/dev ...`): in Git Bash, prefix `gh` with `MSYS_NO_PATHCONV=1`, or Git Bash rewrites the leading slash into a Windows path.

## Doing it by hand

- **Move a ticket**: change its `status:*` label in GitHub (one label; the old one is removed for you). A label you set always wins, even moving backwards. Dragging the board card alone gets reset on the next sync.
- **Unclaim**: remove yourself as assignee. An In Progress ticket returns to To Do; branches stay.
- **Close without a PR**: close the issue (or add `status:done`). Reopen puts it back to In Progress (assigned) or To Do.
- **Jira**: read-only. Edits there are overwritten by the next GitHub change.

## Setup (once)

1. `node kit/install.mjs`: renders "How work runs" in `AGENTS.md` from `workflow.config.json`, links the skills for each agent you use, writes the orchestrator role files, links the workspace `AGENTS.md`/`CLAUDE.md`, and turns on kb's pre-commit hook (`core.hooksPath .githooks`: secret scan and note validation). Re-run it after pulling kit changes or editing the config.
2. `gh auth refresh -h github.com -s project`, then from a terminal in `acme-kb`: `bash kit/scripts/bootstrap-github.sh` (Windows PowerShell: `& "C:\Program Files\Git\bin\bash.exe" kit/scripts/bootstrap-github.sh`; plain `bash` there is WSL's): labels, board, variables, Actions access, and prompts for the three secrets (set per repo; the org is on GitHub Free).
   - `KB_BOT_TOKEN`: a maintainer PAT. Fine-grained: owner `acme`, the hub and every code repo, Contents RW, Issues RW, Pull requests R, org Projects RW. Classic: `repo`, `project`.
   - `JIRA_EMAIL` + `JIRA_API_TOKEN`: an Atlassian account that can edit ACME (token from id.atlassian.com > Security > API tokens).
3. Push `acme-kb` `main`. Copy `kit/github/ticket-status.yml` to `.github/workflows/` in each code repo (skip this without Jira: PR sync needs the Jira key and would fail every PR).
4. Jira ACME board: a column/status **In Review** between In Progress and Done.
5. Install the **GitHub for Jira** app on the `acme` org (Jira > Apps > GitHub for Jira) so ACME branches, commits and PRs appear in the Jira dev panel.

## When something looks wrong

Open the run: `gh run list --repo acme/acme-kb --workflow ticket-sync.yml`. Each run writes a summary of what it changed and any warnings (missing secret, missing Jira status, ticket without `repo:*` labels). Runs are idempotent: re-trigger by editing the issue.
