// qa-fix — FIX engine (second half of the qa-explore loop): pick up tracker issues a human has
// marked as real bugs, fix them in an isolated worktree, prove the fix with a regression test, and
// open a merge request for human review. NOTHING is ever merged automatically.
//
// Invoked by the /qa-fix skill via Workflow({ scriptPath, args }) FROM INSIDE the target project repo
// (so each agent's worktree is a worktree of that repo). args = {
//   tracker: { type, host, project, tokenEnv, fixLabel, fixingLabel, defaultBranch, assignees },
//   baseUrl, appPath, login,        // baseUrl runs the OLD deployed code — used only to UNDERSTAND the repro
//   e2eDir, framework,              // where the regression test goes / "playwright" | "cypress"
//   fix: {                          // how the fixing half runs (see qa.config.example.jsonc)
//     fixStrategy, maxFixes,        //   "per-issue" | "batched"; cap per run
//     buildTest,                    //   code-level check that COMPILES the changed code (e.g. "./mvnw -q test -pl adapter")
//     localRun: { command, url },   //   optional: build+serve the FIXED app locally so E2E tests/repros see the fix
//     verify,                       //   default true: an independent agent re-verifies each fix and comments the MR
//   },
// }
export const meta = {
  name: 'qa-fix',
  description: 'Read the issues a human marked with the fix label, and for each one: reproduce it, write a regression test (run against the CHANGED code, not the stale live app), fix the code until that test goes green and the suite stays green, push a branch and open a merge request, then have an INDEPENDENT skeptic agent re-verify the fix and comment its verdict on the MR. Each agent works in its own git worktree; merges are always left to a human.',
  phases: [
    { title: 'Select', detail: 'list issues a human labelled as confirmed bugs (skip ones already in progress / with an MR)' },
    { title: 'Fix', detail: 'one isolated-worktree agent per issue: reproduce, regression-test, fix, push branch, open MR' },
    { title: 'Verify-fix', detail: 'an independent agent checks out the branch, audits the test, confirms red->green, reproduces the bug is gone, reviews the diff' },
  ],
}

const cfg = args || {}
const tracker = cfg.tracker || {}
const fix = cfg.fix || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const FW = cfg.framework || 'playwright'
const E2E = cfg.e2eDir || 'the project E2E directory'
const TARGET = tracker.defaultBranch || 'develop'
const MAX = fix.maxFixes || cfg.maxFixes || tracker.maxFixes || 5
const STRATEGY = fix.fixStrategy || cfg.fixStrategy || tracker.fixStrategy || 'per-issue'   // "per-issue" (atomic MR each) | "batched" (one MR per run)
const BUILDTEST = fix.buildTest || cfg.buildTest || ''
const LOCALRUN = fix.localRun || {}
const VERIFY = fix.verify !== false   // default ON
const TOK = tracker.tokenEnv || 'GITLAB_TOKEN'

if (tracker.type !== 'gitlab' && tracker.type !== 'github') {
  log('qa-fix: tracker.type="' + tracker.type + '" no soportado (usa "gitlab" o "github").')
  return { fixes: [], summary: 'tracker disabled/unsupported' }
}
const isGitlab = tracker.type === 'gitlab'

// The single most important correctness rule: tests/repros must observe the FIX, which lives in the
// worktree — never the stale app at baseUrl. Handed to both the fixer and the verifier.
const changedCodeRule = [
  '⚠️ RUN AGAINST THE CHANGED CODE — NOT ' + BASE + '. The live app at ' + BASE + ' runs the OLD deployed code and will NOT reflect the fix; only use it to UNDERSTAND the repro. Anything that must OBSERVE the fix has to execute against the worktree code:',
  '  (a) PREFER a code-level test (unit/integration' + (BUILDTEST ? ', e.g. `' + BUILDTEST + '`' : '') + ') that compiles the changed code and sees the fix directly — most reliable.',
  '  (b) If only a browser/E2E test can express the bug, BUILD AND RUN the app locally from the worktree' + (LOCALRUN.command ? ' using: `' + LOCALRUN.command + '`' + (LOCALRUN.url ? ' (serves at ' + LOCALRUN.url + ')' : '') : ' (build + serve it yourself)') + ' and point the test/repro at THAT local instance' + (LOCALRUN.url ? ' (' + LOCALRUN.url + ')' : '') + ', never at ' + BASE + '. Tear it down when done.',
].join('\n')

