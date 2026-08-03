// Validates the runtime shim WITHOUT a model: pipeline/parallel semantics + that the REAL engine
// files load and run on the shim when agent() is stubbed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { pipeline, parallel, runWorkflow } from '../src/runtime.mjs'
import { stripJsonc, normalizeConfig } from '../src/config.mjs'
import { fromExploreResult } from '../src/findings.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENGINE = (p) => resolve(HERE, '..', '..', 'skills', p)
const sink = { write() {} }   // swallow progress output in tests

test('pipeline runs stages independently and passes (prev, item, index)', async () => {
  const seen = []
  const out = await pipeline(
    [1, 2, 3],
    (v) => v * 10,
    (prev, item, i) => { seen.push([prev, item, i]); return prev + item },
  )
  assert.deepEqual(out, [11, 22, 33])
  assert.deepEqual(seen, [[10, 1, 0], [20, 2, 1], [30, 3, 2]])
})

test('pipeline: a throwing stage drops that item to null', async () => {
  const out = await pipeline([1, 2], (v) => { if (v === 2) throw new Error('boom'); return v }, (v) => v + 1)
  assert.deepEqual(out, [2, null])
})

test('parallel is a barrier and maps throwers to null', async () => {
  const out = await parallel([() => 'a', () => { throw new Error('x') }, async () => 'c'])
  assert.deepEqual(out, ['a', null, 'c'])
})

test('stripJsonc tolerates a UTF-8 BOM, comments and trailing commas', async () => {
  // An editor on Windows saves qa.config.json with a BOM; JSON.parse would throw on it.
  const withBom = '﻿{\n  // the target\n  "baseUrl": "http://localhost:3000",\n  "areas": null,\n}'
  assert.deepEqual(JSON.parse(stripJsonc(withBom)), { baseUrl: 'http://localhost:3000', areas: null })
  // a "//" inside a string is not a comment
  assert.deepEqual(JSON.parse(stripJsonc('{"baseUrl":"http://x.test"}')), { baseUrl: 'http://x.test' })
})

test('normalizeConfig fills portability defaults and accepts a bare storageState path', async () => {
  assert.equal(normalizeConfig({}).bootTimeout, 90000)
  assert.deepEqual(normalizeConfig({ login: ' ./state.json ' }).login, { storageStatePath: './state.json' })
  assert.equal(normalizeConfig({ login: 'log in as admin' }).login, 'log in as admin')
})

test('normalizeConfig anchors a relative shotsDir to the project root, not to e2eDir', async () => {
  const root = process.platform === 'win32' ? 'C:\\builds\\app' : '/builds/app'
  // The explore agents cd into e2eDir, so a relative path resolving from there would drop the
  // evidence outside the CI artifact glob.
  assert.equal(normalizeConfig({ shotsDir: 'qa-evidence' }, root).shotsDir, resolve(root, 'qa-evidence'))
  assert.equal(normalizeConfig({ shotsDir: './evidence' }, root).shotsDir, resolve(root, 'evidence'))
  // An absolute path is left exactly as the user wrote it.
  const abs = process.platform === 'win32' ? 'C:\\tmp\\qa-explore' : '/tmp/qa-explore'
  assert.equal(normalizeConfig({ shotsDir: abs }, root).shotsDir, abs)
  // Unset stays unset — the engines apply their own default.
  assert.equal(normalizeConfig({}, root).shotsDir, undefined)
})

test('runWorkflow loads the REAL explore-verify engine and runs it with a stubbed agent', async () => {
  // stub: explore call returns a findings object; recon is skipped because we supply areas.
  const stub = async (_prompt, opts) => (opts && opts.schema
    ? { area: 'Area A', flowsExercised: ['opened list'], worksWell: ['list loads'], findings: [], notes: '' }
    : '')
  const { meta, result } = await runWorkflow({
    scriptPath: ENGINE('qa-explore/engine/explore-verify.workflow.js'),
    args: { baseUrl: 'http://example.test', areas: [{ key: 'a', label: 'Area A', mission: 'open the list' }] },
    agent: stub,
    sink,
  })
  assert.equal(meta.name, 'qa-explore-engine')
  assert.ok(Array.isArray(result))
  // The result always leads with the Step-0 (deterministic suite) entry, then the explored areas
  // (+ any access-control entries). Assert by KEY, not index, so adding phases doesn't break this.
  assert.ok(result.find((r) => r.key === 'step0'), 'result includes the Step-0 entry')
  const areaA = result.find((r) => r.key === 'a')
  assert.ok(areaA, 'result includes the explored area "a"')
  assert.equal(areaA.area, 'Area A')
})

test('runWorkflow loads report-issues and short-circuits when tracker is disabled (no agent call)', async () => {
  const stub = async () => { throw new Error('agent should NOT be called when tracker is disabled') }
  const { result } = await runWorkflow({
    scriptPath: ENGINE('qa-explore/engine/report-issues.workflow.js'),
    args: { tracker: { type: 'none' }, findings: [{ area: 'x', severity: 'major', confidence: 'judgement', title: 't', whatHappened: 'w', repro: 'r' }] },
    agent: stub,
    sink,
  })
  assert.deepEqual(result.issues, [])
})

