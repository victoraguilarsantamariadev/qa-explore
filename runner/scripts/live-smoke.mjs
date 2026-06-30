#!/usr/bin/env node
// Live smoke for the standalone runner — exercises the REAL Claude Agent SDK path end-to-end
// (makeAgent -> SDK query -> result) WITHOUT a browser or target. It proves the live agent wiring
// works headless; the engine workflows then layer browser agents on top of this same path.
//
// Costs a few tokens, so it lives OUTSIDE test/ and is NOT part of `node --test`. Run it explicitly:
//   npm run smoke
// Auth: inherits Claude Code credentials on a logged-in machine (subscription), or set
// CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`) / ANTHROPIC_API_KEY in CI.
import assert from 'node:assert/strict'
import { makeAgent } from '../src/agent.mjs'

let query
try {
  ;({ query } = await import('@anthropic-ai/claude-agent-sdk'))
} catch (e) {
  console.error('SKIP live-smoke: @anthropic-ai/claude-agent-sdk not installed (run `npm install`).')
  console.error('  ' + (e && e.message ? e.message : e))
  process.exit(2)
}

const agent = makeAgent({ query, concurrency: 1 })

// 1) Plain text agent — the basic query path returns a non-empty string.
console.error('live-smoke · text agent…')
const text = await agent('Reply with exactly the word: OK. No punctuation, no other words.', {
  label: 'smoke-text',
})
assert.ok(text && /ok/i.test(text), 'text agent returned: ' + JSON.stringify(text))

// 2) Structured agent — the schema path returns a validated object (msg.structured_output).
console.error('live-smoke · structured agent…')
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
}
const obj = await agent('Return a JSON object with a single boolean field "ok" set to true.', {
  label: 'smoke-json',
  schema,
})
assert.ok(obj && obj.ok === true, 'structured agent returned: ' + JSON.stringify(obj))

console.error('\n✓ live smoke passed · spent $' + agent.totalCost().toFixed(4))
