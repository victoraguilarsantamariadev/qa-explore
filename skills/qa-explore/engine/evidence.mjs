#!/usr/bin/env node
// qa-explore — evidence housekeeping. Deterministic, no model involved.
//
//   node evidence.mjs check <shotsDir>
//       Where will the evidence actually land? A full run writes GBs of trace/video; if shotsDir sits
//       on a tmpfs (the old "/tmp/qa-explore" default) that is RAM, and it stays eaten until something
//       deletes it. Exits 2 on a volatile filesystem so the caller can refuse to run.
//
//   node evidence.mjs prune <shotsDir> --keep <file> [--retain <policy>] [--dry-run] [--max-trace-mb N]
//       Drop the heavy artifacts nobody needs any more. Traces/videos/HARs are captured for EVERY area
//       and EVERY suspicion, but only the ones behind a confirmed finding are ever opened again — those
//       are the paths in --keep (JSON array or one path per line; a directory keeps its whole subtree).
//       Screenshots, console logs and reports are NEVER touched: they are small and they are the report.
//
// Exit codes: 0 ok · 1 usage/safety error · 2 check found a volatile filesystem.

import { existsSync, readFileSync, readdirSync, statSync, realpathSync, unlinkSync, rmdirSync } from 'node:fs'
import * as fs from 'node:fs'
import { resolve, join, extname, sep, basename, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'

// Heavy, regenerable, and only useful while a finding is alive. The optional compression suffix catches
// artifacts squeezed by hand when the disk got tight (network.har.gz).
const PRUNABLE_RE = /\.(zip|webm|har)(\.(gz|zst|br))?$/i
// Filesystems that live in RAM: evidence written here is memory the machine cannot use for anything else.
const VOLATILE = new Set(['tmpfs', 'ramfs', 'devtmpfs'])
// Never let a typo'd shotsDir turn into a walk over somebody's home directory.
const FORBIDDEN_ROOTS = new Set(['/', '/home', '/root', '/usr', '/etc', '/var', '/opt', '/srv', '/tmp', '/mnt', homedir()])

const die = (msg, code = 1) => { console.error('evidence: ' + msg); process.exit(code) }
const mb = (bytes) => (bytes / 1048576)
const human = (bytes) => (bytes >= 1073741824 ? (bytes / 1073741824).toFixed(1) + ' GB' : Math.round(mb(bytes)) + ' MB')

// ---- filesystem introspection -------------------------------------------------------------------

// Longest mount point that is a prefix of `p`. Linux only (/proc/mounts); null anywhere else.
function fsTypeOf(p) {
  let mounts
  try { mounts = readFileSync('/proc/mounts', 'utf8') } catch { return null }
  let best = null
  for (const line of mounts.split('\n')) {
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const mnt = parts[1].replace(/\\040/g, ' ')
    const under = p === mnt || p.startsWith(mnt === '/' ? '/' : mnt + sep)
    if (under && (!best || mnt.length > best.mnt.length)) best = { mnt, type: parts[2] }
  }
  return best && best.type
}

// Does this path live in RAM? Exported so the headless runner can apply the same guard as the skill.
export function volatileFsAt(p) {
  const type = fsTypeOf(nearestExisting(resolve(p)))
  return (type && VOLATILE.has(type)) ? type : null
}

// The deepest ancestor of `p` that exists — a shotsDir is often checked before its first run created it.
function nearestExisting(p) {
  let cur = p
  while (cur && cur !== sep && !existsSync(cur)) cur = resolve(cur, '..')
  return cur
}

function freeSpace(p) {
  try { const s = fs.statfsSync(p); return s.bavail * s.bsize } catch { return null }
}

// ---- walking -------------------------------------------------------------------------------------

// Files under `dir`, never following symlinked directories (a symlink out of shotsDir must not be pruned).
function* walk(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile()) {
      let size = 0
      try { size = statSync(p).size } catch { continue }
      yield { path: p, size, ext: extOf(e.name) }
    }
  }
}

// Bucket a file by artifact kind, so .har and .har.gz report as the same line.
function extOf(name) {
  const m = PRUNABLE_RE.exec(name)
  return m ? '.' + m[1].toLowerCase() + (m[2] ? m[2].toLowerCase() : '') : extname(name).toLowerCase()
}

