// Submittal Workspace STRICT pixel-parity harness — SW-5.
//
// Captures the approved prototype (platform/Submittal Workspace CRM.dc.html,
// served over file:// so its x-dc runtime + #st= state machine expand) for each
// SW-5 state, AND — when a live authenticated ats-web dev server is available —
// the real SubmittalWorkspaceView at an identical 1440×900 viewport / dSF 1 /
// animations off / fonts.ready, over a deterministic route-mocked SW-4 workspace
// payload, so SW-5-owned geometry is comparable.
//
// The actual side needs an AUTHENTICATED dev server (the workspace route is behind
// RouteGuard): bring up the local run (FE:4201 + API:3000 + auth:3001, same SHA —
// see reference_local_run_from_dist_recovery) and sign in, then set SW_CAPTURE_ACTUAL=1.
// Without it, only the prototype reference states are captured (always available).
//
// Run:
//   1) (optional, for the actual side) local run up + signed in; SW_CAPTURE_ACTUAL=1
//   2) node apps/ats-web/visual-harness/submittal-workspace-parity.mjs
// Env: SW_BASE (default http://localhost:4201), SW_PROTO / SW_PROTO_URL,
//      SW_OUT_DIR (default /tmp/sw5-parity), SW_CAPTURE_ACTUAL (default off).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.SW_BASE || 'http://localhost:4201';
const PROTO_PATH =
  process.env.SW_PROTO ||
  '/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/design/aramo-prototype/platform/Submittal Workspace CRM.dc.html';
const PROTO_URL = process.env.SW_PROTO_URL || 'file://' + encodeURI(PROTO_PATH);
const OUT = process.env.SW_OUT_DIR || '/tmp/sw5-parity';
const CAPTURE_ACTUAL = process.env.SW_CAPTURE_ACTUAL === '1';
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });

// The prototype states to capture (its #st= hash machine). A–N + an RTR-focus entry.
const STATES = [
  { id: 'A', hash: '#st=A&sc=marcus', label: 'Draft — several missing' },
  { id: 'C', hash: '#st=C&sc=divya1001', label: 'Ready — can submit' },
  { id: 'D', hash: '#st=D&sc=divya1001', label: 'Ready — view only' },
  { id: 'E', hash: '#st=E&sc=divya1001', label: 'Record submittal modal' },
  { id: 'F', hash: '#st=F&sc=divya1001', label: 'Submitted to client' },
  { id: 'G', hash: '#st=G&sc=divya1001', label: 'Submitted — rate changed' },
  // SW-6 — the client-response spectrum.
  { id: 'H', hash: '#st=H&sc=divya1001', label: 'Client review' },
  { id: 'I', hash: '#st=I&sc=divya1001', label: 'Interview' },
  { id: 'J', hash: '#st=J&sc=divya1001', label: 'Declined' },
  { id: 'K', hash: '#st=K&sc=divya1001', label: 'Selected' },
  { id: 'L', hash: '#st=L&sc=divya1001', label: 'Withdrawn' },
  { id: 'M', hash: '#st=M&sc=divya1001', label: 'Revoked' },
  { id: 'N', hash: '#st=N&sc=divya1001', label: 'Submit refused (race)' },
  { id: 'RTR', hash: '#st=A&sc=marcus&focus=rtr', label: 'RTR-focus entry' },
];

// SW-5-owned regions to measure (text/selector-anchored, prototype side).
const PROBES = [
  { key: 'header', sel: 'main > div:nth-of-type(3)' },
  { key: 'grid', sel: 'main [style*="grid-template-columns"]' },
];

async function measure(page, probes) {
  return page.evaluate((ps) => {
    const out = {};
    for (const p of ps) {
      const el = document.querySelector(p.sel);
      if (!el) { out[p.key] = null; continue; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out[p.key] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), fontSize: cs.fontSize, borderRadius: cs.borderRadius };
    }
    return out;
  }, probes);
}

const ANIM_OFF = `*{animation:none!important;transition:none!important;caret-color:transparent!important}`;

const browser = await chromium.launch();
const geom = { viewport: VIEWPORT, prototype: {}, actual: {} };

// ── Prototype side (always available; no auth) ──────────────────────────────
for (const st of STATES) {
  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript((css) => {
      const s = document.createElement('style'); s.textContent = css; document.documentElement.appendChild(s);
    }, ANIM_OFF);
    await page.goto(PROTO_URL + st.hash, { waitUntil: 'networkidle' });
    await page.waitForTimeout(350);
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.screenshot({ path: `${OUT}/sw5-${st.id}.prototype.png`, fullPage: true });
    geom.prototype[st.id] = await measure(page, PROBES).catch(() => null);
    await ctx.close();
  } catch (e) {
    console.log(`prototype ${st.id} skipped:`, String(e));
  }
}

