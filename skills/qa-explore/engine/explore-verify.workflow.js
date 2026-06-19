// qa-explore — EXPLORE + VERIFY engine (reusable across projects)
// Invoked by the /qa-explore skill via Workflow({ scriptPath, args }).
// args = the resolved qa.config object (see qa.config.example.jsonc), optionally with `areas` pre-filled
// (the skill passes a diff-scoped/cached subset here when running in "diff" mode).
export const meta = {
  name: 'qa-explore-engine',
  description: 'Reusable exploratory QA: recon the app, fan out human-tester agents that drive a real browser and visually judge rendering + data, then adversarially verify each serious finding. Captures Playwright trace/HAR/console/video as evidence and reuses one login session across agents.',
  phases: [
    { title: 'Recon', detail: 'discover the functional areas/routes to cover (skipped if areas are supplied/cached)' },
    { title: 'Explore', detail: 'one human-tester agent per area drives a real browser, screenshots, judges, captures evidence' },
    { title: 'Verify', detail: 'an independent skeptic re-runs each serious finding to confirm it is real' },
  ],
}

const cfg = args || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const SHOTS = cfg.shotsDir || '/tmp/qa-explore'
const E2E = cfg.e2eDir || 'the project E2E directory'

function preamble(extra) {
  return [
    'You are a meticulous human QA tester exploring a LIVE web app by hand, clicking through everything like a real user. You EXPLORE and judge — you are NOT running a scripted regression suite.',
    '',
    'APP URL: ' + BASE,
    'LOGIN RECIPE:',
    (cfg.login || '(no login configured — the app may be open, or discover the login flow yourself)'),
    '',
    'KNOWN-CORRECT / INTENTIONAL BEHAVIOUR — do NOT report any of these as bugs (this list grows as the team rejects false positives):',
    (cfg.domainNotes || '(none provided)'),
    '',
    'HOW YOU SEE AND CLICK: you have no mouse, so you drive a real Chromium browser with Playwright as your hands and you SEE by taking screenshots and reading them back.',
    '  - cd into a directory that already has @playwright/test + Chromium installed (use ' + E2E + ' if it exists; otherwise: npm i -D @playwright/test && npx playwright install chromium).',
    '  - LOGIN SESSION REUSE (saves tokens): if ' + SHOTS + '/storageState.json exists, create the context with { storageState: "' + SHOTS + '/storageState.json" } and SKIP the login steps. If it does NOT exist, log in per the recipe once and immediately persist it: await context.storageState({ path: "' + SHOTS + '/storageState.json" }). (sessionStorage-based logins: also re-set the JWT after navigations as the recipe says.)',
    '  - EVIDENCE (mandatory, this is what makes a finding credible): create the context with recordVideo:{ dir: "' + SHOTS + '/<AREA_KEY>/video" } and recordHar:{ path: "' + SHOTS + '/<AREA_KEY>/network.har" }; call context.tracing.start({ screenshots:true, snapshots:true, sources:true }) at the start; subscribe page.on("console") and page.on("pageerror") and append every line to ' + SHOTS + '/<AREA_KEY>/console.log. When you hit a finding, call context.tracing.stop({ path: "' + SHOTS + '/<AREA_KEY>/trace-<n>.zip" }) capturing that repro (you may start/stop tracing around each repro). Attach the trace/har/video/console paths and the exact console/HTTP error to the finding.',
    '  - Screenshot EVERY meaningful step into ' + SHOTS + '/<AREA_KEY>/NN-step.png (mkdir -p first). Then use the Read tool on the meaningful PNGs to actually LOOK at them — this visual check is the core of the job; never claim something looks right without having read its screenshot.',
    '',
    'JUDGE on every screen: (1) RENDERING — broken/overlapping layout, blank/white areas, stuck spinners, error toasts, missing icons, untranslated i18n keys, literal undefined/null/NaN text, cut-off content. (2) DATA SENSE — plausible numbers, correct units, right labels/legends/axes, totals that add up, sane dates; distinguish a legitimate empty-state from a broken one. (3) FLOW — buttons respond, forms validate bad input, Save persists across reload, edits stick, deletes remove, navigation lands where expected, submissions report success.',
    '',
    'CRITICAL anti-false-positive rules (learned the hard way):',
    '  - COMPLETE every flow before judging: confirm pickers/data-sources, click the final confirm/✓, wait for the network to settle. A disabled Save button or empty preview seen MID-selection is NOT a bug.',
    '  - An empty preview/area/canvas can be INTENTIONAL (live/websocket widgets, genuinely empty data). Check the KNOWN-CORRECT notes above and the network/console before calling it broken.',
    '  - Reproduce a suspected bug at least twice. Capture the exact HTTP status / console error as HARD evidence. A vague "looks wrong" with no concrete signal is low-confidence — mark it confidence:"judgement".',
    '',
    'RULES: discover the REAL current UI yourself (real labels/selectors, do not assume); prefix everything you create with "qa-<AREA_KEY>-" + a timestamp and only delete what YOU created; wrap each step in try/catch and keep going after a failure (screenshot + trace the failure state); clean up your artifacts at the end (best effort).',
    (extra || ''),
    '',
    'REPORT: return ONLY the structured object — what you exercised, what genuinely works, and each problem with an honest severity, confidence, evidence paths, and concrete repro steps.',
  ].join('\n')
}

