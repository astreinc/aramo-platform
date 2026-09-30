// Talent 360 visual-closure harness (retained regression evidence). Drives the
// REAL Vite-served ats-web / real routing / real Talent360View / real CSS+fonts;
// only the session + GET /v1/talent-360/:id (+ /v1/me, comms capabilities) are
// mocked at the HTTP boundary with a deterministic, contract-valid fixture.
// PRESENTATION/LAYOUT validation ONLY — backend integration is proven separately
// (api integration + Pact). Run:
//   1) npx nx serve aramo-ats-web        (serves http://localhost:4201)
//   2) node apps/ats-web/visual-harness/talent-360-parity.mjs   (run from repo root)
//   3) open the screenshot (T360_OUT) and compare to the frozen prototype
//      design/aramo-prototype/platform/Talent 360.dc.html at 1440px.
// Env: T360_BASE (default http://localhost:4201), T360_OUT (screenshot path).
import { chromium } from 'playwright-core';

const BASE = process.env.T360_BASE || 'http://localhost:4201';
const TALENT_ID = '11111111-1111-7111-8111-111111111111';
const OUT = process.env.T360_OUT || '/tmp/talent-360-parity.png';

// Contract-valid Talent360View — mirrors apps/api/src/talent-360/dto exactly,
// rich enough to exercise the frozen Overview. authorized_sections all true;
// no null sections here (this fixture is the fully-authorized case).
const j = (reqId, sub, stages) => ({
  requisition_id: reqId, talent_record_id: TALENT_ID, current_journey_stage: sub.pipeline_stage || 'QUALIFIED',
  stages: stages || [], sub_states: { pipeline_stage: 'qualified', submittal_state: null, selection_state: null, interview_state: null, offer_state: null, placement_state: null, pre_start_state: null, assignment_state: null, ...sub }, actions: [],
});
const FIXTURE = {
  generated_at: '2026-09-30T13:14:00.000Z',
  server_date: '2026-09-30',
  header: {
    talent_id: TALENT_ID, first_name: 'Divya', last_name: 'Vasudevan', display_name: 'Divya Vasudevan',
    title: 'Scrum Master / Product Owner', location: 'Vienna, VA (Eastern)', experience_summary: '11 yrs experience',
    email: 'divya.vasudevan@gmail.com', phone: '(703) 555-0182', work_authorization: 'permanent_resident',
    desired_compensation: '$85/hr', engagement_type: 'c2c',
    availability: { status: 'available_now', detail: 'Current contract ends Sep 30' },
    recruiting_ready: { ready: true, rule: 'A live record with at least one contact channel and a work authorization on record. Worked out by Aramo from the record; never set by hand.' },
    contactability: { summary: 'contactable', recruiting_permitted: true, email_permitted: true, phone_permitted: true, sms_permitted: false },
    actions: { can_email: true, can_call: true, can_add_to_requisition: true, can_log_activity: true, can_edit_profile: true },
    record_status: 'live', superseded_by_record_id: null,
  },
  relationship_strip: {
    active_opportunities: 3, submittals: 2, interviews_today: 1, offers: 0, assignments: 0,
    last_contact: { at: '2026-09-30T13:14:00.000Z', channel: 'email' },
  },
  opportunities: {
    active: [
      { pipeline_id: 'p1', requisition_id: 'r1', requisition_code: 'REQ-1001', client_name: 'Freddie Mac', role_title: 'Scrum Master — Multifamily', stage: 'INTERVIEW', contextual_state: 'Client interview today', age_label: '2d', owner_label: 'You', next_action: { kind: 'open_interview', label: 'Open interview', href: '/requisitions/r1' }, open_journey_href: '/requisitions/r1', journey: j('r1', { pipeline_stage: 'INTERVIEW', submittal_state: 'submitted_to_ats', selection_state: 'INTERVIEW', interview_state: 'SCHEDULED' }, [{ stage: 'INTERVIEW', owner: 'client-selection', source_object_id: 'csp1' }]) },
      { pipeline_id: 'p2', requisition_id: 'r2', requisition_code: 'REQ-1032', client_name: 'Fannie Mae', role_title: 'Agile Delivery Lead', stage: 'CLIENT_REVIEW', contextual_state: 'Waiting for client · 3 days', age_label: '3d', owner_label: 'Sanjay Kumar', next_action: { kind: 'follow_up', label: 'Follow up', href: '/requisitions/r2' }, open_journey_href: '/requisitions/r2', journey: j('r2', { pipeline_stage: 'CLIENT_REVIEW', submittal_state: 'submitted_to_ats', selection_state: 'CLIENT_REVIEW' }, [{ stage: 'CLIENT_REVIEW', owner: 'client-selection', source_object_id: 'csp2', occurred_at: '2026-09-27T12:00:00Z' }]) },
      { pipeline_id: 'p3', requisition_id: 'r3', requisition_code: 'REQ-1048', client_name: 'Capital One', role_title: 'Senior Scrum Master', stage: 'QUALIFYING', contextual_state: 'Compensation not confirmed', age_label: '1d', owner_label: 'You', next_action: { kind: 'continue_qualification', label: 'Continue qualification', href: '/requisitions/r3' }, open_journey_href: '/requisitions/r3', journey: j('r3', { pipeline_stage: 'QUALIFYING', submittal_state: null }, []) },
    ],
    closed: [
      { pipeline_id: 'p4', requisition_id: 'r4', requisition_code: 'REQ-0921', client_name: 'Wells Fargo', role_title: 'Agile Coach', outcome: 'Not selected', closed_at: '2026-06-01T00:00:00Z', open_journey_href: '/requisitions/r4' },
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
      { id: 'e1', occurred_at: '2026-09-30T13:14:00Z', category: 'communications', title: 'Email received', body: '"Hybrid three days works for me. Happy to proceed."', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'From Divya', channel: 'email' },
      { id: 'e2', occurred_at: '2026-09-29T19:42:00Z', category: 'communications', title: 'Voice call · 11 min', body: 'Interested in Capital One. Would consider about $72/hr W2.', requisition_id: 'r3', requisition_label: 'REQ-1048', actor_label: 'Purush P.', channel: 'voice' },
      { id: 'e3', occurred_at: '2026-09-28T15:30:00Z', category: 'requisitions', title: 'Qualification completed', body: 'Scrum Master — Multifamily', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'Purush P.', channel: null },
      { id: 'e4', occurred_at: '2026-09-26T09:48:00Z', category: 'documents', title: 'RTR signed', body: 'Right to Represent for Freddie Mac', requisition_id: 'r1', requisition_label: 'REQ-1001', actor_label: 'Signed by Divya', channel: null },
    ],
    category_counts: { communications: 2, requisitions: 1, documents: 1, client: 0, interviews: 0, tasks: 0 },
    has_more: true,
  },
  documents: {
    key_documents: [
      { id: 'd1', kind: 'Résumé', requisition_id: null, requisition_label: null, meta: 'Divya_Vasudevan_2026.docx · current · uploaded Sep 14', signed: false, signed_at: null },
      { id: 'd2', kind: 'Right to Represent · Freddie Mac', requisition_id: 'r1', requisition_label: 'REQ-1001', meta: 'Signed', signed: true, signed_at: '2026-09-26T00:00:00Z' },
      { id: 'd3', kind: 'Right to Represent · Fannie Mae', requisition_id: 'r2', requisition_label: 'REQ-1032', meta: 'Signed', signed: true, signed_at: '2026-09-25T00:00:00Z' },
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
      { label: 'engagement', value: 'c2c', source: 'Talent-stated' },
    ],
    skills: [
      { label: 'Scrum', verified: true }, { label: 'SAFe', verified: true }, { label: 'Jira', verified: true },
      { label: 'Product ownership', verified: true }, { label: 'Stakeholder management', verified: true },
      { label: 'Kanban', verified: false }, { label: 'Confluence', verified: false },
    ],
    work_history: [],
  },
  relationship: {
    history: { known_since: '2024-03-01T00:00:00Z', requisitions: 5, submittals: 3, interviews: 2, placements: 0 },
    ownership: { owner_provenance: { user_id: 'u1', name: 'Purush P.' }, also_working_with: [{ user_id: 'u2', name: 'Sanjay Kumar', requisition_id: 'r2', requisition_label: 'REQ-1032' }], source: 'Referral sourcing', source_channel: null },
  },
  authorized_sections: { opportunities: true, attention: true, tasks: true, activity: true, communications: true, documents: true, identity: true },
};