// ── Actual side (opt-in; needs an authenticated dev server) ─────────────────
if (CAPTURE_ACTUAL) {
  // One representative route-mocked workspace payload per capturable state.
  const mkView = (over) => ({
    identity: { submittal_id: 'sub1', talent: { id: 't1', name: 'Divya Vasudevan' }, requisition: { id: 'r1', title: 'Scrum Master' }, company: { id: 'c1', name: 'Freddie Mac' } },
    context: { recruiter: { id: 'u1', name: 'Deepika Rao' }, owner: { id: 'u2', name: 'Purush P.' }, talent_location: 'McLean, VA', talent_title: 'Scrum Master', work_authorization: 'Permanent resident' },
    pipeline: { linked_episode_id: 'p1', current_stage: 'qualifying', is_live: true },
    submittal: { state: 'ready_for_review', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: 're1' },
    readiness: { status: 'READY', requirements: [
      { key: 'rtr', label: 'Right to Represent executed', required: true, satisfied: true, severity: 'blocking', source: 'documents', reason: null, remediation: null, deny_code: null },
      { key: 'resume_selected', label: 'Résumé selected for this requisition', required: true, satisfied: true, severity: 'blocking', source: 'documents', reason: null, remediation: null, deny_code: null },
    ] },
    documents: { rtr_satisfied: true, rtr_deny: null, resume_selected: true },
    engagement: { governed: false, policy_present: false, satisfied: true, override_available: false, unavailable: false },
    commercial: { live_bill_rate_amount: '92.00', live_bill_rate_currency: 'USD', live_bill_rate_period: 'HOURLY', submitted_bill_rate: null, submitted_rate_currency: null, submitted_rate_period: null },
    delivery: { delivery_channel: null, external_reference: null, external_submitted_at: null, submitted_at: null, submitted_by_actor_id: null },
    client_selection: { present: false, state: null, latest_interview: null, feedback: [] },
    actions: { can_submit_to_client: true, submit_authority: true, can_revoke: true },
    ...over,
  });
  const ACTUAL_STATES = {
    C: mkView({}),
    A: mkView({ submittal: { state: 'handoff_draft', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: null }, readiness: { status: 'BLOCKED', requirements: [{ key: 'rtr', label: 'Right to Represent executed', required: true, satisfied: false, severity: 'blocking', source: 'documents', reason: 'A Right to Represent is required but not executed', remediation: 'Obtain an executed Right to Represent for this requisition', deny_code: 'SUBMITTAL_RTR_NOT_EXECUTED' }] }, actions: { can_submit_to_client: false, submit_authority: true, can_revoke: true } }),
    F: mkView({ submittal: { state: 'submitted_to_client', created_at: null, created_by: null, confirmed_at: null, revoked_at: null, resume_edition_id: 're1' }, commercial: { live_bill_rate_amount: '95.00', live_bill_rate_currency: 'USD', live_bill_rate_period: 'HOURLY', submitted_bill_rate: '92.00', submitted_rate_currency: 'USD', submitted_rate_period: 'HOURLY' }, delivery: { delivery_channel: 'manual_vms', external_reference: 'FG-938273', external_submitted_at: null, submitted_at: '2026-10-02T14:42:00.000Z', submitted_by_actor_id: 'u1' }, client_selection: { present: true, state: 'CLIENT_REVIEW', latest_interview: null, feedback: [] }, actions: { can_submit_to_client: false, submit_authority: true, can_revoke: true } }),
  };
  for (const [id, view] of Object.entries(ACTUAL_STATES)) {
    try {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.route('**/v1/submittals?*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ submittal: { id: 'sub1', state: view.submittal.state } }) }));
      await page.route('**/v1/submittals/*/workspace', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) }));
      await page.addInitScript((css) => { const s = document.createElement('style'); s.textContent = css; document.documentElement.appendChild(s); }, ANIM_OFF);
      await page.goto(`${BASE}/talent/t1/submittal/r1/workspace`, { waitUntil: 'networkidle' }).catch((e) => console.log(`actual ${id} goto:`, String(e)));
      await page.waitForTimeout(400);
      await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await page.screenshot({ path: `${OUT}/sw5-${id}.actual.png`, fullPage: true });
      geom.actual[id] = await measure(page, PROBES).catch(() => null);
      await ctx.close();
    } catch (e) {
      console.log(`actual ${id} skipped:`, String(e));
    }
  }
}

writeFileSync(`${OUT}/geometry.json`, JSON.stringify(geom, null, 2));
writeFileSync(`${OUT}/report.md`, [
  '# Submittal Workspace parity — SW-5',
  `Viewport ${VIEWPORT.width}×${VIEWPORT.height}. Prototype states: ${STATES.map((s) => s.id).join(', ')}.`,
  `Actual side captured: ${CAPTURE_ACTUAL ? 'yes' : 'no (set SW_CAPTURE_ACTUAL=1 with an authenticated dev server)'}.`,
  '',
  '```json',
  JSON.stringify(geom, null, 2),
  '```',
].join('\n'), 'utf8');

await browser.close();
console.log(`submittal-workspace-parity: wrote ${OUT} (sw5-*.prototype.png${CAPTURE_ACTUAL ? ', sw5-*.actual.png' : ''}, geometry.json, report.md)`);
