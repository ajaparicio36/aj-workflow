---
type: trap
title: "Windows python3 store alias"
summary: "On this Windows machine python3 opens the Microsoft Store stub; run the orchestrator helper scripts with python"
author: "example"
created: 2026-11-24
repos: [web]
tickets: []
status: active
---

# Windows python3 store alias

## Symptom

The orchestrator skill's gates, `python3 <skill-dir>/bin/validate_plan.py ...` and `verify_research.py`, print nothing useful. Instead they open the Microsoft Store, or exit with "Python was not found".

## Cause

Windows ships App Execution Aliases for `python3.exe` that point at the Store installer. On many machines the real interpreter is only on PATH as `python`.

## Fix

Run the helper scripts with `python`, not `python3`:
`python <skill-dir>/bin/validate_plan.py .orchestrator/plan.json`.
Turning off the `python3.exe` alias in Settings, under Apps, then Advanced app settings, then App execution aliases, also works. That is a machine setting, though, so leave it to the user.

## How to check

`python --version` prints a version. `python <skill-dir>/bin/validate_plan.py .orchestrator/plan.json` prints `VALID: ...` or `INVALID: ...`.
