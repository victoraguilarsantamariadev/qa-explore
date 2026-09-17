// The config reader is the front door: everything the engines do is driven by what comes out of here,
// and a JSONC bug mangles the user's settings silently (a dropped "mode" is a write run on production).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripJsonc, loadConfig } from '../src/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

test('stripJsonc removes line and block comments', () => {
  const src = `{
    // a line comment
    "a": 1,   // trailing comment
    /* a block
       comment */
    "b": 2
  }`
  assert.deepEqual(JSON.parse(stripJsonc(src)), { a: 1, b: 2 })
})

test('stripJsonc does NOT eat // inside a string — a baseUrl is not a comment', () => {
  const src = '{ "baseUrl": "https://staging.example.com:8443/app" }'
  assert.deepEqual(JSON.parse(stripJsonc(src)), { baseUrl: 'https://staging.example.com:8443/app' })
})

test('stripJsonc survives escaped quotes and /* inside strings', () => {
  const src = '{ "login": "type \\"admin\\" then /* not a comment */ submit" }'
  assert.equal(JSON.parse(stripJsonc(src)).login, 'type "admin" then /* not a comment */ submit')
})

test('stripJsonc drops trailing commas in objects and arrays', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ "a": [1, 2, ], }')), { a: [1, 2] })
})

test('the shipped qa.config.example.jsonc parses and carries the keys the engines read', () => {
  const raw = readFileSync(join(REPO, 'skills/qa-explore/qa.config.example.jsonc'), 'utf8')
  const cfg = JSON.parse(stripJsonc(raw))
  for (const key of ['baseUrl', 'mode', 'projectType', 'shotsDir', 'evidence', 'viewports', 'coverage', 'tracker', 'fix', 'heal']) {
    assert.ok(key in cfg, 'example config lost "' + key + '"')
  }
  assert.equal(cfg.evidence.retain, 'confirmed-only')
  assert.ok(!/^\/tmp\b/.test(cfg.shotsDir), 'the example must not default shotsDir onto /tmp (RAM on most Linux boxes)')
})

test('loadConfig finds the config by convention, nearest name first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-cfg-'))
  mkdirSync(join(dir, 'test', 'E2E'), { recursive: true })
  writeFileSync(join(dir, 'test', 'E2E', 'qa.config.json'), '{"baseUrl":"http://nested"}')
  assert.equal(loadConfig(dir).config.baseUrl, 'http://nested')

  writeFileSync(join(dir, 'qa.config.json'), '{"baseUrl":"http://root"}')
  assert.equal(loadConfig(dir).config.baseUrl, 'http://root', 'a config at the root wins over the E2E one')
  rmSync(dir, { recursive: true, force: true })
})

test('loadConfig honours an explicit path and reports a missing config instead of guessing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-cfg-'))
  const explicit = join(dir, 'custom.jsonc')
  writeFileSync(explicit, '{ /* c */ "baseUrl": "http://explicit" }')
  assert.equal(loadConfig(dir, explicit).config.baseUrl, 'http://explicit')

  const empty = mkdtempSync(join(tmpdir(), 'qa-cfg-empty-'))
  assert.throws(() => loadConfig(empty), /qa\.config\.json not found/)
  rmSync(dir, { recursive: true, force: true })
  rmSync(empty, { recursive: true, force: true })
})
