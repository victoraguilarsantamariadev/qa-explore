// qa-sec — SECURITY REVIEW engine (reusable across projects)
// The same drive-your-app engine as qa-explore, pointed at a different question: not "is this broken?"
// but "can someone abuse this?". It FINDS and PROVES, and stops there — it is a defensive review of an
// app you own, not an attack tool. Every pass is detection-first: enough evidence to fix the hole, never
// more than that.
//
// Invoked by the /qa-sec skill via Workflow({ scriptPath, args }).
// args = the resolved qa.config object (baseUrl, login, roles, allowedHosts, domainNotes, shotsDir…)
//        plus a `security` block — see qa.config.example.jsonc.
export const meta = {
  name: 'qa-sec',
  description: 'Defensive security review of your own web app: passively audit headers/cookies/tokens/bundle, hunt broken access control across roles, and probe input handling and business logic with benign markers. Detection-first — it proves a hole exists and stops; it never extracts data, persists anything, or stress-tests.',
  phases: [
    { title: 'Surface', detail: 'map what is actually exposed: routes, APIs, auth flow, upload and redirect points (skipped if areas are supplied/cached)' },
    { title: 'Passive', detail: 'no probing — read the headers, cookies, token handling, JS bundle and error pages the app already serves' },
    { title: 'Access-control', detail: 'per extra role: forced browsing, IDOR/BOLA on ids, privilege escalation, session invalidation' },
    { title: 'Input-logic', detail: 'benign markers on inputs (reflection, traversal, open redirect) + business-logic abuse; only when intrusiveness is safe-active' },
    { title: 'Verify', detail: 'an independent skeptic reproduces each serious finding before it counts' },
  ],
}

// Accept args as an object (runner / tests) OR a JSON string (some Workflow hosts serialize it).
const cfg = (typeof args === 'string' && args.trim()) ? JSON.parse(args) : (args || {})
const sec = cfg.security || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const SHOTS = cfg.shotsDir || './qa-evidence'
const baseHost = (cfg.baseUrl || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0]
const ALLOWED = (cfg.allowedHosts && cfg.allowedHosts.length) ? cfg.allowedHosts : (baseHost ? [baseHost] : [])

// "passive"     = read only what the app already serves. Zero probing, safe against anything, any time.
// "safe-active" = also send benign markers to inputs (a harmless string, a traversal path, a redirect
//                 target) and exercise business-logic abuse. Still detection-only.
const INTRUSIVE = sec.intrusiveness === 'safe-active' ? 'safe-active' : 'passive'
const ROLES = (cfg.roles && cfg.roles.length) ? cfg.roles : [{ name: 'default', login: cfg.login }]
const PRIMARY = ROLES[0]
const MAXAREAS = sec.maxAreas || cfg.maxAreas || 8
const LOGIN_ATTEMPTS = Math.min(sec.maxLoginAttempts || 8, 20)   // enough to see whether lockout exists; never a brute force

// ---- the authorization gate: this runs against a live system, so someone must own the decision ----
if (sec.authorized !== true) {
  log('qa-sec: `security.authorized` is not true — nothing will run.')
  log('  This skill reviews the security of an app YOU own. Set `security.authorized: true` in')
  log('  qa.config.json together with `security.scope` (which system, and who authorised it), then run again.')
  return { ran: false, reason: 'not authorized: set security.authorized true + security.scope', findings: [] }
}
if (!ALLOWED.length) {
  log('qa-sec: no baseUrl and no allowedHosts — there is no scope to review.')
  return { ran: false, reason: 'no target host resolved', findings: [] }
}

