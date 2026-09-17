// qa-sec reviews a live system, so its boundaries are the feature. The gate, the scope and the
// detection-first rules are pinned here: if any of these stops reaching the agents, the skill has
// quietly become something its author did not intend to ship.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from '../src/runtime.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEC = resolve(HERE, '..', '..', 'skills', 'qa-sec', 'engine', 'qa-sec.workflow.js')

async function capture(args) {
  const calls = []
  const logs = []
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    calls.push({ label, phase: opts.phase, prompt })
    if (label === 'surface') return { areas: [{ key: 'cuentas', label: 'Cuentas', mission: 'ids de usuario en /api/users/:id' }] }
    if (label.startsWith('verify')) return { verdicts: [] }
    return { pass: label, checked: ['something clean'], findings: [], notes: '' }
  }
  const out = await runWorkflow({ scriptPath: SEC, args, agent, sink: { write: (m) => logs.push(m) } })
  return { calls, labels: calls.map((c) => c.label), logs: logs.join(''), result: out.result }
}

const owned = (extra = {}) => ({
  baseUrl: 'http://app.example.test',
  login: 'fill #user/#pass',
  security: { authorized: true, scope: 'our own staging, authorised by the owner', ...(extra.security || {}) },
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'security')),
})

// ---- the gate -------------------------------------------------------------------------------------

test('without security.authorized nothing runs at all — not one agent', async () => {
  for (const security of [undefined, {}, { authorized: false }, { authorized: 'true' }, { authorized: 1 }]) {
    const { calls, result } = await capture({ baseUrl: 'http://app.example.test', security })
    assert.equal(calls.length, 0, 'an unauthorised run must spawn nothing, got ' + calls.length)
    assert.equal(result.ran, false)
    assert.match(result.reason, /not authorized/)
  }
})

test('the gate explains what to do instead of failing silently', async () => {
  const { logs } = await capture({ baseUrl: 'http://app.example.test' })
  assert.match(logs, /security\.authorized/)
  assert.match(logs, /security\.scope/)
})

test('no resolvable target host means no scope, so no run', async () => {
  const { calls, result } = await capture({ security: { authorized: true } })
  assert.equal(calls.length, 0)
  assert.equal(result.ran, false)
  assert.match(result.reason, /no target host/)
})

// ---- scope ----------------------------------------------------------------------------------------

test('every agent is confined to the allowed hosts and told that off-host is out of scope', async () => {
  const { calls } = await capture(owned({ allowedHosts: ['staging.example.com', 'api.example.com'] }))
  assert.ok(calls.length > 0)
  for (const c of calls) {
    assert.match(c.prompt, /SCOPE \(strict\)/)
    assert.match(c.prompt, /staging\.example\.com, api\.example\.com/)
    assert.match(c.prompt, /Never scan, probe, enumerate or connect to any other machine/)
  }
})

test('the scope defaults to the baseUrl host, never to "anywhere"', async () => {
  const { calls } = await capture(owned())
  assert.match(calls[0].prompt, /ONLY send requests to app\.example\.test/)
})

// ---- detection-first rules ------------------------------------------------------------------------

test('the non-negotiable rules reach every single agent', async () => {
  const { calls } = await capture(owned({ security: { intrusiveness: 'safe-active' } }))
  assert.ok(calls.length >= 5)
  for (const c of calls) {
    assert.match(c.prompt, /DETECTION-FIRST/)
    assert.match(c.prompt, /you are DONE with that finding/, 'stop at proof')
    assert.match(c.prompt, /NEVER read or copy real data beyond the ONE record/)
    assert.match(c.prompt, /never plant a payload that persists/)
    assert.match(c.prompt, /NO load, stress, flooding or timing attacks/)
    assert.match(c.prompt, /NEVER try credentials that are not the ones configured/)
    assert.match(c.prompt, /No destructive SQL/)
  }
})

