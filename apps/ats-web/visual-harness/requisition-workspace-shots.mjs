// Requisition WORKSPACE §25 visual-evidence harness.
//
// Renders the real React ats-web RequisitionDetailView (default tab = the new
// "Workspace" projection) via playwright-core (chromium, headless) against the
// Vite dev server (http://localhost:4201), with HTTP ROUTE MOCKS for every
// /v1/* + /auth/recruiter/session endpoint the detail view + WorkspacePanel
// eager-load. NO real backend. Mirrors apps/ats-web/visual-harness/
// talent-360-parity.mjs (same mock-the-network approach, NO_ANIM style tag,
// waitForTimeout before each shot).
//
// FIXTURES ARE VISUAL-HARNESS DATA ONLY — never production code or app fallback.
//
// Run:
//   1) npx nx serve aramo-ats-web                 # serves http://localhost:4201
//   2) node apps/ats-web/visual-harness/requisition-workspace-shots.mjs
// Env: RWS_BASE (default http://localhost:4201), RWS_OUT_DIR (default /tmp/req-ws).
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.RWS_BASE || 'http://localhost:4201';
const OUT = process.env.RWS_OUT_DIR || '/tmp/req-ws';
const VIEWPORT = { width: 1440, height: 900 };
const REQ_ID = 'req-ws-1';
const TENANT = '00000000-0000-7000-8000-00000000t001';
const RECRUITER_ID = 'u-recruiter-1';

mkdirSync(OUT, { recursive: true });

const NO_ANIM =
  '*{transition:none!important;animation:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';

// ── scope sets ────────────────────────────────────────────────────────────────
const BROAD_SCOPES = [
  'requisition:read', 'requisition:edit',
  'pipeline:read', 'pipeline:add', 'pipeline:change-status',
  'activity:read', 'activity:create',
  'talent:read', 'talent:source',
  'task:read',
  'offer:create', 'submittal:create',
  'placement:read', 'company:read', 'contact:read',
];
const RESTRICTED_SCOPES = ['requisition:read'];

const session = (scopes) => ({
  sub: RECRUITER_ID,
  consumer_type: 'recruiter',
  tenant_id: TENANT,
  scopes,
  iat: 1_790_000_000,
  exp: 1_790_003_600,
});

const ME = {
  user: { display_name: 'Purush Pichaimuthu', email: 'purush@astreconsulting.com' },
  roles: ['tenant_owner'],
  tenant: { display_name: 'Astre Consulting Services Inc', status: 'ACTIVE' },
};

// ── talent roster (names resolved via getTalent per pipeline) ───────────────────
const TALENT_NAMES = {
  't-1': ['Divya', 'Vasudevan'],
  't-2': ['Marcus', 'Bennett'],
  't-3': ['Aisha', 'Rahman'],
  't-4': ['Leon', 'Okafor'],
  't-5': ['Priya', 'Nair'],
};
const talentRecord = (id) => {
  const [first, last] = TALENT_NAMES[id] ?? ['Jordan', 'Lee'];
  return {
    id, tenant_id: TENANT, site_id: null, first_name: first, last_name: last,
    email1: `${first.toLowerCase()}@example.com`, email2: null,
    phone_home: null, phone_cell: '(703) 555-0100', phone_work: null,
    address: null, address2: null, city: 'Vienna', state: 'VA', zip: '22180',
    country: 'US', source: 'referral', key_skills: 'Scrum, SAFe',
    current_employer: null, current_pay: null, desired_pay: null,
    availability_status: 'available_now', engagement_type: 'c2c',
    work_authorization: 'permanent_resident', date_available: null,
    can_relocate: false, is_hot: false, notes: null, web_site: null,
    best_time_to_call: null, title: 'Scrum Master', owner_id: null,
  };
};