const AREAS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          key: { type: 'string', description: 'short kebab id, used for screenshot folder + prefixes' },
          label: { type: 'string' },
          mission: { type: 'string', description: 'one paragraph of concrete user actions to exercise (CRUD, forms, submissions, charts)' },
        },
        required: ['key', 'label', 'mission'],
      },
    },
  },
  required: ['areas'],
}

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    area: { type: 'string' },
    flowsExercised: { type: 'array', items: { type: 'string' } },
    worksWell: { type: 'array', items: { type: 'string' }, description: 'flows confirmed working — candidates for GREEN smoke tests in the codify pass' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'visual', 'data-sense', 'cosmetic'] },
          confidence: { type: 'string', enum: ['hard-evidence', 'judgement'], description: 'hard-evidence = concrete HTTP status/console error/API mismatch; judgement = looks-wrong visual call' },
          title: { type: 'string' },
          whatHappened: { type: 'string' },
          expected: { type: 'string' },
          dataSense: { type: 'string' },
          repro: { type: 'string' },
          evidence: { type: 'string', description: 'exact HTTP status / console error / API JSON, if any' },
          screenshot: { type: 'string' },
          trace: { type: 'string', description: 'path to the Playwright trace.zip for this finding' },
          har: { type: 'string', description: 'path to the network HAR' },
          video: { type: 'string', description: 'path to the recorded video' },
        },
        required: ['severity', 'confidence', 'title', 'whatHappened', 'repro'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['area', 'flowsExercised', 'findings'],
}

const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          confirmed: { type: 'boolean', description: 'true ONLY if you reproduced it yourself' },
          adjustedSeverity: { type: 'string' },
          notes: { type: 'string' },
          screenshot: { type: 'string' },
          trace: { type: 'string' },
        },
        required: ['title', 'confirmed', 'notes'],
      },
    },
  },
  required: ['verdicts'],
}

// ---- Recon: discover areas if not supplied (the skill caches/diff-scopes them) ----
let areas = (cfg.areas && cfg.areas.length) ? cfg.areas : null
if (!areas) {
  phase('Recon')
  const recon = await agent(
    preamble() +
      '\n\n=== RECON MODE ===\nYour ONLY job now is to produce the list of functional areas/routes worth testing. ' +
      (cfg.sourceHints ? 'Read the route/router definitions here to enumerate routes: ' + cfg.sourceHints + '. ' : '') +
      'Also log in and open the navigation menu to see what sections exist. Return up to ' + (cfg.maxAreas || 10) +
      ' areas; each needs a short kebab key, a label, and a concrete one-paragraph mission of the real user actions to exercise there (list, create, fill forms, submit, view charts, edit, delete).',
    { label: 'recon', phase: 'Recon', schema: AREAS_SCHEMA, agentType: 'general-purpose' }
  )
  areas = (recon && recon.areas) || []
}
if (cfg.maxAreas) areas = areas.slice(0, cfg.maxAreas)
log('qa-explore: cubriendo ' + areas.length + ' áreas → ' + areas.map((a) => a.key).join(', '))

// ---- Explore + Verify (pipeline: each area verifies as soon as it is explored) ----
const results = await pipeline(
  areas,
  (a) => agent(
    preamble() + '\n\n=== YOUR AREA: ' + a.label + ' ===\nAREA_KEY (for screenshots + prefixes): ' + a.key + '\n\nMISSION:\n' + a.mission,
    { label: 'explore:' + a.key, phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'general-purpose' }
  ),
  (res, a) => {
    if (!res) return null
    const serious = (res.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major')
    if (serious.length === 0) return { area: a.label, key: a.key, explore: res, verify: { verdicts: [] } }
    const list = serious
      .map((f, i) => (i + 1) + '. [' + f.severity + '/' + f.confidence + '] ' + f.title + '\n   what happened: ' + f.whatHappened + '\n   repro: ' + f.repro + '\n   evidence: ' + (f.evidence || 'none') + '\n   trace: ' + (f.trace || 'none'))
      .join('\n')
    return agent(
      preamble() +
        '\n\n=== VERIFY MODE (independent skeptic) ===\nAnother tester reported the issues below in area "' + a.label + '". Re-run EACH repro yourself from a fresh context, capture a trace, and READ the screenshot. Mark confirmed=true ONLY if you actually reproduce the problem. If it works for you (often because the original judged a mid-selection or intentional-empty state — see the KNOWN-CORRECT notes), mark confirmed=false. Default to skeptical.\n\nISSUES:\n' + list,
      { label: 'verify:' + a.key, phase: 'Verify', schema: VERIFY_SCHEMA, agentType: 'general-purpose' }
    ).then((v) => ({ area: a.label, key: a.key, explore: res, verify: v || { verdicts: [] } }))
  }
)

const clean = results.filter(Boolean)
let total = 0, hard = 0
for (const r of clean) for (const f of (r.explore.findings || [])) { total++; if (f.confidence === 'hard-evidence') hard++ }
log('qa-explore terminado: ' + total + ' hallazgos (' + hard + ' con evidencia dura) en ' + clean.length + ' áreas.')
return clean
