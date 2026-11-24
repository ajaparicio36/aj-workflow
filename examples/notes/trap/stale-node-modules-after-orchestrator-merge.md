---
type: trap
title: "Stale node_modules after merging orchestrator worker branches"
summary: "TS2307 cannot find module after merging orchestrator worker branches: main checkout node_modules is stale"
author: "example"
created: 2026-11-17
repos: [web]
tickets: []
status: active
---

# Stale node_modules after merging orchestrator worker branches

## Symptom

Every worker's verify passed, but the final gate in the main checkout fails with `TS2307: Cannot find module 'some-new-package'` (or any newly added package). `next build` and `vitest` also fail.

## Cause

Each orchestrator worker runs `pnpm install` inside its own git worktree. Merging its branch brings `package.json` and `pnpm-lock.yaml` into the main checkout, but not `node_modules`, so the main checkout still has the old dependencies.

## Fix

After merging a wave that changed `package.json` or the lockfile, run `pnpm install --frozen-lockfile` in the main checkout before the typecheck or the final gate.

## How to check

`git diff --name-only <base>...HEAD | grep -E 'package.json|pnpm-lock.yaml'` lists a file → install before verifying.