test('fromExploreResult only carries skeptic-CONFIRMED findings into codify', async () => {
  const result = [{
    area: 'Tasks',
    explore: {
      worksWell: ['List renders the seeded rows', 'axe-core: 0 serious violations', 'Nav works'],
      findings: [
        { title: 'create is a no-op', severity: 'blocker', repro: 'click add', expected: 'row appears' },
        { title: 'refuted guess', severity: 'major' },
        { title: 'never verified', severity: 'minor' },
      ],
    },
    verify: {
      verdicts: [
        { title: 'create is a no-op', confirmed: true },
        { title: 'refuted guess', confirmed: false },
      ],
    },
  }]

  const { args, summary } = fromExploreResult(result)
  assert.equal(args.bugs.length, 1, 'only the confirmed finding becomes a red spec')
  assert.equal(args.bugs[0].title, 'create is a no-op')
  assert.equal(args.bugs[0].repro, 'click add')
  // A skeptic-refuted finding and an unverified one must never reach the suite.
  assert.ok(!args.bugs.some((b) => /refuted|never verified/.test(b.title)))
  assert.match(summary, /2 unconfirmed finding\(s\) NOT codified/)
  // worksWell entries that are not user flows are not specs.
  assert.deepEqual(args.smokes.map((s) => s.title), ['List renders the seeded rows', 'Nav works'])

  // report gets the same gate, and stamps them verified so the issue body can say so.
  const rep = fromExploreResult(result, { skill: 'report' })
  assert.equal(rep.args.findings.length, 1)
  assert.equal(rep.args.findings[0].verified, true)
})

test('fromExploreResult caps smokes and reports what the cap dropped', async () => {
  const result = [{ area: 'A', explore: { findings: [], worksWell: ['a', 'b', 'c', 'd'] }, verify: { verdicts: [] } }]
  const { args, summary } = fromExploreResult(result, { maxSmokes: 2 })
  assert.equal(args.smokes.length, 2)
  assert.match(summary, /2 further working flow\(s\) DROPPED at the --max-smokes cap of 2/)
  // Default cap keeps all four.
  assert.equal(fromExploreResult(result).args.smokes.length, 4)
  assert.throws(() => fromExploreResult({ not: 'an array' }), /expected an explore result array/)
})

test('the publishable package ships the engines the CLI resolves', async () => {
  // Publishing runner/ on its own shipped 9 files and NO skills/, so every skill died with
  // ENOENT on node_modules/skills/... The package must be rooted at the repo, where the CLI's
  // ../../skills resolves inside the package.
  const root = resolve(HERE, '..', '..')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'qa-explore', 'the published name is what `npx qa-explore` needs')
  assert.ok(!pkg.private, 'a private package cannot be published')
  assert.ok(pkg.files.includes('skills'), 'skills/ must ship or every engine 404s at runtime')
  assert.ok(pkg.files.some((f) => f.startsWith('runner/bin')), 'the CLI entrypoint must ship')
  assert.equal(pkg.bin['qa-explore'], 'runner/bin/qa-explore.mjs')
  // Every engine the CLI can dispatch to must exist relative to the package root.
  const cli = readFileSync(resolve(root, 'runner', 'bin', 'qa-explore.mjs'), 'utf8')
  const engines = [...cli.matchAll(/^\s+\w+: '([^']+\.workflow\.js)',$/gm)].map((m) => m[1])
  assert.ok(engines.length >= 8, 'expected the full skill set, got ' + engines.length)
  for (const e of engines) {
    assert.ok(existsSync(resolve(root, 'skills', e)), 'missing engine: skills/' + e)
  }
})

test('no engine log() string is left in Spanish', async () => {
  // Three hand-written sweeps each missed strings, because each guessed at patterns. This
  // enumerates every literal inside every log() call and rejects known Spanish words outright.
  const SPANISH = /\b(nuevas?|duplicadas?|saltadas?|fallidas?|estrategia|aprobada|soportado|archivan|desactivado|aislado|hallazgos?|bloqueantes?|veredicto|terminado|reparados?|regresi[oó]n|aserci[oó]n|unidades|cobertura|muestreo|ronda|huecos?|riesgos?|evaluadas?|pendientes?|abiertas|verificadas|dudas|sanar|un solo|no hay|issues? nuevas)\b/i
  const engines = ['qa-explore/engine/codify.workflow.js', 'qa-explore/engine/explore-verify.workflow.js',
    'qa-explore/engine/report-issues.workflow.js', 'qa-fix/engine/qa-fix.workflow.js',
    'qa-gate/engine/qa-gate.workflow.js', 'qa-heal/engine/qa-heal.workflow.js',
    'qa-plan/engine/qa-plan.workflow.js']
  const offenders = []
  for (const rel of engines) {
    const src = readFileSync(ENGINE(rel), 'utf8')
    for (const line of src.split('\n')) {
      if (!/\blog\(/.test(line)) continue
      for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        if (SPANISH.test(m[1])) offenders.push(rel + ': ' + m[1].trim())
      }
    }
  }
  assert.deepEqual(offenders, [], 'Spanish left in user-facing log output')
})

