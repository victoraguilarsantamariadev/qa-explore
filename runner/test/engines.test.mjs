// Every engine, end to end on a stub: the right agents get spawned, the caps and gates hold, and
// nothing runs when it should not. Previously only "the files parse" was covered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from '../src/runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = (p) => resolve(HERE, '..', '..', 'skills', p)
const sink = { write() {} }

// Record every agent call; answer with whatever shape the engine expects for that label.
function spy(answers = {}) {
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, phase: opts.phase, prompt, isolation: opts.isolation })
    for (const [prefix, value] of Object.entries(answers)) {
      if (label === prefix || label.startsWith(prefix)) return typeof value === 'function' ? value(prompt, opts) : value
    }
    return opts.schema ? {} : ''
  }
  agent.calls = calls
  agent.labels = () => calls.map((c) => c.label)
  return agent
}
const run = (script, args, agent) => runWorkflow({ scriptPath: ENGINE(script), args, agent, sink })

// ---- report-issues -------------------------------------------------------------------------------

const FINDING = { area: 'widgets', severity: 'blocker', confidence: 'hard-evidence', title: 'save returns 500', whatHappened: 'w', repro: 'r' }
const REPORT = 'qa-explore/engine/report-issues.workflow.js'

test('report-issues files nothing when there is nothing to file', async () => {
  const agent = spy()
  const { result } = await run(REPORT, { tracker: { type: 'gitlab', project: 'g/p' }, findings: [] }, agent)
  assert.deepEqual(result.issues, [])
  assert.equal(agent.calls.length, 0, 'no agent is spawned for an empty finding list')
})

test('report-issues refuses to file against an unsupported tracker', async () => {
  const agent = spy()
  const { result } = await run(REPORT, { tracker: { type: 'jira' }, findings: [FINDING] }, agent)
  assert.match(result.summary, /tracker disabled/)
  assert.equal(agent.calls.length, 0)
})

test('report-issues briefs the filer with the dedup fingerprint and the human triage gate', async () => {
  const agent = spy({ '': { issues: [{ title: FINDING.title, action: 'created', iid: 7 }] } })
  await run(REPORT, {
    tracker: { type: 'gitlab', host: 'https://git.example.com', project: 'g/p', tokenEnv: 'GL_TOKEN', issueLabels: ['qa-explore'], fixLabel: 'qa::confirmed' },
    findings: [FINDING],
    shotsDir: '/data/evidence',
    baseUrl: 'http://app.example.test',
  }, agent)
  const p = agent.calls[0].prompt
  assert.match(p, /qa-fp/, 'the fingerprint is what stops re-runs piling up duplicates')
  assert.match(p, /GL_TOKEN/, 'the token is referenced by env var name, never inlined')
  assert.match(p, /qa::confirmed/)
  assert.ok(p.includes(FINDING.title))
})

// ---- codify --------------------------------------------------------------------------------------

const CODIFY = 'qa-explore/engine/codify.workflow.js'

test('codify writes one spec per bug and per smoke, each in its own worktree', async () => {
  const agent = spy({ 'codify': { file: 'x.spec.ts', validated: true, notes: '' } })
  const { result } = await run(CODIFY, {
    e2eDir: './e2e',
    bugs: [{ id: 1, title: 'save 500' }, { id: 2, title: 'list empty' }],
    smokes: [{ id: 's1', title: 'login works' }],
  }, agent)

  const labels = agent.labels()
  assert.equal(labels.filter((l) => l.startsWith('codify-bug:')).length, 2)
  assert.equal(labels.filter((l) => l.startsWith('codify-smoke:')).length, 1)
  assert.equal(result.length, 3)
  assert.ok(agent.calls.every((c) => c.isolation === 'worktree'), 'spec writers must not collide in the working tree')
})

test('codify with nothing approved spawns nobody', async () => {
  const agent = spy()
  const { result } = await run(CODIFY, { e2eDir: './e2e', bugs: [], smokes: [] }, agent)
  assert.deepEqual(result, [])
  assert.equal(agent.calls.length, 0)
})

// ---- qa-fix --------------------------------------------------------------------------------------

const FIX = 'qa-fix/engine/qa-fix.workflow.js'

test('qa-fix does nothing without a supported tracker — the issue gate is the whole point', async () => {
  const agent = spy()
  await run(FIX, { tracker: { type: 'none' } }, agent)
  assert.equal(agent.calls.length, 0)
})

test('qa-fix only picks up issues a human labelled, and never more than maxFixes', async () => {
  const issues = Array.from({ length: 9 }, (_, i) => ({ iid: i + 1, title: 'bug ' + i }))
  const agent = spy({
    'select-issues': { issues },
    '': { issue: 1, fixed: true, mr: 'https://git/mr/1' },
  })
  await run(FIX, {
    tracker: { type: 'gitlab', project: 'g/p', fixLabel: 'qa::confirmed', fixingLabel: 'qa::fixing' },
    fix: { maxFixes: 3, verify: false },
  }, agent)

  const select = agent.calls.find((c) => c.label === 'select-issues')
  assert.match(select.prompt, /qa::confirmed/, 'only human-marked issues are eligible')
  // Asserted exactly, not as "<= 3": a cap test that passes because nothing ran proves nothing.
  assert.deepEqual(agent.labels(), ['select-issues', 'fix:#1', 'fix:#2', 'fix:#3'],
    'nine labelled issues, maxFixes 3 → exactly three fixers')
})

