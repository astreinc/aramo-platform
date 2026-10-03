// Talent 360 STRICT pixel-parity harness.
//
// Renders BOTH the frozen prototype (file://, its own x-dc runtime) AND the real
// Vite-served ats-web Talent360View, for ALL SEVEN tabs, at an identical
// 1440×900 viewport / deviceScaleFactor 1 / animations disabled / fonts.ready,
// using ONE deterministic fixture that populates every field the production
// Talent360 composed read already supports (so geometry is actually comparable —
// NOT a populated-prototype-vs-sparse-record false test). The two ruled gaps
// (opportunity commercial facts; per-requisition contact evidence) stay honest-
// empty: the fixture does not invent them.
//
// Output per tab: prototype.png, actual.png, overlay-50.png, diff.png, plus a
// geometry table (text-anchored getBoundingClientRect + computed styles) and
// per-tab/-region diff metrics (changed-pixel % and mean-abs-error). Image diff
// is done in Chromium's own canvas — NO pixelmatch/pngjs dependency added.
//
// FIXTURE IS VISUAL-HARNESS DATA ONLY — never production code or app fallback.
//
// Run:
//   1) npx nx serve aramo-ats-web                 # serves http://localhost:4201
//   2) node apps/ats-web/visual-harness/talent-360-parity.mjs
//   3) inspect $T360_OUT_DIR (default /tmp/t360-parity): <tab>.{prototype,actual,overlay-50,diff}.png,
//      geometry.json, metrics.json, report.md
// Env: T360_BASE (default http://localhost:4201), T360_PROTO (prototype file path),
//      T360_OUT_DIR (default /tmp/t360-parity).
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.T360_BASE || 'http://localhost:4201';
const PROTO_PATH =
  process.env.T360_PROTO ||
  '/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/design/aramo-prototype/platform/Talent 360.dc.html';
// The x-dc runtime fetches the page source to expand its templates, which the
// file:// scheme blocks — so the prototype must be served over HTTP. Pass
// T360_PROTO_URL (e.g. http://localhost:8899/Talent%20360.dc.html) after serving
// the prototype directory; file:// is only a (degraded) fallback.
const PROTO_URL = process.env.T360_PROTO_URL || 'file://' + encodeURI(PROTO_PATH);
const OUT = process.env.T360_OUT_DIR || '/tmp/t360-parity';
const TALENT_ID = '11111111-1111-7111-8111-111111111111';
const VIEWPORT = { width: 1440, height: 900 };

mkdirSync(OUT, { recursive: true });

