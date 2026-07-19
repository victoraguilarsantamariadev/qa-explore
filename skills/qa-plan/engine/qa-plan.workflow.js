// qa-plan — RISK-BASED TEST PLAN engine (reusable across projects)
// The upfront half of the QA process: recon the app, have an agent judge IMPACT × LIKELIHOOD per area,
// then RANK by risk into P0/P1/P2 DETERMINISTICALLY (rules, not vibes) and emit a test charter that also
// seeds qa-explore's `areas` in priority order — so the expensive exploration hits the riskiest surface first.
//
// Invoked by the /qa-plan skill via Workflow({ scriptPath, args }).
// args = {
//   baseUrl, appPath, login, ...(qa.config),   // same config qa-explore uses
//   areas: [ { key, label, mission } ],         // optional; if absent, an agent recons them
//   plan: {
//     bands: { p0: 15, p1: 8 },                 // risk thresholds (risk = impact×likelihood, 1..25)
//     changed: '...' | [ ... ],                 // what changed this release -> raises likelihood on touched areas
//     release: 'v1.2.3 / PR#456',
//     outFile: 'test-plan.md',
//   },
// }
export const meta = {
  name: 'qa-plan',
  description: 'Risk-based test plan: recon the app, an agent judges impact×likelihood per area (with rationale + an acceptance "done" line), then RANK into P0/P1/P2 deterministically (risk = impact×likelihood) and write a test charter that seeds qa-explore areas in priority order. Model assesses; rules rank.',
  phases: [
    { title: 'Assess', detail: 'recon the areas (if not supplied) and judge impact (blast radius) × likelihood (fragility/change) per area, with a rationale and an acceptance line' },
    { title: 'Charter', detail: 'rank by risk into P0/P1/P2 (deterministic) and write the test plan; the ranked areas seed qa-explore riskiest-first' },
  ],
}

// Accept args as an object (runner / tests) OR a JSON string (some Workflow hosts serialize it).
const cfg = (typeof args === 'string' && args.trim()) ? JSON.parse(args) : (args || {})
const plan = cfg.plan || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const BANDS = { p0: (plan.bands && plan.bands.p0) || 15, p1: (plan.bands && plan.bands.p1) || 8 }
const OUT = plan.outFile || 'test-plan.md'
const RELEASE = plan.release || null
const CHANGED = Array.isArray(plan.changed) ? plan.changed.join(', ') : (plan.changed || '')
const clamp = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 1)))
const band = (risk) => (risk >= BANDS.p0 ? 'P0' : risk >= BANDS.p1 ? 'P1' : 'P2')

const loginNote = cfg.login
  ? (typeof cfg.login === 'string' ? cfg.login : (cfg.login.storageStatePath ? 'reuse session ' + cfg.login.storageStatePath : JSON.stringify(cfg.login)))
  : '(no login configured)'

// -------------------------------------------------------------- ASSESS (agent judges; rules will rank)
phase('Assess')
const ASSESS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['areas'],
  properties: {
    areas: {
      type: 'array', minItems: 1, maxItems: 40,
      items: {
        type: 'object', additionalProperties: false,
        required: ['key', 'label', 'mission', 'impact', 'likelihood', 'rationale', 'done'],
        properties: {
          key: { type: 'string', description: 'short kebab id' },
          label: { type: 'string' },
          mission: { type: 'string', description: 'concrete user actions to exercise here (feeds qa-explore)' },
          impact: { type: 'integer', minimum: 1, maximum: 5, description: 'blast radius if broken: 5=money/data/security/legal, 1=cosmetic' },
          likelihood: { type: 'integer', minimum: 1, maximum: 5, description: 'how likely it IS broken: 5=new/changed/complex/past-bugs, 1=stable & simple' },
          rationale: { type: 'string', description: 'why these two scores' },
          done: { type: 'string', description: 'acceptance: the happy path + the key negative/edge case that must hold' },
        },
      },
    },
  },
}
const suppliedAreas = (cfg.areas && cfg.areas.length)
  ? '\n\nUSE EXACTLY these areas (do not invent others); score each:\n' + JSON.stringify(cfg.areas)
  : '\n\nFirst RECON the app (log in, open the nav, note the routes/features) and enumerate its functional areas.'
