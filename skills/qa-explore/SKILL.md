---
name: qa-explore
description: Exploratory end-to-end QA with a team of agents that drive a real browser like human testers — they click through the whole app, create/fill/submit, screenshot and visually judge rendering + data correctness, capture trace/HAR/console/video evidence, adversarially verify each finding, learn from rejected findings, and codify confirmed bugs (and working flows) as real regression/smoke tests. Use when asked to "test the whole app", "explore for bugs", "QA this web app", "find anything broken on <url>", "test as a user", or to set up/grow an agent-based exploratory E2E suite for any web project. Works cold (no tests yet) or warm (existing Playwright/Cypress suite).
---

# qa-explore

A reusable harness that tests any web app the way a human QA team would, then turns what it learns into a self-growing deterministic E2E suite.

## The loop

```
Step 0  RUN EXISTING SUITE (deterministic, full, cheap)  — your regression net; skipped on a cold project
1. EXPLORE  one human-tester agent per area: navigate, create, fill, submit, screenshot, judge, capture evidence
2. VERIFY   independent skeptics re-run each serious finding (flaky / false-positive killer)
3. TRIAGE   you approve which findings are real    (human gate — never auto-codify; LEARN from rejections)
4. CODIFY   write + self-validate specs:  RED regression test per confirmed bug,  GREEN smoke per working flow
            → those specs become Step 0 next time. The suite grows itself.
```

Cold start (no tests): Step 0 is empty and skipped; agents explore first to discover real routes/flows/selectors, then Codify writes the FIRST suite. Never write tests blind from source — exploration is what makes good (non-brittle) tests possible.

## Engine files (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/engine/explore-verify.workflow.js`
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/engine/codify.workflow.js`
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/qa.config.example.jsonc` (config template)

(If `$CLAUDE_PLUGIN_ROOT` is unset, the skill is at `~/.claude/skills/qa-explore` — resolve the engine paths relative to this SKILL.md.)

## How to run

1. **Resolve config.** Find `qa.config.json` in the project (cwd or its E2E dir). If missing, copy the example and fill `baseUrl`, `appPath`, `login`, `e2eDir`, `framework`, and `domainNotes`. Ask the user only for what you can't infer (base URL, credentials).

2. **Decide scope (cost control — never downgrade the model, scope instead).**
   - **full** (default cold start, or a scheduled crawl): cover all areas (recon-discovered or from config). Cache the discovered `areas` back into the config so future runs skip recon.
   - **diff** (per-PR): run `git diff --name-only <base>..HEAD`, map changed files → affected areas, and PULL IN any area that depends on changed **shared code or API endpoints** (not just literally-changed files) **plus** any area that has no smoke coverage yet. Pass that subset as `args.areas`. Areas that are stable (green smoke + untouched) are skipped by the agents — but see step 3.

3. **Step 0 — existing suite (the regression net).** ALWAYS run the full deterministic suite if one exists in `e2eDir` (`npx playwright test --reporter=line,json`), even in diff mode — this is what catches a PR breaking an untouched area. Parse results, summarize pass/fail. No suite yet → "cold start, skipping Step 0". Reminder: failing baseline tests are often stale selectors, not app bugs — the explore pass adjudicates which. (The agent scope is cheap-cut; the deterministic net is never cut.)

4. **Explore + Verify.** `Workflow({ scriptPath: "<engine>/explore-verify.workflow.js", args: <config-with-scoped-areas> })`. Agents reuse one login session (`storageState.json`) and capture trace/HAR/console/video per finding. It returns confirmed findings per area.

5. **Synthesize + dedup.** Build `<shotsDir>/INFORME.md` + keep the evidence dir. **Dedupe findings that repeat across areas** (e.g. a shared broken component) into one entry. Group by **confidence** (`hard-evidence` vs `judgement`) then severity. Hard-evidence = concrete HTTP status / console error / API mismatch; judgement = a "looks wrong" visual call (provisional — where false positives hide). Link each finding's trace.zip / video for the dev.

6. **Triage gate (human) + LEARN.** Present findings and the `worksWell` flows. The user marks each: real bug / not-a-bug. For every finding the user **rejects as not-a-bug**, append a one-line rule to the project `qa.config.json` `domainNotes` capturing *what looked wrong and why it is actually correct* (e.g. "Status widget is websocket → empty preview is expected"). This is the auto-learning loop: the harness stops re-flagging the same false positive on every future run. **Never codify anything without approval.**

7. **Codify.** `Workflow({ scriptPath: "<engine>/codify.workflow.js", args: { ...config, bugs: <approved>, smokes: <chosen working flows> } })`. Each writer agent writes ONE spec into `e2eDir` (matching local conventions) and **self-validates** it by running it — bug specs must fail for the right reason, smoke specs must pass. Report which specs were written and their observed status. Those specs are now Step 0 for next time. On a cold project, generating smokes for the main working flows is recommended — it bootstraps the regression net so future diff-scoped runs are safe.

## Cadence (recommended)
- **Per PR:** full deterministic suite (Step 0) + diff-scoped agents → codify new confirmed issues.
- **Nightly/weekly:** full agent crawl as a backstop for anything the diff-scope + smoke coverage missed.

## Notes
- Generalizes best to web/UI apps (the agents' "hands" are a browser). For pure APIs/CLIs the same explore→verify→codify loop applies with HTTP/CLI calls instead of Playwright.
- `domainNotes` is the single biggest lever against false positives and it auto-grows via step 6 — keep it in the repo so the whole team benefits.