// ── requisition ─────────────────────────────────────────────────────────────
const REQUISITION = {
  id: REQ_ID, tenant_id: TENANT, site_id: null,
  title: 'Senior Scrum Master — Multifamily Platform',
  requisition_number: 1042,
  company_id: 'co-1', contact_id: 'ct-1', company_department_id: null,
  status: 'open', type: 'Contract', duration: '12 months',
  description: 'Lead Agile delivery across the multifamily modernization program.',
  notes: null, is_hot: true,
  openings: 3, openings_available: 1, capacity_balance: 1,
  client_submittal_status: 'open', client_submittal_reason: null,
  start_date: '2026-11-01T00:00:00.000Z',
  city: 'Washington', state: 'DC', postal_code: '20005',
  recruiter_id: RECRUITER_ID, owner_id: null, entered_by_id: RECRUITER_ID,
  created_at: '2026-08-15T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
  version: 4,
  compensation_model: 'CONTRACT',
  pay_rate_amount: null, pay_rate_currency: null, pay_rate_period: null,
  bill_rate_amount: null, bill_rate_currency: null, bill_rate_period: null,
  placement_fee_percent: null, placement_fee_amount: null,
  salary_amount: null, salary_currency: null,
  margin_amount: null, markup_percent: null, margin_percent: null,
  job_type: 'Contract', labor_category: 'IT', role_family: 'Agile Delivery',
  seniority_level: 'Senior', headcount_reason: null,
  work_arrangement: 'hybrid', onsite_days_per_week: 3, travel_percent: null,
  relocation_offered: null, work_authorization: null,
  end_date: null, duration_value: 12, duration_unit: 'months',
  extension_possible: true, hours_per_week: 40,
  source_system: null, external_req_id: 'EXT-9981', imported_at: null,
  target_margin_percent: null, markup_percent_target: null, rate_card_id: null,
  min_bill_rate: null, max_bill_rate: null, min_pay_rate: null, max_pay_rate: null,
  rate_type: 'C2C', allow_subcontractors: true, run_match_on_create: false,
  golden_profile_id: null, bookmarked: false,
  pending_approval_submitter_id: null,
};

// ── pipelines (one per talent on the board) ─────────────────────────────────
const pipeline = (id, talentId, status) => ({
  id, tenant_id: TENANT, site_id: null,
  talent_record_id: talentId, requisition_id: REQ_ID,
  status, created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-18T00:00:00.000Z', version: 2,
});
const PIPELINES = [
  pipeline('pl-1', 't-1', 'qualified'),
  pipeline('pl-2', 't-2', 'qualified'),
  pipeline('pl-3', 't-3', 'contacted'),
  pipeline('pl-4', 't-4', 'no_contact'),
  pipeline('pl-5', 't-5', 'no_contact'),
];

// ── talent board (populated) ──────────────────────────────────────────────────
const nextAction = (key, label, scope, route) => ({
  key, label, owner: 'pipeline', command_route: route, required_scope: scope,
});
const card = (over) => ({
  talent_record_id: 't-x', pipeline_id: 'pl-x', column: 'pipeline',
  owner: 'pipeline', source_object_id: 'pl-x', owner_state: 'no_contact',
  resume: { resume_edition_id: null, source: 'none', locked: false },
  rtr_state: null, readiness: null, days_in_stage: null, stage_entered_at: null,
  assigned_recruiter_user_id: RECRUITER_ID, next_actions: [], handoff: false,
  ...over,
});
const BOARD_POPULATED = {
  requisition_id: REQ_ID,
  total_active: 5,
  closed: { total: 1, by_reason: [{ reason: 'client_declined', count: 1 }] },
  columns: [
    {
      key: 'pipeline', owner: 'pipeline', count: 2,
      cards: [
        card({
          talent_record_id: 't-4', pipeline_id: 'pl-4', column: 'pipeline',
          owner_state: 'no_contact', days_in_stage: 1, stage_entered_at: '2026-09-29T00:00:00Z',
          next_actions: [nextAction('pipeline.contact', 'Reach out', 'pipeline:change-status', `/requisitions/${REQ_ID}`)],
        }),
        card({
          talent_record_id: 't-5', pipeline_id: 'pl-5', column: 'pipeline',
          owner_state: 'no_contact', days_in_stage: 4, stage_entered_at: '2026-09-26T00:00:00Z',
          next_actions: [nextAction('pipeline.contact', 'Reach out', 'pipeline:change-status', `/requisitions/${REQ_ID}`)],
        }),
      ],
    },
    {
      key: 'contacted', owner: 'pipeline', count: 1,
      cards: [
        card({
          talent_record_id: 't-3', pipeline_id: 'pl-3', column: 'contacted',
          owner_state: 'contacted', days_in_stage: 2, stage_entered_at: '2026-09-28T00:00:00Z',
          next_actions: [nextAction('pipeline.qualify', 'Continue qualification', 'pipeline:change-status', `/requisitions/${REQ_ID}`)],
        }),
      ],
    },
    {
      key: 'qualified', owner: 'pipeline', count: 2,
      cards: [
        card({
          talent_record_id: 't-1', pipeline_id: 'pl-1', column: 'qualified',
          owner_state: 'qualified', rtr_state: 'signed',
          days_in_stage: 3, stage_entered_at: '2026-09-27T00:00:00Z',
          readiness: { requisition_state: 'open', requisition_reason: null, blockers: [], band: 'ready_to_submit' },
          next_actions: [nextAction('submittal.create', 'Submit to client', 'submittal:create', `/requisitions/${REQ_ID}`)],
        }),
        card({
          talent_record_id: 't-2', pipeline_id: 'pl-2', column: 'qualified',
          owner_state: 'qualified', rtr_state: 'pending',
          days_in_stage: 6, stage_entered_at: '2026-09-24T00:00:00Z',
          readiness: {
            requisition_state: 'open', requisition_reason: null,
            blockers: ['rtr_not_executed', 'resume_not_selected'], band: 'needs_action',
          },
          next_actions: [],
        }),
      ],
    },
  ],
};
const BOARD_EMPTY = {
  requisition_id: REQ_ID, total_active: 0,
  closed: { total: 0, by_reason: [] }, columns: [],
};

