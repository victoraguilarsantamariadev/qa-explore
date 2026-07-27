// Carry an explore run's result into the args codify/report expect.
//
// codify/report read their findings from ARGS, not from qa.config.json, so without this the CLI
// had no way to hand them a previous run's output and both were a silent no-op.
//
// Deliberately conservative: ONLY findings an independent skeptic CONFIRMED are carried over.
// Interactively a human triages first; headless there is no human, so "the skeptic reproduced it"
// is the gate. Everything taken or dropped is reported — never silently.
import { readFileSync } from 'node:fs'

// worksWell also records observations that make no sense as a spec ("0 axe violations",
// "no console errors"). Those belong in the report, not in the suite.
const NOT_A_FLOW = /\ba11y\b|axe|wcag|violation|contrast|no console|no page ?error|no error|lighthouse/i

export const DEFAULT_MAX_SMOKES = 8

export function fromExploreResult(entries, { skill = 'codify', maxSmokes } = {}) {
  if (!Array.isArray(entries)) throw new Error('expected an explore result array, got ' + typeof entries)

  const findings = [], verdicts = []
  for (const e of entries) {
    for (const f of (e.explore && e.explore.findings) || []) findings.push({ ...f, area: f.area || e.area })
    for (const v of (e.verify && e.verify.verdicts) || []) verdicts.push(v)
  }
  const verdictFor = (f) => verdicts.find((v) => (v.title || v.findingTitle) === f.title)
  const confirmed = findings.filter((f) => { const v = verdictFor(f); return v && v.confirmed === true })
  const unconfirmed = findings.length - confirmed.length

  if (skill === 'report') {
    return {
      args: { findings: confirmed.map((f) => ({ ...f, verified: true })) },
      summary: confirmed.length + ' skeptic-confirmed finding(s) to file; ' +
        unconfirmed + ' unconfirmed dropped (file those after a human triage).',
    }
  }

  const bugs = confirmed.map((f, i) => ({
    id: 'BUG-' + (i + 1),
    title: f.title,
    repro: f.repro || f.whatHappened || '',
    expected: f.expected || '',
    evidence: f.evidence || '',
    area: f.area,
  }))

  const flows = []
  for (const e of entries) {
    for (const w of (e.explore && e.explore.worksWell) || []) {
      if (typeof w === 'string' && w.trim() && !NOT_A_FLOW.test(w)) flows.push({ text: w.trim(), area: e.area })
    }
  }
  // One agent per smoke is the biggest cost here, so cap it — and say what the cap dropped.
  const cap = Number(maxSmokes) > 0 ? Number(maxSmokes) : DEFAULT_MAX_SMOKES
  const kept = flows.slice(0, cap)
  const dropped = flows.length - kept.length

  return {
    args: {
      bugs,
      smokes: kept.map((s, i) => ({ id: 'SMOKE-' + (i + 1), title: s.text, flow: s.text, area: s.area })),
    },
    summary: bugs.length + ' confirmed bug(s) -> red specs, ' + kept.length + ' working flow(s) -> green specs' +
      ' (' + unconfirmed + ' unconfirmed finding(s) NOT codified' +
      (dropped ? '; ' + dropped + ' further working flow(s) DROPPED at the --max-smokes cap of ' + cap : '') + ').',
  }
}

export function fromExploreResultFile(path, opts) {
  return fromExploreResult(JSON.parse(readFileSync(path, 'utf8')), opts)
}
