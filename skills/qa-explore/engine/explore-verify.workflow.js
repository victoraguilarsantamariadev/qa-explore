// qa-explore — EXPLORE + VERIFY engine (reusable across projects)
// Invoked by the /qa-explore skill via Workflow({ scriptPath, args }).
// args = the resolved qa.config object (see qa.config.example.jsonc), optionally with `areas` pre-filled
// (the skill passes a diff-scoped/cached subset here when running in "diff" mode).
export const meta = {
  name: 'qa-explore-engine',
  description: 'Reusable exploratory QA: recon the app, fan out human-tester agents that drive a real browser and visually judge rendering + data, then adversarially verify each serious finding. Captures Playwright trace/HAR/console/video as evidence and reuses one login session across agents.',
  phases: [
    { title: 'Step 0', detail: 'run the existing deterministic suite (regression net) if one exists; skipped on a cold project' },
    { title: 'Recon', detail: 'discover the functional areas/routes to cover (skipped if areas are supplied/cached)' },
    { title: 'Setup', detail: 'enter each declared app state/mode (e.g. simulation/demo, a feature flag, offline, dark theme) before its pass; only when >1 appState configured' },
    { title: 'Explore', detail: 'one human-tester agent per area drives a real browser, sweeps viewports, runs an axe-core a11y check, screenshots, judges, captures evidence' },
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
// Accessibility (axe-core) is a free extra pass on web targets; set cfg.a11y=false to skip it.
const A11Y = isWeb && cfg.a11y !== false
// App states/modes (simulation/demo, feature flags, offline, theme, plan tier, tenant, …). The whole
// suite re-runs in EACH declared state so the app is tested in every mode, not just the active one.
// The first/`default` state needs no enter recipe; extras declare how to enter (and optionally exit).
const APP_STATES = (cfg.appStates && cfg.appStates.length) ? cfg.appStates : [{ name: 'default', default: true }]
const PRIMARY_STATE = APP_STATES.find((s) => s.default) || APP_STATES[0]
const MULTI_STATE = APP_STATES.length > 1
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

function a11yBlock() {
  if (!A11Y) return ''
  return [
    'ACCESSIBILITY (axe-core) — a free extra pass on this area\'s KEY screens:',
    '  - Install once: npm i -D @axe-core/playwright (it injects axe from node_modules, so the app CSP does NOT block it — do NOT load axe from a CDN).',
    '  - On 2–4 representative screens of this area (e.g. a list, a form, a detail/dashboard), after the screen settles run:',
    '      const AxeBuilder = (await import("@axe-core/playwright")).default;',
    '      const r = await new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa"]).analyze();',
    '  - Report ONLY violations with impact "critical" or "serious" (ignore minor/moderate to avoid noise), DEDUPED by rule id across screens. For each: severity "minor", confidence "hard-evidence", title prefixed "[a11y] <ruleId>", evidence = the rule id + help URL + a failing selector + which screen. Cap at the ~8 most impactful and say how many more were dropped.',
    '  - These are real WCAG 2 A/AA failures (missing form labels/alt text, color-contrast, name-role-value, etc.) — concrete, not a "looks wrong" judgement.',
  ].join('\n')
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
    a11yBlock(),
  ].filter(Boolean).join('\n')
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
    '(4) STATE, SEQUENCE & NOTIFICATIONS — this is a stateful SPA whose stores/singletons LEAK across in-app navigation, and a full reload MASKS those bugs, so NEVER judge a flow from a single op:',
    '    • SEQUENCE: create AND delete the SAME entity 2-3 times in a row WITHOUT reloading between (e.g. Save → land on list → click New again → does the form open, or does it bounce straight back / block the second create?).',
    '    • STALE STATE: after an action that shows a success/error toast, navigate AWAY and BACK (do NOT reload) — a "created/deleted/saved successfully" toast that RE-FIRES just from navigating, or a form that self-submits/redirects on mount, is a stale-singleton finding.',
    '    • NOTIFICATION HYGIENE: plain navigation must trigger NO success/error toast. Any toast that appears without a matching user action = finding. Also flag DUPLICATE toasts for a single action.',
    '    • CROSS-ENTITY PARITY: shared patterns (bulk-select + delete, the create form, the save-toast, the row confirm-modal) must behave IDENTICALLY across EVERY entity that has them. If bulk-delete (or any shared flow) works on one entity but does nothing / opens a 2nd modal / duplicates on another, that DIVERGENCE is the finding — test the shared pattern on each entity, do not assume.',
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

// ---- Step 0: run the EXISTING deterministic suite (the regression net) BEFORE exploring ----
// Warm project (a suite exists) → run it; cold project (no suite) → skip. Never writes/fixes tests.
const STEP0_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean', description: 'true if a suite existed and was executed; false on cold start (no suite found)' },
    total: { type: 'number' }, passed: { type: 'number' }, failed: { type: 'number' }, skipped: { type: 'number' },
    failingSpecs: { type: 'array', items: { type: 'string' }, description: 'failing spec file paths or test titles' },
    timedOut: { type: 'boolean' },
    note: { type: 'string', description: 'short summary; on cold start, say no suite was found' },
  },
  required: ['ran', 'note'],
}
phase('Step 0')
const step0 = await agent(
  'STEP 0 — run the project\'s EXISTING deterministic E2E suite as the regression net, BEFORE any exploration. Do NOT write, scaffold or fix tests — only run what exists and report.\n' +
  '1. cd into ' + E2E + '. Detect whether a ' + (cfg.framework || 'playwright') + ' suite EXISTS: look for a config (playwright.config.* / cypress.config.*) AND spec files (glob **/*.spec.* / **/*.cy.*). If NONE exist → this is a COLD start: return {ran:false, note:"cold start — no existing suite, skipped"} and stop.\n' +
  '2. If a suite EXISTS, RUN it: `npx playwright test --reporter=line,json` (or the project\'s own test script). If its config reads a host/base URL from an env var, set it so the suite targets ' + BASE + ' (e.g. `EVOLUTION_HOST=' + baseHost + ' npx playwright test ...`). Cap the run at ~10 minutes: if it exceeds, kill it, set timedOut:true and report whatever pass/fail you captured.\n' +
  '3. Parse the reporter output and return {ran:true,total,passed,failed,skipped,failingSpecs,timedOut,note}. IMPORTANT: a failing baseline test is often a STALE SELECTOR/assertion, not an app bug — do NOT treat Step-0 failures as confirmed findings; they are flagged for the explore pass to adjudicate.',
  { label: 'step0-suite', phase: 'Step 0', schema: STEP0_SCHEMA, agentType: 'general-purpose' }
)
if (step0) log('qa-explore Step 0: ' + (step0.ran
  ? ((step0.passed || 0) + '/' + (step0.total || 0) + ' passed' + (step0.failed ? ', ' + step0.failed + ' FAILED (' + (step0.failingSpecs || []).slice(0, 6).join(', ') + ')' : '') + (step0.timedOut ? ' [timed out]' : ''))
  : 'cold start — skipped'))

