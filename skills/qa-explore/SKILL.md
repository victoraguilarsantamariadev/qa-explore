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
3. REPORT   file each verify-confirmed finding as a tracker issue (GitLab/GitHub), idempotently   [if tracker configured]
4. TRIAGE   a human marks the genuine bugs with the fix label — in the tracker (the gate moved there); LEARN from the rest
5. CODIFY   write + self-validate specs:  RED regression test per confirmed bug,  GREEN smoke per working flow
            → those specs become Step 0 next time. The suite grows itself.
```

Then `/qa-fix` closes the loop: it picks up the labelled issues, fixes them in isolated worktrees, and opens a merge request per bug for human review. (No tracker configured → REPORT is skipped and TRIAGE happens in-chat as before.)

Cold start (no tests): Step 0 is empty and skipped; agents explore first to discover real routes/flows/selectors, then Codify writes the FIRST suite. Never write tests blind from source — exploration is what makes good (non-brittle) tests possible.

## Engine files (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/engine/explore-verify.workflow.js`
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/engine/report-issues.workflow.js` (files findings as tracker issues)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/engine/codify.workflow.js`
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-explore/qa.config.example.jsonc` (config template)
- Fixing half lives in the sibling `qa-fix` skill (`${CLAUDE_PLUGIN_ROOT}/skills/qa-fix/`).

(If `$CLAUDE_PLUGIN_ROOT` is unset, the skill is at `~/.claude/skills/qa-explore` — resolve the engine paths relative to this SKILL.md.)

## Safety (read before running)

This drives a **real browser as a real user against a live target**. `mode` controls behaviour and is independent of the environment — writing against real production is the user's call. The dials, most→least powerful:
- **`explore` (default)** — create / edit / submit / **delete** (prefixed `qa-…`, best-effort cleanup, not guaranteed). Best for staging / pre-prod.
- **`no-delete`** — write but never delete; the safe middle ground for a sensitive/production target.
- **`read-only`** — zero writes; the cautious choice for real production.

Rules regardless of mode:
- It runs with **your machine's network access** and is confined to `allowedHosts` (defaults to the `baseUrl` host): it never follows links/redirects off-host and never scans other machines — it only goes where the config points it.
- Before any **write-enabled** run (`explore` or `no-delete`), **state the resolved target URL + mode and get a go-ahead**, especially the first time against a new target, and louder if it looks like production. Treat that confirmation as the authorization. Recommend a **dedicated QA account with segregated data** for write runs against production.

## How to run

1. **Resolve config.** Find `qa.config.json` in the project (cwd or its E2E dir). If missing, copy the example and fill `baseUrl`, `appPath`, `login`, `e2eDir`, `framework`, and `domainNotes`. Ask the user only for what you can't infer (base URL, credentials). Read `mode` (`explore` default / `read-only`) and `allowedHosts`, and apply the Safety step above. Also read the **coverage axes**: `viewports` (first = primary full pass, extras = responsive sweeps — mobile/desktop), `roles` (first = primary; extras trigger an **access-control** pass that hunts broken authorization), and `projectType` (`web-spa`/`web-ssr` → Chromium; `electron` → Playwright Electron; `api`/`cli` → HTTP/CLI instead of a browser). Note whether a `tracker` block is set (`type` = `gitlab`/`github`) — it switches steps 6–7 from in-chat triage to the file-issue → human-mark → `/qa-fix` loop.

2. **Decide scope (cost control — never downgrade the model, scope instead).**
   - **full** (default cold start, or a scheduled crawl): cover all areas (recon-discovered or from config). Cache the discovered `areas` back into the config so future runs skip recon.
   - **diff** (per-PR): run `git diff --name-only <base>..HEAD`, map changed files → affected areas, and PULL IN any area that depends on changed **shared code or API endpoints** (not just literally-changed files) **plus** any area that has no smoke coverage yet. Pass that subset as `args.areas`. Areas that are stable (green smoke + untouched) are skipped by the agents — but see step 3.

2b. **Coverage mode (`coverage.mode`).** `sample` (default) = one agent per functional area (≤ `maxAreas`): a thorough human-style pass, broad but not guaranteed-complete. `exhaustive` = recon builds a full **inventory** (every route, entity, and enumerable variant — e.g. *every* widget type) and fans out **one unit of work per item** (a separate "create a `<X>` widget" per type, full CRUD per entity, a visit per route), then a **completeness-critic loops** over the inventory covering any gap until none remain (or `maxRounds`/`maxUnits` — drops are **logged, never silent**). Use `exhaustive` when the user wants "test absolutely everything"; expect more tokens (the cost lever is scope, not model). For `exhaustive`, point `sourceHints` at the routes + the widget/component registry + API.

3. **Step 0 — existing suite (the regression net).** ALWAYS run the full deterministic suite if one exists in `e2eDir` (`npx playwright test --reporter=line,json`), even in diff mode — this is what catches a PR breaking an untouched area. Parse results, summarize pass/fail. No suite yet → "cold start, skipping Step 0". Reminder: failing baseline tests are often stale selectors, not app bugs — the explore pass adjudicates which. (The agent scope is cheap-cut; the deterministic net is never cut.)

4. **Explore + Verify.** `Workflow({ scriptPath: "<engine>/explore-verify.workflow.js", args: <config-with-scoped-areas> })`. Agents reuse one login session (`storageState.json`) and capture trace/HAR/console/video per finding. It returns confirmed findings per area.

5. **Synthesize + dedup.** Build `<shotsDir>/INFORME.md` + keep the evidence dir. **Dedupe findings that repeat across areas** (e.g. a shared broken component) into one entry. Group by **confidence** (`hard-evidence` vs `judgement`) then severity. Hard-evidence = concrete HTTP status / console error / API mismatch; judgement = a "looks wrong" visual call (provisional — where false positives hide). Link each finding's trace.zip / video for the dev.

6. **Report → tracker (if `tracker.type` is `gitlab`/`github`).** Decide which findings to file: the default policy is `tracker.fileSeverities` (blocker/major/data-sense) **plus** any `hard-evidence` finding, and — for serious findings — only those the Verify pass **confirmed**. Confirm the token env var (`tracker.tokenEnv`) is set without printing it. Then `Workflow({ scriptPath: "<engine>/report-issues.workflow.js", args: { tracker, findings: <chosen>, shotsDir, baseUrl } })`. It dedupes against open issues (by an embedded `qa-fp` fingerprint) so re-runs don't pile up duplicates, and files the rest with the `issueLabels` (it deliberately does **not** apply the human `fixLabel`). Report the issue links. **The triage gate now lives in the tracker:** a human adds `fixLabel` to the genuine bugs; those flow to `/qa-fix`. (No tracker → present findings + `worksWell` in chat and let the user mark each real / not-a-bug, as before.)

   **LEARN (always).** For every finding rejected as not-a-bug (in chat, or an issue a human closes as invalid), append a one-line rule to `qa.config.json` `domainNotes` capturing *what looked wrong and why it is actually correct* (e.g. "Status widget is websocket → empty preview is expected"). The harness stops re-flagging that false positive on future runs.

7. **Codify (smokes + cold start).** `Workflow({ scriptPath: "<engine>/codify.workflow.js", args: { ...config, bugs: <approved>, smokes: <chosen working flows> } })`. Each writer agent writes ONE spec into `e2eDir` (matching local conventions) and **self-validates** it. Note: when the tracker loop is active, the **red regression test per bug is written by `/qa-fix`** inside the fix MR (so the MR carries its own proof) — here, focus Codify on GREEN smokes for the `worksWell` flows. On a cold project, generating those smokes bootstraps the regression net so future diff-scoped runs are safe. Those specs become Step 0 next time.

## Cadence (recommended)
- **Per PR:** full deterministic suite (Step 0) + diff-scoped agents → codify new confirmed issues.
- **Nightly/weekly:** full agent crawl as a backstop for anything the diff-scope + smoke coverage missed.

## Notes
- Generalizes best to web/UI apps (the agents' "hands" are a browser). For pure APIs/CLIs the same explore→verify→codify loop applies with HTTP/CLI calls instead of Playwright.
- `domainNotes` is the single biggest lever against false positives and it auto-grows via step 6 — keep it in the repo so the whole team benefits.