test('all engine files load (parse) on the shim', async () => {
  const { loadWorkflow } = await import('../src/runtime.mjs')
  for (const p of [
    'qa-explore/engine/explore-verify.workflow.js',
    'qa-explore/engine/report-issues.workflow.js',
    'qa-explore/engine/codify.workflow.js',
    'qa-fix/engine/qa-fix.workflow.js',
    'qa-heal/engine/qa-heal.workflow.js',
    'qa-manual/engine/qa-manual.workflow.js',
    'qa-gate/engine/qa-gate.workflow.js',
    'qa-plan/engine/qa-plan.workflow.js',
  ]) {
    assert.equal(typeof loadWorkflow(ENGINE(p)), 'function', 'loads ' + p)
  }
})

test('qa-plan ranking is deterministic: risk = impact×likelihood → P0/P1/P2, ordered', async () => {
  const stub = async (_p, opts) => {
    if (opts && opts.label === 'assess-risk') return { areas: [
      { key: 'pay', label: 'Payments', mission: 'm', impact: 5, likelihood: 4, rationale: 'r', done: 'd' },   // 20 → P0
      { key: 'prof', label: 'Profile', mission: 'm', impact: 2, likelihood: 2, rationale: 'r', done: 'd' },   // 4  → P2
      { key: 'search', label: 'Search', mission: 'm', impact: 3, likelihood: 3, rationale: 'r', done: 'd' },  // 9  → P1
    ] }
    return (opts && opts.schema) ? { markdown: '# plan' } : ''
  }
  const { result } = await runWorkflow({ scriptPath: ENGINE('qa-plan/engine/qa-plan.workflow.js'), args: { baseUrl: 'http://x.test' }, agent: stub, sink })
  assert.deepEqual(result.plan.map((a) => a.key), ['pay', 'search', 'prof'])      // ordered by risk desc
  assert.equal(result.plan[0].risk, 20)
  assert.deepEqual(result.plan.map((a) => a.priority), ['P0', 'P1', 'P2'])
  assert.deepEqual(result.counts, { P0: 1, P1: 1, P2: 1 })
  assert.deepEqual(result.areas.map((a) => a.key), ['pay', 'search', 'prof'])     // seeds qa-explore riskiest-first
})

test('qa-gate verdict is deterministic: a confirmed major = NO-GO; clean = GO; waived = GO', async () => {
  const stub = async (_p, opts) => (opts && opts.schema ? { markdown: '# sign-off' } : '')
  const run = (results, gate) => runWorkflow({ scriptPath: ENGINE('qa-gate/engine/qa-gate.workflow.js'), args: { results, gate }, agent: stub, sink })

  // a confirmed major finding blocks the release
  const withMajor = [
    { key: 'step0', step0: { ran: true, failed: 0 } },
    { area: 'A', key: 'a', explore: { findings: [{ severity: 'major', confidence: 'hard-evidence', title: 'data leak', evidence: 't.zip' }] }, verify: { verdicts: [] } },
  ]
  const r1 = (await run(withMajor, {})).result
  assert.equal(r1.verdict, 'NO-GO')
  assert.equal(r1.blockers.length, 1)
  assert.equal(r1.blockers[0].title, 'data leak')

  // only a minor (not in blockOn) → GO
  const clean = [
    { key: 'step0', step0: { ran: true, failed: 0 } },
    { area: 'A', key: 'a', explore: { findings: [{ severity: 'minor', confidence: 'hard-evidence', title: 'typo' }] }, verify: { verdicts: [] } },
  ]
  assert.equal((await run(clean, {})).result.verdict, 'GO')

  // a red Step-0 baseline blocks
  const redSuite = [{ key: 'step0', step0: { ran: true, failed: 3 } }]
  assert.equal((await run(redSuite, {})).result.verdict, 'NO-GO')

  // the same major, WAIVED with a reason → GO, but recorded as an accepted risk
  const r4 = (await run(withMajor, { waive: [{ match: 'data leak', reason: 'fp', approvedBy: 'lead' }] })).result
  assert.equal(r4.verdict, 'GO')
  assert.equal(r4.waived.length, 1)
  assert.equal(r4.waived[0].approvedBy, 'lead')

  // an UNCONFIRMED major (no verify verdict, not hard-evidence) does NOT block
  const unconf = [
    { key: 'step0', step0: { ran: true, failed: 0 } },
    { area: 'A', key: 'a', explore: { findings: [{ severity: 'major', confidence: 'judgement', title: 'maybe' }] }, verify: { verdicts: [] } },
  ]
  assert.equal((await run(unconf, {})).result.verdict, 'GO')
})
