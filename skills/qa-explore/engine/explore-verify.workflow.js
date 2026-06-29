// qa-explore — EXPLORE + VERIFY engine (reusable across projects)
// Invoked by the /qa-explore skill via Workflow({ scriptPath, args }).
// args = the resolved qa.config object (see qa.config.example.jsonc), optionally with `areas` pre-filled
// (the skill passes a diff-scoped/cached subset here when running in "diff" mode).
export const meta = {
  name: 'qa-explore-engine',
  description: 'Reusable exploratory QA: recon the app, fan out human-tester agents that drive a real browser and visually judge rendering + data, then adversarially verify each serious finding. Captures Playwright trace/HAR/console/video as evidence and reuses one login session across agents.',
  phases: [
    { title: 'Recon', detail: 'discover the functional areas/routes to cover (skipped if areas are supplied/cached)' },
    { title: 'Explore', detail: 'one human-tester agent per area drives a real browser, sweeps viewports, screenshots, judges, captures evidence' },
    { title: 'Verify', detail: 'an independent skeptic re-runs each serious finding to confirm it is real' },
    { title: 'Access-control', detail: 'per extra role, an agent checks for broken access control (only when >1 role configured)' },
  ],
}

const cfg = args || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const SHOTS = cfg.shotsDir || '/tmp/qa-explore'
const E2E = cfg.e2eDir || 'the project E2E directory'

// ---- safety: what the run may DO, and WHERE it may reach ----
const MODE = (cfg.mode === 'read-only' || cfg.mode === 'no-delete') ? cfg.mode : 'explore'
const baseHost = (cfg.baseUrl || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0]
const ALLOWED = (cfg.allowedHosts && cfg.allowedHosts.length) ? cfg.allowedHosts : (baseHost ? [baseHost] : [])
const modeBlock =
  MODE === 'read-only'
    ? 'MODE = READ-ONLY (no mutations). Navigate, screenshot and JUDGE only. DO NOT create, edit, submit, upload or delete anything that persists — do not click Save/Confirm/Delete. If validating a flow would require writing, describe what you WOULD do and why, but DO NOT execute it. You can still fully test rendering, data-sense, navigation, and the validation messages that appear before submit.'
    : MODE === 'no-delete'
      ? 'MODE = NO-DELETE (write, but never delete). You MAY create, edit and submit to exercise flows, but you must NEVER delete anything (no trash/remove/destroy actions, no DELETE requests) — this target is sensitive. Prefix everything you create with "qa-<AREA_KEY>-<timestamp>"; never touch data that looks real / pre-existing. If a test needs cleanup, leave the qa-prefixed record and note it rather than deleting.'
      : 'MODE = EXPLORE (full read-write). Behave like a real user: you MAY create, edit, submit and delete to exercise flows. Treat the target as a TEST / STAGING environment. STRICTLY: prefix everything you create with "qa-<AREA_KEY>-<timestamp>"; only delete what YOU created this run; never bulk-delete; never touch data that looks real / pre-existing; clean up your own artifacts at the end (best effort).'
const confinementBlock = ALLOWED.length
  ? 'NETWORK CONFINEMENT (strict): you may ONLY navigate to and send requests to these host(s): ' + ALLOWED.join(', ') + '. If any link, redirect, form action or request would go to a DIFFERENT host, do NOT follow it — record it as an observation and stay. NEVER scan, probe or connect to any other machine on the network.'
  : ''

