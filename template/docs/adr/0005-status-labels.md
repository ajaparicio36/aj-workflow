# 5. Ticket status lives in `status:*` labels on the hub issue

Status: Accepted (2026-11-16)

## Context
The flow must work for agents and for people clicking in the GitHub UI. Project v2 Status fields do not trigger `issues` workflows, so a board-only status could not drive Jira or branches. Labels do.

## Decision
Exactly one of `status:todo`, `status:in-progress`, `status:in-review`, `status:done` sits on each hub issue; the board's Status field and Jira follow it. Rules, in order: closed is Done; a `status:*` label someone just added wins, even backwards; reopened is In Progress if assigned, else To Do; otherwise assigning a To Do ticket moves it to In Progress and unassigning an In Progress one moves it back; anything else keeps the current label. Automation never overrides a manual move. Adding `status:done` closes the issue. PR events in code repos set the label through `KB_BOT_TOKEN`: opened -> In Review, draft or closed unmerged -> In Progress, merged -> Done (closes the issue only when the ticket names a single repo; multi-repo tickets get a comment and a human closes them).

## Consequences
- Moving a card on the board without changing the label is undone on the next sync. Change the label instead (or use `/ticket status`).
- Hub runs are serialized per issue and read the live issue, so bursts of events converge on the latest state even when the queue drops intermediate runs.
- Bot label writes come from a real account, so the rules do not tell bots from people; that is deliberate.
