// qa-explore — CODIFY engine (3rd pass): turn approved findings + working flows into real E2E tests.
// Invoked by the /qa-explore skill via Workflow({ scriptPath, args }) AFTER the human triage gate.
// args = {
//   baseUrl, appPath, login,            // same as the explore config
//   e2eDir, framework,                  // where to write specs, "playwright" | "cypress"
//   bugs:   [ { id, title, repro, expected, evidence, area } ],   // approved confirmed bugs -> RED regression tests
//   smokes: [ { id, title, flow, area } ],                        // working flows -> GREEN smoke tests (cold-start baseline)
// }
export const meta = {
  name: 'qa-explore-codify',
  description: 'Generate and SELF-VALIDATE E2E specs: failing (red) regression tests for confirmed bugs, and passing (green) smoke tests for flows that work. Each generated test is run once to confirm it behaves as intended before being kept.',
  phases: [
    { title: 'Codify-bugs', detail: 'one agent per confirmed bug writes a regression spec that fails today' },
    { title: 'Codify-smokes', detail: 'one agent per working flow writes a smoke spec that passes today' },
  ],
}

const cfg = args || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const FW = cfg.framework || 'playwright'
const E2E = cfg.e2eDir || '.'

function writerPreamble(kind) {
  const wantRed = kind === 'bug'
  return [
    'You are a senior test engineer writing ONE ' + FW + ' end-to-end spec against a LIVE app.',
    'APP URL: ' + BASE,
    'LOGIN RECIPE:\n' + (cfg.login || '(open app / discover login)'),
    'Write the spec into: ' + E2E + ' (match the existing file/style conventions there — read a neighbouring spec and the helpers first; reuse the project login helper if one exists).',
    '',
    wantRed
      ? 'GOAL: a REGRESSION test that asserts the CORRECT (expected) behaviour, so it FAILS today because of the bug and will turn GREEN once the bug is fixed. Name it after the bug id and tag/title it clearly as a known-bug regression. Do NOT assert the buggy behaviour.'
      : 'GOAL: a SMOKE test that asserts the current WORKING behaviour of this flow, so it PASSES today and guards against future regressions. Keep it stable: target real, robust selectors you verify by running, prefer role/text/test-id over brittle CSS, and assert meaningful outcomes (navigation, persisted value, visible result).',
    '',
    'SELF-VALIDATION (mandatory): after writing the spec, RUN just that spec (e.g. npx playwright test <file> -g "<title>"). Confirm it ' +
      (wantRed ? 'FAILS for the right reason (the assertion about correct behaviour), not because of a broken selector/login/timeout' : 'PASSES reliably (run it twice if flaky-prone)') +
      '. If it does not behave as intended, fix the SPEC (selectors/waits/flow) — never weaken the assertion to force the result — and re-run. Report the final observed status.',
    '',
    'Any artifacts you create in the app to set up the test must be cleaned up by the test itself (afterEach/afterAll) or be clearly prefixed and disposable.',
    'Return ONLY the structured object.',
  ].join('\n')
}

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    file: { type: 'string', description: 'path to the spec written' },
    testTitle: { type: 'string' },
    kind: { type: 'string', enum: ['bug-regression', 'smoke'] },
    observedStatus: { type: 'string', enum: ['fails-as-expected', 'passes-as-expected', 'unexpected', 'could-not-write'] },
    notes: { type: 'string' },
  },
  required: ['file', 'testTitle', 'kind', 'observedStatus'],
}

const bugs = (cfg.bugs || [])
const smokes = (cfg.smokes || [])
log('qa-codify: ' + bugs.length + ' tests de regresión (rojos) + ' + smokes.length + ' smoke (verdes) → ' + E2E)

const bugSpecs = await parallel(bugs.map((b) => () =>
  agent(
    writerPreamble('bug') +
      '\n\n=== CONFIRMED BUG #' + (b.id || '?') + ' (' + (b.area || '') + ') ===\nTitle: ' + b.title +
      '\nExpected (assert THIS): ' + (b.expected || '') +
      '\nRepro: ' + (b.repro || '') +
      '\nEvidence: ' + (b.evidence || 'n/a'),
    { label: 'codify-bug:' + (b.id || b.title || '').toString().slice(0, 24), phase: 'Codify-bugs', schema: RESULT_SCHEMA, agentType: 'general-purpose', isolation: 'worktree' }
  )
))

const smokeSpecs = await parallel(smokes.map((s) => () =>
  agent(
    writerPreamble('smoke') +
      '\n\n=== WORKING FLOW (smoke) (' + (s.area || '') + ') ===\nTitle: ' + s.title + '\nFlow to lock in: ' + (s.flow || s.title),
    { label: 'codify-smoke:' + (s.id || s.title || '').toString().slice(0, 24), phase: 'Codify-smokes', schema: RESULT_SCHEMA, agentType: 'general-purpose', isolation: 'worktree' }
  )
))

const all = [...bugSpecs, ...smokeSpecs].filter(Boolean)
const ok = all.filter((r) => r.observedStatus === 'fails-as-expected' || r.observedStatus === 'passes-as-expected').length
log('qa-codify terminado: ' + ok + '/' + all.length + ' specs validados como esperado.')
return all