// ---- coverage axes: viewports, roles, project type ----
const VIEWPORTS = (cfg.viewports && cfg.viewports.length) ? cfg.viewports : [{ name: 'desktop', width: 1440, height: 900 }]
const ROLES = (cfg.roles && cfg.roles.length) ? cfg.roles : [{ name: 'default', login: cfg.login }]
const PRIMARY = ROLES[0]
const PTYPE = cfg.projectType || 'web-spa'
const isWeb = PTYPE === 'web-spa' || PTYPE === 'web-ssr'
const usesBrowser = isWeb || PTYPE === 'electron'
const NEEDS_WEBKIT = VIEWPORTS.some((v) => v.browser === 'webkit')
const vdesc = (v) => {
  const eng = v.browser && v.browser !== 'chromium' ? ', engine:' + v.browser : ''
  return v.playwrightDevice
    ? 'Playwright device "' + v.playwrightDevice + '" (devices["' + v.playwrightDevice + '"]' + (v.browser ? ' launched with ' + v.browser : '') + ')'
    : ((v.width || 1280) + 'x' + (v.height || 800) + (v.isMobile ? ', isMobile:true, hasTouch:true' : '') + eng)
}

function viewportBlock() {
  const prim = VIEWPORTS[0]
  const extras = VIEWPORTS.slice(1)
  const lines = ['VIEWPORTS: run your PRIMARY full pass at "' + prim.name + '" (' + vdesc(prim) + ').']
  if (extras.length) {
    lines.push('Then for EACH extra viewport, switch to its size/device — AND its browser engine when specified: use Playwright WebKit for iOS fidelity (a Chromium browser with an iPhone user-agent is NOT real Safari) — and re-walk the KEY screens of this area at that viewport: ' + extras.map((v) => v.name + ' (' + vdesc(v) + ')').join('; ') + '.')
    lines.push('MOBILE / RESPONSIVE checklist (run for each touch/small viewport): (1) NO horizontal scroll or content spilling off-screen; (2) the hamburger / off-canvas menu opens AND navigates; (3) tap targets are big enough (~44px) and not overlapping; (4) sticky headers/footers/toolbars do NOT cover content or the focused input; (5) a <meta name="viewport"> exists (the page is not just a zoomed-out desktop); (6) forms are usable — fields reachable and the on-screen keyboard does not hide the field/submit; (7) images/tables/charts scale instead of overflowing; (8) tap (not hover) reveals menus/tooltips that desktop shows on hover.')
    lines.push('Screenshot each into ' + SHOTS + '/<AREA_KEY>/<viewport>-NN.png, READ them, and TAG any viewport-specific finding with the viewport name in its title (e.g. "[mobile] ...").')
  }
  return lines.join('\n')
}

function handsBlock(stateFile) {
  if (PTYPE === 'api') return 'HOW YOU ACT: this is an API target — no browser. Exercise the HTTP API directly (curl/fetch). "Seeing" = reading status codes, headers and JSON bodies. JUDGE: correct status codes, response shape/schema, plausible data, error handling for bad input, auth enforced. Save raw request+response into ' + SHOTS + '/<AREA_KEY>/ as evidence.'
  if (PTYPE === 'cli') return 'HOW YOU ACT: this is a CLI target — no browser. Run the commands. "Seeing" = reading stdout/stderr and exit codes. JUDGE: correct exit codes, helpful errors, sane output, idempotency, no leaking stack traces. Save command + output into ' + SHOTS + '/<AREA_KEY>/ as evidence.'
  const launch = PTYPE === 'electron'
    ? '  - Launch the desktop app with Playwright Electron: const { _electron } = require("playwright"); const app = await _electron.launch({ args: ["."] }); const page = await app.firstWindow().'
    : '  - cd into a directory that already has @playwright/test + Chromium installed (use ' + E2E + ' if it exists; otherwise: npm i -D @playwright/test && npx playwright install ' + (NEEDS_WEBKIT ? 'chromium webkit' : 'chromium') + ').'
  return [
    'HOW YOU SEE AND CLICK: you have no mouse, so you drive a real ' + (PTYPE === 'electron' ? 'Electron app' : 'Chromium browser') + ' with Playwright as your hands and you SEE by taking screenshots and reading them back.',
    launch,
    '  - LOGIN SESSION REUSE (saves tokens): if ' + stateFile + ' exists, create the context with { storageState: "' + stateFile + '" } and SKIP the login steps. If it does NOT exist, log in per the recipe once and immediately persist it: await context.storageState({ path: "' + stateFile + '" }). (sessionStorage-based logins: also re-set the JWT after navigations as the recipe says.)',
    '  - EVIDENCE (mandatory, this is what makes a finding credible): create the context with recordVideo:{ dir: "' + SHOTS + '/<AREA_KEY>/video" } and recordHar:{ path: "' + SHOTS + '/<AREA_KEY>/network.har" }; call context.tracing.start({ screenshots:true, snapshots:true, sources:true }) at the start; subscribe page.on("console") and page.on("pageerror") and append every line to ' + SHOTS + '/<AREA_KEY>/console.log. When you hit a finding, call context.tracing.stop({ path: "' + SHOTS + '/<AREA_KEY>/trace-<n>.zip" }) capturing that repro. Attach the trace/har/video/console paths and the exact console/HTTP error to the finding.',
    '  - Screenshot EVERY meaningful step into ' + SHOTS + '/<AREA_KEY>/NN-step.png (mkdir -p first). Then use the Read tool on the meaningful PNGs to actually LOOK at them — this visual check is the core of the job; never claim something looks right without having read its screenshot.',
    viewportBlock(),
  ].join('\n')
}

