// qa-explore — REPORT engine: file verify-confirmed findings as tracker issues, idempotently.
// Invoked by the /qa-explore skill via Workflow({ scriptPath, args }) AFTER the explore+verify pass,
// when cfg.tracker.type is "gitlab" or "github". This is the first half of the closed loop:
//   file issue  ->  a HUMAN adds the fixLabel to the real ones  ->  /qa-fix opens a MR.
//
// args = {
//   tracker: { type, host, project, tokenEnv, issueLabels, fixLabel, assignees },  // resolved qa.config.tracker
//   findings: [ {                                  // the set the skill chose to file (already de-noised)
//     area, severity, confidence, title, whatHappened, expected, repro,
//     evidence, screenshot, trace, har, video,
//     verified,                                    // true | false | undefined — set it from the Verify
//                                                  // verdicts. Only blocker/major are re-run, so a
//                                                  // filed hard-evidence minor (every a11y hit) is
//                                                  // undefined and the issue says "not assessed".
//   } ],
//   shotsDir,                                      // evidence root (for attaching the primary screenshot)
//   baseUrl,                                        // app URL, for context in the issue body
// }
export const meta = {
  name: 'qa-explore-report',
  description: 'File each verify-confirmed finding as a tracker issue (GitLab/GitHub), idempotently: skip a finding that already has an open qa-explore issue (matched by an embedded fingerprint), otherwise create it with repro, expected behaviour, evidence links and the agreed labels. Half one of the file-issue -> human-mark -> auto-fix loop.',
  phases: [
    { title: 'Report', detail: 'dedup against open issues, then create one issue per new confirmed finding' },
  ],
}

const cfg = args || {}
const tracker = cfg.tracker || {}
const findings = (cfg.findings || [])
const SHOTS = cfg.shotsDir || '/tmp/qa-explore'
const BASE = cfg.baseUrl || '(app url not provided)'

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string' },
          fingerprint: { type: 'string', description: 'AREA::slug used to dedup' },
          action: { type: 'string', enum: ['created', 'skipped-duplicate', 'failed'] },
          iid: { type: 'number', description: 'tracker issue number (iid for GitLab), if created/found' },
          url: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['title', 'action'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['issues'],
}

if (findings.length === 0) {
  log('qa-report: no confirmed findings to file.')
  return { issues: [], summary: 'nothing to file' }
}
if (tracker.type !== 'gitlab' && tracker.type !== 'github') {
  log('qa-report: tracker.type="' + tracker.type + '" — no issues filed (tracker disabled).')
  return { issues: [], summary: 'tracker disabled' }
}

const labels = (tracker.issueLabels && tracker.issueLabels.length) ? tracker.issueLabels : ['qa-explore']
const findingsBlock = findings
  .map((f, i) =>
    '--- FINDING ' + (i + 1) + ' ---\n' +
    'area: ' + (f.area || '?') + '\n' +
    'severity: ' + (f.severity || '?') + '   confidence: ' + (f.confidence || '?') + '\n' +
    // Only blocker/major go through the Verify pass, but the filing policy also files any
    // hard-evidence finding — including every a11y hit, which is minor by construction. Say so
    // per issue: an unverified finding must never read as if a skeptic had confirmed it.
    'verified: ' + (f.verified === true ? 'yes — independently reproduced by a skeptic agent'
      : f.verified === false ? 'NO — the skeptic could not reproduce it'
      : 'not assessed — below the verify threshold (only blocker/major are re-run); treat as a single-agent observation') + '\n' +
    'title: ' + (f.title || '(untitled)') + '\n' +
    'whatHappened: ' + (f.whatHappened || '') + '\n' +
    'expected: ' + (f.expected || '(infer the correct behaviour)') + '\n' +
    'repro: ' + (f.repro || '') + '\n' +
    'evidence: ' + (f.evidence || 'none') + '\n' +
    'screenshot: ' + (f.screenshot || 'none') + '\n' +
    'trace: ' + (f.trace || 'none') + '   har: ' + (f.har || 'none') + '   video: ' + (f.video || 'none'))
  .join('\n')