// ---- Recon: discover areas if not supplied (the skill caches/diff-scopes them) ----
let areas = (cfg.areas && cfg.areas.length) ? cfg.areas : null
let inventory = null
if (!areas) {
  phase('Recon')
  const reconExtra = EXHAUSTIVE
    ? '\n\n=== RECON MODE (EXHAUSTIVE — leave nothing untested) ===\nProduce a COMPLETE INVENTORY. ' +
      (cfg.sourceHints ? 'Read the routes/router + component/widget registries + API here to ENUMERATE everything: ' + cfg.sourceHints + '. ' : 'Read the source (routes, component/widget registries, API) AND crawl the live nav to ENUMERATE everything. ') +
      'Return (1) "inventory": EVERY route, EVERY CRUD entity type, EVERY enumerable VARIANT family with each item listed (e.g. all widget types, all device types, all chart types), and the key actions; and (2) "areas": FINE-GRAINED missions, ONE per unit of work, so EACH route is visited, EACH entity gets full CRUD, and EACH variant is exercised on its own (e.g. a separate mission "create a <X> widget" for EVERY widget type — do NOT collapse variants into one mission). ALSO emit, for EACH CRUD entity: a SEQUENCE mission "create 2-3 <entity> back-to-back WITHOUT reloading, then delete 2-3 back-to-back" (catches stale-singleton/state-leak bugs a single op hides); and a SHARED-PATTERN PARITY mission per shared flow (bulk-select+delete, create-form, save-toast, row confirm-modal) that exercises it on EVERY entity that has it and compares (a flow working on one entity but broken/duplicated on another is the bug). Do not cap arbitrarily; list them all (up to ' + HARD_CAP + ').'
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
async function exploreAreas(areaList, state) {
  const sName = (state && state.name) || 'default'
  const sessionSetup = (state && state.scope === 'session' && state.enter)
    ? ' This state is SESSION-SCOPED: FIRST put YOUR OWN browser session into it yourself — ' + JSON.stringify(state.enter) + ' — then proceed (other agents do the same in parallel; do not change a global setting).'
    : ''
  const stateNote = MULTI_STATE
    ? '\n\n=== APP STATE: "' + sName + '" ===\nThe app is set to the "' + sName + '" state/mode for this pass.' + sessionSetup + ' ' + (state.expect || '') + ' Put this area\'s screenshots under ' + SHOTS + '/<AREA_KEY>/' + sName + '/, and PREFIX every finding title with "[' + sName + '] ".'
    : ''
  const r = await pipeline(
    areaList,
    (a) => agent(
      preamble() + '\n\n=== YOUR AREA: ' + a.label + ' ===\nAREA_KEY (for screenshots + prefixes): ' + a.key + '\n\nMISSION:\n' + a.mission + stateNote,
      { label: 'explore:' + a.key + (MULTI_STATE ? '@' + sName : ''), phase: 'Explore', schema: FINDINGS_SCHEMA, agentType: 'general-purpose' }
    ),
    (res, a) => {
      if (!res) return null
      const serious = (res.findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major')
      if (serious.length === 0) return { area: a.label, key: a.key, state: sName, explore: res, verify: { verdicts: [] } }
      const list = serious
        .map((f, i) => (i + 1) + '. [' + f.severity + '/' + f.confidence + '] ' + f.title + '\n   what happened: ' + f.whatHappened + '\n   repro: ' + f.repro + '\n   evidence: ' + (f.evidence || 'none') + '\n   trace: ' + (f.trace || 'none'))
        .join('\n')
      return agent(
        preamble() +
          '\n\n=== VERIFY MODE (independent skeptic) ===\nAnother tester reported the issues below in area "' + a.label + '". Re-run EACH repro yourself from a fresh context, capture a trace, and READ the screenshot. Mark confirmed=true ONLY if you actually reproduce the problem. If it works for you (often because the original judged a mid-selection or intentional-empty state — see the KNOWN-CORRECT notes), mark confirmed=false. Default to skeptical.\n\nISSUES:\n' + list + stateNote,
        { label: 'verify:' + a.key + (MULTI_STATE ? '@' + sName : ''), phase: 'Verify', schema: VERIFY_SCHEMA, agentType: 'general-purpose' }
      ).then((v) => ({ area: a.label, key: a.key, state: sName, explore: res, verify: v || { verdicts: [] } }))
    }
  )
  return r.filter(Boolean)
}

// Robustly ENTER a GLOBAL app state/mode before its pass. The transition is done as a DETERMINISTIC
// SCRIPT the setup agent writes & runs (NOT click-by-click LLM judgement): fire the action, then poll a
// readiness predicate while RE-AUTHENTICATING each round and TOLERATING transient 401/403/5xx + connection
// errors (a mode switch often restarts the backend / invalidates the session / changes the credential),
// gate on a real authenticated health-check, with a generous configurable timeout. Detect-first (skip if
// already in the target). manual:true → assume it was set externally, verify only. Session-scoped states
// are NOT entered here — each area agent sets them per-session (see stateSetup in exploreAreas).
async function enterState(state) {
  if (!state || (!state.enter && !state.readyWhen)) return
  if (state.scope === 'session') return
  phase('Setup')
  const tSec = Math.round((state.timeoutMs || 180000) / 1000)
  const pSec = Math.round((state.pollMs || 4000) / 1000)
  const transient = JSON.stringify(state.expectTransient || [401, 403, 500, 502, 503, 504])
  log('qa-explore: preparando estado de app "' + state.name + '"…')
  await agent(
    preamble() +
      '\n\n=== ENTER APP STATE: "' + state.name + '" — DETERMINISTIC SETUP, not exploration ===\n' +
      'CREDENTIALS for this state: ' + (state.login || cfg.login) + '\n' +
      (state.manual
        ? 'This state is set MANUALLY/EXTERNALLY — do NOT switch it. VERIFY readiness only: ' + JSON.stringify(state.readyWhen || '(none)') + '. Poll up to ' + tSec + 's; print "READY" when satisfied (after one authenticated request returns 200) or "FAILED: not in state ' + state.name + '".'
        : 'WRITE AND RUN a script (bash+curl+python3, or node) that performs this transition ROBUSTLY, then return its final line. Do NOT do it click-by-click in the browser. The script MUST:\n' +
          '  1) login() → returns a FRESH token (try the credential candidates above; use whichever /auth/authenticate returns 200).\n' +
          '  2) DETECT: check the readiness predicate [' + JSON.stringify(state.readyWhen || 'n/a') + ']. If ALREADY satisfied → print "READY (already)" and exit 0.\n' +
          '  3) FIRE (authenticated): ' + JSON.stringify(state.enter) + '  — it may return 202 (async).\n' +
          '  4) POLL every ' + pSec + 's for up to ' + tSec + 's: EACH round call login() AGAIN (the switch invalidates the session and the credential may change between projects), TOLERATE transient HTTP ' + transient + ' and connection errors (the backend restarts mid-switch), then re-check the predicate.\n' +
          '  5) When the predicate holds, HEALTH-CHECK: one authenticated REAL request (e.g. a list endpoint) must return 200. Only then print "READY".\n' +
          '  6) On timeout, print "FAILED: <reason>".\n' +
          'Save the script output to ' + SHOTS + '/state-' + state.name + '.log and return EXACTLY the final READY/FAILED line. If FAILED, that becomes a finding and this state\'s pass is skipped.'),
    { label: 'enter-state:' + state.name, phase: 'Setup', agentType: 'general-purpose' }
  )
}

await enterState(PRIMARY_STATE)
let clean = await exploreAreas(areas, PRIMARY_STATE)

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
    clean = clean.concat(await exploreAreas(gaps, PRIMARY_STATE))
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

// ---- Extra app states: re-run the whole area suite in each non-primary declared state ----
for (const state of APP_STATES) {
  if (state === PRIMARY_STATE) continue
  await enterState(state)
  log('qa-explore: pasada de estado "' + state.name + '" sobre ' + areas.length + ' área(s)')
  clean = clean.concat(await exploreAreas(areas, state))
}
if (MULTI_STATE && PRIMARY_STATE.enter) { await enterState(PRIMARY_STATE) } // leave the app in the resting state

const step0Entry = {
  area: 'Step 0 — deterministic regression suite', key: 'step0', state: 'default',
  step0: step0 || { ran: false, note: 'not run' },
  explore: { area: 'Step 0', flowsExercised: [], worksWell: [], findings: [] },
  verify: { verdicts: [] },
}
const all = [step0Entry, ...clean, ...authz]
let total = 0, hard = 0
for (const r of all) for (const f of (r.explore.findings || [])) { total++; if (f.confidence === 'hard-evidence') hard++ }
log('qa-explore terminado: ' + total + ' hallazgos (' + hard + ' con evidencia dura) en ' + all.length + ' áreas' + (authz.length ? ' (incl. ' + authz.length + ' de control de acceso)' : '') + '.')
return all
