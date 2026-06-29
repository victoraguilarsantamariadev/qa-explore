// qa-heal — SELF-HEALING engine: when the deterministic suite (Step 0) goes red, decide per failing
// test whether it's a STALE/BRITTLE test (repair it) or a REAL REGRESSION (leave it red → it's a bug),
// repair the brittle ones on a branch and open ONE merge request, and hand back the real regressions
// so the skill files them as issues (which then flow into /qa-fix). NOTHING is ever merged automatically.
//
// THE CARDINAL RULE: heal the HOW (selectors / waits / locators / setup), NEVER the WHAT (assertions
// about behaviour). If a test can only go green by changing what it asserts, that is a real regression,
// not a stale selector — leave it red. Weakening an assertion to force green would HIDE a real bug.
//
// Invoked by the /qa-heal skill via Workflow({ scriptPath, args }) FROM INSIDE the target project repo.
// args = {
//   tracker, baseUrl, appPath, login, e2eDir, framework,
//   fix: { buildTest, ... },          // reused: how to run code-level tests
//   heal: { verify, maxHeal, suiteCommand },
//   failures: [ { testFile, testTitle, error } ],   // optional; if absent, a Collect agent runs the suite
// }
export const meta = {
  name: 'qa-heal',
  description: 'Self-healing test suite: triage each failing deterministic test into stale-selector (repair the HOW: selectors/waits, never the assertion) vs real regression (leave red → file as a bug). Repairs the brittle tests on a branch and opens ONE merge request; an independent agent confirms only selectors/waits changed (no assertion weakened); real regressions are returned to be filed as issues for /qa-fix.',
  phases: [
    { title: 'Collect', detail: 'run the suite and list the failing tests with their errors (skipped if failures are supplied)' },
    { title: 'Heal', detail: 'adjudicate each failure; repair brittle ones (selectors/waits only) on a branch, open a MR; flag real regressions' },
    { title: 'Verify-heal', detail: 'an independent agent confirms the diff touched only the HOW (no assertion changed) and the repaired tests pass' },
  ],
}

const cfg = args || {}
const tracker = cfg.tracker || {}
const fix = cfg.fix || {}
const heal = cfg.heal || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const FW = cfg.framework || 'playwright'
const E2E = cfg.e2eDir || 'the project E2E directory'
const TARGET = tracker.defaultBranch || 'develop'
const TOK = tracker.tokenEnv || 'GITLAB_TOKEN'
const BUILDTEST = fix.buildTest || cfg.buildTest || ''
const VERIFY = heal.verify !== false
const MAXHEAL = heal.maxHeal || 30
const SUITE_HINT = heal.suiteCommand || (FW === 'cypress' ? 'npx cypress run' : 'npx playwright test --reporter=json')
const isGitlab = tracker.type === 'gitlab'
const hasTracker = tracker.type === 'gitlab' || tracker.type === 'github'

const api = isGitlab
  ? 'TRACKER = GitLab. API base: ' + (tracker.host || 'https://gitlab.com') + '/api/v4 . Project "' + tracker.project + '" -> URL-encode "/" as %2F. Auth header on EVERY call: --header "PRIVATE-TOKEN: $' + TOK + '" (token in that env var; never print it).'
  : hasTracker
    ? 'TRACKER = GitHub. Use the authenticated gh CLI against repo "' + tracker.project + '".'
    : 'NO TRACKER configured: do not open a MR — instead commit the repairs to a local branch "qa-heal/<date-slug>" and report the branch name + the diff so the user can review/push it.'

// ---------- Phase 1: collect failing tests (skipped if supplied) ----------
const COLLECT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    failures: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          testFile: { type: 'string' },
          testTitle: { type: 'string' },
          error: { type: 'string', description: 'the failure message / assertion error / timeout' },
        },
        required: ['testFile', 'testTitle'],
      },
    },
  },
  required: ['failures'],
}