function preamble(extra, role) {
  role = role || PRIMARY
  const stateFile = SHOTS + '/storageState-' + (role.name || 'default') + '.json'
  return [
    'You are a meticulous human QA tester exploring a LIVE ' + (isWeb ? 'web app' : PTYPE + ' target') + ' by hand, like a real user. You EXPLORE and judge — you are NOT running a scripted regression suite.',
    '',
    'TARGET: ' + BASE + (PTYPE !== 'web-spa' ? '   (project type: ' + PTYPE + ')' : ''),
    'ACTING AS ROLE: "' + (role.name || 'default') + '".',
    '',
    '>>> ' + modeBlock,
    (confinementBlock ? '>>> ' + confinementBlock : ''),
    '',
    'LOGIN RECIPE:',
    (role.login || cfg.login || '(no login configured — the app may be open, or discover the login flow yourself)'),
    '',
    'KNOWN-CORRECT / INTENTIONAL BEHAVIOUR — do NOT report any of these as bugs (this list grows as the team rejects false positives):',
    (cfg.domainNotes || '(none provided)'),
    '',
    handsBlock(stateFile),
    '',
    'JUDGE on every screen: (1) RENDERING — broken/overlapping layout, blank/white areas, stuck spinners, error toasts, missing icons, untranslated i18n keys, literal undefined/null/NaN text, cut-off content. (2) DATA SENSE — plausible numbers, correct units, right labels/legends/axes, totals that add up, sane dates; distinguish a legitimate empty-state from a broken one. (3) FLOW — buttons respond, forms validate bad input, Save persists across reload, edits stick, deletes remove, navigation lands where expected, submissions report success.',
    '',
    'CRITICAL anti-false-positive rules (learned the hard way):',
    '  - COMPLETE every flow before judging: confirm pickers/data-sources, click the final confirm/✓, wait for the network to settle. A disabled Save button or empty preview seen MID-selection is NOT a bug.',
    '  - An empty preview/area/canvas can be INTENTIONAL (live/websocket widgets, genuinely empty data). Check the KNOWN-CORRECT notes above and the network/console before calling it broken.',
    '  - Reproduce a suspected bug at least twice. Capture the exact HTTP status / console error as HARD evidence. A vague "looks wrong" with no concrete signal is low-confidence — mark it confidence:"judgement".',
    '',
    'RULES: discover the REAL current UI yourself (real labels/selectors, do not assume); follow the MODE rule above for anything that writes (create/edit/submit/delete); wrap each step in try/catch and keep going after a failure (screenshot + trace the failure state).',
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

// ---- coverage strategy: "sample" (default, ≤ maxAreas) vs "exhaustive" (enumerate everything + loop until covered) ----
const coverage = cfg.coverage || {}
const EXHAUSTIVE = coverage.mode === 'exhaustive'
const MAXROUNDS = coverage.maxRounds || 3
const HARD_CAP = coverage.maxUnits || (EXHAUSTIVE ? 200 : (cfg.maxAreas || 10))

const INVENTORY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    inventory: {
      type: 'object', additionalProperties: false,
      properties: {
        routes: { type: 'array', items: { type: 'string' } },
        entities: { type: 'array', items: { type: 'string' }, description: 'CRUD entity types (devices, contracts, dashboards, widgets...)' },
        variants: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { family: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } }, required: ['family', 'items'] }, description: 'enumerable variants to exercise INDIVIDUALLY: e.g. family "widget-types" items [PIE,BAR,KPI,...]; "device-types" [...]' },
        actions: { type: 'array', items: { type: 'string' } },
      },
    },
    areas: AREAS_SCHEMA.properties.areas,
  },
  required: ['areas'],
}