test('login attempts are capped low and capped hard', async () => {
  const dflt = await capture(owned())
  assert.match(dflt.calls[0].prompt, /At most 8 deliberately-wrong login attempts/)

  const greedy = await capture(owned({ security: { maxLoginAttempts: 5000 } }))
  assert.match(greedy.calls[0].prompt, /At most 20 deliberately-wrong login attempts/, 'the cap cannot be configured upward without limit')
})

test('agents are told never to paste a token into a finding', async () => {
  const { calls } = await capture(owned())
  assert.match(calls[0].prompt, /never paste a token, cookie value or credential into a finding/)
})

// ---- passes -------------------------------------------------------------------------------------

test('passive is the default and sends nothing beyond normal use', async () => {
  const { labels, calls, logs } = await capture(owned())
  assert.ok(labels.some((l) => l.startsWith('passive:')), 'the passive audit always runs')
  assert.equal(labels.filter((l) => l.startsWith('input:')).length, 0, 'no probing in passive mode')
  assert.match(calls[0].prompt, /INTRUSIVENESS = PASSIVE/)
  assert.match(calls[0].prompt, /Do NOT submit crafted input/)
  assert.match(logs, /se omite la pasada de entradas/)
})

test('the passive audit covers transport, session, client exposure and dependencies', async () => {
  const { labels } = await capture(owned())
  for (const k of ['passive:transport-headers', 'passive:session-tokens', 'passive:client-exposure', 'passive:dependencies']) {
    assert.ok(labels.includes(k), 'missing passive pass ' + k)
  }
})

test('safe-active adds the input and business-logic pass, one agent per area', async () => {
  const { labels, calls } = await capture(owned({
    security: { intrusiveness: 'safe-active' },
    areas: [{ key: 'cuentas', label: 'Cuentas', mission: 'm' }, { key: 'pagos', label: 'Pagos', mission: 'm' }],
  }))
  assert.deepEqual(labels.filter((l) => l.startsWith('input:')), ['input:cuentas', 'input:pagos'])
  const input = calls.find((c) => c.label === 'input:cuentas')
  assert.match(input.prompt, /INTRUSIVENESS = SAFE-ACTIVE/)
  assert.match(input.prompt, /BUSINESS LOGIC/, 'the part no scanner finds')
  assert.match(input.prompt, /never point at cloud metadata endpoints, internal ranges|Never point at cloud metadata endpoints/)
})

test('access control runs per extra role and is keyed so qa-gate blocks on it', async () => {
  const { labels, result } = await capture(owned({
    roles: [{ name: 'admin', login: 'a' }, { name: 'viewer', login: 'v' }, { name: 'guest', login: 'g' }],
  }))
  assert.deepEqual(labels.filter((l) => l.startsWith('authz:')), ['authz:viewer', 'authz:guest'])
  // qa-gate treats any entry whose key starts with "authz" as access control, and blocks on it.
  const keys = result.map((r) => r.key)
  assert.ok(keys.includes('authz-viewer') && keys.includes('authz-guest'))
})

test('a single role still runs the pass, but says out loud what it cannot test', async () => {
  const { labels, calls, logs } = await capture(owned())
  assert.deepEqual(labels.filter((l) => l.startsWith('authz:')), ['authz:default'])
  assert.match(logs, /solo hay un rol configurado/)
  assert.match(calls.find((c) => c.label === 'authz:default').prompt, /only one role is configured/)
})

test('a refusal is a clean check, not a finding — the pass is told so explicitly', async () => {
  const { calls } = await capture(owned({ roles: [{ name: 'admin', login: 'a' }, { name: 'viewer', login: 'v' }] }))
  const authz = calls.find((c) => c.label === 'authz:viewer')
  assert.match(authz.prompt, /A redirect, a 403 or an empty result is CORRECT and is NOT a finding/)
  assert.match(authz.prompt, /IDOR \/ BOLA/)
  assert.match(authz.prompt, /do not actually modify anything/)
})

