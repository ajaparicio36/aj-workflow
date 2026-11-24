---
name: ship
description: 'Push the current ticket branch and open its PR in an Acme repo, linked to the hub ticket. Use after the work is verified, on "ship", "open the PR", "push this".'
---

# /ship

```
/ship           push + PR
/ship --draft   push + draft PR (ticket stays In Progress)
```

1. **Pre-flight.** `git status --porcelain` empty (else ask to commit or stash). Branch matches `<type>/ACME-<k>-<slug>`; otherwise stop: work happens on the branch the claim cut. Typecheck, lint and tests pass with the repo's own scripts.
2. **Find the ticket.** The hub issue carries `<!-- jira:ACME-<k> -->` in its body:
   ```bash
   gh issue list --repo acme/acme-kb --state open --assignee @me --limit 100 --json number,title,body,labels \
     --jq '.[] | select(.body | contains("<!-- jira:ACME-<k> -->")) | {number,title,repos:[.labels[].name|select(startswith("repo:"))]}'
   ```
   No match -> ask for the issue number; never guess.
3. **Push.** `git push -u origin HEAD`.
4. **PR.**
   ```bash
   gh pr create --title "ACME-<k>: <ticket title>" --body-file <file> [--draft]
   ```
   Body: `## What` (one paragraph), `## Changes` (bullets from `git log --oneline origin/<default>..HEAD`), `## Tested` (commands run and what you checked in the app), then the link line:
   - ticket has one `repo:*` label -> `Fixes acme/acme-kb#<n>` (merge closes it)
   - several -> `Refs acme/acme-kb#<n>` (the last merge's author closes it with `/ticket done`)
5. Print the PR URL. Automation moves the ticket to In Review (draft: In Progress). Merge only when the user asks; never enable auto-merge on your own.
