// qa-manual — LIVING MANUAL engine (reusable across projects)
// The same "an agent that operates your app" engine as qa-explore, pointed at a different output:
// a coherent, screenshot-annotated USER/CONFIG manual instead of a bug report.
//
// Invoked by the /qa-manual skill via Workflow({ scriptPath, args }) FROM the target project repo.
// TWO-CALL, GATED flow (mirrors qa-heal taking optional `failures`):
//   1) no `manual.toc`  -> RECON only: explore + order features + propose a TOC + audience, then RETURN it
//                          (the skill shows it to the human = GATE 1, edits/approves, re-invokes with toc).
//   2) `manual.toc` set -> CAPTURE each approved section in order + ASSEMBLE one Markdown master
//                          (the skill hands the draft to the human = GATE 2 before publishing).
//
// args = {
//   baseUrl, appPath, login, shotsDir, viewports, projectType,     // same qa.config qa-explore uses
//   manual: {
//     audience: 'end-user' | 'installer',   // default end-user; reshapes TOC + step depth
//     outFile,                              // default docs/manual.md
//     title, product, brand, sampleHint,    // cover copy + the one clean example to reuse throughout
//     toc: [ { key, title, goal } ],        // absent on call 1 (recon); the APPROVED toc on call 2
//   },
// }
export const meta = {
  name: 'qa-manual',
  description: 'Generate a living user/config manual by driving the real app: recon + order features into a setup/usage sequence and propose a TOC + audience for approval (call 1), then walk each approved section in order — screenshot, annotate, and assemble one coherent Markdown master with a single clean example throughout (call 2). Markdown is the master so it re-generates when the UI drifts; a section whose happy path is blocked by a bug is flagged, never faked.',
  phases: [
    { title: 'Recon', detail: 'explore the live app and reorder its features into the sequence a real person follows; propose a TOC + audience (returned for human approval — no screenshots yet)' },
    { title: 'Capture', detail: 'per approved section, in order, drive the app to that view, screenshot and annotate the exact steps; flag any section blocked by a bug' },
    { title: 'Assemble', detail: 'stitch the sections into ONE coherent Markdown master with the shared clean example running through every screenshot' },
  ],
}

const cfg = args || {}
const m = cfg.manual || {}
const BASE = (cfg.baseUrl || 'http://localhost') + (cfg.appPath || '/')
const SHOTS = cfg.shotsDir || '/tmp/qa-manual'
const AUD = m.audience === 'installer' ? 'installer' : 'end-user'
const OUT = m.outFile || 'docs/manual.md'
const VP = (cfg.viewports && cfg.viewports[0]) || { name: 'desktop', width: 1440, height: 900 }
const VPDESC = (VP.width || 1440) + 'x' + (VP.height || 900) + (VP.isMobile ? ' (mobile)' : '')
const SAMPLE = m.sampleHint || 'ONE clean, coherent example (same sample records/flow) reused across the whole manual so the screenshots tell a single story'
const TITLE = m.title || (m.product ? m.product + ' — manual' : 'User manual')
const BRAND = m.brand || m.product || ''

const audienceBlock = AUD === 'installer'
  ? 'AUDIENCE = INSTALLER / CONFIG ADMIN. Document setup & configuration in the order you configure a fresh instance: prerequisites first, then where each setting lives and what each option does. Assume a technical operator. Include gotchas and required-vs-optional.'
  : 'AUDIENCE = END USER / DAILY USE. Document how a NON-technical person uses the app day to day, in the order they would meet each feature. Skip admin/config internals unless the daily user touches them. Plain language, no jargon.'

// Login is described to the agent; credentials come from the env, never inlined.
const L = cfg.login || {}
const loginBlock = L.storageStatePath
  ? 'LOGIN: reuse the saved session at ' + L.storageStatePath + ' (Playwright storageState). If it is missing/expired, log in via the recipe below.'
  : 'LOGIN: go to ' + BASE + ', fill the email field with env $QA_EMAIL and the password field with env $QA_PASS' +
    (L.emailSelector ? ' (email selector: ' + L.emailSelector + ', password selector: ' + L.passwordSelector + ', submit: ' + (L.submitSelector || 'the submit button') + ')' : ' (use the obvious email/password inputs and the submit button)') +
    ', submit, and wait for the app shell' + (L.readySelector ? ' (ready when "' + L.readySelector + '" is visible)' : '') + '. NEVER print the credentials.'

const BOOT = cfg.bootTimeout || 90000
const bootBlock = 'The first load may be slow (cold build): allow up to ' + BOOT + ' ms for the first navigation' +
  (cfg.readySelector ? ' (ready when "' + cfg.readySelector + '" is visible — never screenshot a "loading…" screen as the final state)' : '') +
  ' before deciding anything is wrong.' +
  ((m.warmup || cfg.warmup) ? ' WARM-UP first: request ' + (m.warmup || cfg.warmup) + ' once before capturing.' : '')

