# Acme workspace

This folder holds separate git repos, not one repo. Canonical copy of this file: `acme-kb/AGENTS.md` (linked to the workspace root by `kit/install.mjs`); edit it there. Each repo's own `AGENTS.md` wins inside that repo.

## Map

<!-- aj:map:start -->
| Folder | What | Stack |
|---|---|---|
| `acme-app` | describe it | fill in |
| `acme-web` | describe it | fill in |
| `acme-kb` | Hub: tickets, ADRs, notes, agent kit, ticket-sync | Node 24 TS scripts |
<!-- aj:map:end -->

Project names (owner, hub, repo keys, ticket key, Jira URL, agents, models) live in `acme-kb/workflow.config.json`. After editing it, re-run `node acme-kb/kit/install.mjs`.

## Tickets

No work starts without a **claimed** ticket. Tickets are GitHub issues in `acme/acme-kb`; use the `ticket` skill (`/ticket new | claim | status | mine | board | done`).

- Status lives in one `status:*` label: To Do -> In Progress (claimed) -> In Review (PR open) -> Done (merged). Automation (`tools/ticket-sync`) mirrors it to the org board and Jira `ACME`. Jira is read-only for status.
- Claiming cuts `<type>/ACME-<n>-<slug>` from the default branch in every repo named by a `repo:*` label. Work only on that branch.
- Rules and reasons: `acme-kb/docs/workflow.md`, decisions in `acme-kb/docs/adr/`.

## Coding a ticket

Start with `/dev` (`/dev <n>`, `/dev <notes>`, or bare `/dev` to pick): it runs the whole session below and asks you once, at the plan.

1. `/ticket claim <n>`, then `git fetch origin && git switch <branch>` in each repo.
2. Build it the way "How work runs" below says.
3. Verify with the repo's own typecheck, lint and tests, then QA the change on the real surface (below).
4. `/ship` (push + PR titled `ACME-<n>: ...`). Merge only when asked.

## How work runs

<!-- aj:mode:start -->
(rendered by `kit/install.mjs` from `workflow.config.json`)
<!-- aj:mode:end -->

## QA

Unit, integration, static and headless tests run without asking whenever they are part of the task. A finished feature is also checked on a real surface (a browser, an emulator, a device), not only by tests.

Interactive QA takes over a shared resource, so ask the user to confirm the browser, emulator or device is free first; another session or worktree may be using it. Then name the exact browser session or device before acting and keep to the app under test.

Report the flows exercised, the evidence (screenshot paths, logs, command output) and any failure. A QA failure is a bug in this ticket, not a follow-up.

## Notes

`acme-kb/notes/` holds lessons: traps, patterns, runbooks, session logs (`notes/README.md` has the types).
- **Before working an area**, search them: `node acme-kb/tools/notes/notes.ts find <words>` from the workspace root, `node ../acme-kb/tools/notes/notes.ts find <words>` from inside a code repo, or grep `summary:` lines under `acme-kb/notes/`. A matching trap is a known failure; read it before debugging.
- **After a fix whose cause was not obvious**, or a reusable approach, or a recurring procedure, write one with `notes.ts new <type> <slug> "<summary>"` and commit it on a kb branch with the ticket.
- **Never** put secrets or personal data in a note; the kb pre-commit hook and CI reject token-shaped strings.

## Domain

One glossary for the whole product: `acme-kb/CONTEXT.md`. Decisions: `acme-kb/docs/adr/`. Use the glossary's words in tickets, code and tests; if a needed term is missing, add it there.

## Code rules

Add your house rules here (language, lint, types, components, design skills). One line per rule, with its reason.