// ---- the rules every agent runs under. Detection-first, and the boundaries are not negotiable. ----
const rulesBlock = [
  'YOU ARE REVIEWING A SYSTEM THE OWNER ASKED YOU TO REVIEW. Scope: ' + (sec.scope || '(not stated — treat ' + ALLOWED.join(', ') + ' as the whole of it)') + '.',
  'SCOPE (strict): you may ONLY send requests to ' + ALLOWED.join(', ') + '. Any link, redirect, form action, webhook or resource pointing at a DIFFERENT host is OUT OF SCOPE — record that it exists and move on. Never scan, probe, enumerate or connect to any other machine, and never follow a finding off-host.',
  'DETECTION-FIRST — the job is to prove a hole EXISTS so it can be closed, and then STOP:',
  '  - The moment you have evidence (the forbidden 2xx, the reflected marker, the leaked field, the header that is missing), you are DONE with that finding. Do not go further to see how far it goes.',
  '  - NEVER read or copy real data beyond the ONE record that proves the exposure, and REDACT it in the report (keep the field names and the shape, replace values with <redacted>). Never bulk-export, never page through results.',
  '  - NEVER modify or delete anything to prove a point, never plant a payload that persists (stored XSS, a webhook, a scheduled job, an extra account), never change a password or a permission, and never leave anything behind. If the only way to prove it would be destructive, report it as UNPROVEN with the reasoning instead.',
  '  - NO load, stress, flooding or timing attacks, and no request loops. At most ' + LOGIN_ATTEMPTS + ' deliberately-wrong login attempts, and ONLY to see whether lockout/rate-limiting exists at all — stop the moment you know the answer.',
  '  - NEVER try credentials that are not the ones configured here: no default-password lists, no reuse, no guessing.',
  '  - Use only BENIGN markers: a harmless unique string (e.g. qasec-<random>), a read-only traversal path, a redirect to an in-scope URL. No destructive SQL (no DROP/DELETE/UPDATE), no shell payloads, no encryption, no data-changing requests.',
  INTRUSIVE === 'passive'
    ? '  - INTRUSIVENESS = PASSIVE: send NOTHING beyond normal use of the app. You may log in, browse, and read every response, header, cookie, token and script the app already serves you. Do NOT submit crafted input, do NOT hand-build requests to endpoints the UI did not call, do NOT probe. If a check needs a probe, describe what you WOULD send and why, and mark it UNPROVEN.'
    : '  - INTRUSIVENESS = SAFE-ACTIVE: you may additionally submit benign markers into inputs the app exposes and call endpoints the app itself calls, with altered parameters. Everything above still binds: no destructive payloads, no persistence, no bulk reads, no stress.',
  'HONESTY: a missing header or a permissive setting is a real finding, but say plainly what it does and does NOT enable. Do not inflate. If something looks bad but you could not prove it, mark it UNPROVEN and say what would prove it. A finding that turns out to be intentional belongs in the KNOWN-CORRECT list, not in the report.',
].join('\n')

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    pass: { type: 'string' },
    checked: { type: 'array', items: { type: 'string' }, description: 'what you actually looked at, including the checks that came back CLEAN' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'cosmetic'], description: 'blocker = exploitable now with real impact (auth bypass, data of another tenant, RCE); major = a real hole needing a condition; minor = hardening' },
          confidence: { type: 'string', enum: ['hard-evidence', 'judgement'], description: 'hard-evidence = you observed the forbidden response/leak/header yourself; judgement = it looks wrong but you could not prove it' },
          proven: { type: 'boolean', description: 'false when the check could not be completed within the rules — say so rather than guessing' },
          title: { type: 'string' },
          owasp: { type: 'string', description: 'OWASP Top 10 id, e.g. A01:2021-Broken Access Control' },
          cwe: { type: 'string' },
          whatHappened: { type: 'string' },
          impact: { type: 'string', description: 'what an abuser gains — concretely, no hand-waving' },
          repro: { type: 'string', description: 'exact steps/request, with any real data redacted' },
          evidence: { type: 'string', description: 'the observed status code / header / response snippet, REDACTED' },
          remediation: { type: 'string', description: 'the specific change that closes it' },
          screenshot: { type: 'string' },
          trace: { type: 'string' },
        },
        required: ['severity', 'confidence', 'proven', 'title', 'whatHappened', 'impact', 'repro'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['pass', 'checked', 'findings'],
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
          confirmed: { type: 'boolean', description: 'true ONLY if you reproduced it yourself, within the same rules' },
          adjustedSeverity: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['title', 'confirmed', 'notes'],
      },
    },
  },
  required: ['verdicts'],
}