// ---- qa-heal -------------------------------------------------------------------------------------

const HEAL = 'qa-heal/engine/qa-heal.workflow.js'

test('qa-heal stops early when the suite is green', async () => {
  const agent = spy({ 'collect-failures': { failures: [] } })
  await run(HEAL, { e2eDir: './e2e' }, agent)
  assert.deepEqual(agent.labels(), ['collect-failures'], 'a green suite costs exactly one agent')
})

test('qa-heal adjudicates each red test and is told never to weaken an assertion', async () => {
  const agent = spy({
    'collect-failures': { failures: [{ spec: 'a.spec.ts', title: 'saves', error: 'timeout' }] },
    '': { spec: 'a.spec.ts', verdict: 'stale', healed: true, notes: '' },
  })
  await run(HEAL, { e2eDir: './e2e', heal: { verify: false } }, agent)
  const adjudicate = agent.calls.find((c) => c.label !== 'collect-failures')
  assert.ok(adjudicate, 'a red test gets adjudicated')
  assert.match(adjudicate.prompt, /assertion/i, 'the heal-the-HOW-never-the-WHAT rule must reach the agent')
})

// ---- qa-manual -----------------------------------------------------------------------------------

const MANUAL = 'qa-manual/engine/qa-manual.workflow.js'

test('qa-manual stops at the TOC when none is approved yet — that gate is a human one', async () => {
  const agent = spy({ 'recon-toc': { audience: 'end-user', toc: [{ key: 'login', title: 'Acceso', goal: 'g' }], notes: '' } })
  const { result } = await run(MANUAL, { baseUrl: 'http://app.example.test' }, agent)

  assert.deepEqual(agent.labels(), ['recon-toc'], 'no screenshot is taken before a human approves the TOC')
  assert.equal(result.stage, 'toc-proposed')
  assert.ok(result._gate, 'the result tells the caller to get the TOC approved')
})

test('an approved TOC is captured section by section, in order, then assembled once', async () => {
  const agent = spy({
    'capture:': (p, o) => ({ key: o.label.slice(8), title: o.label, markdown: '1. do it', screenshots: [], blocked: false }),
    'assemble': { outFile: 'docs/manual.md', markdown: '# manual', sectionCount: 2, blockedSections: [] },
  })
  const { result } = await run(MANUAL, {
    baseUrl: 'http://app.example.test',
    shotsDir: '/data/evidence',
    manual: { audience: 'installer', toc: [{ key: 'acceso', title: 'Acceso', goal: 'g' }, { key: 'alta', title: 'Alta', goal: 'g' }] },
  }, agent)

  assert.deepEqual(agent.labels(), ['capture:acceso', 'capture:alta', 'assemble'])
  assert.equal(result.stage, 'drafted')
  assert.equal(result.audience, 'installer')
  const first = agent.calls[0].prompt
  assert.match(first, /SECTION 1\/2/, 'each writer knows where it sits, so the example builds up in order')
  assert.match(first, /\/data\/evidence\/acceso-NN\.png/)
})

test('a section blocked by a bug is flagged, never faked — the manual must not teach a broken flow', async () => {
  const agent = spy({
    'capture:': { key: 'alta', title: 'Alta', markdown: '', screenshots: [], blocked: true, blockReason: 'save returns 500' },
    'assemble': { outFile: 'docs/manual.md', markdown: '# m', sectionCount: 1, blockedSections: ['Alta'] },
  })
  const { result } = await run(MANUAL, {
    baseUrl: 'http://app.example.test',
    manual: { toc: [{ key: 'alta', title: 'Alta', goal: 'g' }] },
  }, agent)

  assert.match(agent.calls[0].prompt, /do NOT document a fake\/guessed path/)
  assert.deepEqual(result.blocked, ['Alta'], 'the blocked section is surfaced to the human, not silently dropped')
})

test('qa-manual writes its screenshots to disk by default, not into a tmpfs', async () => {
  const agent = spy({ 'capture:': { key: 'a', title: 'A', markdown: '', screenshots: [], blocked: false }, 'assemble': { outFile: 'o', markdown: '', sectionCount: 1 } })
  await run(MANUAL, { baseUrl: 'http://app.example.test', manual: { toc: [{ key: 'a', title: 'A', goal: 'g' }] } }, agent)
  const p = agent.calls[0].prompt
  assert.match(p, /\.\/qa-evidence\/a-NN\.png/)
  assert.doesNotMatch(p, /\/tmp\/qa-manual/)
})