// ---------- shared API cheat-sheet handed to every agent ----------
const api = isGitlab
  ? [
      'TRACKER = GitLab. API base: ' + (tracker.host || 'https://gitlab.com') + '/api/v4 . Project "' + tracker.project + '" -> URL-encode "/" as %2F for the path segment.',
      'Auth header on EVERY call: --header "PRIVATE-TOKEN: $' + TOK + '"  (token is in that env var; never print it).',
    ].join('\n')
  : [
      'TRACKER = GitHub. Use the authenticated gh CLI against repo "' + tracker.project + '".',
    ].join('\n')

const SELECT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          iid: { type: 'number', description: 'issue number (GitLab iid / GitHub number)' },
          title: { type: 'string' },
          body: { type: 'string', description: 'full issue description incl. repro + evidence + fingerprint' },
          url: { type: 'string' },
        },
        required: ['iid', 'title', 'body'],
      },
    },
  },
  required: ['issues'],
}

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    iid: { type: 'number' },
    status: { type: 'string', enum: ['mr-opened', 'skipped-unfixable', 'failed'] },
    branch: { type: 'string' },
    mrUrl: { type: 'string' },
    testFile: { type: 'string', description: 'the regression test written' },
    testStatus: { type: 'string', enum: ['red-then-green', 'still-red', 'not-written', 'n/a'] },
    suiteStatus: { type: 'string', description: 'result of the broader test/build run' },
    summary: { type: 'string', description: 'what was changed, or why it was skipped' },
  },
  required: ['iid', 'status', 'summary'],
}

// ---------- Phase 1: select the human-approved issues ----------
phase('Select')
const selectPrompt = [
  'You list the issues that a HUMAN has greenlit for auto-fixing. Be conservative — only return issues that clearly qualify.',
  api,
  '',
  isGitlab
    ? 'List open issues that carry the label "' + (tracker.fixLabel || 'qa::confirmed') + '":\n' +
      '  curl -sf --header "PRIVATE-TOKEN: $' + TOK + '" "<base>/api/v4/projects/<ENC_PROJECT>/issues?state=opened&labels=' + encodeURIComponent(tracker.fixLabel || 'qa::confirmed') + '&per_page=100"\n' +
      'EXCLUDE any issue that also has the "' + (tracker.fixingLabel || 'qa::fixing') + '" label (already being worked) or that already has a linked merge request (check the issue\'s related MRs endpoint: <base>/api/v4/projects/<ENC_PROJECT>/issues/<iid>/related_merge_requests ).'
    : 'List open issues labelled "' + (tracker.fixLabel || 'qa::confirmed') + '":  gh issue list --repo ' + tracker.project + ' --state open --label "' + (tracker.fixLabel || 'qa::confirmed') + '" --json number,title,body,url . Exclude any that already have a linked PR.',
  '',
  'Return up to ' + MAX + ' issues, each with iid/number, title, the FULL body (we need the repro + evidence + the <!-- qa-fp --> marker), and the url. If none qualify, return an empty list.',
].join('\n')
const selected = await agent(selectPrompt, { label: 'select-issues', phase: 'Select', schema: SELECT_SCHEMA, agentType: 'general-purpose' })
let issues = (selected && selected.issues) || []
if (issues.length > MAX) issues = issues.slice(0, MAX)
if (issues.length === 0) {
  log('qa-fix: no hay issues marcadas con "' + (tracker.fixLabel || 'qa::confirmed') + '" pendientes de arreglar.')
  return { fixes: [], summary: 'no approved issues to fix' }
}
log('qa-fix: ' + issues.length + ' issue(s) aprobada(s) → un agente por issue (worktree aislado): ' + issues.map((i) => '#' + i.iid).join(', '))

