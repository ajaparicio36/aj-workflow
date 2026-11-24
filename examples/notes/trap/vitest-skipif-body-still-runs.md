---
type: trap
title: "A skipped vitest describe still runs its body"
summary: "Skipped vitest suite still throws (e.g. DATABASE_URL is not set): describe.skipIf body runs during collection"
author: "example"
created: 2026-11-17
repos: [web]
tickets: []
status: active
---

# A skipped vitest describe still runs its body

## Symptom

An integration test guarded with `describe.skipIf(!process.env.DATABASE_URL)` passes locally with a database but fails in CI or pre-push with `Error: DATABASE_URL is not set` and `1 failed` suite. The guard looks right.

## Cause

Vitest runs the `describe` callback during collection, so it can find the tests inside, even when the suite is skipped. Code written directly in the callback body (such as `const db = getDb()`) executes anyway. Only the hooks (`beforeAll`, ...) and the `it` bodies are skipped.

## Fix

Move side effects into `beforeAll` (or into each `it`). For example:

```ts
describe.skipIf(!process.env.DATABASE_URL)("db", () => {
  let db: ReturnType<typeof getDb>;
  beforeAll(() => {
    db = getDb();
  });
});
```

## How to check

`pnpm test` with `DATABASE_URL` unset reports the suite as `skipped`, not `failed`.