const AREAS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    areas: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          mission: { type: 'string', description: 'the security-relevant surface here: which inputs, ids, uploads, redirects and privileged actions' },
        },
        required: ['key', 'label', 'mission'],
      },
    },
  },
  required: ['areas'],
}

function preamble(role) {
  role = role || PRIMARY
  const stateFile = SHOTS + '/storageState-' + (role.name || 'default') + '.json'
  return [
    'You are a security engineer reviewing a web application THE OWNER OF THIS RUN OWNS, so they can fix what you find. You are not attacking it — you are auditing it.',
    '',
    'TARGET: ' + BASE,
    'ACTING AS ROLE: "' + (role.name || 'default') + '".',
    '',
    '>>> ' + rulesBlock,
    '',
    'LOGIN RECIPE:',
    (role.login || cfg.login || '(no login configured — the app may be open, or discover the login flow yourself)'),
    '',
    'KNOWN-CORRECT / INTENTIONAL BEHAVIOUR — never report any of these (this list grows as findings are rejected):',
    (cfg.domainNotes || '(none provided)') + (sec.knownAccepted ? '\n' + sec.knownAccepted : ''),
    '',
    'HOW YOU WORK: drive a real Chromium browser with Playwright as your hands, and read what comes back.',
    '  - cd into a directory that already has @playwright/test + Chromium installed (' + (cfg.e2eDir || './e2e') + ' if it exists; otherwise npm i -D @playwright/test && npx playwright install chromium).',
    '  - LOGIN SESSION REUSE: if ' + stateFile + ' exists, create the context with { storageState: "' + stateFile + '" }; otherwise log in once per the recipe and persist it with await context.storageState({ path: "' + stateFile + '" }).',
    '  - Capture the network with recordHar:{ path: "' + SHOTS + '/sec-<PASS_KEY>/network.har" } — the HAR is where most of the passive evidence lives. Screenshot anything visual to ' + SHOTS + '/sec-<PASS_KEY>/NN.png and READ it back.',
    '  - Write scratch scripts to ' + SHOTS + '/sec-<PASS_KEY>/driver/ and run them from there. NEVER create a file inside ' + (cfg.e2eDir || './e2e') + ', and never name one *.test.* / *.spec.* / *.cy.* anywhere — those globs are the project\'s regression suite.',
    '  - ALWAYS close the context in a finally block.',
    '  - ⚠ The HAR and storageState hold real session tokens. They stay in ' + SHOTS + '; never paste a token, cookie value or credential into a finding — reference it as <redacted>.',
    '',
    'REPORT: return ONLY the structured object. List what you checked INCLUDING the checks that came back clean (a clean result is information too), and for each finding give the concrete impact, the redacted evidence, and the specific fix.',
  ].join('\n')
}

