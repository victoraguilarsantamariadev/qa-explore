---
description: Risk-based test plan — score each area by impact × likelihood, rank P0/P1/P2 deterministically, emit a test charter
argument-hint: "[--changed <git ref or diff>]"
---

Run the `qa-plan` skill at `${CLAUDE_PLUGIN_ROOT}/skills/qa-plan/SKILL.md`.

Read that SKILL.md now and follow it exactly — an agent judges impact and likelihood, but the rules compute the risk score and the P0/P1/P2 band, so the ranking stays deterministic.

User arguments (may be empty): $ARGUMENTS

The plan is a human gate: present the ranked areas and their acceptance criteria for approval or re-ranking before it seeds `qa-explore`'s `areas`.
