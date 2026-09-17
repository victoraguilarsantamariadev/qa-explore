// What the agents are TOLD is the product: the prompts carry the safety rails (what may be written,
// which hosts may be touched) and the evidence protocol. A regression here is not a cosmetic one —
// it is a write run against production, or gigabytes of trace nobody asked for. So pin the rails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from '../src/runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = (p) => resolve(HERE, '..', '..', 'skills', p)
const EXPLORE = ENGINE('qa-explore/engine/explore-verify.workflow.js')
const sink = { write() {} }

// Runs an engine with a stub that records every prompt instead of spawning anything.
async function capture(args, scriptPath = EXPLORE) {
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, phase: opts.phase, prompt })
    if (label === 'step0') return { ran: false, note: 'cold start — no existing suite' }
    if (label === 'recon') return { areas: [{ key: 'a', label: 'Area A', mission: 'm' }], inventory: { routes: ['/a'] } }
    if (label.startsWith('completeness')) return { areas: [] }
    if (label.startsWith('verify')) return { verdicts: [] }
    if (label.startsWith('explore') || label.startsWith('authz')) {
      return { area: 'Area A', flowsExercised: ['listed'], worksWell: ['list loads'], findings: [] }
    }
    return opts.schema ? {} : 'READY'
  }
  const out = await runWorkflow({
    scriptPath,
    args,
    agent,
    sink: { write: (m) => logs.push(m) },
  })
  return { calls, logs: logs.join(''), result: out.result, meta: out.meta }
}

const AREAS = [{ key: 'a', label: 'Area A', mission: 'open the list' }]
const base = (extra = {}) => ({ baseUrl: 'http://app.example.test', areas: AREAS, ...extra })
const explorePrompts = (calls) => calls.filter((c) => c.label.startsWith('explore')).map((c) => c.prompt)

// ---- what the run may DO -------------------------------------------------------------------------

test('read-only mode forbids every write, in every prompt', async () => {
  const { calls } = await capture(base({ mode: 'read-only' }))
  const prompts = explorePrompts(calls)
  assert.ok(prompts.length > 0)
  for (const p of prompts) {
    assert.match(p, /MODE = READ-ONLY/)
    assert.match(p, /DO NOT create, edit, submit, upload or delete/)
    assert.doesNotMatch(p, /full read-write/)
  }
})

test('no-delete mode allows writes but never deletion', async () => {
  const { calls } = await capture(base({ mode: 'no-delete' }))
  for (const p of explorePrompts(calls)) {
    assert.match(p, /MODE = NO-DELETE/)
    assert.match(p, /never delete/i)
    assert.doesNotMatch(p, /MODE = EXPLORE/)
  }
})

test('the default mode is the full read-write one, with the qa- prefix and cleanup rules', async () => {
  const { calls } = await capture(base())
  for (const p of explorePrompts(calls)) {
    assert.match(p, /MODE = EXPLORE \(full read-write\)/)
    assert.match(p, /prefix everything you create with "qa-/)
    assert.match(p, /only delete what YOU created this run/)
  }
})

test('an unknown mode value falls back to a known one rather than to no rule at all', async () => {
  const { calls } = await capture(base({ mode: 'yolo' }))
  for (const p of explorePrompts(calls)) assert.match(p, /MODE = (EXPLORE|NO-DELETE|READ-ONLY)/)
})

// ---- where the run may REACH ---------------------------------------------------------------------

test('network confinement defaults to the baseUrl host', async () => {
  const { calls } = await capture(base())
  for (const p of explorePrompts(calls)) {
    assert.match(p, /NETWORK CONFINEMENT \(strict\)/)
    assert.match(p, /app\.example\.test/)
    assert.match(p, /NEVER scan, probe or connect to any other machine/)
  }
})

test('an explicit allowedHosts list is what the agents are confined to', async () => {
  const { calls } = await capture(base({ allowedHosts: ['staging.example.com', 'api.example.com'] }))
  const p = explorePrompts(calls)[0]
  assert.match(p, /staging\.example\.com, api\.example\.com/)
})

// ---- coverage axes -------------------------------------------------------------------------------

test('a single role runs no access-control pass; extra roles do', async () => {
  const one = await capture(base({ roles: [{ name: 'admin', login: 'x' }] }))
  assert.equal(one.calls.filter((c) => c.label.startsWith('authz')).length, 0)

  const two = await capture(base({ roles: [{ name: 'admin', login: 'x' }, { name: 'viewer', login: 'y' }] }))
  const authz = two.calls.filter((c) => c.label.startsWith('authz'))
  assert.equal(authz.length, 1)
  assert.equal(authz[0].label, 'authz:viewer')
  assert.match(authz[0].prompt, /BROKEN ACCESS CONTROL/)
  assert.match(authz[0].prompt, /a redirect \/ 403 \/ empty result = CORRECT/)
})

test('extra appStates get a setup agent and re-run the areas, tagged by state', async () => {
  const { calls } = await capture(base({
    appStates: [
      { name: 'real', default: true },
      { name: 'simulation', enter: 'POST /api/simulation {enabled:true}', expect: 'writes are rejected by design' },
    ],
  }))
  assert.ok(calls.some((c) => c.label === 'enter-state:simulation'), 'the non-primary state is entered')
  const explores = calls.filter((c) => c.label.startsWith('explore'))
  assert.equal(explores.length, 2, 'every area re-runs in every declared state')
  const sim = explores.find((c) => c.label.includes('simulation'))
  assert.match(sim.prompt, /PREFIX every finding title with "\[simulation\] "/)
  assert.match(sim.prompt, /writes are rejected by design/, 'the state\'s expectations reach the agent so it does not report them as bugs')
})

test('a11y rides along by default on web and can be switched off', async () => {
  const on = await capture(base())
  assert.match(explorePrompts(on.calls)[0], /axe-core/)

  const off = await capture(base({ a11y: false }))
  assert.doesNotMatch(explorePrompts(off.calls)[0], /axe-core/)
})

test('projectType swaps the agent\'s hands', async () => {
  const api = await capture(base({ projectType: 'api' }))
  assert.match(explorePrompts(api.calls)[0], /this is an API target — no browser/)

  const cli = await capture(base({ projectType: 'cli' }))
  assert.match(explorePrompts(cli.calls)[0], /this is a CLI target — no browser/)

  const electron = await capture(base({ projectType: 'electron' }))
  assert.match(explorePrompts(electron.calls)[0], /_electron\.launch/)
})

test('more areas than the cap are dropped loudly, never silently', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ key: 'k' + i, label: 'L' + i, mission: 'm' }))
  const { calls, logs } = await capture(base({ areas: many, maxAreas: 3 }))
  assert.equal(calls.filter((c) => c.label.startsWith('explore')).length, 3)
  assert.match(logs, /dropping 9/)
})