// ---------------------------------------------------------------- Surface
let areas = (sec.areas && sec.areas.length) ? sec.areas : (cfg.areas || [])
if (!areas.length) {
  phase('Surface')
  log('qa-sec: mapping the exposed surface…')
  const recon = await agent(
    preamble() +
      '\n\n=== SURFACE MAPPING ===\nMap what this app actually EXPOSES, as a reviewer would before auditing it. ' +
      (cfg.sourceHints ? 'Read the route/API definitions here: ' + cfg.sourceHints + '. ' : '') +
      'Log in and walk the app; watch the network. Return up to ' + MAXAREAS + ' areas, each with the SECURITY-RELEVANT surface it holds: which user inputs reach the server, which endpoints take an id you could change, where files are uploaded, where a URL or redirect target is accepted, and which actions are privileged. Do NOT probe anything yet.',
    { label: 'surface', phase: 'Surface', schema: AREAS_SCHEMA, agentType: 'general-purpose' }
  )
  areas = (recon && recon.areas) || []
}
if (areas.length > MAXAREAS) {
  log('⚠️ qa-sec: ' + areas.length + ' areas > cap ' + MAXAREAS + ' → dropping ' + (areas.length - MAXAREAS) + ' (raise security.maxAreas to cover them all).')
  areas = areas.slice(0, MAXAREAS)
}
log('qa-sec: ' + areas.length + ' area(s), intrusiveness ' + INTRUSIVE + ', ' + ROLES.length + ' role(s).')

// ---------------------------------------------------------------- Passive (always runs)
phase('Passive')
const PASSIVE_MISSIONS = [
  {
    key: 'transport-headers',
    mission:
      'Audit what the server ALREADY sends, on the login page, an authenticated page, and a JSON API response. Check: Content-Security-Policy (present? does it allow unsafe-inline/unsafe-eval or a wildcard?); Strict-Transport-Security; X-Content-Type-Options; frame protection (frame-ancestors or X-Frame-Options) — and actually TRY framing the app in a local iframe to see whether it loads; Referrer-Policy; the CORS headers on an API response (is Access-Control-Allow-Origin a wildcard or reflected, and is Allow-Credentials true alongside it?); whether HTTP redirects to HTTPS; and any Server/X-Powered-By banner exposing exact versions. Report each MISSING protection as its own finding only if it is actually exploitable here — say what it enables.',
  },
  {
    key: 'session-tokens',
    mission:
      'Audit how the session is held. Where does the token live — an httpOnly cookie, or localStorage/sessionStorage where any script can read it? Cookie flags: Secure, HttpOnly, SameSite. If it is a JWT, decode the PAYLOAD ONLY (never the signature, never try to forge one): does it carry an exp, is the lifetime sane, does it embed anything sensitive? Then test the lifecycle: log out and REPLAY a request with the old token — is it actually invalidated server-side, or only dropped from the browser? Does the session fix itself to a new id on login? Are state-changing requests protected against CSRF (a token, or SameSite doing the job)?',
  },
  {
    key: 'client-exposure',
    mission:
      'Audit what the front-end hands to anyone who opens devtools. Fetch the production JS/CSS bundles and search them for: API keys, tokens, passwords, private endpoints, internal hostnames, cloud credentials, and .map source-map files served in production. Then look at error handling: force a few natural errors (a bad route, a malformed id in the URL) and see whether the response leaks a stack trace, a SQL string, a framework debug page, or internal paths. Also list any third-party script the app loads and from where.',
  },
  {
    key: 'dependencies',
    mission:
      'Audit the dependency surface from the REPOSITORY, not the live app: run `npm audit --omit=dev --json` (or `osv-scanner`/`trivy` if the project uses another ecosystem) in the project root and report only HIGH and CRITICAL advisories that affect code actually shipped to production. For each: the package, the installed version, the fixed version, and what the advisory enables. Do not report dev-only tooling. If no lockfile or no scanner is available, say so rather than guessing.',
  },
]
const passive = await parallel(PASSIVE_MISSIONS.map((m) => () =>
  agent(
    preamble() + '\n\n=== PASSIVE AUDIT: ' + m.key + ' ===\nPASS_KEY (for evidence paths): ' + m.key + '\n\nMISSION:\n' + m.mission,
    { label: 'passive:' + m.key, phase: 'Passive', schema: FINDINGS_SCHEMA, agentType: 'general-purpose' }
  ).then((r) => r ? { area: 'passive: ' + m.key, key: 'passive-' + m.key, sec: r } : null)
))

