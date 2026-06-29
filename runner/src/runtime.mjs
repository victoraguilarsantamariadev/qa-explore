// qa-explore runner — workflow runtime shim.
// Runs the EXACT same `*.workflow.js` engine files the Claude Code plugin uses, by providing the
// same globals (agent / pipeline / parallel / phase / log / args / budget) on top of the Agent SDK.
// One engine, two runtimes (Claude Code harness + this standalone runner).
//
// The engine scripts are NOT normal ESM modules: they start with `export const meta = {...}`, use
// top-level `await`, and end with a top-level `return`. We wrap the body in an AsyncFunction and inject
// the globals — exactly how the harness's Workflow tool evaluates them.
import { readFileSync } from 'node:fs'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

// ---- concurrency limiter (shared across all agent() calls in a run) ----
export class Semaphore {
  constructor(max) { this.max = Math.max(1, max | 0); this.cur = 0; this.q = [] }
  acquire() {
    if (this.cur < this.max) { this.cur++; return Promise.resolve() }
    return new Promise((res) => this.q.push(res))
  }
  release() {
    this.cur--
    const next = this.q.shift()
    if (next) { this.cur++; next() }
  }
}

// ---- pipeline: each item flows through ALL stages independently (no barrier between stages) ----
// stage(prevResult, originalItem, index). A stage that THROWS drops that item to null + skips its rest.
export async function pipeline(items, ...stages) {
  return Promise.all((items || []).map(async (item, i) => {
    let v = item
    for (let s = 0; s < stages.length; s++) {
      try { v = await stages[s](v, item, i) } catch { return null }
    }
    return v
  }))
}

// ---- parallel: BARRIER. Run all thunks concurrently; a thrower resolves to null (never rejects). ----
export async function parallel(thunks) {
  return Promise.all((thunks || []).map((t) => Promise.resolve().then(t).catch(() => null)))
}

export function loadWorkflow(scriptPath) {
  let src = readFileSync(scriptPath, 'utf8')
  // `export const meta = {...}`  ->  capture into the injected __capture object instead of exporting.
  src = src.replace(/export\s+const\s+meta\s*=/, '__capture.meta =')
  // Defensive: the engines export nothing else, but strip any stray leading `export ` just in case.
  src = src.replace(/^\s*export\s+(?=(const|let|var|function|class)\s)/gm, '')
  return new AsyncFunction('agent', 'pipeline', 'parallel', 'phase', 'log', 'args', 'budget', '__capture', src)
}

const defaultBudget = { total: null, spent: () => 0, remaining: () => Infinity }

// Execute a workflow file. `agent` is the SDK-backed (or stubbed) implementation.
export async function runWorkflow({ scriptPath, args, agent, budget = defaultBudget, sink = process.stderr }) {
  const fn = loadWorkflow(scriptPath)
  const capture = {}
  const phase = (t) => sink.write('\n▶ ' + t + '\n')
  const log = (m) => sink.write('  · ' + m + '\n')
  const result = await fn(agent, pipeline, parallel, phase, log, args, budget, capture)
  return { meta: capture.meta, result }
}
