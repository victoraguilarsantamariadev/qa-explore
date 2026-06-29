---
name: qa-heal
description: Self-healing test suite — when the deterministic E2E/regression suite goes red, triage each failing test into a STALE/BRITTLE test (repair the selectors/waits, never the assertion) vs a REAL REGRESSION (leave it red — it's a bug). Repairs the brittle ones on a branch and opens one merge request; real regressions are filed as issues that flow into /qa-fix. Use when asked to "fix the failing tests", "heal the broken suite", "the selectors are stale", "stop the flaky tests", or "the CI suite is red". Never weakens an assertion; never merges.
---

# qa-heal

Tests rot: selectors drift, labels change, waits get flaky — and a red suite that's just stale gets ignored, which is how real regressions slip through. `qa-heal` keeps the suite honest. For each failing test it decides **why** it fails and acts:

```
suite red  →  per failing test, in an isolated worktree:
   ├─ behaviour still holds, selector/label/timing drifted   → REPAIR the test (the HOW)  → green
   ├─ behaviour is gone / assertion no longer matches the app → REAL REGRESSION → leave red → file a bug
   └─ passes on retry                                         → stabilize (proper wait, no assertion change)
repairs  →  one branch + one MR ("qa-heal: repair N stale tests")  →  you review & merge
verify   →  an INDEPENDENT agent confirms the diff touched ONLY selectors/waits — no assertion moved
regressions → filed as issues (via the report step) → they flow into /qa-fix
```

## 🔒 The cardinal rule
**Heal the HOW (selectors, locators, waits, setup) — never the WHAT (assertions).** If a test can only go green by changing what it *asserts*, the test is right and the app changed: that's a **real regression**, not a stale selector. Weakening an assertion to force green would **hide a real bug** — qa-heal refuses to do it, and the independent Verify-heal pass exists specifically to catch any repair that touched an assertion.

## Engine (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-heal/engine/qa-heal.workflow.js`

(If `$CLAUDE_PLUGIN_ROOT` is unset, the skill is at `~/.claude/skills/qa-heal` — resolve the engine path relative to this SKILL.md.)

## Prerequisites
- The same `qa.config.json` qa-explore/qa-fix use (`baseUrl`, `login`, `e2eDir`, `framework`, and — to open the MR + file regressions — a `tracker` block + its token env var). Optional `heal` block: `verify` (default true), `maxHeal`, `suiteCommand`.
- **Run from inside the target project's git repo** — the healer works in a worktree and pushes a branch. Without a tracker it just leaves a local branch + diff for you.

## How to run

1. **Resolve config.** Load `qa.config.json`. Confirm the token env var if a `tracker` is set (don't print it).
2. **Find the failures.** If the user already has suite output, pass it as `args.failures` (`[{testFile, testTitle, error}]`). Otherwise the engine's **Collect** phase runs the suite (`heal.suiteCommand` or the framework default) and lists the red tests.
3. **Confirm before any push.** Repairing tests + opening a MR is an outward action — state how many tests are red and that it will open one MR of repairs. Proceed on the user's go-ahead.
4. **Run the engine.** `Workflow({ scriptPath: "<engine>/qa-heal.workflow.js", args: { ...config, failures? } })`. It adjudicates each failure (heal vs real-regression vs flaky), repairs the brittle ones on one branch, opens one MR, and an independent agent verifies the diff is HOW-only.
5. **File the regressions.** Take the returned `regressions` (real app bugs the tests caught) and file them via `report-issues.workflow.js` (same as qa-explore findings) so they enter the `qa::confirmed` → `/qa-fix` loop. The suite's red tests for those bugs stay red until `/qa-fix` fixes the app.
6. **Report back.** Summarize: tests healed (with the MR + the exact HOW-level changes), real regressions filed (with links), flaky stabilized, and **loudly flag** any repair the verifier said touched an assertion — those must not be merged without a human looking.

## Where it fits the loop
`qa-explore` finds new bugs · `qa-heal` keeps the existing suite trustworthy (stale ≠ broken) · `qa-fix` fixes the real bugs both surface. Run qa-heal whenever Step 0 is red, or on a schedule, before trusting a red suite as "regressions."

## Notes
- **Human merges, always.** qa-heal opens the MR; you merge it. The MR shows exactly which selectors/waits moved.
- A test it can't safely adjudicate is returned `could-not-heal` (not silently changed) for a human to take.
- Cadence: on demand (`/qa-heal` when the suite is red). A scheduled/CI variant rides the same roadmap as the standalone runner.