// ---------------------------------------------------------------- Access-control (the high-value pass)
phase('Access-control')
const surface = areas.map((a) => '- ' + a.label + ': ' + a.mission).join('\n')
const authzRoles = ROLES.length > 1 ? ROLES.slice(1) : [PRIMARY]
if (ROLES.length < 2) {
  log('⚠️ qa-sec: only one role is configured. The authorization check is MUCH stronger with two')
  log('   (one less privileged): declare another in `roles` to catch escalation between users.')
}
const authz = await parallel(authzRoles.map((role) => () =>
  agent(
    preamble(role) +
      '\n\n=== ACCESS CONTROL (role "' + (role.name || 'default') + '") ===\nPASS_KEY (for evidence paths): authz-' + (role.name || 'default') + '\n' +
      'This is the pass that finds the expensive bugs. Broken access control is authorisation decided in the UI instead of on the server, so hunt exactly that:\n' +
      '  1. FORCED BROWSING: open privileged routes directly by URL. A redirect, a 403 or an empty result is CORRECT and is NOT a finding. Rendering the privileged screen IS.\n' +
      '  2. HIDDEN-BUT-NOT-BLOCKED: find actions this role does not see in the UI, then call the SAME endpoint the privileged UI calls. If the server accepts it (2xx) the control was only cosmetic.\n' +
      '  3. IDOR / BOLA: take an id from a resource this role legitimately owns, then change it to one belonging to another user/tenant. Fetch, and if the app has them, also try the update/delete endpoints (a 403 is the result you WANT — if it returns 2xx, report it and STOP; do not actually modify anything).\n' +
      '  4. MASS ASSIGNMENT: when submitting a form, add a field the UI does not send (role, isAdmin, ownerId, price, status) and see whether the server accepts it.\n' +
      '  5. SESSION BOUNDARY: does this role\'s token work on endpoints scoped to another tenant/project?\n' +
      (ROLES.length < 2 ? '  NOTE: only one role is configured, so cross-user escalation cannot be tested properly. Test what you can from this role and say clearly in `notes` that a second, lower-privileged account would be needed.\n' : '') +
      '\nThe app surface is:\n' + surface +
      '\n\nEvery attempt that is correctly REFUSED is a clean check — list it in `checked`. Report a finding only when the server let you see or do something this role should not. Mark confidence "hard-evidence" only when you captured the forbidden 2xx or the leaked field yourself (redacted).',
    { label: 'authz:' + (role.name || 'default'), phase: 'Access-control', schema: FINDINGS_SCHEMA, agentType: 'general-purpose' }
  ).then((r) => r ? { area: 'access-control: ' + (role.name || 'default'), key: 'authz-' + (role.name || 'default'), sec: r } : null)
))

