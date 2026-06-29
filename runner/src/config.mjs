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

export function loadConfig(cwd = process.cwd(), explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : ['qa.config.json', 'qa.config.jsonc', 'test/E2E/qa.config.json', 'e2e/qa.config.json'].map((p) => resolve(cwd, p))
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, config: JSON.parse(stripJsonc(readFileSync(p, 'utf8'))) }
  }
  throw new Error('qa.config.json not found (looked in: ' + candidates.join(', ') + ')')
}
