// qa-gate — RELEASE GATE / QA SIGN-OFF engine (reusable across projects)
// The decision layer a senior QA team owns: aggregate the signals the other skills produced and apply a
// WRITTEN, deterministic rubric to emit GO / NO-GO. The verdict is COMPUTED BY RULES (same inputs → same
// verdict, every time); an agent only writes the human-readable sign-off — it never decides whether to ship.
//
// Invoked by the /qa-gate skill via Workflow({ scriptPath, args }).
// args = {
//   results: [ ...the qa-explore result array ],   // each entry: { area, key, explore:{findings[]}, verify:{verdicts[]} } + the step0 entry
//   gate: {
//     blockOn: ['blocker','major'],       // severities that block (default)
//     requireStep0Green: true,            // red baseline suite = NO-GO
//     blockOnAccessControl: true,         // any confirmed broken-authz = NO-GO
//     a11yBlockOn: ['critical'],          // axe impact levels that block
//     waive: [ { match, reason, approvedBy } ],   // accepted risks — removed from blockers, PRINTED in sign-off
//     release: 'v1.2.3 / PR#456',         // label for the sign-off
//     outFile: 'qa-signoff.md',
//   },
//   visual, perf,                         // optional pre-computed results (presence => "assessed" in coverage)
// }
export const meta = {
  name: 'qa-gate',
  description: 'Release gate / QA sign-off: aggregate explore findings (severity×confidence, verified?), the Step-0 suite, access-control and a11y against a written rubric and COMPUTE a deterministic GO/NO-GO verdict with the exact blockers and an audited waiver trail. Rules decide; an agent only writes the sign-off document.',
  phases: [
    { title: 'Adjudicate', detail: 'apply the release rubric to every signal (deterministic): count confirmed blockers, honour waivers, check the Step-0 baseline and access-control' },
    { title: 'Sign-off', detail: 'an agent writes the human-readable sign-off (GO/NO-GO, blockers with evidence, accepted risks, residual-risk summary) — it does NOT decide the verdict' },
  ],
}

// Accept args as an object (runner / tests) OR a JSON string (some Workflow hosts serialize it).
const cfg = (typeof args === 'string' && args.trim()) ? JSON.parse(args) : (args || {})
const gate = cfg.gate || {}
const results = Array.isArray(cfg.results) ? cfg.results : ((cfg.signals && cfg.signals.results) || [])
const BLOCK_ON = (gate.blockOn || ['blocker', 'major']).map((s) => String(s).toLowerCase())
const REQUIRE_STEP0 = gate.requireStep0Green !== false
const BLOCK_AC = gate.blockOnAccessControl !== false
const WAIVERS = gate.waive || []
const OUT = gate.outFile || 'qa-signoff.md'
const RELEASE = gate.release || null

const norm = (s) => String(s == null ? '' : s).toLowerCase().trim()
const isAccessCtrl = (r) => /^authz|access-control/.test(r.key || '') || /access-control/.test(r.area || '')

// A finding counts as "confirmed" if the Verify pass confirmed it, or it is self-proving (hard-evidence).
function confirmed(f, verdicts) {
  if (norm(f.confidence) === 'hard-evidence') return true
  const v = (verdicts || []).find((x) => x && x.title && f.title && norm(x.title) === norm(f.title))
  if (v) return v.confirmed === true || v.confirmed === 'true' || v.isReal === true || /confirm/i.test(v.verdict || '')
  return false // unverified, non-self-proving → does not block
}
// Waiver match: by finding title substring, area key, or "step0"/"suite" for the baseline gate.
function waiverFor(title, key) {
  return WAIVERS.find((w) => {
    const m = norm(w.match)
    return m && (norm(title).includes(m) || norm(key) === m)
  })
}

// -------------------------------------------------------------- ADJUDICATE (deterministic)
phase('Adjudicate')
const blockers = []
const accepted = []   // waived risks (still shown in the sign-off)
const allFindings = []
let step0 = null