const ME = { user: { display_name: 'Purush Pichaimuthu', email: 'purush@astreconsulting.com' }, roles: ['tenant_owner'], tenant: { display_name: 'Astre Consulting Services Inc', status: 'ACTIVE' } };

// Authenticated session (mirrors openapi/auth.yaml SessionResponse / the
// fe-foundation Session type) — carries the Talent-360 section scopes so every
// authorized section composes and RouteGuard (talent:read) passes.
const nowSec = Math.floor(Date.now() / 1000);
const SESSION = {
  sub: '00000000-0000-7000-8000-000000000bb1',
  consumer_type: 'recruiter',
  tenant_id: '11111111-1111-7111-8111-111111111111',
  scopes: ['talent:read', 'pipeline:read', 'task:read', 'activity:read', 'communication:read', 'communication:voice:call', 'document:read', 'identity:resolve', 'dashboard:read', 'requisition:read', 'placement:read', 'company:read', 'contact:read', 'report:read'],
  iat: nowSec,
  exp: nowSec + 3600,
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1800 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const reqs = [];
page.on('request', (r) => reqs.push(`${r.method()} ${r.url()}`));
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE-ERR:', m.text()); });

await page.route('**/v1/talent-360/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE) }));
await page.route('**/v1/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
await page.route('**/auth/recruiter/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SESSION) }));
// Communications capabilities 200 → CallButton renders enabled (header parity).
await page.route('**/communications/capabilities**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ voice_call: true }) }));

await page.goto(`${BASE}/talent/${TALENT_ID}`, { waitUntil: 'networkidle' }).catch((e) => console.log('goto:', String(e)));
await page.waitForTimeout(1500);
try { await page.evaluate(() => (document.fonts ? document.fonts.ready : Promise.resolve())); } catch {}
await page.waitForTimeout(500);
await page.screenshot({ path: OUT, fullPage: true });
console.log('TITLE:', await page.title());
console.log('BODY-TEXT-HEAD:', (await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n+/g, ' | '));
console.log('REQUESTS:\n' + [...new Set(reqs)].join('\n'));
await browser.close();
