---
type: trap
title: "Git Bash drops IANA time zone names for Windows Node"
summary: "Git Bash drops IANA TZ names for Windows Node, so TZ=America/New_York tests silently run in the machine zone"
author: "example"
created: 2026-11-18
repos: [web]
tickets: []
status: active
---

# Git Bash drops IANA time zone names for Windows Node

## Symptom

A test meant to run in another time zone (`TZ=America/New_York pnpm vitest run ...` or `npx jest`) passes, but it ran in the machine's own zone (here offset -480), so it proved nothing. `TZ=America/New_York node -e "console.log(process.env.TZ)"` prints `undefined`.

## Cause

Git Bash (MSYS) does not pass an IANA `TZ` value such as `America/New_York` to native Windows processes. POSIX-style values (`EST5EDT`, `UTC`) do get through. Setting `process.env.TZ` inside a test is not reliable either: vitest workers and jest give each file its own copy of `process.env`.

## Fix

Use a POSIX zone in Bash commands: `TZ=EST5EDT` (offset 300 in January) or `TZ=UTC`. Guard the test so a zone that did not take effect fails: have it read `EXPECT_TZ_OFFSET` and compare it with `new Date(2026, 0, 1).getTimezoneOffset()`. In PowerShell, `$env:TZ='America/New_York'` works.

## How to check

`TZ=EST5EDT EXPECT_TZ_OFFSET=300 pnpm vitest run src/lib/time.test.ts` passes, and `TZ=America/New_York EXPECT_TZ_OFFSET=300 ...` fails with "expected -480 to be 300".
