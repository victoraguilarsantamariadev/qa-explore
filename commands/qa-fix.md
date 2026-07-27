---
description: Turn labelled tracker issues into verified merge requests — reproduce, RED regression test, fix, independent verify
argument-hint: "[issue iid or number]"
---

Run the `qa-fix` skill at `${CLAUDE_PLUGIN_ROOT}/skills/qa-fix/SKILL.md`.

Read that SKILL.md now and follow it exactly — one isolated worktree per issue, a regression test that runs against the CHANGED code, and an independent agent that verifies the branch before the MR gets its verdict.

User arguments (may be empty): $ARGUMENTS

This requires a configured `tracker` and only picks up issues carrying the `fixLabel` — that label is the human gate on which bugs get fixed. Never merge automatically; the MR is for the user to review.
