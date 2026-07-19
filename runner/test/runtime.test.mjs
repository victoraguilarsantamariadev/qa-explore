// Validates the runtime shim WITHOUT a model: pipeline/parallel semantics + that the REAL engine
// files load and run on the shim when agent() is stubbed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { pipeline, parallel, runWorkflow } from '../src/runtime.mjs'

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

test('all engine files load (parse) on the shim', async () => {
  const { loadWorkflow } = await import('../src/runtime.mjs')
  for (const p of [
    'qa-explore/engine/explore-verify.workflow.js',
    'qa-explore/engine/report-issues.workflow.js',
    'qa-explore/engine/codify.workflow.js',
    'qa-fix/engine/qa-fix.workflow.js',
    'qa-heal/engine/qa-heal.workflow.js',
    'qa-manual/engine/qa-manual.workflow.js',
  ]) {
    assert.equal(typeof loadWorkflow(ENGINE(p)), 'function', 'loads ' + p)
  }
})