// ── deterministic fixture (every production-supported field populated) ─────────
const j = (reqId, sub, stages) => ({
  requisition_id: reqId, talent_record_id: TALENT_ID, current_journey_stage: sub.pipeline_stage || 'QUALIFIED',
  stages: stages || [], sub_states: { pipeline_stage: 'qualified', submittal_state: null, selection_state: null, interview_state: null, offer_state: null, placement_state: null, pre_start_state: null, assignment_state: null, ...sub }, actions: [],
});
const FIXTURE = {
  generated_at: '2026-09-30T13:14:00.000Z', server_date: '2026-09-30',
  header: {
    talent_id: TALENT_ID, first_name: 'Divya', last_name: 'Vasudevan', display_name: 'Divya Vasudevan',
    title: 'Scrum Master / Product Owner', location: 'Vienna, VA (Eastern)', experience_summary: '11 yrs experience',
    email: 'divya.vasudevan@gmail.com', phone: '(703) 555-0182', work_authorization: 'permanent_resident',
    desired_compensation: '$85/hr', engagement_type: 'c2c',
    availability: { status: 'available_now', detail: 'Current contract ends Sep 30' },
    recruiting_ready: { ready: true, rule: 'A live record with a contact channel and work authorization on record.' },
    contactability: { summary: 'contactable', recruiting_permitted: true, email_permitted: true, phone_permitted: true, sms_permitted: false },
    actions: { can_email: true, can_call: true, can_add_to_requisition: true, can_log_activity: true, can_edit_profile: true },
    record_status: 'live', superseded_by_record_id: null,
  },
  relationship_strip: { active_opportunities: 3, submittals: 2, interviews_today: 1, offers: 0, assignments: 0, last_contact: { at: '2026-09-30T13:14:00.000Z', channel: 'email' } },
  opportunities: {
    active: [
      { pipeline_id: 'p1', requisition_id: 'r1', requisition_code: 'REQ-1001', client_name: 'Freddie Mac', role_title: 'Scrum Master — Multifamily', stage: 'INTERVIEW', contextual_state: 'Client interview today', age_label: '2d', owner_label: 'You', next_action: { kind: 'open_interview', label: 'Open interview', href: '/requisitions/r1' }, open_journey_href: '/requisitions/r1', journey: j('r1', { pipeline_stage: 'INTERVIEW', submittal_state: 'submitted_to_client', selection_state: 'INTERVIEW', interview_state: 'SCHEDULED' }, [{ stage: 'INTERVIEW', owner: 'client-selection', source_object_id: 'csp1' }]) },
      { pipeline_id: 'p2', requisition_id: 'r2', requisition_code: 'REQ-1032', client_name: 'Fannie Mae', role_title: 'Agile Delivery Lead', stage: 'CLIENT_REVIEW', contextual_state: 'Waiting for client · 3 days', age_label: '3d', owner_label: 'Sanjay Kumar', next_action: { kind: 'follow_up', label: 'Follow up', href: '/requisitions/r2' }, open_journey_href: '/requisitions/r2', journey: j('r2', { pipeline_stage: 'CLIENT_REVIEW', submittal_state: 'submitted_to_client', selection_state: 'CLIENT_REVIEW' }, [{ stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'csp2', occurred_at: '2026-09-27T12:00:00Z' }]) },
      { pipeline_id: 'p3', requisition_id: 'r3', requisition_code: 'REQ-1048', client_name: 'Capital One', role_title: 'Senior Scrum Master', stage: 'QUALIFYING', contextual_state: 'Compensation not confirmed', age_label: '1d', owner_label: 'You', next_action: { kind: 'continue_qualification', label: 'Continue qualification', href: '/requisitions/r3' }, open_journey_href: '/requisitions/r3', journey: j('r3', { pipeline_stage: 'QUALIFYING', submittal_state: null }, []) },
    ],
    closed: [
      { pipeline_id: 'p4', requisition_id: 'r4', requisition_code: 'REQ-0921', client_name: 'Wells Fargo', role_title: 'Agile Coach', outcome: 'Not selected', closed_at: '2026-06-01T00:00:00Z', open_journey_href: '/requisitions/r4' },
      { pipeline_id: 'p5', requisition_id: 'r5', requisition_code: 'REQ-0874', client_name: 'Truist', role_title: 'Scrum Master', outcome: 'Withdrew', closed_at: '2026-03-01T00:00:00Z', open_journey_href: '/requisitions/r5' },
    ],
  },
  attention: [
    { id: 'a1', kind: 'interview', kicker: 'TODAY · 4:00 PM', title: 'Freddie Mac client interview', subtitle: 'REQ-1001 · Teams · talent confirmed', requisition_id: 'r1', requisition_label: 'REQ-1001', action: { kind: 'open', label: 'Open', href: '/requisitions/r1' } },
    { id: 'a2', kind: 'blocking', kicker: 'BLOCKING QUALIFICATION', title: 'Capital One: compensation not confirmed', subtitle: 'REQ-1048 · W2 rate needed', requisition_id: 'r3', requisition_label: 'REQ-1048', action: { kind: 'continue', label: 'Continue', href: '/requisitions/r3' } },
    { id: 'a3', kind: 'waiting', kicker: 'WAITING 3 DAYS', title: "Fannie Mae hasn't responded", subtitle: 'REQ-1032 · submitted Sep 27', requisition_id: 'r2', requisition_label: 'REQ-1032', action: { kind: 'follow_up', label: 'Follow up', href: '/requisitions/r2' } },
    { id: 'a4', kind: 'identity', kicker: 'IDENTITY', title: 'Possible duplicate profile', subtitle: '"Divya V." shares this mobile', requisition_id: null, requisition_label: null, action: { kind: 'review', label: 'Review', href: '/identity/advisories' } },
  ],
  tasks: [
    { id: 't1', title: 'Debrief call with Divya after Freddie Mac interview', status: 'open', due_date: '2026-10-01T00:00:00Z', requisition_id: 'r1', requisition_label: 'REQ-1001' },
    { id: 't2', title: 'Confirm Capital One hybrid policy with Deepika', status: 'open', due_date: '2026-10-02T00:00:00Z', requisition_id: 'r3', requisition_label: 'REQ-1048' },
  ],
  recent_activity: {
    items: [
      { id: 'e1', occurred_at: '2026-09-30T13:14:00Z', category: 'communications', title: 'Email received', body: '"Hybrid three days works for me. Happy to proceed."', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'From Divya · reply to prep email', channel: 'email' },
      { id: 'e2', occurred_at: '2026-09-30T12:40:00Z', category: 'interviews', title: 'Interview confirmed by talent', body: 'Freddie Mac client panel · today 4:00 PM', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'Via calendar response', channel: null },
      { id: 'e3', occurred_at: '2026-09-29T19:42:00Z', category: 'communications', title: 'Voice call · two-way · 11 min', body: 'Interested in Capital One. Would consider about $72/hr W2.', requisition_id: 'r3', requisition_label: 'REQ-1048', actor_label: 'Purush P. · Zoom', channel: 'voice' },
      { id: 'e4', occurred_at: '2026-09-28T15:30:00Z', category: 'client', title: 'Client scheduled interview', body: 'Michael Tran booked a panel for Sep 30', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'Freddie Mac', channel: null },
      { id: 'e5', occurred_at: '2026-09-27T16:02:00Z', category: 'requisitions', title: 'Submitted to Fannie Mae', body: 'Agile Delivery Lead · tailored résumé attached', requisition_id: 'r2', requisition_label: 'REQ-1032', actor_label: 'Sanjay Kumar', channel: null },
      { id: 'e6', occurred_at: '2026-09-26T09:48:00Z', category: 'documents', title: 'RTR signed', body: 'Right to Represent for Freddie Mac', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'Signed by Divya', channel: null },
      { id: 'e7', occurred_at: '2026-09-25T10:05:00Z', category: 'tasks', title: 'Task created', body: 'Debrief call with Divya after Freddie Mac interview', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'Purush P.', channel: null },
    ],
    category_counts: { communications: 2, interviews: 1, client: 1, requisitions: 1, documents: 1, tasks: 1 },
    has_more: true,
  },
  documents: {
    key_documents: [
      { id: 'd1', kind: 'Résumé', requisition_id: null, requisition_label: null, meta: 'Divya_Vasudevan_2026.docx · current · uploaded Sep 14', signed: false, signed_at: null },
      { id: 'd2', kind: 'Résumé · tailored', requisition_id: 'r1', requisition_label: 'REQ-1001', meta: 'Divya_Vasudevan_FreddieMac.docx · submitted Sep 26', signed: false, signed_at: null },
      { id: 'd3', kind: 'RTR · Freddie Mac', requisition_id: 'r1', requisition_label: 'REQ-1001', meta: 'Signed', signed: true, signed_at: '2026-09-26T00:00:00Z' },
      { id: 'd4', kind: 'RTR · Fannie Mae', requisition_id: 'r2', requisition_label: 'REQ-1032', meta: 'Signed', signed: true, signed_at: '2026-09-25T00:00:00Z' },
    ],
    total: 5,
  },
  identity: { primary_email_confirmed: true, mobile_confirmed: true, advisory: { advisory_id: 'adv1', label: 'Possible duplicate needs review' } },
  profile: {
    summary: '11 years in Agile delivery across financial services. SAFe SPC. Led four Scrum teams through a mortgage-platform modernization at Navy Federal.',
    facts: [
      { label: 'availability', value: 'available_now', source: 'Current contract ends Sep 30' },
      { label: 'compensation', value: '$85/hr C2C', source: 'Stated on call · Sep 29' },
      { label: 'work authorization', value: 'permanent_resident', source: 'Self-reported · Sep 23' },
      { label: 'location', value: 'Vienna, VA', source: 'Hybrid up to 3 days onsite' },
      { label: 'engagement', value: 'Contract · C2C or W2', source: 'Talent-stated' },
      { label: 'notice', value: 'None needed', source: 'Talent-stated · Sep 24' },
    ],
    skills: [
      { label: 'Scrum', verified: true }, { label: 'SAFe', verified: true }, { label: 'Jira', verified: true },
      { label: 'Product ownership', verified: true }, { label: 'Stakeholder management', verified: true },
      { label: 'Kanban', verified: false }, { label: 'Confluence', verified: false }, { label: 'Mortgage / multifamily', verified: false },
    ],
    work_history: [
      { role: 'Senior Scrum Master', organization: 'Navy Federal Credit Union', span: '2022 – Sep 2026', source: 'Résumé + second source' },
      { role: 'Scrum Master / Product Owner', organization: 'Booz Allen Hamilton', span: '2018 – 2022', source: 'Résumé + second source' },
      { role: 'Business Analyst', organization: 'CGI Federal', span: '2015 – 2018', source: 'Résumé only' },
    ],
  },
  relationship: {
    history: { known_since: '2024-03-01T00:00:00Z', requisitions: 5, submittals: 3, interviews: 2, placements: 0 },
    ownership: { owner_provenance: { user_id: 'u1', name: 'Purush P.' }, also_working_with: [{ user_id: 'u2', name: 'Sanjay Kumar', requisition_id: 'r2', requisition_label: 'REQ-1032' }], source: 'Referral sourcing', source_channel: null },
  },
  authorized_sections: { opportunities: true, attention: true, tasks: true, activity: true, communications: true, documents: true, identity: true },
};
const ME = { user: { display_name: 'Purush Pichaimuthu', email: 'purush@astreconsulting.com' }, roles: ['tenant_owner'], tenant: { display_name: 'Astre Consulting Services Inc', status: 'ACTIVE' } };
const DOSSIER = { ledger_established: true, dimensions: { identity: { band: 'supported' }, claims: { band: 'supported' }, continuity: { band: 'supported' }, eligibility: { band: 'self_reported' } }, verifications: [], merge_provenance: [], statements: [], contradictions: [], proposal_pointers: [] };
const nowSec = 1_790_000_000;
const SESSION = { sub: '00000000-0000-7000-8000-000000000bb1', consumer_type: 'recruiter', tenant_id: TALENT_ID, scopes: ['talent:read', 'pipeline:read', 'task:read', 'activity:read', 'communication:read', 'communication:voice:call', 'document:read', 'identity:resolve', 'dashboard:read', 'requisition:read', 'placement:read', 'company:read', 'contact:read', 'report:read'], iat: nowSec, exp: nowSec + 3600 };

