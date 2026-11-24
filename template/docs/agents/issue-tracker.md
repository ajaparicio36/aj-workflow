# Issue tracker: GitHub, hub repo

Every ticket for the workspace is a GitHub issue in **`acme/acme-kb`**, whatever repo you are in. Always pass `--repo acme/acme-kb` to `gh issue`; never infer the repo from `git remote` (in a code repo that would file into the wrong tracker). Jira `ACME` is a read-only mirror kept in sync by automation; never write to it. Why: `docs/adr/0001-hub-repo.md`, `0002-github-to-jira-one-way.md`.

## Conventions

`HUB=acme/acme-kb`. The `ticket` skill holds the full rules; the essentials for any skill that writes issues:

- **Create an issue**: dedupe first (`gh issue list --repo $HUB --state all --search "<words>"`), then `gh issue create --repo $HUB --title "..." --label "status:todo,type:<feat|fix|chore|refactor|docs|design>,repo:<key from workflow.config.json>,priority:<p1|p2>" --body-file <file>`. Body sections: `## Why`, an `**Estimate:** ~2h` line (required), `## Done when` (checkable). One `repo:*` label per repo the work touches; branches are cut from those.
- **Read an issue**: `gh issue view <number> --repo $HUB --comments --json number,title,body,labels,assignees,state,comments`.
- **List issues**: `gh issue list --repo $HUB --state open --json number,title,body,labels,assignees,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], assignees: [.assignees[].login], comments: [.comments[].body]}]'` with `--label` / `--state` filters.
- **Comment**: `gh issue comment <number> --repo $HUB --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo $HUB --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo $HUB --comment "..."` (automation sets `status:done` and Jira Done).

- **Epics**: a parent issue labelled `epic`, with no `priority:*`, whose tickets are GitHub sub-issues linked by `blocked_by` dependencies. Never claim an epic; claim its sub-tickets, and close it when they are all closed.

## Status

Status is one `status:*` label (`status:todo`, `status:in-progress`, `status:in-review`, `status:done`), never the board or Jira. Add the new one; automation removes the old and syncs the board and Jira. Assigning a person is a claim: it moves the ticket to In Progress and cuts `<type>/ACME-<n>-<slug>` branches. So a skill only assigns when the user asked to claim. Why: `docs/adr/0005-status-labels.md`.

Triage roles (`docs/agents/triage-labels.md`) are separate labels and do not replace status: a `ready-for-agent` ticket stays `status:todo` until someone claims it.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

PRs live in the code repos, issues only in the hub, so a bare `#42` in a code repo is a PR there; hub issues are written `acme/acme-kb#42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `acme/acme-kb` with the labels and body sections above.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo acme/acme-kb --comments`. On a ticket branch, the number comes from the hub issue whose body contains `<!-- jira:ACME-<n> -->` (see the `ship` skill).

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single hub issue with **child** issues as tickets. All commands take `--repo acme/acme-kb` (API paths use `repos/acme/acme-kb`).

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --repo $HUB --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`) plus the usual `status:todo`, `type:*`, `repo:*`. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/acme/acme-kb/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/acme/acme-kb/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body and add the `blocked` label. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --repo $HUB --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --repo $HUB --add-assignee @me`, the session's first write (automation then cuts the branches).
- **Resolve**: `gh issue comment <n> --repo $HUB --body "<answer>"`, then `gh issue close <n> --repo $HUB`, then append a context pointer (gist + link) to the map's Decisions-so-far.