// ---------- Phase 2: one fixer per issue, isolated worktree ----------
function fixerPrompt(issue) {
  return [
    'You are a senior engineer fixing ONE confirmed bug end-to-end and opening a merge request for human review. You work in an ISOLATED git worktree of this project — your changes do not touch anyone else\'s. You NEVER merge; a human reviews and merges the MR.',
    '',
    'APP (only to UNDERSTAND the repro — it runs OLD code): ' + BASE,
    'LOGIN RECIPE:\n' + (cfg.login || '(open app / discover login)'),
    api,
    '',
    changedCodeRule,
    '',
    '=== ISSUE #' + issue.iid + ': ' + issue.title + ' ===',
    issue.body || '',
    '',
    'DO THIS IN ORDER:',
    '1. CLAIM IT: add the label "' + (tracker.fixingLabel || 'qa::fixing') + '" to the issue and post a short comment that qa-fix is starting (' + (isGitlab
      ? 'PUT <base>/api/v4/projects/<ENC>/issues/' + issue.iid + ' with add_labels=' + (tracker.fixingLabel || 'qa::fixing') + ' ; POST .../issues/' + issue.iid + '/notes for the comment'
      : 'gh issue edit ' + issue.iid + ' --add-label "' + (tracker.fixingLabel || 'qa::fixing') + '"; gh issue comment ' + issue.iid) + '). If you bail out later, REMOVE that label again.',
    '2. UNDERSTAND the bug from the repro steps + linked evidence/trace (you may observe it on ' + BASE + ', but remember that is the OLD code). Find the real root cause — do not guess.',
    '3. WRITE A REGRESSION TEST that asserts the EXPECTED/correct behaviour and RUNS AGAINST THE CHANGED CODE per the rule above (code-level test preferred; E2E only against a local build of the worktree). Put it in ' + E2E + ' or the matching unit/integration test location, matching the neighbouring tests\' style. Confirm it is RED right now (before your fix) and fails for the RIGHT reason (the assertion), not a broken selector/login/setup.',
    '4. FIX THE CODE (smallest correct change; follow the repo conventions and any CLAUDE.md). Re-run the regression test against the changed code until it is GREEN.',
    '5. GUARD AGAINST REGRESSIONS: run the broader checks so you do not break anything' + (BUILDTEST ? ' (project check: `' + BUILDTEST + '`)' : '') + ' and, if an E2E suite exists in ' + E2E + ', run it (against the local build, not ' + BASE + '). Report the result. If your change breaks something else, fix that too or scope down.',
    '6. OPEN THE MR: create a branch "qa-fix/' + issue.iid + '-<short-slug>" off ' + TARGET + ', commit (fix + the new test) with a message referencing the issue, push the branch, and open a merge request targeting "' + TARGET + '". ' +
      (isGitlab
        ? 'POST <base>/api/v4/projects/<ENC>/merge_requests with source_branch, target_branch="' + TARGET + '", title="Fix #' + issue.iid + ': ...", description including "Closes #' + issue.iid + '" and what you changed' + (tracker.assignees && tracker.assignees.length ? ', and assign the reviewers' : '') + ', remove_source_branch=true.'
        : 'Use: git push -u origin <branch>; then gh pr create --base ' + TARGET + ' --title "Fix #' + issue.iid + ': ..." --body "Closes #' + issue.iid + ' ...".') +
      ' Then comment the MR link on the issue and REPLACE the "' + (tracker.fixingLabel || 'qa::fixing') + '" label with nothing (leave the human gate label as-is).',
    '',
    'IF YOU CANNOT SAFELY FIX IT (needs a product/design decision, root cause unclear, or the fix is too risky to do blind): do NOT force a bad MR. Post a comment on the issue explaining what you found and what blocks an automatic fix, remove the "' + (tracker.fixingLabel || 'qa::fixing') + '" label, and return status "skipped-unfixable". A weak or speculative fix is worse than none.',
    '',
    'Never weaken the regression test to make it pass. Never merge. Return ONLY the structured object.',
  ].join('\n')
}