// ---- evidence protocol ---------------------------------------------------------------------------

test('traces are recorded per finding, not per session', async () => {
  const p = explorePrompts((await capture(base())).calls)[0]
  assert.match(p, /TRACE PER FINDING, NEVER PER SESSION/)
  assert.match(p, /tracing\.startChunk/)
  assert.match(p, /tracing\.stopChunk/)
  assert.match(p, /sources:false/, 'bundling the sources into every trace is pure weight')
  assert.doesNotMatch(p, /tracing\.stop\(\{ path/, 'stop() would dump the whole session into one zip')
})

test('the context is always closed — that is what flushes the video and frees Playwright\'s temp dir', async () => {
  const p = explorePrompts((await capture(base())).calls)[0]
  assert.match(p, /try\/finally/)
  assert.match(p, /context\.close\(\)/)
})

test('video is recorded small, and the size is configurable', async () => {
  const dflt = explorePrompts((await capture(base())).calls)[0]
  assert.match(dflt, /size: \{ width: 800, height: 450 \}/)

  const custom = explorePrompts((await capture(base({ evidence: { videoSize: { width: 640, height: 360 } } }))).calls)[0]
  assert.match(custom, /size: \{ width: 640, height: 360 \}/)
})

test('evidence never defaults into /tmp — that is RAM on most Linux boxes', async () => {
  const p = explorePrompts((await capture(base())).calls)[0]
  assert.match(p, /\.\/qa-evidence/)
  assert.doesNotMatch(p, /\/tmp\/qa-explore/)
})

test('a configured shotsDir is where every artifact is told to go', async () => {
  const p = explorePrompts((await capture(base({ shotsDir: '/data/evidence' }))).calls)[0]
  assert.match(p, /\/data\/evidence\/<AREA_KEY>\/video/)
  assert.match(p, /\/data\/evidence\/<AREA_KEY>\/network\.har/)
  assert.match(p, /\/data\/evidence\/<AREA_KEY>\/console\.log/)
  assert.match(p, /\/data\/evidence\/storageState-default\.json/)
})

// ---- false-positive defences ---------------------------------------------------------------------

test('domainNotes reach every agent as known-correct behaviour', async () => {
  const notes = '- the status widget is websocket-fed; an empty preview is by design.'
  const { calls } = await capture(base({ domainNotes: notes }))
  for (const p of explorePrompts(calls)) {
    assert.match(p, /KNOWN-CORRECT \/ INTENTIONAL BEHAVIOUR/)
    assert.ok(p.includes(notes))
  }
})

test('the verify pass is briefed to be skeptical and to reproduce before confirming', async () => {
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, prompt })
    if (label === 'step0') return { ran: false, note: 'cold' }
    if (label.startsWith('verify')) return { verdicts: [{ title: 'boom', confirmed: false, notes: 'works for me' }] }
    if (label.startsWith('explore')) {
      return { area: 'A', flowsExercised: [], worksWell: [], findings: [{ severity: 'blocker', confidence: 'judgement', title: 'boom', whatHappened: 'w', repro: 'r' }] }
    }
    return opts.schema ? {} : ''
  }
  const { result } = await runWorkflow({ scriptPath: EXPLORE, args: base(), agent, sink })

  const verify = calls.find((c) => c.label.startsWith('verify'))
  assert.ok(verify, 'a blocker triggers an independent verify')
  assert.match(verify.prompt, /Default to skeptical/)
  assert.match(verify.prompt, /confirmed=true ONLY if you actually reproduce/)
  assert.equal(result.find((r) => r.key === 'a').verify.verdicts[0].confirmed, false)
})

test('a run with no serious finding spends nothing on verify', async () => {
  const { calls } = await capture(base())
  assert.equal(calls.filter((c) => c.label.startsWith('verify')).length, 0)
})