// ------------------------------------------------------------------ GATE 1: RECON → propose TOC
if (!m.toc || !m.toc.length) {
  phase('Recon')
  const TOC_SCHEMA = {
    type: 'object', additionalProperties: false,
    required: ['audience', 'toc'],
    properties: {
      audience: { type: 'string' },
      toc: {
        type: 'array', minItems: 1, maxItems: 24,
        items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'title', 'goal'],
          properties: {
            key: { type: 'string', description: 'short kebab-case id, e.g. "login", "base-datos"' },
            title: { type: 'string', description: 'human section title in the app language' },
            goal: { type: 'string', description: 'what the reader should be able to DO after this section' },
          },
        },
      },
      notes: { type: 'string', description: 'ordering rationale, prerequisites, anything the human should know before approving' },
    },
  }
  const recon = await agent(
    'You are documenting a running web app to write its manual. ' + audienceBlock + '\n\n' +
    loginBlock + '\n' + bootBlock + '\n\n' +
    'TASK (recon only — take NO manual screenshots yet): open ' + BASE + ' at ' + VPDESC + ', log in, and explore every functional area (sidebar/nav sections, key screens, settings). Then RE-ORDER what you find into the sequence a real ' + AUD + ' would follow — SETUP/PREREQUISITES FIRST, each section building on the previous (NOT file/menu order). ' +
    'Propose a table of contents: for each section a short key, a human title (in the app\'s language), and the goal (what the reader can DO after it). Add a "notes" line explaining the ordering and any prerequisite. ' +
    'Keep it to the sections a ' + AUD + ' actually needs — merge trivial ones, drop irrelevant admin screens for an end-user guide (or focus on them for an installer guide).',
    { schema: TOC_SCHEMA, label: 'recon-toc', phase: 'Recon' }
  )
  return { stage: 'toc-proposed', audience: AUD, outFile: OUT, toc: recon ? recon.toc : [], notes: recon ? recon.notes : '', _gate: 'Show this TOC + audience to the human to approve/edit, then re-invoke with manual.toc set.' }
}

// ------------------------------------------------------------------ GATE-approved: CAPTURE + ASSEMBLE
const toc = m.toc
const SECTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['key', 'title', 'markdown', 'blocked'],
  properties: {
    key: { type: 'string' },
    title: { type: 'string' },
    markdown: { type: 'string', description: 'the section body in Markdown: numbered steps + short explanations + ![alt](path) image refs to the screenshots taken' },
    screenshots: { type: 'array', items: { type: 'string' }, description: 'absolute paths of the screenshots taken for this section' },
    blocked: { type: 'boolean', description: 'true if the happy path could NOT be completed (a bug blocks it)' },
    blockReason: { type: 'string', description: 'if blocked, what stopped it (so it is flagged, not faked)' },
  },
}
const sections = await pipeline(
  toc,
  (s, _orig, i) => agent(
    'You are writing ONE section of a living manual for a running web app by DRIVING it. ' + audienceBlock + '\n\n' +
    loginBlock + '\n' + bootBlock + '\n\n' +
    'SECTION ' + (i + 1) + '/' + toc.length + ': "' + s.title + '" (key: ' + s.key + ')\nGOAL: ' + s.goal + '\n\n' +
    'Use this SHARED EXAMPLE throughout so all screenshots are coherent: ' + SAMPLE + '.\n\n' +
    'STEPS: open ' + BASE + ' at ' + VPDESC + ', log in, navigate to this feature, and walk its HAPPY PATH exactly as a ' + AUD + ' would. As you go: screenshot each meaningful state to ' + SHOTS + '/' + s.key + '-NN.png and READ each screenshot to confirm it shows what you describe. ' +
    'Write the section as Markdown: a short intro, then NUMBERED steps (what to click/type and what to notice), referencing the screenshots with ![caption](absolute-path). Every instruction and image must come from the REAL app — never invent UI. ' +
    'If the happy path is BLOCKED by a bug (error, dead end, wrong data), set blocked=true with a blockReason and do NOT document a fake/guessed path — the manual must not teach a broken flow.',
    { schema: SECTION_SCHEMA, phase: 'Capture', label: 'capture:' + s.key }
  )
)
const good = sections.filter(Boolean)

phase('Assemble')
const ASSEMBLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outFile', 'markdown', 'sectionCount'],
  properties: {
    outFile: { type: 'string' },
    markdown: { type: 'string', description: 'the FULL assembled manual in Markdown (cover + intro + TOC + all sections in order)' },
    sectionCount: { type: 'integer' },
    blockedSections: { type: 'array', items: { type: 'string' }, description: 'titles of sections flagged as blocked by a bug' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}
const assembled = await agent(
  'Assemble ONE coherent Markdown manual titled "' + TITLE + '"' + (BRAND ? ' (' + BRAND + ')' : '') + '. ' + audienceBlock + '\n\n' +
  'You are given the per-section drafts (JSON). Produce the FULL manual in Markdown: a short cover/intro (one-sentence "what this is"), a table of contents, then every section IN THE GIVEN ORDER, lightly edited for ONE consistent voice and the shared example (' + SAMPLE + '). Keep all ![](...) screenshot references intact. ' +
  'For any section with blocked=true, do NOT include its (nonexistent) happy path — instead add a short "⚠ Known issue" note under its heading and list its title in blockedSections. ' +
  'Write the result to ' + OUT + ' and also return it in `markdown`.\n\nSECTIONS:\n' + JSON.stringify(good.map((s) => ({ key: s.key, title: s.title, markdown: s.markdown, blocked: s.blocked, blockReason: s.blockReason }))),
  { schema: ASSEMBLE_SCHEMA, label: 'assemble', phase: 'Assemble' }
)

return {
  stage: 'drafted',
  audience: AUD,
  outFile: (assembled && assembled.outFile) || OUT,
  sectionCount: good.length,
  blocked: good.filter((s) => s.blocked).map((s) => s.title),
  sections: good.map((s) => ({ key: s.key, title: s.title, blocked: s.blocked, screenshots: s.screenshots || [] })),
  _gate: 'Hand the assembled Markdown to the human to review before publishing (GATE 2).',
}