function batchedPrompt(list) {
  return [
    'You are a senior engineer fixing SEVERAL confirmed bugs in ONE pass and opening a SINGLE merge request for human review. You work in an ISOLATED git worktree of this project. You NEVER merge.',
    '',
    'APP (only to UNDERSTAND the repros — it runs OLD code): ' + BASE,
    'LOGIN RECIPE:\n' + (cfg.login || '(open app / discover login)'),
    api,
    '',
    changedCodeRule,
    '',
    'Work on ONE branch "qa-fix/batch-' + list.length + 'fixes-<short-slug>" off ' + TARGET + '. For EACH issue below, in order: claim it (add "' + (tracker.fixingLabel || 'qa::fixing') + '" + a comment), understand it, write a RED regression test asserting the correct behaviour AND running against the changed code (per the rule above), fix the code until it is GREEN. Keep unrelated issues independent in separate commits so a reviewer can follow them.',
    'After all are done, run the broader checks once' + (BUILDTEST ? ' (`' + BUILDTEST + '`)' : '') + ' + the E2E suite if present (against a local build, not ' + BASE + '); everything must be green. Then push the branch and open ONE merge request targeting "' + TARGET + '" whose description lists each fix and includes a "Closes #<iid>" line for EVERY issue. Comment the MR link on each issue and drop the "' + (tracker.fixingLabel || 'qa::fixing') + '" label from each.',
    'If a specific issue is NOT safely fixable, skip just that one (comment why on it, drop its fixing label, exclude it from the MR) and keep going with the rest. A weak/speculative fix is worse than none, and never weaken a test to force green.',
    '',
    'ISSUES (' + list.length + '):',
    list.map((it) => '--- #' + it.iid + ': ' + it.title + ' ---\n' + (it.body || '')).join('\n\n'),
    '',
    'Return ONLY the structured object: a "fixes" array with one entry per issue (its iid, status, the shared branch/mrUrl, its regression test, summary).',
  ].join('\n')
}

// ---------- Phase 3: independent skeptic re-verifies each fix (adversarial, like explore->verify) ----------
const VERIFY_FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    iid: { type: 'number' },
    verdict: { type: 'string', enum: ['fix-verified', 'fix-doubt', 'test-weak', 'not-fixed', 'failed'] },
    testHonest: { type: 'boolean', description: 'the regression test asserts the CORRECT behaviour and is specific (not a tautology)' },
    redWithoutFix: { type: 'boolean', description: 'the test genuinely FAILS when the production-code change is reverted' },
    greenWithFix: { type: 'boolean', description: 'the test passes with the full branch, against the changed code' },
    bugGone: { type: 'boolean', description: 'the original repro no longer reproduces against the changed code' },
    sideEffects: { type: 'string', description: 'any regressions/side-effects spotted in the diff or suite' },
    commentedOnMr: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['iid', 'verdict', 'notes'],
}