// ── sparse / empty-state fixtures (§20 matrix) — actual-only, no prototype
// compare (the prototype has no sparse state). SPARSE = a thin real record;
// UNAUTH = documents scope not granted (section is authorization-hidden). */
const SPARSE = {
  ...FIXTURE,
  relationship_strip: { active_opportunities: 1, submittals: null, interviews_today: 0, offers: 0, assignments: 0, last_contact: { at: '2026-09-21T14:45:00.000Z', channel: 'email' } },
  opportunities: { active: [{ pipeline_id: 'p1', requisition_id: 'r1', requisition_code: 'REQ-1000', client_name: 'Technology Ventures', role_title: 'Business Analyst - Multi-Family', stage: 'SOURCED', contextual_state: null, age_label: null, owner_label: 'Purush Pichaimuthu', next_action: null, open_journey_href: '/requisitions/r1', journey: j('r1', { pipeline_stage: 'SOURCED' }, [{ stage: 'SOURCED', owner: 'pipeline', source_object_id: 'pl1' }]) }], closed: [] },
  attention: [],
  tasks: [],
  recent_activity: { items: [{ id: 'e1', occurred_at: '2026-09-21T14:45:00Z', category: 'communications', title: 'Email sent', body: null, requisition_id: null, requisition_label: null, actor_label: null, channel: 'email' }, { id: 'e2', occurred_at: '2026-09-14T16:00:00Z', category: 'communications', title: 'Email sent', body: null, requisition_id: null, requisition_label: null, actor_label: null, channel: 'email' }], category_counts: { communications: 2 }, has_more: false },
  documents: { key_documents: [], total: 0 },
  identity: { primary_email_confirmed: true, mobile_confirmed: true, advisory: null },
  profile: { summary: null, facts: [{ label: 'availability', value: 'available_now', source: null }, { label: 'compensation', value: '70/Hr', source: null }, { label: 'work authorization', value: 'permanent_resident', source: null }, { label: 'location', value: 'Vienna, VA', source: null }, { label: 'engagement', value: 'Contract', source: null }], skills: [], work_history: [] },
  relationship: { history: { known_since: '2026-09-01T00:00:00Z', requisitions: 1, submittals: 0, interviews: 0, placements: 0 }, ownership: { owner_provenance: { user_id: 'u1', name: 'Purush Pichaimuthu' }, also_working_with: [], source: null, source_channel: null } },
};
const UNAUTH = { ...FIXTURE, documents: null, attention: null, tasks: null, authorized_sections: { opportunities: true, attention: false, tasks: false, activity: true, communications: true, documents: false, identity: true } };
const STATE = process.env.T360_STATE || 'full';
const ACTIVE_FIXTURE = STATE === 'sparse' ? SPARSE : STATE === 'unauth' ? UNAUTH : FIXTURE;

