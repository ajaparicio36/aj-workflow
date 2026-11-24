# 2. GitHub is the source of truth; Jira mirrors one way

Status: Accepted (2026-11-16)

## Context
Developers live in GitHub (issues, branches, PRs). Jira project `ACME` is wanted for reporting and the GitHub for Jira dev panel. Two-way sync creates conflict resolution, loops and a second place to edit.

## Decision
Sync runs GitHub -> Jira only. `tools/ticket-sync` creates the Jira issue on first sight (labels `gh-<n>`, `repo-<key>`), writes `<!-- jira:ACME-<k> -->` into the hub issue body, updates summary/description on edit, and transitions Jira to the hub status. Nothing reads Jira except the PR flow, which maps `ACME-<k>` back to the hub issue through the `gh-<n>` label.

## Consequences
- Status, title and body edits in Jira are overwritten or ignored; Jira is read-only for people.
- Jira must have every hub status (To Do, In Progress, In Review, Done). A missing one shows as a warning in the run summary.
- Jira keys exist only after the first sync run, so branches (which embed the key) are cut by automation, not by hand.