let failures = (cfg.failures && cfg.failures.length) ? cfg.failures : null
if (!failures) {
  phase('Collect')
  const collected = await agent(
    [
      'Run the project E2E/test suite once and return the list of FAILING tests (do not fix anything yet).',
      'Suite location: ' + E2E + ' (framework: ' + FW + '). Suggested command: `' + SUITE_HINT + '` — adjust to the project (read its config/package.json scripts first).',
      'Run it against the app at ' + BASE + ' if it is an E2E suite. Parse the reporter output and return each failing test with its file, full title, and the exact error (assertion message / timeout / selector-not-found).',
      'If nothing fails, return an empty list. Return ONLY the structured object.',
    ].join('\n'),
    { label: 'collect-failures', phase: 'Collect', schema: COLLECT_SCHEMA, agentType: 'general-purpose' }
  )
  failures = (collected && collected.failures) || []
}
if (failures.length > MAXHEAL) failures = failures.slice(0, MAXHEAL)
if (failures.length === 0) {
  log('qa-heal: la suite está verde — nada que sanar. 🎉')
  return { healed: [], regressions: [], mrUrl: null, summary: 'suite green' }
}
log('qa-heal: ' + failures.length + ' test(s) en rojo → adjudicar (selector caducado vs regresión real).')

// ---------- Phase 2: adjudicate + heal (one worktree agent, one MR for all repairs) ----------
const TEST_VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    testFile: { type: 'string' },
    testTitle: { type: 'string' },
    verdict: { type: 'string', enum: ['healed', 'real-regression', 'flaky-stabilized', 'could-not-heal'] },
    changeKind: { type: 'string', enum: ['selector', 'wait', 'locator', 'setup', 'none'], description: 'what was changed — MUST be a HOW, never an assertion' },
    assertionTouched: { type: 'boolean', description: 'true is a RED FLAG — a heal must never change what the test asserts' },
    regressionSummary: { type: 'string', description: 'if real-regression: what the app no longer does (becomes a bug issue)' },
    notes: { type: 'string' },
  },
  required: ['testFile', 'testTitle', 'verdict'],
}
const HEAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    branch: { type: 'string' },
    mrUrl: { type: 'string' },
    verdicts: { type: 'array', items: TEST_VERDICT },
    summary: { type: 'string' },
  },
  required: ['verdicts'],
}

const failBlock = failures
  .map((f, i) => (i + 1) + '. ' + (f.testFile || '?') + ' :: ' + (f.testTitle || '?') + '\n   error: ' + (f.error || '(rerun to capture)'))
  .join('\n')

const healResult = await agent(
  [
    'You maintain a test suite that has gone red. For EACH failing test, decide WHY it fails and act. You work in an ISOLATED git worktree. You NEVER merge.',
    '',
    'APP under test (the source of truth the tests must match): ' + BASE,
    'LOGIN RECIPE:\n' + (cfg.login || '(open app / discover login)'),
    'Suite: ' + E2E + ' (' + FW + '). ' + api,
    '',
    '🔒 THE CARDINAL RULE — heal the HOW, never the WHAT:',
    '  - You may change SELECTORS, LOCATORS, WAITS, and test SETUP to match the CURRENT app (these drift as the UI changes — that is a stale/brittle test).',
    '  - You must NEVER change, relax, or remove an ASSERTION about behaviour/data to make a test pass. If a test can only go green by altering what it ASSERTS, the test is RIGHT and the APP changed → that is a REAL REGRESSION (a bug), not a heal.',
    '',
    'FOR EACH failing test below:',
    '  a. Open the app and observe whether the behaviour the test ASSERTS still holds.',
    '  b. If the behaviour holds but the test fails on a stale selector / changed label / timing → REPAIR the test (robust selectors: role/text/test-id over brittle CSS; proper waits). Re-run it → must be GREEN now. verdict "healed", changeKind = what you changed, assertionTouched MUST be false.',
    '  c. If the behaviour is GONE/wrong (the assertion no longer matches the real app) → DO NOT touch the test. verdict "real-regression"; fill regressionSummary with what the app no longer does. This will be filed as a bug.',
    '  d. If it passes on re-run (flaky) → stabilize with a proper wait/condition (no assertion change). verdict "flaky-stabilized".',
    '  e. If you genuinely cannot tell or repair safely → verdict "could-not-heal" with notes.',
    '',
    'AFTER adjudicating all: if you repaired ANY test, put all repairs on ONE branch "qa-heal/' + failures.length + 'tests-<short-slug>" off ' + TARGET + ', commit (message: "qa-heal: repair stale tests"), ' +
      (hasTracker
        ? 'push it and open ONE merge request targeting "' + TARGET + '" that lists each repaired test and EXACTLY what HOW-level change you made (so a reviewer can confirm no assertion moved). ' + (isGitlab ? 'POST <base>/api/v4/projects/<ENC>/merge_requests.' : 'gh pr create --base ' + TARGET + '.')
        : 'leave it as a local branch and report its name + the diff.') +
      ' Do NOT include the real-regression tests in the MR (leave them red).',
    'Never weaken an assertion. Never merge. Return ONLY the structured object with one verdict per test (+ branch/mrUrl if you opened one).',
    '',
    'FAILING TESTS (' + failures.length + '):',
    failBlock,
  ].join('\n'),
  { label: 'heal', phase: 'Heal', schema: HEAL_SCHEMA, agentType: 'general-purpose', isolation: 'worktree' }
)

