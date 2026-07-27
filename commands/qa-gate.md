---
description: Release sign-off — a deterministic GO / NO-GO verdict against a written rubric, with audited waivers
argument-hint: "[release name or tag]"
---

Run the `qa-gate` skill at `${CLAUDE_PLUGIN_ROOT}/skills/qa-gate/SKILL.md`.

Read that SKILL.md now and follow it exactly — the rubric decides the verdict, an agent only writes the sign-off. Same inputs must always give the same verdict.

User arguments (may be empty): $ARGUMENTS

Be honest about coverage: a signal that was never collected reads "not assessed", never "clean". Print every accepted waiver with who approved it and why — a waiver is never silent. On NO-GO, the blockers are the fix list for `/qa-fix`.
