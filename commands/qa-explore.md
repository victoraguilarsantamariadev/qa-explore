---
description: Exploratory E2E QA — agents drive the live app, judge it visually, verify findings, and codify them into a self-growing suite
argument-hint: "[base url] [--mode read-only|no-delete|explore]"
---

Run the `qa-explore` skill at `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/SKILL.md`.

Read that SKILL.md now and follow it exactly — it owns the loop (Step 0 → explore → verify → report → triage → codify) and invokes its engines via the Workflow tool.

User arguments (may be empty): $ARGUMENTS

Before spending any explore agent, resolve the config: look for `qa.config.json` (also `qa.config.jsonc`, `test/E2E/qa.config.json`, `e2e/qa.config.json`). If none exists, help the user create one from `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/qa.config.example.jsonc` and confirm `baseUrl`, `login` and `mode` with them before the first run.

`mode` drives a real browser against a live target. If the target looks like production and `mode` is not `read-only`, say so and get explicit confirmation first.
