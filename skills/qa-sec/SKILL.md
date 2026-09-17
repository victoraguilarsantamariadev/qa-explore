---
name: qa-sec
description: Defensive security review of a web app you own, driven by agents that operate the real app — audit headers, cookies, token handling and the JS bundle passively; hunt broken access control across roles (forced browsing, IDOR/BOLA, privilege escalation, session invalidation); and probe input handling and business-logic abuse with benign markers. Detection-first — it proves a hole exists and stops, never extracting data, persisting payloads or stress-testing. Use when asked to "check the security of the app", "look for vulnerabilities", "is this app safe", "audit access control / permissions", "find security holes before the client does", or to add a security pass to an existing qa-explore setup. Sibling of qa-explore; same engine, different question.
---

# qa-sec

qa-explore asks *is this broken?*. qa-sec asks *can someone abuse this?* — on an app **you own**, so you can fix it.

It is a **review, not an attack**: every pass finds a hole, proves it exists, and stops there.

## The passes

```
Surface          map what is actually exposed: inputs, ids, uploads, redirects, privileged actions
Passive          (always) headers/CSP/CORS · cookies + token lifecycle · secrets & source maps in the
                 bundle · leaky error pages · HIGH/CRITICAL dependency advisories
Access-control   (the expensive bugs) forced browsing · hidden-but-not-blocked actions · IDOR/BOLA on
                 ids · mass assignment · session/tenant boundaries — one agent per role
Input & logic    (safe-active only) reflection · injection error signals · traversal · open redirect ·
                 SSRF · upload type enforcement · server-side validation · BUSINESS-LOGIC abuse
Verify           an independent skeptic reproduces each serious finding, in both directions
```

Findings come out in the **same shape qa-explore produces**, so `/qa-gate` blocks on them (its `blockOnAccessControl` is on by default) and the report/fix loop works unchanged.

## Engine (invoke via the Workflow tool; do not inline)
- `${CLAUDE_PLUGIN_ROOT}/skills/qa-sec/engine/qa-sec.workflow.js`
- Config: reuses the project `qa.config.json` (baseUrl, login, **roles**, allowedHosts, shotsDir, domainNotes, e2eDir, sourceHints) plus a `security` block.

## Before it runs — the two gates

1. **`security.authorized` must be `true`, with `security.scope` naming the system and who authorised it.** Without it the engine returns immediately and does nothing. This is a live system: someone owns that decision, and the config is where it is recorded.
2. **Scope is `allowedHosts`** (defaults to the `baseUrl` host). Agents may not send a request anywhere else, follow a finding off-host, or touch another machine. A third-party host that turns up is recorded as out-of-scope, not probed.

Then, as with qa-explore: **state the resolved target, the intrusiveness and the scope, and get a go-ahead** before the run — louder if it looks like production.

## Intrusiveness

| `security.intrusiveness` | What it sends | Good for |
|---|---|---|
| `passive` *(default)* | nothing beyond normal use — it logs in, browses, and reads the headers, cookies, tokens, bundles and errors the app already serves | anything, any time, including production |
| `safe-active` | the above **plus** benign markers into inputs the app exposes and calls to endpoints the app itself calls, with altered parameters | staging / pre-prod, or production with the owner's explicit say-so |

Under **both**, these are hard rules the engine writes into every agent's prompt: stop at proof; never read real data beyond the one record that proves the exposure, redacted; never modify, delete, or plant anything that persists; no load/stress/timing attacks; login attempts capped (`security.maxLoginAttempts`, default 8) and only to check that lockout exists; no credentials other than the configured ones; benign markers only — no destructive SQL, no shell payloads.

## How to run

1. **Resolve config.** Read `qa.config.json` for the target, `login`, `allowedHosts`, `shotsDir`, `domainNotes` and `e2eDir`, plus the `security` block. Check `security.authorized` and `scope`; if they are missing, **ask the user to confirm they own this system and write it into the config** rather than passing the flag yourself.

1b. **Check the evidence dir.** `node <qa-explore engine>/evidence.mjs check <shotsDir>` — the HARs this run captures hold session tokens, and `shotsDir` must be on disk, not a tmpfs.

2. **Declare a second role.** The access-control pass is *much* stronger with two accounts (one lower-privileged): most of what it hunts is one user reaching another user's data. With a single role it still runs, but it says in its notes what it could not test. If the project has no second account, offer to have one created.

3. **Run.** `Workflow({ scriptPath: "<engine>/qa-sec.workflow.js", args: <config> })`. Returns one entry per pass, each with `checked` (including the clean results) and `findings`.

4. **Synthesize.** Write `<shotsDir>/INFORME-SEGURIDAD.md`: group by **proven + confirmed** first, then severity, then the hardening list. For each finding give the impact in one sentence, the redacted repro, and the fix. Keep the `checked` lists — *"CSRF is protected, SameSite=Lax + token on every mutation"* is as useful to the reader as a finding. Call out anything `proven: false` as what it is: a suspicion that needs a deeper look.

5. **Report — carefully.** If a `tracker` is configured, file security findings as **confidential** issues (GitLab `confidential: true`; GitHub: a private security advisory, or a private repo — never a public issue). **Never attach the HAR or storageState**: they contain live session tokens. Screenshots only, and only after checking them.

6. **Prune the evidence.** Same step as qa-explore (`evidence.mjs prune`), and it matters more here: the HARs hold tokens and possibly personal data. Keep only what a confirmed finding needs.

7. **LEARN.** A finding rejected as intentional goes into `security.knownAccepted` (with the reason) so the next run does not re-raise it — the security equivalent of `domainNotes`. An accepted risk is a decision, and it belongs in writing.

## Notes
- **Cadence:** `passive` on every release (it is cheap and catches regressions in headers/cookies/bundle); `safe-active` against staging before a release, or after a change to auth, permissions, uploads or payments.
- **It does not replace a pentest.** No authenticated fuzzing at depth, no chained exploitation, no infrastructure, no social engineering. It catches the flat, common, expensive things — the ones that are embarrassing to be told about by someone else.
- **Access control is the one to care about.** Headers and cookies are worth fixing but rarely the breach; one user reading another's data is. That is why it gets its own pass and why `/qa-gate` treats it as non-negotiable.
- **Dependencies are read from the repo, not the app** (`npm audit --omit=dev`, `osv-scanner`, `trivy`), and only HIGH/CRITICAL affecting shipped code.
