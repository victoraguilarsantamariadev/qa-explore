---
name: qa-fix
description: Second half of the qa-explore loop — pick up the issues a human marked as real bugs in the tracker (GitLab/GitHub), reproduce each one, write a regression test that asserts the correct behaviour, fix the code until that test goes green and the suite stays green, then open a merge request linked to the issue for human review. Use when asked to "fix the QA issues", "work the qa-explore backlog", "auto-fix the confirmed bugs", or "open MRs for the labelled issues". Never merges — a human always reviews.
---

# qa-fix

The fixing half of the closed loop. `qa-explore` files issues for what it finds; a human marks the real ones with the fix label; **`qa-fix` turns those labelled issues into reviewed merge requests.**

```
qa-explore  →  files issue per confirmed finding
human       →  adds the fix label to the genuine bugs        ← the triage gate
qa-fix Fix  →  per labelled issue, in an isolated worktree:
               reproduce → write RED regression test (run against the CHANGED code) → fix
               → test GREEN + suite green → push branch → open MR ("Closes #iid")
qa-fix Verify → an INDEPENDENT skeptic checks out the branch: audits the test, confirms
               red-without-fix / green-with-fix, reproduces the bug is gone, reviews the diff
               → comments its verdict on the MR (qa::fix-verified | qa::fix-doubt)
human       →  reviews & merges the MR                        ← the merge gate
```

Two human gates, both lightweight, both in the tracker: **which bugs get fixed** (the label) and **what actually ships** (the merge). qa-fix never merges and never touches an unlabelled issue. The fix is checked **twice**: deterministically (its own regression test + suite) *and* by an independent agent (the Verify-fix pass) — the same adversarial idea as explore→verify, now for fixes.

## Engine (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-fix/engine/qa-fix.workflow.js`

(If `$CLAUDE_PLUGIN_ROOT` is unset, the skill is at `~/.claude/skills/qa-fix` — resolve the engine path relative to this SKILL.md.)

## Prerequisites
- A `qa.config.json` with a `tracker` block (`type` = `gitlab` | `github`, `host`, `project`, `tokenEnv`, `fixLabel`, `fixingLabel`, `defaultBranch`) and a `fix` block. Same file `qa-explore` uses.
- The token: a Personal Access Token with `api` scope (GitLab) exported in the env var named by `tracker.tokenEnv` (e.g. `GITLAB_TOKEN`). Confirm it is set before running — never inline or echo it.
- **Run this skill from inside the target project's git repo** — each agent works in a git worktree of the current repo, and pushes a branch to its `origin`. Push access (SSH/PAT) must already work.
- **`fix.buildTest`** (a code-level test command) and/or **`fix.localRun`** (how to build + serve the fixed app locally) so the regression test runs against the **changed code**, not the stale live app. Without either, the agent falls back to building/serving from the worktree itself — slower and less reliable. See the Notes.

## How to run

1. **Resolve config.** Load `qa.config.json` (cwd or its E2E dir). Read the `tracker` block. If `tracker.type` is `none`/missing, stop and tell the user to configure the tracker first (point at `qa.config.example.jsonc`).

2. **Confirm the token is present** (`[ -n "$GITLAB_TOKEN" ]` or the configured env var) without printing it. If absent, ask the user to export it and stop.

3. **Confirm scope with the user before any push.** Pushing branches and opening MRs is an outward action. State how many issues carry the fix label and that running will open that many MRs against `defaultBranch`. Proceed only on an explicit go-ahead (this run *is* the per-operation push authorization). Pass `maxFixes` if the user wants to cap a first run.

4. **Run the engine.** `Workflow({ scriptPath: "<engine>/qa-fix.workflow.js", args: { ...config } })`. It:
   - **Select**: lists open issues with `fixLabel`, skipping any already tagged `fixingLabel` or already linked to an MR.
   - **Fix** (one isolated-worktree agent per issue): claims the issue (adds `fixingLabel` + a comment), understands the bug, writes a **red** regression test that asserts the correct behaviour **and runs against the changed code** (code-level preferred; E2E only against a local build of the worktree — never `baseUrl`, which serves the old code), fixes until **green**, runs the broader checks/suite, pushes `qa-fix/<iid>-<slug>`, opens an MR (`Closes #<iid>`), comments the link on the issue. Not safely auto-fixable → no bad MR: it comments why, drops `fixingLabel`, returns `skipped-unfixable`.
   - **Verify-fix** (independent skeptic, own worktree; skip with `fix.verify: false`): checks out the MR branch and re-verifies — test honesty, that it is **red without** the production change and **green with** it, that the original repro is **gone**, and the diff has no obvious side-effects. Posts a ✅/⚠️ verdict comment and labels the MR `qa::fix-verified` or `qa::fix-doubt`.

5. **Report back.** Summarize per issue: MR opened (link + regression test + the **verify verdict**), skipped-as-unfixable (with reasoning), or failed. Flag any MR that came back `fix-doubt` so the human looks harder. Remind the user the MRs are theirs to review and merge.

## Branch strategy
- **`per-issue` (default, recommended): one branch + one MR per bug.** Atomic and independently reviewable — you merge the good ones and reject the bad ones separately, and each MR carries exactly the regression test for its bug. This is *not* an MR flood: volume is bounded by the human `fixLabel` gate (only labelled issues get fixed) plus `maxFixes` per run. Label 3 → get 3 MRs.
- **`batched`: one branch + one MR for the whole run** (separate commits per bug). Only for piles of small, related fixes where N tiny MRs would be more annoying to review than one. Set `fix.fixStrategy: "batched"`.

## Notes
- **Tests run against the CHANGED code, never `baseUrl`.** The live app serves the *old* deployed code until you redeploy, so it can't prove a fix. The regression test must execute against the worktree: a **code-level** unit/integration test (`fix.buildTest`) sees the fix directly and is preferred; an **E2E** test only proves anything when pointed at a **local build** of the worktree (`fix.localRun`). Both the fixer and the independent verifier enforce this.
- **The regression test is the contract, checked twice.** Its definition of done: red before the fix, green after, suite still green — *and* an independent agent re-confirms that (test honesty + red-without/green-with + bug-gone + diff review) before you see the MR. The MR carries both the proof and the second opinion, and the test joins Step 0 for the next `qa-explore` run.
- **Never weaken a test to force green, never merge, never fix outside the labelled issue's scope.** Smallest correct change, repo conventions, CLAUDE.md respected.
- Cadence: on demand for now (`/qa-fix` after triaging the tracker). A scheduled/CI variant is on the roadmap (Claude Agent SDK standalone runner).
