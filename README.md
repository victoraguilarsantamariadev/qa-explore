# qa-explore

**A team of AI agents that test your web app like a human QA team — then write the tests for you.**

They open the live app, click through everything, fill forms, submit, **screenshot every step and visually judge** whether it renders right and the data makes sense, capture **trace / HAR / console / video** evidence, **adversarially verify** each finding to kill false positives, **learn** from the ones you reject, and finally **codify** confirmed bugs and working flows into a real Playwright/Cypress suite that **grows itself**.

> Distributed as a [Claude Code](https://claude.com/claude-code) plugin. Requires Claude Code.

## The loop

```
Step 0  RUN EXISTING SUITE (deterministic, full, cheap)  — your regression net; skipped on a cold project
1. EXPLORE  one agent per area: navigate, create, fill, submit, screenshot, judge, capture evidence
2. VERIFY   independent skeptics re-run each serious finding (flaky / false-positive killer)
3. TRIAGE   you approve which findings are real      (human gate — and the harness LEARNS from rejections)
4. CODIFY   write + self-validate specs:  RED regression test per bug,  GREEN smoke per working flow
            → those specs become Step 0 next run. The suite compounds.
```

- **Cold start (no tests yet):** Step 0 is empty and skipped — agents explore first, then write the *first* suite. (Writing tests blind from source gives brittle, stale-selector tests; exploration is what makes good tests possible.)
- **Warm:** Step 0 runs the accumulated suite cheaply (catches regressions even in untouched areas), agents hunt only for what's **new**, the suite grows.

## What makes it different from "a bot that clicks"

- **Adversarial verification** — every serious finding is re-run by an independent skeptic before you ever see it.
- **Auto-learning** — when you reject a finding as not-a-bug, the reason is appended to the project's `domainNotes`, so the same false positive is never raised again. The harness gets smarter per project.
- **Real evidence** — Playwright trace.zip, network HAR, console log and video per finding. Reproducing is one click in the trace viewer.
- **It closes the loop** — confirmed bugs become failing regression tests; working flows become passing smoke tests. Self-validated (run once) before they're kept.

## Install (Claude Code)

```
/plugin marketplace add <your-gh-user>/qa-explore
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

## Cost & scope

A full exploration is token-heavy. Keep your best model everywhere and control cost by **scope**, not quality:
- The deterministic suite (Step 0) carries the known ground for free.
- Run agents **diff-scoped** per PR (changed areas + dependents + uncovered areas); a **full crawl** nightly/weekly as backstop.
- One shared login session and cached recon cut the boilerplate.

## Roadmap

- v0.1 — Claude Code plugin (this).
- Next — a standalone runner (Claude Agent SDK) so it runs in CI / on PRs without an interactive session; GitHub-issue + SARIF reporters; a11y (axe) and multi-viewport passes.

## License

MIT