for (const r of results) {
  if ((r.key || '') === 'step0') { step0 = r.step0 || r; continue }
  const verdicts = (r.verify && r.verify.verdicts) || []
  const ac = isAccessCtrl(r)
  for (const f of ((r.explore && r.explore.findings) || [])) {
    const rec = { area: r.area, key: r.key, severity: norm(f.severity), confidence: f.confidence, title: f.title, evidence: f.evidence || f.trace || 'none', accessControl: ac }
    allFindings.push(rec)
    if (!confirmed(f, verdicts)) continue                          // only confirmed findings can block
    const sevBlocks = BLOCK_ON.includes(rec.severity)
    const acBlocks = BLOCK_AC && ac
    if (!(sevBlocks || acBlocks)) continue
    const w = waiverFor(f.title, r.key)
    if (w) { accepted.push({ ...rec, reason: w.reason || '(no reason given)', approvedBy: w.approvedBy || '(unspecified)' }); continue }
    blockers.push({ ...rec, why: acBlocks ? 'broken access control (security — non-negotiable at the gate)' : rec.severity + ' severity, confirmed' })
  }
}

// Hard gate: the Step-0 deterministic regression suite must be green.
if (REQUIRE_STEP0 && step0) {
  const failed = step0.failed != null ? step0.failed : ((step0.failingSpecs && step0.failingSpecs.length) || 0)
  if (step0.ran && failed > 0) {
    const w = WAIVERS.find((x) => /step.?0|suite|baseline/i.test(String(x.match || '')))
    const rec = { area: 'Step 0', key: 'step0', title: 'Step-0 deterministic suite is RED (' + failed + ' failing)', evidence: step0.note || 'see suite output' }
    if (w) accepted.push({ ...rec, reason: w.reason || '(no reason given)', approvedBy: w.approvedBy || '(unspecified)' })
    else blockers.unshift({ ...rec, why: 'baseline regression suite not green — shipping on red hides regressions' })
  }
}

const verdict = blockers.length ? 'NO-GO' : 'GO'
const bySeverity = allFindings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m }, {})
const coverage = {
  explore: results.some((r) => r.explore) ? 'assessed' : 'not assessed',
  step0: step0 ? (step0.ran ? 'assessed' : 'not run') : 'not assessed',
  accessControl: results.some((r) => isAccessCtrl(r)) ? 'assessed' : 'not assessed (single role)',
  a11y: allFindings.some((f) => /a11y|accessib|axe/i.test(f.title || '')) ? 'assessed' : 'not assessed (no axe findings fed)',
  visual: cfg.visual ? 'assessed' : 'not assessed',
  perf: cfg.perf ? 'assessed' : 'not assessed',
}
log('qa-gate: veredicto ' + verdict + ' · ' + blockers.length + ' bloqueante(s) · ' + accepted.length + ' riesgo(s) aceptado(s) · ' + allFindings.length + ' hallazgo(s) totales')

// -------------------------------------------------------------- SIGN-OFF (narrated, NOT decided, by an agent)
phase('Sign-off')
const SIGNOFF_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['markdown'],
  properties: { markdown: { type: 'string', description: 'the full QA sign-off document in Markdown' }, outFile: { type: 'string' } },
}
const brief = {
  verdict, release: RELEASE, blockers, acceptedRisks: accepted,
  findingsBySeverity: bySeverity, findingsTotal: allFindings.length, coverage, rubric: { blockOn: BLOCK_ON, requireStep0Green: REQUIRE_STEP0, blockOnAccessControl: BLOCK_AC },
}
const signoff = await agent(
  'Write a QA RELEASE SIGN-OFF in Markdown from this ALREADY-DECIDED data (do NOT change the verdict — it is computed by rules; you only narrate). ' +
  'Lead with the verdict in bold (' + verdict + ')' + (RELEASE ? ' for ' + RELEASE : '') + '. Then: (1) the BLOCKERS as a checklist — each with severity, why it blocks, and its evidence path (on NO-GO, say plainly these are the fix list for /qa-fix); (2) ACCEPTED RISKS (waivers) with who approved and why — never hide these; (3) a short RESIDUAL-RISK summary; (4) a COVERAGE table stating what was and was NOT assessed (be honest — "not assessed" is not "clean"). Keep it tight and decision-ready. ' +
  'Write it to ' + OUT + ' and also return it in `markdown`.\n\nDATA:\n' + JSON.stringify(brief),
  { schema: SIGNOFF_SCHEMA, label: 'sign-off', phase: 'Sign-off' }
)

return {
  verdict,                          // 'GO' | 'NO-GO' — deterministic; wire CI to fail on NO-GO
  release: RELEASE,
  blockers,
  waived: accepted,
  findingsTotal: allFindings.length,
  findingsBySeverity: bySeverity,
  coverage,
  outFile: (signoff && signoff.outFile) || OUT,
  signoffMarkdown: signoff ? signoff.markdown : null,
}
