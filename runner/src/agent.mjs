// qa-explore runner — the agent() implementation, backed by the Claude Agent SDK.
// Maps the harness contract `agent(prompt, { schema, label, model, isolation, ... })` onto SDK query().
// Auth: the SDK launches Claude Code under the hood and inherits its credentials — so on a machine
// logged into Claude Code it runs on your SUBSCRIPTION (no API key). In CI, provide a credential
// (CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`, or ANTHROPIC_API_KEY) as an env secret.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Semaphore } from './runtime.mjs'

// Make a worktree-isolated copy of `repo`, return its path (or null on failure).
function addWorktree(repo, id) {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'qa-wt-' + id + '-'))
    execFileSync('git', ['worktree', 'add', '--detach', dir], { cwd: repo, stdio: 'ignore' })
    return dir
  } catch { return null }
}
function removeWorktree(repo, dir) {
  try { execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo, stdio: 'ignore' }) }
  catch { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
}

// opts of agent(): { schema, label, phase, model, effort, isolation, agentType }
export function makeAgent({ query, model, cwd = process.cwd(), concurrency = 8, dryRun = false, sink = process.stderr, onResult } = {}) {
  const sem = new Semaphore(concurrency)
  let counter = 0
  let totalCost = 0

  async function agent(prompt, opts = {}) {
    const id = ++counter
    const label = opts.label || ('agent-' + id)
    if (dryRun) {
      sink.write('  [dry-run] would spawn ' + label + (opts.schema ? ' (structured)' : '') + (opts.isolation ? ' [' + opts.isolation + ']' : '') + '\n')
      return opts.schema ? {} : ''
    }

    await sem.acquire()
    let runCwd = opts.cwd || cwd
    let wt = null
    if (opts.isolation === 'worktree') { wt = addWorktree(runCwd, id); if (wt) runCwd = wt }
    try {
      const options = {
        model: opts.model || model,                  // undefined → SDK/session default
        cwd: runCwd,
        permissionMode: 'bypassPermissions',          // headless: agents use tools unattended
        allowDangerouslySkipPermissions: true,        // required companion flag for bypassPermissions
      }
      if (opts.schema) options.outputFormat = { type: 'json_schema', schema: opts.schema }

      let resultText = '', structured, cost = 0, isError = false, errMsg = ''
      for await (const msg of query({ prompt, options })) {
        if (msg.type === 'result') {
          cost = msg.total_cost_usd || 0
          if (msg.subtype === 'success') { resultText = msg.result || ''; structured = msg.structured_output }
          else { isError = true; errMsg = msg.subtype || 'error' }
        }
      }
      totalCost += cost
      if (onResult) onResult({ id, label, cost, isError })
      sink.write('  ✓ ' + label + (cost ? '  ($' + cost.toFixed(3) + ')' : '') + (isError ? '  [error: ' + errMsg + ']' : '') + '\n')
      if (isError) return null
      return opts.schema ? (structured ?? null) : resultText
    } catch (e) {
      sink.write('  ✗ ' + label + '  [' + (e && e.message ? e.message : e) + ']\n')
      return null
    } finally {
      if (wt) removeWorktree(opts.cwd || cwd, wt)
      sem.release()
    }
  }

  agent.totalCost = () => totalCost
  return agent
}
