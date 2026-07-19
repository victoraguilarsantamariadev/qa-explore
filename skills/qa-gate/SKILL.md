---
name: qa-gate
description: Release gate / QA sign-off — the decision layer a senior QA team owns. It aggregates every signal the other skills produce (explore findings by severity+confidence, the Step-0 deterministic suite, access-control, a11y, and optional visual/perf) and applies a WRITTEN, consistent release rubric to emit a deterministic GO / NO-GO verdict with the exact blockers, the risk summary, and an auditable list of waivers. The verdict is computed by rules (not LLM vibes); an agent only writes the human-readable sign-off. Use when asked to "can we ship?", "release sign-off", "go/no-go", "is this release-ready", "QA gate", or "quality gate for CI".
---

# qa-gate

Top QA orgs don't just *run* tests — they **own the ship decision**. `qa-gate` is that decision, standardized: it takes the evidence the rest of the suite already gathered and turns it into a **GO / NO-GO** against a rubric you can read, version, and defend — the same way a release manager signs off.

```
signals in  →  explore findings (severity × confidence, verified?)
               Step-0 deterministic suite (green? red?)
               access-control findings · a11y violations · (visual drift · perf budget)
apply RUBRIC (deterministic, configurable) → count blockers, honour waivers
verdict OUT →  GO ✅ / NO-GO ❌  +  the exact blockers  +  risk summary  +  waiver audit trail
            →  qa-signoff.md (the sign-off a human/CI can act on)
```

## 🔒 Why the verdict is deterministic
A gate that changes its mind run-to-run is not a gate. The **GO/NO-GO is computed by rules** over the signals — same inputs, same verdict, every time. The LLM is used ONLY to write the narrative (risk summary, wording), never to decide whether to ship. This is what makes it auditable and CI-safe.

## The default release rubric (all configurable in `gate`)
A finding **blocks the release** when it is:
- **severity ∈ `blockOn`** (default `["blocker","major"]`), **AND**
- **confirmed** — the Verify pass marked it `confirmed:true`, or its confidence is `hard-evidence` (self-proving: a captured 2xx/leak/console error), **AND**
- **not waived** (see below).

Plus these hard gates (each configurable):
- `requireStep0Green` (default true): the Step-0 deterministic regression suite must be green. A red baseline = **NO-GO** (unless waived) — shipping on a red suite is how regressions escape.
- `blockOnAccessControl` (default true): any confirmed access-control / broken-authorization finding = **NO-GO**, regardless of the severity label. Security is not negotiable at the gate.
- `a11yBlockOn` (default `["critical"]`): axe-core violations at these impact levels block.
- Optional `visualBlock` / `perfBudget` if you feed visual-regression / Lighthouse results.

**Waivers are first-class and audited.** A real team ships with known, accepted risk — but on the record. `gate.waive: [{ match, reason, approvedBy }]` removes a specific finding from the blockers **and prints it in the sign-off** as an accepted risk with who approved it and why. Never silent.

## Engine (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-gate/engine/qa-gate.workflow.js`

(If `$CLAUDE_PLUGIN_ROOT` is unset, the skill is at `~/.claude/skills/qa-gate` — resolve the engine path relative to this SKILL.md.)

## Prerequisites
- The signals to judge. Normally you get them by running `qa-explore` first and passing its `result` array as `args.results` (each entry already carries `explore.findings`, `verify.verdicts`, and the `step0` entry). You can also pass a pre-normalized `signals` object.
- Optional `gate` block in `qa.config.json` with the rubric overrides + `outFile` (default `qa-signoff.md`) + `release` label (version/PR).

## How to run

1. **Gather the evidence.** Run `qa-explore` (explore + verify + Step 0 + access-control) and keep its `result`. For a full gate also run/collect a11y (qa-explore already does an axe pass), and — if configured — visual-regression and perf results.
2. **Confirm the rubric.** Load `qa.config.json`'s `gate` block (or accept the defaults above). If the caller wants stricter/looser blocking for this release, that's a config change, stated up front — never bend the rubric silently per-run.
3. **Run the engine.** `Workflow({ scriptPath: "<engine>/qa-gate.workflow.js", args: { ...config, results } })`. It **computes** the verdict deterministically, then an agent writes `qa-signoff.md`.
4. **Report the verdict, loudly.** State **GO** or **NO-GO** first, then the blockers (each with severity, why it blocks, and its evidence), the accepted waivers (with approver + reason), and the residual-risk summary. On NO-GO, the blockers ARE the fix list — hand them to `/qa-fix`.
5. **CI use.** In a pipeline, exit non-zero on NO-GO so the release stops. The runner returns the verdict; wire `verdict === 'NO-GO'` to a failing step.

## Where it fits
`qa-plan` (risk-based, if present) scopes what to test · `qa-explore` finds bugs · `qa-heal` keeps the suite honest · `qa-fix` fixes them · **`qa-gate` decides whether the result is shippable** — the QA-lead function, encoded. It is the last step before a release and the natural CI quality gate.

## Notes
- **Deterministic verdict, narrated by an agent.** Rules decide; the model only explains.
- **No silent waivers.** Every accepted risk appears in the sign-off with who approved it and why.
- **Honest about coverage.** If a signal wasn't collected (no a11y pass, no visual baseline), the sign-off says "not assessed" for it rather than implying a clean bill.
- Cadence: every release / on the PR that cuts it; as a required CI check on the release branch.