// ── interviews / tasks / activities ─────────────────────────────────────────
const INTERVIEWS_POPULATED = {
  interviews: [
    {
      id: 'iv-1', scheduled_at: '2026-10-03T20:00:00.000Z', scheduled_end_at: '2026-10-03T20:45:00.000Z',
      timezone: 'America/New_York', state: 'SCHEDULED', round: 1, interview_type: 'client_panel',
      talent_record_id: 't-1', talent_name: 'Divya Vasudevan', requisition_id: REQ_ID,
      requisition_number: 1042, requisition_title: REQUISITION.title,
      company_id: 'co-1', company_name: 'Freddie Mac', interviewer_user_ids: [RECRUITER_ID], version: 1,
    },
    {
      id: 'iv-2', scheduled_at: '2026-10-05T15:00:00.000Z', scheduled_end_at: null,
      timezone: 'America/New_York', state: 'RESCHEDULED', round: 2, interview_type: 'tech_screen',
      talent_record_id: 't-3', talent_name: 'Aisha Rahman', requisition_id: REQ_ID,
      requisition_number: 1042, requisition_title: REQUISITION.title,
      company_id: 'co-1', company_name: 'Freddie Mac', interviewer_user_ids: [RECRUITER_ID], version: 1,
    },
  ],
  window: { from: '2026-10-01T00:00:00.000Z', to: '2026-12-30T00:00:00.000Z' },
};
const INTERVIEWS_EMPTY = { interviews: [], window: { from: '2026-10-01T00:00:00.000Z', to: '2026-12-30T00:00:00.000Z' } };

const task = (id, title, due) => ({
  id, tenant_id: TENANT, title, description: null, due_date: due,
  status: 'open', type: 'follow_up', priority: 'med', source: 'manual',
  assignee_id: RECRUITER_ID, created_by_user_id: RECRUITER_ID,
  owner_type: 'requisition', owner_id: REQ_ID,
  created_at: '2026-09-20T00:00:00.000Z', updated_at: '2026-09-20T00:00:00.000Z',
});
const TASKS_POPULATED = {
  items: [
    task('tk-1', 'Confirm Freddie Mac panel availability', '2026-10-02T00:00:00.000Z'),
    task('tk-2', 'Chase RTR signature from Marcus', '2026-10-03T00:00:00.000Z'),
  ],
};
const TASKS_EMPTY = { items: [] };