// ---- verify + output ------------------------------------------------------------------------------

test('only serious, proven findings cost a verify pass', async () => {
  const mk = (findings) => async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'surface') return { areas: [{ key: 'a', label: 'A', mission: 'm' }] }
    if (label.startsWith('verify')) return { verdicts: [{ title: 'x', confirmed: true, notes: 'reproduced' }] }
    if (label === 'passive:transport-headers') return { pass: label, checked: [], findings }
    return { pass: label, checked: [], findings: [] }
  }
  const base = { severity: 'blocker', confidence: 'hard-evidence', title: 'x', whatHappened: 'w', impact: 'i', repro: 'r' }

  const calls = []
  const wrap = (impl) => async (p, o) => { calls.push(o.label); return impl(p, o) }

  // a minor finding is not worth a skeptic
  await runWorkflow({ scriptPath: SEC, args: owned(), agent: wrap(mk([{ ...base, severity: 'minor', proven: true }])), sink: { write() {} } })
  assert.equal(calls.filter((l) => l.startsWith('verify')).length, 0)

  // an unproven one is not either — there is nothing to reproduce yet
  calls.length = 0
  await runWorkflow({ scriptPath: SEC, args: owned(), agent: wrap(mk([{ ...base, proven: false }])), sink: { write() {} } })
  assert.equal(calls.filter((l) => l.startsWith('verify')).length, 0)

  // a proven blocker is
  calls.length = 0
  await runWorkflow({ scriptPath: SEC, args: owned(), agent: wrap(mk([{ ...base, proven: true }])), sink: { write() {} } })
  assert.deepEqual(calls.filter((l) => l.startsWith('verify')), ['verify:passive-transport-headers'])
})

test('the skeptic is told to push back in both directions', async () => {
  const agent = async (prompt, opts = {}) => {
    const label = opts.label || ''
    if (label === 'surface') return { areas: [{ key: 'a', label: 'A', mission: 'm' }] }
    if (label.startsWith('verify')) { assert.match(prompt, /a missing header that changes nothing in practice is NOT a blocker/); return { verdicts: [] } }
    if (label === 'passive:session-tokens') {
      return { pass: label, checked: [], findings: [{ severity: 'major', confidence: 'hard-evidence', proven: true, title: 'x', whatHappened: 'w', impact: 'i', repro: 'r' }] }
    }
    return { pass: label, checked: [], findings: [] }
  }
  await runWorkflow({ scriptPath: SEC, args: owned(), agent, sink: { write() {} } })
})

test('accepted risks are never raised again', async () => {
  const accepted = '- No HSTS: served only over an internal VPN.'
  const { calls } = await capture(owned({ security: { knownAccepted: accepted } }))
  assert.ok(calls[0].prompt.includes(accepted))
  assert.match(calls[0].prompt, /KNOWN-CORRECT \/ INTENTIONAL BEHAVIOUR/)
})

test('evidence goes to the configured dir, and to disk by default', async () => {
  const custom = await capture(owned({ shotsDir: '/data/evidence' }))
  assert.match(custom.calls[0].prompt, /\/data\/evidence\/sec-<PASS_KEY>\/network\.har/)

  const dflt = await capture(owned())
  assert.match(dflt.calls[0].prompt, /\.\/qa-evidence\/sec-<PASS_KEY>/)
  assert.doesNotMatch(dflt.calls[0].prompt, /\/tmp\//)
})

test('scratch scripts are kept out of the regression suite', async () => {
  const { calls } = await capture(owned({ e2eDir: './test/E2E' }))
  assert.match(calls[0].prompt, /NEVER create a file inside \.\/test\/E2E/)
  assert.match(calls[0].prompt, /never name one \*\.test\.\* \/ \*\.spec\.\* \/ \*\.cy\.\* anywhere/)
})
