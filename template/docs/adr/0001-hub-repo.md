# 1. One hub repo for tickets, decisions and the agent kit

Status: Accepted (2026-11-16)

## Context
The product spans several repos. Tickets often touch more than one repo. Keeping issues per repo splits the backlog and makes "who is doing what" a multi-repo query. Skills and agent instructions also need one home that every repo can see.

## Decision
`acme-kb` is the hub. Every ticket is a GitHub issue there, whatever repo the code lands in (`repo:*` labels say where). ADRs, `docs/`, the ticket automation (`tools/ticket-sync`) and the agent kit (`kit/skills`, workspace `AGENTS.md`) live there too. `kit/install.mjs` links the skills into each agent's workspace skills folder and links (or copies, when Windows symlinks are unavailable) `AGENTS.md`/`CLAUDE.md` into the workspace root.

## Consequences
- One backlog, one board, one place to search for duplicates.
- PRs in code repos reference the hub issue cross-repo (`Fixes acme/acme-kb#n`).
- Code-repo issue trackers stay unused; turn them off to avoid strays.
- A copy fallback for root docs goes stale until `install.mjs` is re-run.
