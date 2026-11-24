# Domain Docs

How the engineering skills should consume the acme domain documentation when exploring code in any repo of the workspace.

Layout: **one shared context**. Every repo in the workspace is part of one product, so they share one glossary and one ADR log, both in acme-kb. From a code repo the paths are `../acme-kb/...`.

## Before exploring, read these

- **`acme-kb/CONTEXT.md`**: the domain glossary.
- **`acme-kb/docs/adr/`**: read ADRs that touch the area you're about to work in. Decisions that only concern one repo also live here, with the repo named in the title.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved, always in acme-kb.

If you are rebuilding an older system, its code shows how the business works today. When a term comes from there, record it in `CONTEXT.md` with the old name noted, so the new code keeps the language the business already uses.

## File structure

```
acme/                      (workspace folder, not a repo)
├── acme-kb/
│   ├── CONTEXT.md               ← one glossary for the product
│   └── docs/adr/
│       ├── 0001-hub-repo.md
│       └── ...
└── <code repos>/          ← each reads ../acme-kb/CONTEXT.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0005 (status labels), but worth reopening because…_
