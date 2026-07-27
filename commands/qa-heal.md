---
description: Triage a red suite — repair stale tests (selectors/waits only) and surface real regressions as bugs
argument-hint: "[test path or pattern]"
---

Run the `qa-heal` skill at `${CLAUDE_PLUGIN_ROOT}/skills/qa-heal/SKILL.md`.

Read that SKILL.md now and follow it exactly.

User arguments (may be empty): $ARGUMENTS

Cardinal rule: heal the HOW (selectors, waits, timing), never the WHAT (assertions). Weakening an assertion to force green would hide a real bug — if the behaviour is genuinely gone, leave the test red and file it as a regression instead.
