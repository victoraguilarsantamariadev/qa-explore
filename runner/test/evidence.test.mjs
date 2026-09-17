// Evidence housekeeping: the prune step DELETES files, so its rules are pinned here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = resolve(HERE, '..', '..', 'skills', 'qa-explore', 'engine', 'evidence.mjs')

function run(args, opts = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts }) }
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }
  }
}

// A miniature evidence dir shaped like a real run: two areas, one of which produced a kept finding.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qa-evidence-test-'))
  const files = {
    keptTrace: join(root, 'widgets', 'trace-1.zip'),
    dropTrace: join(root, 'widgets', 'trace-2.zip'),
    otherTrace: join(root, 'contracts', 'trace-1.zip'),
    keptVideo: join(root, 'widgets', 'video', 'page@abc.webm'),
    dropVideo: join(root, 'contracts', 'video', 'page@def.webm'),
    har: join(root, 'contracts', 'network.har'),
    shot: join(root, 'contracts', '01-step.png'),
    console: join(root, 'contracts', 'console.log'),
    report: join(root, 'INFORME.md'),
  }
  for (const p of Object.values(files)) {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, 'x'.repeat(1024))
  }
  return { root, files, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('prune drops unreferenced trace/video/har and never touches screenshots or reports', () => {
  const { root, files, cleanup } = fixture()
  const keep = join(root, 'keep.json')
  writeFileSync(keep, JSON.stringify([files.keptTrace, files.keptVideo]))

  const { code } = run(['prune', root, '--keep', keep])
  assert.equal(code, 0)

  assert.ok(existsSync(files.keptTrace), 'a trace behind a confirmed finding survives')
  assert.ok(existsSync(files.keptVideo), 'its video survives')
  assert.ok(!existsSync(files.dropTrace), 'an unreferenced trace is gone')
  assert.ok(!existsSync(files.otherTrace))
  assert.ok(!existsSync(files.dropVideo))
  assert.ok(!existsSync(files.har))

  assert.ok(existsSync(files.shot), 'screenshots are the report — never pruned')
  assert.ok(existsSync(files.console))
  assert.ok(existsSync(files.report))
  cleanup()
})

test('a directory in the keep list keeps its whole subtree', () => {
  const { root, files, cleanup } = fixture()
  const keep = join(root, 'keep.txt')
  writeFileSync(keep, join(root, 'widgets') + '\n')       // newline format, a directory

  run(['prune', root, '--keep', keep])
  assert.ok(existsSync(files.keptTrace))
  assert.ok(existsSync(files.dropTrace), 'everything under a kept directory stays')
  assert.ok(existsSync(files.keptVideo))
  assert.ok(!existsSync(files.otherTrace), 'other areas are still pruned')
  cleanup()
})

test('--dry-run reports but deletes nothing', () => {
  const { root, files, cleanup } = fixture()
  const keep = join(root, 'keep.json')
  writeFileSync(keep, JSON.stringify([]))

  const { code, out } = run(['prune', root, '--keep', keep, '--dry-run'])
  assert.equal(code, 0)
  assert.match(out, /DRY RUN/)
  assert.ok(existsSync(files.dropTrace), 'dry run leaves the disk untouched')
  assert.ok(existsSync(files.har))
  cleanup()
})

test('retain=all prunes nothing', () => {
  const { root, files, cleanup } = fixture()
  const { code, out } = run(['prune', root, '--retain', 'all'])
  assert.equal(code, 0)
  assert.match(out, /nothing pruned/)
  assert.ok(existsSync(files.dropTrace))
  cleanup()
})

test('prune without a keep list refuses instead of wiping everything', () => {
  const { root, files, cleanup } = fixture()
  const { code, out } = run(['prune', root])
  assert.equal(code, 1)
  assert.match(out, /--keep <file> is required/)
  assert.ok(existsSync(files.dropTrace))
  cleanup()
})

test('prune refuses a root that is not an evidence directory', () => {
  for (const bad of ['/', '/home', '/tmp']) {
    const { code, out } = run(['prune', bad, '--keep', '/dev/null'])
    assert.equal(code, 1, bad + ' must be refused')
    assert.match(out, /refusing to prune/)
  }
})

test('unreadable keep paths are reported, not silently ignored', () => {
  const { root, cleanup } = fixture()
  const keep = join(root, 'keep.json')
  writeFileSync(keep, JSON.stringify([join(root, 'widgets', 'trace-never-written.zip')]))

  const { out } = run(['prune', root, '--keep', keep])
  assert.match(out, /do not exist on disk/)
  cleanup()
})

test('check flags a tmpfs shotsDir with exit code 2', { skip: !isTmpfs('/dev/shm') }, () => {
  const { code, out } = run(['check', '/dev/shm/qa-evidence-probe'])
  assert.equal(code, 2, 'a RAM-backed shotsDir must be refused')
  assert.match(out, /TMPFS|RAM/)
})

test('check passes on a disk-backed shotsDir', () => {
  const { root, cleanup } = fixture()
  const { code, out } = run(['check', root])
  if (isTmpfs(root)) return cleanup()      // the test tmpdir itself is RAM here; nothing to assert
  assert.equal(code, 0)
  assert.match(out, /evidence lands on disk/)
  cleanup()
})

function isTmpfs(p) {
  try {
    return /\btmpfs\b/.test(execFileSync('findmnt', ['-no', 'FSTYPE', '--target', p], { encoding: 'utf8' }))
  } catch { return false }   // no findmnt (not Linux) → treat as disk and skip the tmpfs assertions
}
