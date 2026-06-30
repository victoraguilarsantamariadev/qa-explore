# qa-explore

**A team of AI agents that test your web app like a human QA team — then write the tests for you.**

They open the live app, click through everything, fill forms, submit, **screenshot every step and visually judge** whether it renders right and the data makes sense, capture **trace / HAR / console / video** evidence, **adversarially verify** each finding to kill false positives, **learn** from the ones you reject, and finally **codify** confirmed bugs and working flows into a real Playwright/Cypress suite that **grows itself**.

> Distributed as a [Claude Code](https://claude.com/claude-code) plugin. Requires Claude Code.

## The loop

```
Step 0  RUN EXISTING SUITE (deterministic, full, cheap)  — your regression net; skipped on a cold project
1. EXPLORE  one agent per area: navigate, create, fill, submit, screenshot, judge, capture evidence
2. VERIFY   independent skeptics re-run each serious finding (flaky / false-positive killer)
3. REPORT   file each confirmed finding as a tracker issue (GitLab/GitHub) — idempotent, with embedded evidence
4. TRIAGE   a human labels the genuine bugs in the tracker  (the gate) — and the harness LEARNS from the rest
5. CODIFY   GREEN smoke per working flow → those specs become Step 0 next run. The suite compounds.
```

### …then it fixes them too — `/qa-fix`

```
qa-explore  →  files an issue per confirmed bug (screenshot + video + trace embedded)
   you      →  add the `qa::confirmed` label to the real ones            ← which bugs get fixed
qa-fix      →  per labelled issue, in an isolated git worktree:
               reproduce → write a RED regression test (run against the CHANGED code) → fix
               → test GREEN + suite green → push a branch → open a Merge Request ("Closes #iid")
   verify   →  an INDEPENDENT agent checks out the branch: audits the test, confirms red-without /
               green-with, reproduces the bug is gone, reviews the diff → verdict on the MR
   you      →  review & merge the MR                                     ← what actually ships
```

Every fix is checked **twice** — by its own regression test *and* by an independent skeptic agent — and the test runs against the **changed code**, not the stale live app. The MR carries the proof and the second opinion, and that test joins Step 0 so the bug can't come back silently. **Nothing is ever merged automatically; one MR per bug by default.**

### …and keeps the suite honest — `/qa-heal`

A red suite that's just *stale* gets ignored — which is how real regressions slip through. `qa-heal` triages every failing test:

```
behaviour still holds, selector/label/timing drifted   → REPAIR the test (the HOW) → green → MR
behaviour is gone / assertion no longer matches the app → REAL REGRESSION → leave red → file a bug
```

**Cardinal rule: heal the HOW (selectors, waits), never the WHAT (assertions).** Forcing green by weakening an assertion would hide a real bug, so qa-heal refuses — and an independent agent verifies the repair diff touched **no** assertion. Real regressions it surfaces flow straight into `/qa-fix`.

- **Cold start (no tests yet):** Step 0 is empty and skipped — agents explore first, then write the *first* suite. (Writing tests blind from source gives brittle, stale-selector tests; exploration is what makes good tests possible.)
- **Warm:** Step 0 runs the accumulated suite cheaply (catches regressions even in untouched areas), agents hunt only for what's **new**, the suite grows.

## What makes it different from "a bot that clicks"

- **Adversarial verification** — every serious finding is re-run by an independent skeptic before you ever see it.
- **Auto-learning** — when you reject a finding as not-a-bug, the reason is appended to the project's `domainNotes`, so the same false positive is never raised again. The harness gets smarter per project.
- **Real evidence** — Playwright trace.zip, network HAR, console log and video per finding. Reproducing is one click in the trace viewer.
- **It closes the loop** — confirmed bugs become failing regression tests; working flows become passing smoke tests. Self-validated (run once) before they're kept.

## Install (Claude Code)

```
/plugin marketplace add victoraguilarsantamariadev/qa-explore
/plugin install qa-explore@qa-explore
```

Then in any project:

```
/qa-explore
```

It looks for a `qa.config.json` (or helps you create one), runs the loop, and reports findings grouped by confidence and severity.

## Configure per project

Copy [`skills/qa-explore/qa.config.example.jsonc`](skills/qa-explore/qa.config.example.jsonc) to your project as `qa.config.json`. Key fields:

| field | meaning |
|---|---|
| `baseUrl` + `appPath` | where the app is served |
| `login` | prose login recipe (or `""` if open) |
| `e2eDir` / `framework` | where specs live / `playwright` \| `cypress` |
| `areas` | omit to auto-discover (recon); cached back after first run |
| `domainNotes` | **known-correct behaviour — the #1 false-positive lever; auto-grows from your triage rejections** |
| `viewports` | first = primary full pass; extras = responsive sweeps (e.g. `iPhone 13`) — **mobile + desktop** |
| `roles` | first = primary; each extra triggers an **access-control** pass (broken-authorization hunting) |
| `projectType` | `web-spa` / `web-ssr` (Chromium) · `electron` (desktop) · `api` / `cli` (HTTP/CLI, no browser) |
| `tracker` | optional — wire up the issue→fix→MR loop: `type` (`gitlab`/`github`/`none`), `host`, `project`, `tokenEnv` (PAT with `api` scope), `fixLabel`, `defaultBranch`, `attachEvidence` |
| `fix` | how `/qa-fix` runs: `fixStrategy`, `maxFixes`, `buildTest`, `localRun`, `verify` |

When `tracker.type` is `none` (default), the loop stops at chat triage — no issues are filed. Set it to `gitlab`/`github` and the REPORT step files issues; `/qa-fix` then turns the ones you label into merge requests.

## Coverage — sample vs exhaustive

| `coverage.mode` | What it does | When |
|---|---|---|
| `sample` *(default)* | one agent per functional area (≤ `maxAreas`) — a thorough, representative human-style pass | quick checks, per-PR diff scope |
| `exhaustive` | recon builds a full **inventory** (every route, entity, and enumerable variant — *every* widget type, etc.) → **one unit of work per item** (create each widget type, full CRUD per entity, visit each route) → a **completeness-critic loops** until no inventory gap remains | "test **absolutely everything**" |

`exhaustive` is how you get *every* widget created and *every* route visited rather than a sample. It costs more tokens — the lever is scope, never a smaller model — and anything dropped at the `maxUnits`/`maxRounds` cap is **logged, never silently skipped**. (True input-permutation exhaustiveness is infinite; this covers every *discrete feature* that exists and samples inputs within each.)

## ⚠️ Safety — what it does to your target

This isn't a static analyzer. It **drives a real browser as a real user against a live app**, so by default it behaves like one. `mode` is independent of the environment — pointing it at production and letting it write is your call; pick the dial that matches your risk:

| `mode` | What it does | Good for |
|---|---|---|
| `explore` *(default)* | navigate + **create / edit / submit / delete** (prefixed `qa-…`, best-effort cleanup) | localhost, staging, pre-prod |
| `no-delete` | write (create / edit / submit) but **never delete** | a sensitive / production target you still want to exercise writes on |
| `read-only` | navigate, screenshot, judge — **zero writes** | a visual + data-sense smoke against real production |

- **`allowedHosts`** confines the run to the target host(s) (defaults to the `baseUrl` host). The agents never follow links/redirects off-host and never scan other machines — they run with your machine's network access but only go where you point them.
- For any **write** run against production, use a **dedicated QA account with segregated data**, and the harness still avoids anything that looks real / pre-existing.

It works the same on `localhost` and on a deployed pre-prod IP; the only thing that changes per environment is the config (`baseUrl`, `login`, `mode`).

## Cost & scope

A full exploration is token-heavy. Keep your best model everywhere and control cost by **scope**, not quality:
- The deterministic suite (Step 0) carries the known ground for free.
- Run agents **diff-scoped** per PR (changed areas + dependents + uncovered areas); a **full crawl** nightly/weekly as backstop.
- One shared login session and cached recon cut the boilerplate.

## Roadmap

- v0.1 — Claude Code plugin: explore → verify → triage → codify.
- v0.2 — **the full loop (this):** GitLab/GitHub issue reporter with embedded evidence; `/qa-fix` (labelled issue → isolated-worktree fix → regression test → independent verify → MR); `/qa-heal` (self-healing suite); multi-viewport (mobile/desktop), multi-role + access-control, project-type switch (web / electron / API / CLI); safe modes + host confinement.
- v0.3 — a **standalone runner** (`runner/`, Claude Agent SDK) + **GitHub Action** (`runner@v0`) **and a GitLab CI job** so it runs in CI / on PRs without an interactive session, on your subscription. Same engine via a runtime shim; shim + CLI validated (`node --test`), the live agent path by a live smoke (`npm run smoke`, real SDK). Copy-paste CI configs in [`examples/`](examples). Run it against a deployed preview with `CLAUDE_CODE_OAUTH_TOKEN`.
- Next — **visual regression** (screenshot diffing); **a11y (axe)** and **perf (Lighthouse)** passes; **Jira / Linear** reporters + SARIF; a `qa-explore init` wizard; inline PR-comment findings.

## License

MIT