const verdicts = (healResult && healResult.verdicts) || []
const healed = verdicts.filter((v) => v.verdict === 'healed' || v.verdict === 'flaky-stabilized')
const regressions = verdicts.filter((v) => v.verdict === 'real-regression')
const flagged = verdicts.filter((v) => v.assertionTouched)   // red flags — a heal that touched an assertion
const mrUrl = healResult && healResult.mrUrl
log('qa-heal: ' + healed.length + ' reparado(s), ' + regressions.length + ' regresión(es) real(es) → a issue, ' + verdicts.filter((v) => v.verdict === 'could-not-heal').length + ' sin resolver.')
if (flagged.length) log('⚠️ qa-heal: ' + flagged.length + ' reparación(es) tocaron una ASERCIÓN — revísalas a mano, podrían ocultar un bug.')

// ---------- Phase 3: independent verify — the diff must be HOW-only ----------
let verify = null
if (VERIFY && mrUrl && healed.length) {
  phase('Verify-heal')
  const VERIFY_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      assertionsIntact: { type: 'boolean', description: 'true if the diff changed ONLY selectors/waits/locators/setup and NO assertion' },
      testsGreen: { type: 'boolean' },
      suspect: { type: 'array', items: { type: 'string' }, description: 'tests whose assertion looks altered/weakened' },
      notes: { type: 'string' },
    },
    required: ['assertionsIntact', 'testsGreen', 'notes'],
  }
  verify = await agent(
    [
      'You are an INDEPENDENT reviewer of a self-healing test MR. You did NOT write it. Your ONE job: make sure the repairs did NOT weaken or change any ASSERTION (which would hide a real bug).',
      'Check out the branch (' + (healResult.branch || '<branch>') + ') in your own worktree. ' + api,
      'Read the full diff (`git diff ' + TARGET + '...HEAD`). For EVERY changed test: confirm the change is ONLY selector/locator/wait/setup, and the assertion(s) about behaviour/data are byte-for-byte the same intent. Flag any test where an expect/assert/should was relaxed, removed, or changed.',
      'Then run the repaired tests → they must pass against ' + BASE + '.',
      'Comment your verdict on the MR (' + (isGitlab ? 'POST .../merge_requests/<iid>/notes + label qa::heal-verified or qa::heal-doubt' : 'gh pr comment') + '): ✅ if assertions intact + green, ⚠️ listing any suspect test otherwise.',
      'Return ONLY the structured object.',
    ].join('\n'),
    { label: 'verify-heal', phase: 'Verify-heal', schema: VERIFY_SCHEMA, agentType: 'general-purpose', isolation: 'worktree' }
  )
  if (verify && verify.assertionsIntact === false) log('⚠️ qa-heal: el verificador detectó aserciones alteradas — NO mergear sin revisar: ' + (verify.suspect || []).join(', '))
}

return {
  healed,
  regressions,   // the skill files these via report-issues.workflow.js → they flow into /qa-fix
  flaggedAssertionTouched: flagged,
  mrUrl: mrUrl || null,
  verify,
  summary: healed.length + ' healed / ' + regressions.length + ' real regressions / ' + flagged.length + ' assertion-touched',
}