// ---- Recon: discover areas if not supplied (the skill caches/diff-scopes them) ----
let areas = (cfg.areas && cfg.areas.length) ? cfg.areas : null
let inventory = null
if (!areas) {
  phase('Recon')
  const reconExtra = EXHAUSTIVE
    ? '\n\n=== RECON MODE (EXHAUSTIVE — leave nothing untested) ===\nProduce a COMPLETE INVENTORY. ' +
      (cfg.sourceHints ? 'Read the routes/router + component/widget registries + API here to ENUMERATE everything: ' + cfg.sourceHints + '. ' : 'Read the source (routes, component/widget registries, API) AND crawl the live nav to ENUMERATE everything. ') +
      'Return (1) "inventory": EVERY route, EVERY CRUD entity type, EVERY enumerable VARIANT family with each item listed (e.g. all widget types, all device types, all chart types), and the key actions; and (2) "areas": FINE-GRAINED missions, ONE per unit of work, so EACH route is visited, EACH entity gets full CRUD, and EACH variant is exercised on its own (e.g. a separate mission "create a <X> widget" for EVERY widget type — do NOT collapse variants into one mission). Do not cap arbitrarily; list them all (up to ' + HARD_CAP + ').'
    : '\n\n=== RECON MODE ===\nYour ONLY job now is to produce the list of functional areas/routes worth testing. ' +
      (cfg.sourceHints ? 'Read the route/router definitions here to enumerate routes: ' + cfg.sourceHints + '. ' : '') +
      'Also log in and open the navigation menu to see what sections exist. Return up to ' + (cfg.maxAreas || 10) + ' areas; each needs a short kebab key, a label, and a concrete one-paragraph mission of the real user actions to exercise there (list, create, fill forms, submit, view charts, edit, delete).'
  const recon = await agent(preamble() + reconExtra, { label: 'recon', phase: 'Recon', schema: EXHAUSTIVE ? INVENTORY_SCHEMA : AREAS_SCHEMA, agentType: 'general-purpose' })
  areas = (recon && recon.areas) || []
  inventory = (recon && recon.inventory) || null
}
if (areas.length > HARD_CAP) { log('⚠️ qa-explore: ' + areas.length + ' unidades > cap ' + HARD_CAP + ' → recorto ' + (areas.length - HARD_CAP) + ' (sube coverage.maxUnits para cubrirlas todas).'); areas = areas.slice(0, HARD_CAP) }
log('qa-explore: ' + (EXHAUSTIVE ? 'cobertura EXHAUSTIVA' : 'muestreo') + ' de ' + areas.length + ' unidad(es) → ' + areas.map((a) => a.key).join(', '))