const NO_ANIM = '*{transition:none!important;animation:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';

const TABS = [
  { n: '01', key: 'overview', actual: /^Overview/, proto: 'Overview' },
  { n: '02', key: 'opportunities', actual: /^Opportunities/, proto: 'Opportunities' },
  { n: '03', key: 'profile', actual: /^Profile/, proto: 'Profile' },
  { n: '04', key: 'engagement', actual: /^Engagement/, proto: 'Engagement' },
  { n: '05', key: 'activity', actual: /^Activity/, proto: 'Activity' },
  { n: '06', key: 'documents', actual: /^Documents/, proto: 'Documents' },
  { n: '07', key: 'trust', actual: /^Trust/, proto: 'Trust' },
];

// Text-anchored geometry probes (same visible text on both sides). Each returns
// rect + key computed styles for the element matching `text` (optionally its Nth
// ancestor via `up`).
const GEOM_PROBES = [
  { id: 'talent-name', text: 'Divya Vasudevan', up: 0 },
  { id: 'avatar', text: 'DV', up: 0 },
  { id: 'kpi-card (ACTIVE OPPORTUNITIES)', text: 'ACTIVE OPPORTUNITIES', up: 1 },
  { id: 'tab-overview', text: 'Overview', up: 0 },
  { id: 'section-title (Active opportunities)', text: 'Active opportunities', up: 0 },
];