const changedNote = CHANGED
  ? '\n\nCHANGED THIS RELEASE (raise LIKELIHOOD on areas these touch): ' + CHANGED
  : ''
const assessed = await agent(
  'You are a senior QA lead writing a RISK-BASED test plan for a web app at ' + BASE + '. Login: ' + loginNote + '.' +
  suppliedAreas + changedNote + '\n\n' +
  'For EACH functional area, judge two 1–5 scores with a short rationale:\n' +
  '- IMPACT (blast radius if it breaks): 5 = money/data/security/legal/irreversible; 3 = core feature degraded; 1 = cosmetic.\n' +
  '- LIKELIHOOD (how likely it is actually broken): 5 = new/just-changed/complex/many integrations/past-bug hotspot; 1 = stable, simple, untouched.\n' +
  'Also give each area a concrete MISSION (the user actions to exercise) and a DONE line (the happy path + the key negative/edge case that must hold). ' +
  'Do NOT compute priorities yourself — just the two honest scores; the ranking is done by rules afterwards.',
  { schema: ASSESS_SCHEMA, label: 'assess-risk', phase: 'Assess', agentType: 'general-purpose' }
)

// -------------------------------------------------------------- RANK (deterministic)
const ranked = ((assessed && assessed.areas) || [])
  .map((a) => {
    const impact = clamp(a.impact), likelihood = clamp(a.likelihood)
    const risk = impact * likelihood
    return { key: a.key, label: a.label, mission: a.mission, impact, likelihood, risk, priority: band(risk), rationale: a.rationale, done: a.done }
  })
  .sort((x, y) => y.risk - x.risk)
const counts = ranked.reduce((m, a) => { m[a.priority] = (m[a.priority] || 0) + 1; return m }, { P0: 0, P1: 0, P2: 0 })
log('qa-plan: ' + ranked.length + ' área(s) evaluada(s) → P0:' + counts.P0 + ' P1:' + counts.P1 + ' P2:' + counts.P2)

// -------------------------------------------------------------- CHARTER (agent writes the plan document)
phase('Charter')
const CHARTER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['markdown'],
  properties: { markdown: { type: 'string' }, outFile: { type: 'string' } },
}
const charter = await agent(
  'Write a RISK-BASED TEST PLAN in Markdown' + (RELEASE ? ' for ' + RELEASE : '') + ' from this ALREADY-RANKED data (do NOT re-rank — risk = impact×likelihood is computed; you narrate). ' +
  'Sections: (1) a one-line scope + the risk method (impact×likelihood, bands P0≥' + BANDS.p0 + ' / P1≥' + BANDS.p1 + '); (2) a PRIORITY TABLE (Priority | Area | Impact | Likelihood | Risk | Why | Done) sorted P0→P2; (3) the P0 areas expanded with their acceptance ("done"); (4) an honest note that if a budget cap applies, the P2 tail is what gets dropped. Keep it decision-ready. ' +
  'Write it to ' + OUT + ' and return it in `markdown`.\n\nRANKED AREAS:\n' + JSON.stringify(ranked),
  { schema: CHARTER_SCHEMA, label: 'charter', phase: 'Charter' }
)

return {
  release: RELEASE,
  plan: ranked,                                   // full ranked plan
  counts,
  areas: ranked.map((a) => ({ key: a.key, label: a.label, mission: a.mission, priority: a.priority })), // seed qa-explore (priority order)
  outFile: (charter && charter.outFile) || OUT,
  planMarkdown: charter ? charter.markdown : null,
}
