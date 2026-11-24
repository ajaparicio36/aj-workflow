---
type: trap
title: "Worktree baseRef is read from the session start folder"
summary: "Worktree agents start at origin/main: baseRef is read only from the session's start folder, not the repo"
author: "example"
created: 2026-11-16
repos: [web]
tickets: []
status: active
---

# Worktree baseRef is read from the session start folder

## Symptom

Orchestrator workers spawned with `isolation: worktree` start at `origin/main` (the remote default branch), not at
the feature branch the lead is on, so they miss earlier waves' merges. It looks fine whenever the feature branch
still equals main. The repo's `.claude/settings.json` has `{"worktree": {"baseRef": "head"}}` and the orchestrator
preflight `grep` passes.

## Cause

Claude Code loads project settings (`.claude/settings.json`, `.claude/settings.local.json`) from the folder the
session was started in, once at start. Desktop sessions often start at the workspace root (not a
git repo), so each repo's own copy is never read and `baseRef` falls back to `fresh`. The worktree itself is still
cut from the repo you `cd`'d into, which hides the cause. The preflight `grep` is relative to the shell's cwd, so it
finds the repo copy and gives a false pass.

## Fix

Put the setting in the start folder: `<workspace>/.claude/settings.json` with `{"worktree": {"baseRef": "head"}}`.
`kit/install.mjs` writes it when it is missing. Start a new session afterwards; a running session
does not pick it up. A session started inside one repo still reads that repo's copy.

## How to check

From a feature branch that is ahead of `origin/main`, spawn a throwaway agent with `isolation: "worktree"` that runs
`git log -1 --format=%h`. It must print the feature branch tip, not `git rev-parse --short origin/main`.