async function measure(page, probes) {
  return page.evaluate((probes) => {
    const pick = (text) => {
      const all = [...document.querySelectorAll('body *')];
      return all.find((el) => el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === text))
        || all.find((el) => el.textContent.trim() === text);
    };
    const out = {};
    for (const p of probes) {
      let el = pick(p.text);
      for (let i = 0; i < (p.up || 0) && el; i++) el = el.parentElement;
      if (!el) { out[p.id] = null; continue; }
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      out[p.id] = {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight,
        padding: c.padding, borderRadius: c.borderRadius, gap: c.gap,
      };
    }
    // layout columns
    const main = document.querySelector('main') || document.body;
    const mr = main.getBoundingClientRect();
    out['__main'] = { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) };
    return out;
  }, probes);
}

// Canvas diff (in-browser, no deps). Returns {changedPct, mae} and writes diff + overlay PNGs.
async function diffPair(page, protoPng, actualPng, diffPath, overlayPath) {
  const protoB64 = readFileSync(protoPng).toString('base64');
  const actualB64 = readFileSync(actualPng).toString('base64');
  const res = await page.evaluate(async ({ protoB64, actualB64 }) => {
    const load = (b64) => new Promise((resolve) => { const im = new Image(); im.onload = () => resolve(im); im.src = 'data:image/png;base64,' + b64; });
    const [a, b] = await Promise.all([load(protoB64), load(actualB64)]);
    const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
    const mk = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return { c, g, d: g.getImageData(0, 0, w, h).data }; };
    const A = mk(a), B = mk(b);
    const diff = document.createElement('canvas'); diff.width = w; diff.height = h; const dg = diff.getContext('2d'); const di = dg.createImageData(w, h);
    let changed = 0, sum = 0; const thresh = 32;
    for (let i = 0; i < A.d.length; i += 4) {
      const dr = Math.abs(A.d[i] - B.d[i]), dgc = Math.abs(A.d[i + 1] - B.d[i + 1]), db = Math.abs(A.d[i + 2] - B.d[i + 2]);
      const md = (dr + dgc + db) / 3; sum += md;
      if (md > thresh) { changed++; di.data[i] = 255; di.data[i + 1] = 0; di.data[i + 2] = 0; di.data[i + 3] = 255; }
      else { di.data[i] = A.d[i]; di.data[i + 1] = A.d[i + 1]; di.data[i + 2] = A.d[i + 2]; di.data[i + 3] = 60; }
    }
    dg.putImageData(di, 0, 0);
    const ov = document.createElement('canvas'); ov.width = w; ov.height = h; const og = ov.getContext('2d'); og.drawImage(a, 0, 0, w, h); og.globalAlpha = 0.5; og.drawImage(b, 0, 0, w, h);
    const px = w * h;
    return { changedPct: +(100 * changed / px).toFixed(2), mae: +(sum / px).toFixed(2), w, h, diff: diff.toDataURL('image/png'), overlay: ov.toDataURL('image/png') };
  }, { protoB64, actualB64 });
  writeFileSync(diffPath, Buffer.from(res.diff.split(',')[1], 'base64'));
  writeFileSync(overlayPath, Buffer.from(res.overlay.split(',')[1], 'base64'));
  return { changedPct: res.changedPct, mae: res.mae, w: res.w, h: res.h };
}

