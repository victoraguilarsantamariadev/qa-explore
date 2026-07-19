// Minimal JSONC reader (string-aware comment + trailing-comma stripper) for qa.config.json[c].
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function stripJsonc(s) {
  let out = '', i = 0, inStr = false, esc = false
  while (i < s.length) {
    const c = s[i], n = s[i + 1]
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; i++; continue }
    if (c === '"') { inStr = true; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue }
    out += c; i++
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

// Fill in the portability defaults so every engine can rely on them being present.
// - bootTimeout (#4): SPAs whose first load is slow (cold build) must not false-negative on a fixed wait.
// - login (#3): accept a bare storageState path string ("…state.json") as shorthand for { storageStatePath }.
//   A prose recipe string (the classic form) is left untouched; an object is passed through.
// - manual (#2): qa-manual reads its knobs from here.
export function normalizeConfig(config = {}) {
  const c = { ...config }
  if (c.bootTimeout == null) c.bootTimeout = 90000
  if (typeof c.login === 'string' && /\.json\s*$/.test(c.login)) c.login = { storageStatePath: c.login.trim() }
  if (c.manual == null) c.manual = {}
  return c
}

export function loadConfig(cwd = process.cwd(), explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : ['qa.config.json', 'qa.config.jsonc', 'test/E2E/qa.config.json', 'e2e/qa.config.json'].map((p) => resolve(cwd, p))
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, config: normalizeConfig(JSON.parse(stripJsonc(readFileSync(p, 'utf8')))) }
  }
  throw new Error('qa.config.json not found (looked in: ' + candidates.join(', ') + ')')
}
