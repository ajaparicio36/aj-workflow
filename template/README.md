# acme-kb

Hub for the Acme workspace: every ticket (GitHub issues here), decisions, lessons, and the agent kit.

| Path | What |
|---|---|
| `AGENTS.md` | Workspace guide for agents and people (linked to the workspace root) |
| `workflow.config.json` | Project names, repos, Jira, agents and models; edit, then re-run `kit/install.mjs` |
| `CONTEXT.md` | Domain glossary |
| `docs/workflow.md` | Ticket flow, manual moves, one-time setup |
| `docs/adr/` | Decisions |
| `notes/` | Traps, patterns, runbooks, session logs |
| `tools/ticket-sync/` | GitHub -> board + Jira + branches automation (Node 24, no runtime deps) |
| `tools/notes/` | `notes.ts new`, `find`, `check` |
| `.github/` | Sync workflows, reusable PR workflow, issue forms |
| `kit/` | Skills, orchestrator roles, `install.mjs`, `bootstrap-github.sh`, caller workflow |

Tests: `cd tools/ticket-sync && npm ci && npm test && npm run typecheck` (same in `tools/notes`).