// ---- Explore + Verify as a reusable pass (initial + completeness rounds) ----
async function exploreAreas(areaList) {
  const r = await pipeline(
    areaList,
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
  return r.filter(Boolean)
}

let clean = await exploreAreas(areas)

// ---- Completeness loop (exhaustive only): a critic finds inventory items not yet exercised; cover the gaps; repeat until dry ----
if (EXHAUSTIVE) {
  const coveredKeys = new Set(areas.map((a) => a.key))
  for (let round = 1; round <= MAXROUNDS; round++) {
    const exercised = clean.flatMap((r) => [r.area].concat((r.explore && r.explore.flowsExercised) || [], (r.explore && r.explore.worksWell) || []))
    phase('Completeness')
    const critic = await agent(
      preamble() +
        '\n\n=== COMPLETENESS CRITIC (round ' + round + ') ===\nGiven the full INVENTORY and what has ACTUALLY been exercised, list ONLY the GAPS — inventory items (routes / entities / variants / actions) NOT yet exercised, or that failed to even load. Return them as NEW fine-grained "areas" missions (one per gap, fresh kebab keys). If everything in the inventory has been covered, return an EMPTY areas list.\n\nINVENTORY:\n' + JSON.stringify(inventory || {}) + '\n\nALREADY EXERCISED:\n- ' + exercised.join('\n- '),
      { label: 'completeness:' + round, phase: 'Completeness', schema: AREAS_SCHEMA, agentType: 'general-purpose' }
    )
    let gaps = ((critic && critic.areas) || []).filter((a) => !coveredKeys.has(a.key))
    if (!gaps.length) { log('qa-explore: cobertura completa, sin huecos en la ronda ' + round + '. ✅'); break }
    const room = Math.max(0, HARD_CAP - clean.length)
    if (gaps.length > room) { log('⚠️ qa-explore: ' + gaps.length + ' huecos pero queda sitio para ' + room + ' (cap ' + HARD_CAP + ') → ' + (gaps.length - room) + ' quedan SIN cubrir.'); gaps = gaps.slice(0, room) }
    if (!gaps.length) break
    log('qa-explore: ronda ' + round + ' → cubriendo ' + gaps.length + ' hueco(s): ' + gaps.map((g) => g.key).join(', '))
    gaps.forEach((g) => coveredKeys.add(g.key))
    clean = clean.concat(await exploreAreas(gaps))
    areas = areas.concat(gaps)
  }
}

// ---- Access-control pass: each EXTRA role must NOT reach/do things above its privilege ----
let authz = []
if (ROLES.length > 1) {
  phase('Access-control')
  log('qa-explore: chequeo de control de acceso para ' + (ROLES.length - 1) + ' rol(es) extra → ' + ROLES.slice(1).map((r) => r.name).join(', '))
  const surface = areas.map((a) => '- ' + a.label + ': ' + a.mission).join('\n')
  const raw = await parallel(ROLES.slice(1).map((role) => () =>
    agent(
      preamble('', role) +
        '\n\n=== ACCESS-CONTROL CHECK (role "' + role.name + '") ===\nYou are a LOWER/DIFFERENT-privilege user. Hunt for BROKEN ACCESS CONTROL: anything this role can reach or do that it should NOT. Try opening privileged routes directly, calling privileged actions/APIs, and reading data that should be hidden. The app surface (exercised as the primary role "' + (PRIMARY.name || 'default') + '") is:\n' + surface + '\nFor each attempt: a redirect / 403 / empty result = CORRECT (not a finding). Report a finding ONLY when this role can see or do something above its level (data leak, a forbidden action returns 2xx, hidden admin UI shown). Mark confidence "hard-evidence" when you capture the forbidden HTTP 2xx or the leaked data.',
      { label: 'authz:' + role.name, phase: 'Access-control', schema: FINDINGS_SCHEMA, agentType: 'general-purpose' }
    ).then((res) => res ? { area: 'access-control:' + role.name, key: 'authz-' + role.name, explore: res, verify: { verdicts: [] } } : null)
  ))
  authz = raw.filter(Boolean)
}

const all = [...clean, ...authz]
let total = 0, hard = 0
for (const r of all) for (const f of (r.explore.findings || [])) { total++; if (f.confidence === 'hard-evidence') hard++ }
log('qa-explore terminado: ' + total + ' hallazgos (' + hard + ' con evidencia dura) en ' + all.length + ' áreas' + (authz.length ? ' (incl. ' + authz.length + ' de control de acceso)' : '') + '.')
return all