function verifyFixPrompt(issue, f) {
  const br = f.branch || '<the MR source branch>'
  return [
    'You are an INDEPENDENT skeptic reviewing a fix ANOTHER agent produced for a confirmed bug. You did NOT write it. Default to doubt. Catch a weak/tautological test, a fix that does not actually resolve the bug, or a regression — BEFORE a human reviews the MR.',
    '',
    'You work in your OWN isolated git worktree. Get the proposed changes: `git fetch origin ' + br + ' && git checkout ' + br + '`  (branch: ' + br + ' · MR: ' + (f.mrUrl || '?') + ').',
    api,
    '',
    changedCodeRule,
    '',
    '=== ISSUE #' + issue.iid + ': ' + (issue.title || '') + ' ===',
    issue.body || '',
    'Regression test the fixer claims it added: ' + (f.testFile || '(find it in the diff)') + '. Fixer notes: ' + (f.summary || ''),
    '',
    'CHECK, independently, against the CHANGED code:',
    '1. TEST HONESTY: read the regression test + the diff (`git diff ' + TARGET + '...HEAD`). Does the test assert the CORRECT behaviour (not the buggy one), is it specific (not always-green), and does it exercise the fixed path?',
    '2. RED WITHOUT THE FIX: revert ONLY the production-code change but KEEP the test (e.g. stash/checkout just the non-test files onto ' + TARGET + '), run the test → it MUST FAIL. Restore afterwards. If it still passes without the fix, the test proves nothing → verdict "test-weak".',
    '3. GREEN WITH THE FIX: on the full branch, run the test → it MUST PASS.',
    '4. BUG ACTUALLY GONE: re-run the ORIGINAL repro against the changed code (code-level, or a local build per the rule — NEVER ' + BASE + ') → the bug must be gone. If not → "not-fixed".',
    '5. NO COLLATERAL DAMAGE: run ' + (BUILDTEST ? '`' + BUILDTEST + '`' : 'the project checks') + ' + the relevant suite; scan the diff for side-effects.',
    '',
    'POST your verdict as a comment on the MR (' + (isGitlab ? 'POST <base>/api/v4/projects/<ENC>/merge_requests/<mr_iid>/notes' : 'gh pr comment <mr>') + '): a short ✅/⚠️ summary of checks 1–5 and your conclusion. ' + (isGitlab ? 'Add label "qa::fix-verified" to the MR if ALL pass, otherwise "qa::fix-doubt".' : 'Prefix the comment with [qa fix-verified] or [qa fix-doubt].') + ' Do NOT merge and do NOT modify the fix — you only review.',
    '',
    'Return ONLY the structured object with your verdict.',
  ].join('\n')
}

function verifyOne(issue, f) {
  return agent(verifyFixPrompt(issue, f), {
    label: 'verify-fix:#' + issue.iid, phase: 'Verify-fix', schema: VERIFY_FIX_SCHEMA, agentType: 'general-purpose', isolation: 'worktree',
  }).then((v) => ({ ...f, verdict: v || null }))
}

let clean
if (STRATEGY === 'batched') {
  log('qa-fix: estrategia "batched" → un solo MR con ' + issues.length + ' fix(es).')
  const BATCH_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { fixes: { type: 'array', items: FIX_SCHEMA } },
    required: ['fixes'],
  }
  const res = await agent(batchedPrompt(issues), {
    label: 'fix:batch', phase: 'Fix', schema: BATCH_SCHEMA, agentType: 'general-purpose', isolation: 'worktree',
  })
  const fixes = ((res && res.fixes) || []).filter(Boolean)
  clean = VERIFY
    ? (await parallel(fixes.map((f) => () =>
        f.status === 'mr-opened'
          ? verifyOne(issues.find((i) => i.iid === f.iid) || { iid: f.iid }, f)
          : Promise.resolve({ ...f, verdict: null })
      ))).filter(Boolean)
    : fixes
} else {
  // pipeline: each fix is verified by an independent skeptic as soon as it is produced
  const results = await pipeline(
    issues,
    (issue) => agent(fixerPrompt(issue), { label: 'fix:#' + issue.iid, phase: 'Fix', schema: FIX_SCHEMA, agentType: 'general-purpose', isolation: 'worktree' }),
    (f, issue) => {
      if (!f) return null
      if (!VERIFY || f.status !== 'mr-opened') return { ...f, verdict: null }
      return verifyOne(issue, f)
    }
  )
  clean = results.filter(Boolean)
}

const opened = clean.filter((f) => f.status === 'mr-opened').length
const skipped = clean.filter((f) => f.status === 'skipped-unfixable').length
const failed = clean.filter((f) => f.status === 'failed').length
const verified = clean.filter((f) => f.verdict && f.verdict.verdict === 'fix-verified').length
const doubt = clean.filter((f) => f.verdict && f.verdict.verdict && f.verdict.verdict !== 'fix-verified').length
log('qa-fix terminado: ' + opened + ' MR abiertas (' + verified + ' verificadas, ' + doubt + ' con dudas), ' + skipped + ' saltadas, ' + failed + ' fallidas.')
return { fixes: clean, summary: opened + ' MR opened (' + verified + ' verified / ' + doubt + ' doubt) / ' + skipped + ' skipped / ' + failed + ' failed' }
