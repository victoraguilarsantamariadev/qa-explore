---
name: qa-plan
description: Risk-based test plan — what a senior QA team writes BEFORE testing. Recon the app, score each area by RISK (impact × likelihood), rank into P0/P1/P2 deterministically, define the acceptance ("done") per area, and emit a test charter (Markdown) that also seeds qa-explore's areas in priority order so the expensive exploration attacks the riskiest surface first. Use when asked to "write a test plan", "what should we test", "risk assessment", "test strategy", "prioritize testing", or "QA plan for this release".
---

# qa-plan

Top QA teams don't test everything equally — they test by **risk**. `qa-plan` is the upfront half of the process: it decides *what to test and in what order* before a single expensive explore agent runs, so effort lands on the surface where a bug would hurt most and is most likely.

```
recon the app → per area: IMPACT (blast radius if it breaks) × LIKELIHOOD (how fragile / how changed)
             → risk score (deterministic) → rank P0 / P1 / P2
             → acceptance ("done") per area
charter OUT  → test-plan.md (the plan a lead reviews)  [GATE: you approve/re-rank]
             → seeds qa-explore `areas` in PRIORITY ORDER (riskiest first)
```

## 🔒 The priority is deterministic
An agent judges **impact** and **likelihood** (1–5 each, with a written rationale) — but the **risk score and P0/P1/P2 band are computed by rules** (`impact × likelihood`), so the ranking is consistent and defensible, not a vibe. Same judgements → same plan. (Same principle as qa-gate: the model assesses, the rules rank.)

## The default risk rubric (configurable in `plan`)
- **impact** 1–5: blast radius if this area is broken — money/data/security/legal at the top, cosmetic at the bottom.
- **likelihood** 1–5: how likely it *is* broken — new/changed code, complex flows, past-bug hotspots, many integrations rank high.
- **risk = impact × likelihood** (1–25). Bands (defaults): **P0 ≥ 15**, **P1 8–14**, **P2 < 8**.
- Each area gets an **acceptance line** ("done" = the concrete happy path + the key negative/edge case that must hold) so the explore pass and the gate share one definition of success.

## Engine (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-plan/engine/qa-plan.workflow.js`

(If `$CLAUDE_PLUGIN_ROOT` is unset, the skill is at `~/.claude/skills/qa-plan` — resolve the engine path relative to this SKILL.md.)

## Prerequisites
- The same `qa.config.json` qa-explore uses (`baseUrl`, `login`, etc.). Optional `plan` block: `bands` (P0/P1 thresholds), `outFile` (default `test-plan.md`), `changed` (a list/paths of what changed this release, to raise likelihood on touched areas), `release` label.

## How to run

1. **Resolve config.** Load `qa.config.json`. If the user named what changed this release (files/areas/PR), pass it as `args.plan.changed` so touched areas score higher on likelihood.
2. **Run the engine.** `Workflow({ scriptPath: "<engine>/qa-plan.workflow.js", args: { ...config, plan: {...} } })`. It recons (or uses supplied `areas`), an agent scores impact×likelihood per area with rationale, the engine **computes** risk + P0/P1/P2, and writes `test-plan.md`.
3. **Review the plan (GATE).** Show the ranked charter; let the user re-rank / add / drop before it drives anything. A test plan the lead didn't approve isn't a plan.
4. **Feed it to execution.** Run `qa-explore` with the approved `plan.areas` (already priority-ordered missions) so the riskiest surface is explored first — and, if budget is capped, the P2 tail is what gets dropped, on purpose and logged.
5. **Close the loop with the gate.** The acceptance lines defined here are the same bar `qa-gate` signs off against at the end.

## Where it fits
**`qa-plan` (what/риск, before) → `qa-explore` (find) → `qa-heal` (keep honest) → `qa-fix` (fix) → `qa-gate` (ship?, after).** The two bookends — plan and gate — are the QA-lead process around the execution engine.

## Notes
- **Model assesses, rules rank.** Impact/likelihood are judged; the score and priority band are computed.
- **Change-aware.** Point `plan.changed` at the diff/areas of the release and touched areas rise in likelihood — risk-based testing for *this* release, not in the abstract.
- **Honest tail.** If a budget/`maxAreas` cap means P2 areas won't be explored, the plan says so explicitly — "not planned this run" is not "safe".
- Cadence: at the start of a release / on the PR that cuts it, then hand the ranked areas to qa-explore.