const TOK = tracker.tokenEnv || (tracker.type === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN')
const attach = (tracker.attachEvidence && tracker.attachEvidence.length) ? tracker.attachEvidence : ['screenshot', 'video']
const maxMb = tracker.maxAttachMb || 10
const isGitlab = tracker.type === 'gitlab'

const evidenceHelp = [
  '',
  'EVIDENCE UPLOAD (so remote reviewers see the bug without local files): for each finding, UPLOAD these artifact kinds when present and ≤ ' + maxMb + ' MB: ' + attach.join(', ') + '.',
  '  - Skip a file that is missing or larger than ' + maxMb + ' MB — instead reference its path in the body (qa-fix can open it locally).',
  isGitlab
    ? '  - GitLab upload: curl -sf --header "PRIVATE-TOKEN: $' + TOK + '" --form "file=@<path>" "<base>/api/v4/projects/<ENC_PROJECT>/uploads"  → the response has a "markdown" field (e.g. "![file](/uploads/..)"); paste that markdown into the issue description to embed it. Upload BEFORE creating the issue and inline the returned markdown in the body.'
    : '  - GitHub has NO issue-attachment API (uploads only work through the web UI), so you cannot embed a local screenshot. Reference the evidence paths in the body, state they live on the QA machine, and paste the decisive console/HTTP line as text so a remote reader still gets the proof.',
  '  - Always embed the screenshot inline (it shows the bug at a glance); put any uploaded video right below it under a "## Watch it happen" heading.',
].join('\n')

const apiHelp = (isGitlab
  ? [
      'TRACKER = GitLab (self-hosted ok). API base: ' + (tracker.host || 'https://gitlab.com') + '/api/v4',
      'Project path "' + (tracker.project || '?') + '" must be URL-encoded for the path segment (replace every "/" with %2F).',
      'Auth header on every call: --header "PRIVATE-TOKEN: $' + TOK + '"  (the token is in that env var; NEVER print it).',
      'List open qa-explore issues (for dedup):',
      '  curl -sf --header "PRIVATE-TOKEN: $' + TOK + '" "<base>/api/v4/projects/<ENC_PROJECT>/issues?state=opened&labels=' + encodeURIComponent(labels.join(',')) + '&per_page=100"',
      'Create an issue (write the JSON body to a temp file, then POST it):',
      '  curl -sf --request POST --header "PRIVATE-TOKEN: $' + TOK + '" --header "Content-Type: application/json" --data @body.json "<base>/api/v4/projects/<ENC_PROJECT>/issues"',
      '  body.json keys: "title", "description", "labels" (comma-joined string: "' + labels.join(',') + '")' + (tracker.assignees && tracker.assignees.length ? ', and resolve assignee usernames to ids if you can' : '') + '.',
      'The response JSON has "iid" (the human issue number) and "web_url" — return those.',
    ]
  : [
      'TRACKER = GitHub. API base: https://api.github.com . Repo "' + (tracker.project || '?') + '".',
      'Auth header on EVERY call: --header "Authorization: Bearer $' + TOK + '" --header "Accept: application/vnd.github+json" (the token is in that env var; NEVER print it).',
      'Do NOT assume the gh CLI exists — it often is not installed. Use curl against the REST API as the primary path; only use gh if `gh auth status` succeeds.',
      'List open qa-explore issues (for dedup):',
      '  curl -sS --header "Authorization: Bearer $' + TOK + '" --header "Accept: application/vnd.github+json" "https://api.github.com/repos/' + (tracker.project || '?') + '/issues?state=open&labels=' + encodeURIComponent(labels[0]) + '&per_page=100"',
      'Create an issue (write the JSON body to a temp file, then POST it):',
      '  curl -sS --write-out "\\nHTTP:%{http_code}\\n" --request POST --header "Authorization: Bearer $' + TOK + '" --header "Accept: application/vnd.github+json" --header "Content-Type: application/json" --data @body.json "https://api.github.com/repos/' + (tracker.project || '?') + '/issues"',
      '  body.json keys: "title" (string), "body" (string), "labels" (JSON array: ' + JSON.stringify(labels) + ')' + (tracker.assignees && tracker.assignees.length ? ', "assignees" (JSON array)' : '') + '.',
      'The response JSON has "number" (the human issue number) and "html_url" — return those as iid/url.',
      'Use -sS (not -sf): -f hides the response body, and on a failure the body is what tells you WHY.',
    ]
).join('\n') + evidenceHelp

const result = await agent(
  [
    'You are filing QA bug reports into an issue tracker via its API. You are precise and idempotent — you NEVER create a duplicate of an issue that already exists.',
    '',
    'APP under test: ' + BASE,
    'Evidence lives under: ' + SHOTS + ' (raw paths are on this machine — UPLOAD the agreed artifacts to the tracker so remote reviewers can see them, and also reference the local paths for the fixer).',
    '',
    apiHelp,
    '',
    'FAIL FAST ON PERMISSIONS — do this BEFORE preparing bodies or uploading anything. A token that can read but not write is the most common misconfiguration (fine-grained tokens grant NOTHING by default, so Issues write must be ticked explicitly). File the FIRST finding on its own and inspect the HTTP status:',
    '  - 401 → the token in $' + TOK + ' is missing, expired or malformed.',
    '  - 403 / 404-on-write → the token is read-only for issues, or is not scoped to this repository.',
    '  In either case STOP IMMEDIATELY. Do NOT attempt the remaining findings, and do NOT report them as failed one by one — return a single clear diagnosis: the HTTP status, the response message, and the exact remediation (' + (isGitlab ? 'the token needs the "api" scope and Reporter+ on the project' : 'the fine-grained token needs Issues: Read and write, scoped to ' + (tracker.project || 'this repo')) + '). Only once that first create SUCCEEDS may you continue with the rest.',
    '',
    'DEDUP (mandatory): each finding has a stable FINGERPRINT = "<AREA>::<kebab-slug-of-title>". First fetch the open qa-explore issues. An issue belongs to qa-explore if its body contains a marker line of the exact form:  <!-- qa-fp: <fingerprint> -->  . Before creating an issue for a finding, compute its fingerprint and check whether any open issue already carries that marker. If yes -> do NOT create a duplicate; record action "skipped-duplicate" with that issue iid/url. If no -> create it.',
    '',
    'ISSUE BODY format (Markdown). Put the fingerprint marker on the FIRST line, then:',
    '  <!-- qa-fp: <fingerprint> -->',
    '  **Severity:** <sev> · **Confidence:** <hard-evidence|judgement> · **Area:** <area>  ·  filed by qa-explore',
    '  ## What happened ...   ## Expected ...   ## Steps to reproduce ...',
    '  ## Evidence — embed the UPLOADED screenshot inline; add the uploaded video under "## Watch it happen"; paste the exact HTTP status / console error; and list the local trace.zip/HAR paths for the fixer.',
    '  Then a "## How a fix will be verified" line telling qa-fix to add a regression test that asserts the *expected* behaviour (red now, green once fixed) and keep the suite green.',
    'Title: concise, prefixed "[qa] " + the finding title. Apply labels: ' + labels.join(', ') + '. Do NOT apply the human gate label "' + (tracker.fixLabel || 'qa::confirmed') + '" — a human adds that after triage.',
    '',
    'Process EVERY finding below. Be resilient: if one create call fails, record action "failed" with the error and continue with the rest.',
    '',
    'FINDINGS TO FILE (' + findings.length + '):',
    findingsBlock,
    '',
    'Return ONLY the structured object: one entry per finding with its action, and the iid/url for created or duplicate ones.',
  ].join('\n'),
  { label: 'report-issues', phase: 'Report', schema: RESULT_SCHEMA, agentType: 'general-purpose' }
)

const issues = (result && result.issues) || []
const created = issues.filter((i) => i.action === 'created').length
const dup = issues.filter((i) => i.action === 'skipped-duplicate').length
const failed = issues.filter((i) => i.action === 'failed').length
log('qa-report: ' + created + ' new issue(s), ' + dup + ' duplicate(s) skipped, ' + failed + ' failed.')
return result || { issues: [] }