const browser = await chromium.launch({ headless: true });

// ── actual (React) context with HTTP mocks ────────────────────────────────────
const actx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const apage = await actx.newPage();
apage.on('console', (m) => { if (m.type() === 'error') console.log('ACTUAL-ERR:', m.text().slice(0, 160)); });
await apage.route('**/v1/talent-360/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ACTIVE_FIXTURE) }));
await apage.route('**/v1/me', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
await apage.route('**/auth/recruiter/session', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSION) }));
await apage.route('**/communications/capabilities**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ voice_call: true }) }));
await apage.route('**/v1/**/dossier**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DOSSIER) }));
await apage.goto(`${BASE}/talent/${TALENT_ID}`, { waitUntil: 'networkidle' }).catch((e) => console.log('actual goto:', String(e)));
await apage.addStyleTag({ content: NO_ANIM });
await apage.waitForTimeout(800);
try { await apage.evaluate(() => document.fonts && document.fonts.ready); } catch {}
console.log('ACTUAL tabs:', await apage.locator('.t360-tab').count());

// ── prototype (file://) context (only in full compare mode) ───────────────────
let ppage = null;
if (STATE === 'full') {
  const pctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  ppage = await pctx.newPage();
  ppage.on('console', (m) => { if (m.type() === 'error') console.log('PROTO-ERR:', m.text().slice(0, 160)); });
  await ppage.goto(PROTO_URL, { waitUntil: 'networkidle' }).catch((e) => console.log('proto goto:', String(e)));
  await ppage.addStyleTag({ content: NO_ANIM });
  await ppage.waitForTimeout(800);
  try { await ppage.evaluate(() => document.fonts && document.fonts.ready); } catch {}
}
// Sparse/empty states are captured actual-only into a sub-directory.
const STATE_OUT = STATE === 'full' ? OUT : `${OUT}/${STATE}`;
mkdirSync(STATE_OUT, { recursive: true });

const clickActualTab = async (re) => {
  const t = apage.locator('button.t360-tab', { hasText: re }).first();
  await t.click({ force: true, timeout: 8000 }).catch((e) => console.log('actual tab click', String(e).split('\n')[0]));
  await apage.waitForTimeout(400);
};
const clickProtoTab = async (text) => {
  if (!ppage) return;
  const t = ppage.locator('button', { hasText: text }).filter({ hasNotText: 'Add to requisition' }).first();
  await t.click({ force: true, timeout: 8000 }).catch((e) => console.log('proto tab click', String(e).split('\n')[0]));
  await ppage.waitForTimeout(400);
};

const geometry = {};
const metrics = {};

for (const tab of TABS) {
  await clickActualTab(tab.actual);
  await clickProtoTab(tab.proto);
  // Deterministic expand: first opportunity on Overview/Opportunities.
  if (tab.key === 'overview' || tab.key === 'opportunities') {
    const row = apage.locator('.t360-opp-row').first();
    if (await row.count()) { await row.click({ force: true }).catch(() => {}); await apage.waitForTimeout(300); }
    // prototype auto-expands opp 1001 on Overview and all on Opportunities.
  }
  await apage.evaluate(() => window.scrollTo(0, 0));
  await apage.waitForTimeout(200);

  // Sparse/empty-state mode: actual-only evidence, no prototype compare.
  if (STATE !== 'full') {
    await apage.screenshot({ path: `${STATE_OUT}/${tab.n}-${tab.key}.${STATE}.png` });
    await apage.screenshot({ path: `${STATE_OUT}/${tab.n}-${tab.key}.${STATE}.full.png`, fullPage: true });
    console.log(`${tab.n} ${tab.key} [${STATE}]: captured`);
    continue;
  }

  await ppage.evaluate(() => window.scrollTo(0, 0));
  const aPng = `${OUT}/${tab.n}-${tab.key}.actual.png`;
  const pPng = `${OUT}/${tab.n}-${tab.key}.prototype.png`;
  await apage.screenshot({ path: aPng }); // 1440x900 viewport
  await ppage.screenshot({ path: pPng });
  // full-page too (for inspection)
  await apage.screenshot({ path: `${OUT}/${tab.n}-${tab.key}.actual.full.png`, fullPage: true });
  await ppage.screenshot({ path: `${OUT}/${tab.n}-${tab.key}.prototype.full.png`, fullPage: true });

  const m = await diffPair(apage, pPng, aPng, `${OUT}/${tab.n}-${tab.key}.diff.png`, `${OUT}/${tab.n}-${tab.key}.overlay-50.png`);
  metrics[tab.key] = { viewport: m };
  geometry[tab.key] = { actual: await measure(apage, GEOM_PROBES), prototype: await measure(ppage, GEOM_PROBES) };

  // Main-content region diff — isolates the Talent 360 content from the shell
  // (sidebar/top bar, which are RecruiterShell-owned and differ by design). Both
  // sides are clipped to a common region anchored at each page's <main> top-left.
  const am = geometry[tab.key].actual.__main, pm = geometry[tab.key].prototype.__main;
  const cw = Math.max(1, Math.floor(Math.min(am.w, pm.w)));
  const ch = Math.max(1, Math.floor(Math.min(VIEWPORT.height - am.y, VIEWPORT.height - pm.y)) - 2);
  const aMainPng = `${OUT}/${tab.n}-${tab.key}.actual.main.png`;
  const pMainPng = `${OUT}/${tab.n}-${tab.key}.prototype.main.png`;
  await apage.screenshot({ path: aMainPng, clip: { x: am.x, y: am.y, width: cw, height: ch } });
  await ppage.screenshot({ path: pMainPng, clip: { x: pm.x, y: pm.y, width: cw, height: ch } });
  const mm = await diffPair(apage, pMainPng, aMainPng, `${OUT}/${tab.n}-${tab.key}.main.diff.png`, `${OUT}/${tab.n}-${tab.key}.main.overlay-50.png`);
  metrics[tab.key].mainRegion = mm;
  console.log(`${tab.n} ${tab.key}: viewport changed=${m.changedPct}% mae=${m.mae} | MAIN changed=${mm.changedPct}% mae=${mm.mae} (${mm.w}x${mm.h})`);
}

if (STATE === 'full') {
writeFileSync(`${OUT}/geometry.json`, JSON.stringify(geometry, null, 2));
writeFileSync(`${OUT}/metrics.json`, JSON.stringify(metrics, null, 2));

// ── per-region matrix (Overview: header · KPI/fact · tab strip · main section ·
// right rail). Regions are resolved on BOTH sides by a text anchor + an ancestor
// walk to the region container; each is measured (rect + key computed styles),
// cropped, and diffed. The crop is anchored at each region's own top-left so the
// shell offset is removed — this is the Aramo-owned local-alignment evidence. */
const REGION_RESOLVER = `(() => {
  const txt = (t) => [...document.querySelectorAll('body *')].find((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === t));
  const cs = (el) => getComputedStyle(el);
  const up = (el, cond) => { let e = el, g = 0; while (e && g++ < 14) { if (cond(e)) return e; e = e.parentElement; } return null; };
  const rs = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); const c = cs(el); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), borderRadius: c.borderRadius, padding: c.padding, gap: c.gap, fontSize: c.fontSize }; };
  const w = (el) => (el ? el.getBoundingClientRect().width : 0);
  const header = up(txt('divya.vasudevan@gmail.com'), (e) => cs(e).borderRadius.startsWith('13') && w(e) > 800);
  const kpi = up(txt('ACTIVE OPPORTUNITIES'), (e) => cs(e).display === 'grid' && w(e) > 900);
  const tabs = up(txt('Overview'), (e) => e.querySelectorAll('button,[role=tab]').length >= 5 && w(e) > 700);
  const section = up(txt('Active opportunities'), (e) => cs(e).borderRadius.startsWith('13') && w(e) > 480 && w(e) < 1000);
  const rail = up(txt('Your attention'), (e) => w(e) >= 280 && w(e) <= 345 && e.childElementCount >= 3);
  return { header: rs(header), kpi: rs(kpi), tabs: rs(tabs), section: rs(section), rail: rs(rail) };
})()`;

await clickActualTab(/^Overview/);
await clickProtoTab('Overview');
await apage.evaluate(() => window.scrollTo(0, 0));
await ppage.evaluate(() => window.scrollTo(0, 0));
await apage.waitForTimeout(300);
const aReg = await apage.evaluate(REGION_RESOLVER);
const pReg = await ppage.evaluate(REGION_RESOLVER);
const regionReport = {};
for (const name of ['header', 'kpi', 'tabs', 'section', 'rail']) {
  const a = aReg[name], p = pReg[name];
  if (!a || !p) { regionReport[name] = { resolved: false, actual: a, prototype: p }; console.log(`REGION ${name}: UNRESOLVED (actual=${!!a} proto=${!!p})`); continue; }
  const cw = Math.max(1, Math.floor(Math.min(a.w, p.w)));
  const ch = Math.max(1, Math.floor(Math.min(a.h, p.h, VIEWPORT.height - a.y, VIEWPORT.height - p.y)) - 1);
  const aC = `${OUT}/region-${name}.actual.png`, pC = `${OUT}/region-${name}.prototype.png`;
  await apage.screenshot({ path: aC, clip: { x: a.x, y: a.y, width: cw, height: ch } });
  await ppage.screenshot({ path: pC, clip: { x: p.x, y: p.y, width: cw, height: ch } });
  const d = await diffPair(apage, pC, aC, `${OUT}/region-${name}.diff.png`, `${OUT}/region-${name}.overlay-50.png`);
  regionReport[name] = { resolved: true, actual: a, prototype: p, dx: a.x - p.x, dy: a.y - p.y, dw: a.w - p.w, dh: a.h - p.h, diff: d };
  console.log(`REGION ${name}: Δx=${a.x - p.x} Δy=${a.y - p.y} Δw=${a.w - p.w} Δh=${a.h - p.h} | radius a=${a.borderRadius} p=${p.borderRadius} | pad a=${a.padding} p=${p.padding} | diff=${d.changedPct}%`);
}
writeFileSync(`${OUT}/region-report.json`, JSON.stringify(regionReport, null, 2));
console.log('WROTE geometry.json + metrics.json + region-report.json to', OUT);
} else {
  console.log('WROTE', STATE, 'sparse-state captures to', STATE_OUT);
}
await browser.close();