// `budget` caps how many files are counted: `check` may be pointed at a directory that is not an
// evidence dir at all, and walking a whole home directory to print one number is not worth the wait.
function dirSize(dir, budget = Infinity) {
  let bytes = 0, files = 0
  for (const f of walk(dir)) {
    bytes += f.size
    if (++files >= budget) return { bytes, files, truncated: true }
  }
  return { bytes, files, truncated: false }
}

// Directories that became empty after a prune (e.g. an area's video/ folder), deepest first.
function removeEmptyDirs(dir) {
  let removed = 0
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    if (e.isDirectory() && !e.isSymbolicLink()) removed += removeEmptyDirs(join(dir, e.name))
  }
  try {
    if (readdirSync(dir).length === 0) { rmdirSync(dir); removed++ }
  } catch { /* not empty, or gone */ }
  return removed
}

// ---- check ---------------------------------------------------------------------------------------

function cmdCheck(target) {
  if (!target) die('usage: evidence.mjs check <shotsDir>')
  const abs = resolve(target)
  const probe = nearestExisting(abs)
  const type = fsTypeOf(probe)
  const free = freeSpace(probe)

  console.log('shotsDir : ' + abs + (existsSync(abs) ? '' : '   (does not exist yet)'))
  console.log('filesystem: ' + (type || 'unknown (not Linux — could not read /proc/mounts)'))
  if (free != null) console.log('free space: ' + human(free))
  if (existsSync(abs)) {
    const { bytes, files, truncated } = dirSize(abs, 50000)
    console.log('currently : ' + (truncated ? 'over ' : '') + human(bytes) + ' in ' + (truncated ? 'over ' : '') + files + ' files' +
      (truncated ? '   (stopped counting — is this really an evidence directory?)' : ''))
  }

  // Playwright leaves its working artifacts behind whenever a context is not closed; report, never delete
  // (a run in progress owns those directories).
  try {
    const orphans = readdirSync('/tmp', { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('playwright-artifacts-'))
      .map((e) => ({ name: e.name, ...dirSize(join('/tmp', e.name)) }))
      .filter((o) => o.bytes > 0)
    if (orphans.length) {
      const total = orphans.reduce((s, o) => s + o.bytes, 0)
      console.log('\nleftover Playwright temp dirs: ' + orphans.length + ' (' + human(total) + ') in /tmp')
      console.log('  → from contexts that were never closed. Safe to delete once no run is in progress:')
      console.log('    rm -rf /tmp/playwright-artifacts-*')
    }
  } catch { /* no /tmp, fine */ }

  if (type && VOLATILE.has(type)) {
    console.error('\n⚠️  ' + type.toUpperCase() + ' — this directory is RAM, not disk.')
    console.error('    A full run writes several GB of trace/video here and nothing frees it until it is deleted.')
    console.error('    Move "shotsDir" in qa.config.json to a real disk path (e.g. "./qa-evidence") before running.')
    process.exit(2)
  }
  console.log('\nok — evidence lands on disk.')
}

// ---- prune ---------------------------------------------------------------------------------------

function assertSafeRoot(root) {
  if (!existsSync(root)) die('shotsDir does not exist: ' + root)
  if (!statSync(root).isDirectory()) die('shotsDir is not a directory: ' + root)
  if (FORBIDDEN_ROOTS.has(root)) die('refusing to prune ' + root + ' — that is not an evidence directory')
  if (root.split(sep).filter(Boolean).length < 2) die('refusing to prune a top-level directory: ' + root)
}

// The keep list is whatever the caller decided is still worth having: paths straight off the findings.
// Findings cite evidence the way the report does — usually RELATIVE to shotsDir ("D-catalogo/trace-1.zip"),
// sometimes absolute — so relative entries resolve against the evidence root, not against the cwd.
function loadKeep(file, root) {
  if (!existsSync(file)) die('--keep file not found: ' + file)
  const raw = readFileSync(file, 'utf8').trim()
  let list
  if (raw.startsWith('[')) {
    try { list = JSON.parse(raw) } catch (e) { die('--keep is not valid JSON: ' + e.message) }
  } else {
    list = raw.split('\n')
  }
  const files = new Set(), dirs = [], missing = []
  for (const entry of list) {
    const s = String(entry || '').trim()
    if (!s || s === 'none' || s === 'null') continue
    const abs = isAbsolute(s) ? s : resolve(root, s)
    let real = abs
    try { real = realpathSync(abs) } catch { missing.push(s); continue }
    if (statSync(real).isDirectory()) dirs.push(real.endsWith(sep) ? real : real + sep)
    else files.add(real)
  }
  return { files, dirs, missing }
}

function cmdPrune(argv) {
  const target = argv.find((a) => !a.startsWith('-'))
  if (!target) die('usage: evidence.mjs prune <shotsDir> --keep <file> [--retain confirmed-only|findings|all] [--dry-run] [--max-trace-mb N]')
  const flag = (name, def) => { const i = argv.indexOf(name); return i === -1 ? def : argv[i + 1] }
  const dryRun = argv.includes('--dry-run')
  const retain = flag('--retain', 'confirmed-only')
  const keepFile = flag('--keep', null)
  const maxTraceMb = Number(flag('--max-trace-mb', 0)) || 0

  const root = realpathSync(resolve(target))
  assertSafeRoot(root)

  const before = dirSize(root)
  if (retain === 'all') {
    console.log('retain=all → nothing pruned. ' + root + ' holds ' + human(before.bytes) + ' in ' + before.files + ' files.')
    return
  }

  // No keep list means nothing is spared — almost certainly a caller bug, not an intent to wipe everything.
  if (!keepFile) die('--keep <file> is required (use --retain all to prune nothing)')
  const keep = loadKeep(keepFile, root)
  const isKept = (p) => keep.files.has(p) || keep.dirs.some((d) => p.startsWith(d))

  const stats = {}
  const bump = (ext, kind, size) => {
    stats[ext] = stats[ext] || { keptN: 0, keptB: 0, goneN: 0, goneB: 0 }
    stats[ext][kind + 'N']++
    stats[ext][kind + 'B'] += size
  }

  let freed = 0, deleted = 0, failed = 0
  const oversized = []
  for (const f of walk(root)) {
    if (!PRUNABLE_RE.test(f.path)) continue
    if (isKept(f.path)) {
      bump(f.ext, 'kept', f.size)
      if (maxTraceMb && f.ext.startsWith('.zip') && mb(f.size) > maxTraceMb) oversized.push(f)
      continue
    }
    bump(f.ext, 'gone', f.size)
    if (!dryRun) {
      try { unlinkSync(f.path) } catch (e) { failed++; console.error('  could not delete ' + f.path + ': ' + e.message); continue }
    }
    freed += f.size
    deleted++
  }

  const emptied = dryRun ? 0 : removeEmptyDirs(root)
  const after = dryRun ? { bytes: before.bytes - freed, files: before.files - deleted } : dirSize(root)

  console.log((dryRun ? 'DRY RUN — ' : '') + 'pruned ' + root + '  (retain=' + retain + ')')
  for (const ext of Object.keys(stats).sort()) {
    const s = stats[ext]
    console.log('  ' + ext.padEnd(8) + (dryRun ? 'would free ' : 'freed ') + human(s.goneB).padStart(8) + ' (' + s.goneN + ')' +
      '   kept ' + human(s.keptB).padStart(8) + ' (' + s.keptN + ')')
  }
  console.log('  ' + '-'.repeat(60))
  console.log('  ' + (dryRun ? 'would free ' : 'freed ') + human(freed) + ' in ' + deleted + ' files' + (emptied ? ' (+' + emptied + ' empty dirs)' : ''))
  console.log('  evidence dir: ' + human(before.bytes) + ' → ' + human(after.bytes) + ' in ' + after.files + ' files' + (dryRun ? '  (projected)' : ''))
  if (failed) console.log('  ⚠️  ' + failed + ' file(s) could not be deleted')
  if (keep.missing.length) {
    console.log('  ⚠️  ' + keep.missing.length + ' kept path(s) do not exist on disk (reported by an agent but never written):')
    keep.missing.slice(0, 5).forEach((m) => console.log('      ' + m))
  }
  if (oversized.length) {
    console.log('  ⚠️  ' + oversized.length + ' kept trace(s) over ' + maxTraceMb + ' MB — too big to attach to an issue:')
    oversized.slice(0, 5).forEach((f) => console.log('      ' + Math.round(mb(f.size)) + ' MB  ' + basename(f.path)))
  }
}

// ---- main ----------------------------------------------------------------------------------------

// Only act as a CLI when run as one — the runner imports volatileFsAt() from here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'check') cmdCheck(rest[0])
  else if (cmd === 'prune') cmdPrune(rest)
  else die('usage: evidence.mjs check <shotsDir>  |  evidence.mjs prune <shotsDir> --keep <file> [--retain …] [--dry-run]')
}
