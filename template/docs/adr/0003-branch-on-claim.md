# 3. Branches are cut automatically when a ticket is claimed

Status: Accepted (2026-11-16)

## Context
Hand-made branch names drift (`fix/scrum-27-slug-20261116`, `johns-fix`) and break the link between branch, ticket and Jira. A ticket can need work in several repos.

## Decision
When a hub issue is In Progress and has an assignee (claim = assign), automation creates a branch in every repo named by a `repo:*` label, from that repo's default branch, with GraphQL `createLinkedBranch` so it appears in the issue's Development panel. It skips branches that exist and upserts one bot comment listing the branches and the `git fetch && git switch` command.

## Consequences
- Claiming needs `repo:*` labels first; without them the run warns and cuts nothing.
- Cross-repo branch creation needs `KB_BOT_TOKEN` (a maintainer PAT); `GITHUB_TOKEN` cannot write other repos.
- Branches start from the remote default branch, so pull before you switch.