// ---------------------------------------------------------------- Input handling + business logic
let inputLogic = []
if (INTRUSIVE === 'safe-active') {
  phase('Input-logic')
  inputLogic = await parallel(areas.map((a) => () =>
    agent(
      preamble() +
        '\n\n=== INPUT HANDLING & BUSINESS LOGIC: ' + a.label + ' ===\nPASS_KEY (for evidence paths): input-' + a.key + '\nTHIS AREA\'S SURFACE:\n' + a.mission + '\n\n' +
        'Probe the inputs this area exposes, with BENIGN markers only:\n' +
        '  - REFLECTION / XSS: submit a unique harmless marker (qasec-<random>) and check whether it comes back into the page UNESCAPED (in HTML, an attribute, or a JS context). Proof = the marker rendered as markup, not as text. Do NOT use a payload that actually executes anything harmful, and do NOT store one anywhere that another user would load.\n' +
        '  - INJECTION SIGNALS: send input that is syntactically awkward but harmless (a quote, a backslash) and watch for a database/parser ERROR leaking back. The error is the finding. NEVER send DROP/DELETE/UPDATE, never attempt to read data through an injection, never chain it.\n' +
        '  - PATH TRAVERSAL: on parameters that name a file, try a read-only traversal to a harmless known path. Proof = content you should not get. Do not go further.\n' +
        '  - OPEN REDIRECT: on parameters holding a URL, point them at an IN-SCOPE url you control and see whether the app redirects off-path without validation.\n' +
        '  - SSRF: on parameters where the server fetches a URL you supply, point them at an in-scope address and observe whether the server fetches it. Never point at cloud metadata endpoints, internal ranges, or any host outside the allowed list.\n' +
        '  - UPLOADS: is the file type enforced server-side (not just by the accept attribute)? Upload a harmless .txt renamed to an allowed extension and see what the server does. Never upload anything executable.\n' +
        '  - VALIDATION BYPASS: every rule the UI enforces (max length, a range, a required field, a disabled control) — does the SERVER enforce it too when the request is sent without the UI?\n' +
        '  - BUSINESS LOGIC (the part no scanner finds — use the domain notes): negative or fractional quantities, a price or total sent by the client and trusted, skipping a step of a multi-step flow, re-using a one-time action twice, acting on a resource after it should be locked/closed/expired.\n\n' +
        'Remember: prove it exists, then stop. Nothing persists, nothing is extracted, nothing is destroyed.',
      { label: 'input:' + a.key, phase: 'Input-logic', schema: FINDINGS_SCHEMA, agentType: 'general-purpose' }
    ).then((r) => r ? { area: 'input/logic: ' + a.label, key: 'input-' + a.key, sec: r } : null)
  ))
} else {
  log('qa-sec: intrusiveness "passive" → skipping the input and business-logic pass (set "safe-active" to include it).')
}

// ---------------------------------------------------------------- Verify (skeptic)
const all = [...passive, ...authz, ...inputLogic].filter(Boolean)
phase('Verify')
const verified = await pipeline(
  all,
  (r) => {
    const serious = (r.sec.findings || []).filter((f) => (f.severity === 'blocker' || f.severity === 'major') && f.proven !== false)
    if (!serious.length) return { ...r, verify: { verdicts: [] } }
    const list = serious
      .map((f, i) => (i + 1) + '. [' + f.severity + '/' + f.confidence + '] ' + f.title + '\n   what happened: ' + f.whatHappened + '\n   repro: ' + f.repro + '\n   evidence: ' + (f.evidence || 'none'))
      .join('\n')
    return agent(
      preamble() +
        '\n\n=== VERIFY (independent skeptic) ===\nPASS_KEY (for evidence paths): verify-' + r.key + '\nAnother reviewer reported the issues below in "' + r.area + '". Reproduce EACH one yourself from a fresh session, under the SAME rules (detection-first, nothing destructive, nothing persisted). Mark confirmed=true ONLY if you saw it yourself.\n' +
        'Be skeptical in both directions: a missing header that changes nothing in practice is NOT a blocker, and an "access control bug" that is actually the role working as designed is not a bug at all — check the KNOWN-CORRECT notes. If you confirm it, re-judge the severity by real impact.\n\nISSUES:\n' + list,
      { label: 'verify:' + r.key, phase: 'Verify', schema: VERIFY_SCHEMA, agentType: 'general-purpose' }
    ).then((v) => ({ ...r, verify: v || { verdicts: [] } }))
  }
)

const out = verified.filter(Boolean)
let total = 0, proven = 0, blockers = 0
for (const r of out) {
  for (const f of (r.sec.findings || [])) {
    total++
    if (f.proven !== false && f.confidence === 'hard-evidence') proven++
    if (f.severity === 'blocker') blockers++
  }
}
log('qa-sec done: ' + total + ' finding(s) (' + proven + ' with hard evidence, ' + blockers + ' blocker) across ' + out.length + ' pass(es).')
if (INTRUSIVE === 'passive') log('  (passive pass: anything that could not be checked without probing is marked proven:false)')
return out
