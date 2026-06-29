#!/usr/bin/env node
// qa-explore standalone runner — run the qa-explore engines headless (no Claude Code session),
// e.g. in CI / on a PR. Uses the Claude Agent SDK; on a machine logged into Claude Code it runs on
// your subscription. Usage:
//   qa-explore <skill> [--config <path>] [--base <url>] [--model <id>] [--concurrency N] [--dry-run]
//   <skill> = explore | report | codify | fix | heal
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { runWorkflow } from '../src/runtime.mjs'
import { makeAgent } from '../src/agent.mjs'
import { loadConfig } from '../src/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILLS = resolve(HERE, '..', '..', 'skills')   // runner/ sits next to skills/ in the repo
const ENGINES = {
  explore: 'qa-explore/engine/explore-verify.workflow.js',
  report: 'qa-explore/engine/report-issues.workflow.js',
  codify: 'qa-explore/engine/codify.workflow.js',
  fix: 'qa-fix/engine/qa-fix.workflow.js',
  heal: 'qa-heal/engine/qa-heal.workflow.js',
}

function parseArgs(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--dry-run') a.dryRun = true
    else if (t.startsWith('--')) a[t.slice(2)] = argv[++i]
    else a._.push(t)
  }
  return a
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const skill = args._[0]
  if (!skill || !ENGINES[skill]) {
    console.error('usage: qa-explore <explore|report|codify|fix|heal> [--config <path>] [--base <url>] [--model <id>] [--concurrency N] [--dry-run]')
    process.exit(1)
  }
  const scriptPath = resolve(SKILLS, ENGINES[skill])

  const { path: cfgPath, config } = loadConfig(process.cwd(), args.config && resolve(args.config))
  if (args.base) config.baseUrl = args.base
  if (args.mode) config.mode = args.mode                 // CI safety override (e.g. read-only)
  console.error('qa-explore runner · skill=' + skill + ' · config=' + cfgPath + ' · target=' + (config.baseUrl || '(none)') + (args.dryRun ? ' · DRY-RUN' : ''))

  let sdkQuery = null
  if (!args.dryRun) {
    const mod = await import('@anthropic-ai/claude-agent-sdk')
    sdkQuery = mod.query
  }
  const agent = makeAgent({
    query: sdkQuery,
    model: args.model,
    cwd: process.cwd(),
    concurrency: args.concurrency ? Number(args.concurrency) : 8,
    dryRun: !!args.dryRun,
  })

  const { meta, result } = await runWorkflow({ scriptPath, args: config, agent })
  console.error('\n— done: ' + (meta && meta.name ? meta.name : skill) + ' · spent $' + agent.totalCost().toFixed(3))
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

main().catch((e) => { console.error('qa-explore runner failed:', e && e.stack ? e.stack : e); process.exit(1) })
