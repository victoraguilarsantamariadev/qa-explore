// The SDK-facing layer: what options a run sends, and — more important — that a failing agent NEVER
// takes the run down with it. A workflow fans out dozens of these; one throw must cost one agent.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAgent } from '../src/agent.mjs'
import { Semaphore } from '../src/runtime.mjs'

const sink = { write() {} }

// Stands in for the Agent SDK's query(): records what it was asked, yields the messages it is given.
function fakeQuery(messagesFor = () => [{ type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.01 }]) {
  const seen = []
  const query = async function* ({ prompt, options }) {
    seen.push({ prompt, options })
    for (const m of messagesFor({ prompt, options })) yield m
  }
  query.seen = seen
  return query
}

test('dry-run spawns nothing and still returns the shape the engines expect', async () => {
  const query = fakeQuery()
  const agent = makeAgent({ query, dryRun: true, sink })
  assert.deepEqual(await agent('do a thing', { schema: { type: 'object' } }), {})
  assert.equal(await agent('do a thing'), '')
  assert.equal(query.seen.length, 0)
  assert.equal(agent.totalCost(), 0)
})

test('a structured call asks the SDK for json_schema output; a plain one does not', async () => {
  const query = fakeQuery(() => [{ type: 'result', subtype: 'success', result: 'text', structured_output: { ok: true } }])
  const agent = makeAgent({ query, model: 'default-model', sink })
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }

  assert.deepEqual(await agent('p', { schema }), { ok: true }, 'structured output is returned, not the text')
  assert.deepEqual(query.seen[0].options.outputFormat, { type: 'json_schema', schema })

  assert.equal(await agent('p'), 'text', 'without a schema the caller gets the text back')
  assert.equal(query.seen[1].options.outputFormat, undefined)
})

test('the run is headless by contract: permissions bypassed, cwd honoured, model overridable per call', async () => {
  const query = fakeQuery()
  const agent = makeAgent({ query, model: 'default-model', cwd: '/work', sink })
  await agent('p')
  await agent('p', { model: 'other-model' })

  assert.equal(query.seen[0].options.permissionMode, 'bypassPermissions')
  assert.equal(query.seen[0].options.allowDangerouslySkipPermissions, true)
  assert.equal(query.seen[0].options.cwd, '/work')
  assert.equal(query.seen[0].options.model, 'default-model')
  assert.equal(query.seen[1].options.model, 'other-model', 'a per-call model wins over the run default')
})

test('an SDK error result yields null instead of taking the workflow down', async () => {
  const query = fakeQuery(() => [{ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.02 }])
  const agent = makeAgent({ query, sink })
  assert.equal(await agent('p', { schema: { type: 'object' } }), null)
  assert.equal(agent.totalCost(), 0.02, 'a failed agent still cost money — it must still be counted')
})

test('a throwing query yields null too', async () => {
  const query = async function* () { throw new Error('socket hang up') }
  const agent = makeAgent({ query, sink })
  assert.equal(await agent('p'), null)
})

test('a successful call with no structured output returns null rather than a bogus object', async () => {
  const query = fakeQuery(() => [{ type: 'result', subtype: 'success', result: 'text' }])
  const agent = makeAgent({ query, sink })
  assert.equal(await agent('p', { schema: { type: 'object' } }), null)
})

test('cost accumulates across the whole run and is reported per agent', async () => {
  const query = fakeQuery(() => [{ type: 'result', subtype: 'success', result: '', total_cost_usd: 0.25 }])
  const seen = []
  const agent = makeAgent({ query, sink, onResult: (r) => seen.push(r) })
  await agent('a', { label: 'one' })
  await agent('b', { label: 'two' })
  assert.equal(agent.totalCost().toFixed(2), '0.50')
  assert.deepEqual(seen.map((r) => r.label), ['one', 'two'])
  assert.deepEqual(seen.map((r) => r.isError), [false, false])
})

test('concurrency is capped: agent N+1 waits for a slot', async () => {
  let live = 0, peak = 0
  const query = async function* () {
    live++; peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 10))
    live--
    yield { type: 'result', subtype: 'success', result: '' }
  }
  const agent = makeAgent({ query, concurrency: 2, sink })
  await Promise.all(Array.from({ length: 6 }, (_, i) => agent('p' + i)))
  assert.equal(peak, 2, 'peak concurrency was ' + peak + ', expected the configured 2')
})

test('the slot is released even when the agent fails, or the run would deadlock', async () => {
  let calls = 0
  const query = async function* () { calls++; throw new Error('boom') }
  const agent = makeAgent({ query, concurrency: 1, sink })
  await Promise.all([agent('a'), agent('b'), agent('c')])
  assert.equal(calls, 3, 'all three ran: a failure did not hold the only slot')
})

// ---- the limiter underneath ----------------------------------------------------------------------

test('Semaphore never lets more than max through, and queues the rest in order', async () => {
  const sem = new Semaphore(2)
  const order = []
  const task = async (id) => {
    await sem.acquire()
    order.push(id)
    await new Promise((r) => setTimeout(r, 5))
    sem.release()
  }
  await Promise.all([1, 2, 3, 4].map(task))
  assert.deepEqual(order, [1, 2, 3, 4])
})

test('Semaphore clamps a nonsense max to at least one instead of hanging forever', async () => {
  for (const bad of [0, -3, NaN]) {
    const sem = new Semaphore(bad)
    assert.equal(sem.max, 1, 'max ' + bad + ' must clamp to 1')
    await sem.acquire()
    sem.release()
  }
})