const activity = (id, type, notes, at, subjectType, subjectId) => ({
  id, tenant_id: TENANT, site_id: null, type,
  subject_type: subjectType, subject_id: subjectId, notes,
  created_by_id: RECRUITER_ID, created_at: at,
  redacted_at: null, redacted_by: null, redaction_reason_code: null, redaction_reason: null,
  category: type === 'note' ? 'GENERAL' : null, visibility: type === 'note' ? 'TEAM' : null,
  body_format: type === 'note' ? 'plain_text' : null,
  is_pinned: false, pinned_at: null, pinned_by_id: null,
});
const REQ_ACTIVITIES_POPULATED = {
  items: [
    activity('ac-1', 'note', 'Client confirmed the panel for Oct 3.', '2026-09-30T13:00:00.000Z', 'requisition', REQ_ID),
    activity('ac-2', 'note', 'Submitted Divya to Freddie Mac.', '2026-09-28T16:00:00.000Z', 'requisition', REQ_ID),
    activity('ac-3', 'email_logged', null, '2026-09-27T10:00:00.000Z', 'requisition', REQ_ID),
  ],
};
const PIPE_ACTIVITIES_POPULATED = {
  items: [
    activity('ac-4', 'pipeline_status_change', null, '2026-09-27T09:00:00.000Z', 'pipeline', 'pl-1'),
  ],
};
const ACTIVITIES_EMPTY = { items: [] };

const COMPANY = { id: 'co-1', name: 'Freddie Mac' };
const CONTACT = { id: 'ct-1', first_name: 'Michael', last_name: 'Tran', company_id: 'co-1' };
const DIRECTORY = { items: [{ user_id: RECRUITER_ID, display_name: 'Purush Pichaimuthu' }] };

// ── per-state mock wiring ──────────────────────────────────────────────────────
function fixturesFor(state) {
  const empty = state === 'empty';
  return {
    board: empty ? BOARD_EMPTY : BOARD_POPULATED,
    interviews: empty ? INTERVIEWS_EMPTY : INTERVIEWS_POPULATED,
    tasks: empty ? TASKS_EMPTY : TASKS_POPULATED,
    reqActivities: empty ? ACTIVITIES_EMPTY : REQ_ACTIVITIES_POPULATED,
    pipeActivities: empty ? ACTIVITIES_EMPTY : PIPE_ACTIVITIES_POPULATED,
    pipelines: empty ? { items: [] } : { items: PIPELINES },
  };
}

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mountPage(browser, state, scopes) {
  const fx = fixturesFor(state);
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));

  // Fallback FIRST (lowest priority) — any unmocked /v1/* returns an empty list
  // so no request escapes to the (absent) real backend. Specific routes below
  // override it (Playwright: last-registered route wins).
  await page.route('**/v1/**', (r) => json(r, { items: [] }));

  await page.route('**/auth/recruiter/session', (r) => json(r, session(scopes)));
  await page.route('**/v1/me', (r) => json(r, ME));
  await page.route('**/communications/capabilities**', (r) => json(r, { voice_call: true }));

  // Requisition detail + board.
  await page.route(`**/v1/requisitions/${REQ_ID}/talent-board`, (r) => json(r, fx.board));
  await page.route(`**/v1/requisitions/${REQ_ID}`, (r) => json(r, REQUISITION));

  // Pipelines (requisition-scoped list).
  await page.route('**/v1/pipelines?*', (r) => json(r, fx.pipelines));

  // Company / contact / directory.
  await page.route('**/v1/companies/*', (r) => json(r, COMPANY));
  await page.route('**/v1/contacts/*', (r) => json(r, CONTACT));
  await page.route('**/v1/tenant/users/directory**', (r) => json(r, DIRECTORY));

  // Per-talent record reads (name resolution). Echo the id from the URL.
  await page.route('**/v1/talent-records/*', (r) => {
    const m = r.request().url().match(/talent-records\/([^/?]+)/);
    const id = m ? decodeURIComponent(m[1]) : 't-x';
    return json(r, talentRecord(id));
  });

  // Interviews / tasks / offers / placements / attachments.
  await page.route('**/v1/interviews?*', (r) => json(r, fx.interviews));
  await page.route('**/v1/tasks?*', (r) => json(r, fx.tasks));
  await page.route('**/v1/offers**', (r) => json(r, { items: [] }));
  await page.route('**/v1/placements**', (r) => json(r, { items: [] }));
  await page.route('**/v1/attachments?*', (r) => json(r, { items: [] }));

  // Activities — requisition-subject vs pipeline-subject, same endpoint. The
  // detail view issues ONE pipeline-subject read per pipeline id, so the
  // pipeline activity is returned ONLY for pl-1 (else empty) — otherwise the
  // same row would be merged N times (duplicate React keys).
  await page.route('**/v1/activities?*', (r) => {
    const url = r.request().url();
    if (url.includes('subject_type=pipeline')) {
      return json(r, url.includes('subject_id=pl-1') ? fx.pipeActivities : { items: [] });
    }
    return json(r, fx.reqActivities);
  });

  await page.goto(`${BASE}/requisitions/${REQ_ID}`, { waitUntil: 'networkidle' })
    .catch((e) => errors.push('goto: ' + String(e).split('\n')[0]));
  await page.addStyleTag({ content: NO_ANIM });
  await page.waitForTimeout(900);
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { /* ignore */ }
  return { page, ctx, errors };
}

