# qa-explore runner (standalone / CI)

Run the qa-explore engines **headless** — no interactive Claude Code session — so they work in CI / on a PR. It runs the *exact same* `skills/*/engine/*.workflow.js` files the Claude Code plugin uses, via a thin runtime shim over the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). One engine, two runtimes.

> Status: **v0.3 (dev)**. The runtime shim, CLI and `--dry-run` are validated by `node --test`; the live agent path (real Agent SDK, text + structured) by `npm run smoke`. See Auth.

## Install & run locally

```bash
cd runner && npm install
# point at any qa.config.json; --base overrides its baseUrl
node bin/qa-explore.mjs explore --config ../path/to/qa.config.json --base http://localhost:3000

# see the plan without spending a token / calling the model:
node bin/qa-explore.mjs explore --config ./qa.config.json --dry-run
```

`<skill>` = `explore` · `report` · `codify` · `fix` · `heal`. Flags: `--config <path>` `--base <url>` `--mode <explore|no-delete|read-only>` `--model <id>` `--concurrency N` `--dry-run`.

## Auth — uses your subscription

The Agent SDK launches Claude Code under the hood and **inherits its credentials**:

- **Locally**, on a machine logged into Claude Code, it just runs on your **subscription** — no API key.
- **In CI** (no interactive login), provide a credential as a secret. The subscription-friendly way: run `claude setup-token` once on your machine → it prints a long-lived `CLAUDE_CODE_OAUTH_TOKEN` (tied to your plan) → store it as a GitHub secret. An `ANTHROPIC_API_KEY` (pay-per-token) is the alternative.

## GitHub Action

```yaml
# .github/workflows/qa.yml
name: qa-explore
on: pull_request
jobs:
  qa:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: victoraguilarsantamariadev/qa-explore/runner@v0     # this composite action
        with:
          base-url: https://staging.example.com        # your deployed pre-prod / preview URL
          mode: read-only                               # SAFE default in CI — never writes to the target
          claude-token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

The action installs the runner + Chromium, runs the skill, and uploads `qa-explore-result.json` + the evidence dir as a build artifact. `mode: read-only` is the safe default for CI; switch to `explore`/`no-delete` only against a throwaway/seeded environment.

Pinned to the `v0` tag. Ready-to-copy workflows live in [`examples/`](../examples): `github-actions.yml` and **`gitlab-ci.yml`** (GitLab has no marketplace action — the job clones this repo and runs the runner directly, using a `CLAUDE_CODE_OAUTH_TOKEN` CI/CD variable).

## GitLab CI

GitLab can't consume a GitHub composite action, so run the runner from a script step — see [`examples/gitlab-ci.yml`](../examples/gitlab-ci.yml). It uses the official Playwright image (Chromium preinstalled), clones the runner, and runs `explore --mode read-only`, reading `CLAUDE_CODE_OAUTH_TOKEN` from a masked CI/CD variable.

## Tests

```bash
cd runner && node --test       # offline: shim + engine load + stubbed agent (no tokens)
cd runner && npm run smoke      # live: real Agent SDK, text + structured (costs a few tokens)
```

`node --test` covers the runtime shim (pipeline/parallel/phase/log), that the real engine files load and run on the shim with a stubbed agent, and that disabled-tracker short-circuits. `npm run smoke` exercises the live agent path end-to-end (no browser/target) to confirm the SDK wiring works headless.

## Roadmap

- Post findings as an inline PR comment (today: uploaded as an artifact + filed as tracker issues via the `report` skill).
- Reusable workflow + a `qa-explore init` wizard.
