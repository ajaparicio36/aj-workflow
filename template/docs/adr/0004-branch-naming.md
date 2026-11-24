# 4. Branch names are `<type>/ACME-<n>-<slug>`

Status: Accepted (2026-11-16)

## Context
The GitHub for Jira app links branches, commits and PRs to a Jira issue when they contain its key. The PR automation also needs to find the ticket from a branch.

## Decision
Branches are `<type>/ACME-<k>-<slug>`: `type` from the `type:*` label (feat, fix, chore, refactor, docs, design; default chore), `ACME-<k>` the Jira key, `slug` the title in lowercase ASCII, cut at a word boundary within 40 characters. PR titles start with `ACME-<k>: `. The key is read from the branch first, then the title. Install the GitHub for Jira app on the org so the dev panel fills in.

## Consequences
- One ticket gives the same branch name in every repo.
- Renaming a ticket later does not rename its branch.
- Work without a ticket has no key and no automation; that is intended.