async function clickTab(page, name) {
  const t = page.locator('button.tabs__tab[role="tab"]', { hasText: name }).first();
  await t.click({ force: true, timeout: 8000 }).catch((e) => console.log(`tab "${name}":`, String(e).split('\n')[0]));
  await page.waitForTimeout(500);
}

// ── probe: assert the Workspace rendered the expected structure ────────────────
async function probe(page) {
  return page.evaluate(() => {
    const tabs = [...document.querySelectorAll('button.tabs__tab[role="tab"]')].map((b) => b.textContent.trim());
    const selected = document.querySelector('button.tabs__tab[aria-selected="true"]')?.textContent.trim() ?? null;
    const cardTitles = [...document.querySelectorAll('.rc-ws .rc-card__head h2')].map((h) => h.textContent.trim());
    const ctas = [...document.querySelectorAll('.rc-ws .rc-ws__cta, .rc-ws .rc-link-action, .rc-ws .rc-card__head-more')]
      .map((e) => e.textContent.trim());
    const empties = [...document.querySelectorAll('.rc-ws .rc-empty')].map((e) => e.textContent.trim());
    return { tabs, selected, cardTitles, ctas, empties };
  });
}

const browser = await chromium.launch({ headless: true });
const report = {};

// a. populated — default tab is Workspace. Also drive the Details + Talent tabs.
{
  const { page, ctx, errors } = await mountPage(browser, 'populated', BROAD_SCOPES);
  report.populated = { probe: await probe(page), errors };
  await page.screenshot({ path: `${OUT}/workspace-populated.png` });
  await page.screenshot({ path: `${OUT}/workspace-populated.full.png`, fullPage: true });

  await clickTab(page, 'Details');
  report.detailsTab = { probe: await probe(page), errors };
  await page.screenshot({ path: `${OUT}/details-tab.png` });
  await page.screenshot({ path: `${OUT}/details-tab.full.png`, fullPage: true });

  await clickTab(page, 'Talent');
  report.talentTab = { errors };
  await page.screenshot({ path: `${OUT}/talent-tab.png` });
  await page.screenshot({ path: `${OUT}/talent-tab.full.png`, fullPage: true });
  await ctx.close();
}

// b. empty board / no interviews / tasks / activity → empty states.
{
  const { page, ctx, errors } = await mountPage(browser, 'empty', BROAD_SCOPES);
  report.empty = { probe: await probe(page), errors };
  await page.screenshot({ path: `${OUT}/workspace-empty.png` });
  await page.screenshot({ path: `${OUT}/workspace-empty.full.png`, fullPage: true });
  await ctx.close();
}

// c. reduced scope (requisition:read only) → CTAs hidden.
{
  const { page, ctx, errors } = await mountPage(browser, 'populated', RESTRICTED_SCOPES);
  report.restricted = { probe: await probe(page), errors };
  await page.screenshot({ path: `${OUT}/workspace-restricted.png` });
  await page.screenshot({ path: `${OUT}/workspace-restricted.full.png`, fullPage: true });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
