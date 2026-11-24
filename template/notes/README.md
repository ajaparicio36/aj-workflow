# Notes

Lessons that should outlive a session: what broke and why, what worked, how to do a recurring task. One note per lesson, written by people or agents, found with grep.

| Type | Folder | Write one when | Sections |
|---|---|---|---|
| trap | `notes/trap/` | you fixed something whose cause was not obvious | Symptom, Cause, Fix, How to check |
| pattern | `notes/pattern/` | an approach worked and will be reused | When to use, How, Example |
| runbook | `notes/runbook/` | a task recurs and has steps (release, rotate a token, reset a device) | When, Steps, Verify |
| log | `notes/log/` | a session ended with state the next one needs | What happened, Next |

Not notes: decisions go in `docs/adr/`, domain terms in `CONTEXT.md`, work in tickets.

## Write

```bash
node tools/notes/notes.ts new trap cart-total-after-void "Sale total keeps the voided line; totals read the unflagged sum" --repos web --ticket 12
```

It stamps type, author (from `git config user.name`), date and status, writes the section headings, and prints the path. Fill the sections, then commit. The `summary` is the line people will search for: write the symptom or the situation in the words someone would type.

To replace an outdated note, write a new one with `supersedes: notes/<type>/<file>.md` and set the old one's `status: superseded`.

## Find

```bash
node tools/notes/notes.ts find void total
```

Or grep the summaries directly: `grep -ri "summary:.*void" notes/`.

## Never

Secrets, tokens, passwords, customer or staff personal data. `notes.ts check` runs in the kb pre-commit hook and in CI and blocks token-shaped strings in every file, plus `password: ...`-style lines in notes. A documented false positive can carry `notes-check: allow` on its line.
