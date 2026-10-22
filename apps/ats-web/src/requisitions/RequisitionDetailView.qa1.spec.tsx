import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignSubscriptionProvider } from '../rtr/rtr-access';
import { BreadcrumbProvider } from '../shell/breadcrumb';

import { addTalentDisabledReason } from './AddTalentDialog';
import { RequisitionDetailView } from './RequisitionDetailView';

// S3 — the Talent drawer consumes the backend-owned journey; mock it so opening
// the panel from the Talent grid renders without a network read.
vi.mock('../pipeline/talent-journey-api', () => ({
  getTalentJourney: vi.fn(async () => ({
    requisition_id: 'r',
    talent_record_id: 't',
    current_journey_stage: 'QUALIFIED',
    stages: [{ stage: 'QUALIFIED', owner: 'pipeline', source_object_id: 'p' }],
    sub_states: { pipeline: 'qualified' },
    actions: [],
  })),
}));

// RTR-TEMPLATE-1 — the wired RtrPanel reconciles the current RTR on mount. Mock
// its client so each per-row panel resolves to "no current RTR" (→ Request RTR)
// without a network read.
vi.mock('../rtr/rtr-api', () => ({
  getCurrentRtr: vi.fn(async () => null),
  requestRtr: vi.fn(),
  sendRtr: vi.fn(),
  getRtrPreview: vi.fn(),
}));

// ATS-QA-1 D5 / 1.1 — the Talent tab label and the "in play" count use the collapsed
// current set (pipeline/rollup.ts), and Add talent is disabled with a reason on a draft
// or awaiting-approval requisition. Mount pattern from RequisitionDetailView.pipeline.spec.
//
// 2D — the re-skinned header / meta strip / Pipeline tab (funnel ribbon +
// talent table) + breadcrumb publication. The cockpit (Details tab) is
// proven in RequisitionDetailView.cockpit.spec.tsx.

const SESSION: Session = {
  sub: 'u1',
  consumer_type: 'recruiter',
  tenant_id: 't',
  // pipeline:read → the Talent tab is available and is the scope-driven default,
  // so the funnel/talent-table content renders on first paint (as before).
  // document:read/create — a recruiter session can request RTR (the RtrPanel
  // gates Request on document:create per least-visibility, §21).
  scopes: ['requisition:read', 'pipeline:read', 'document:read', 'document:create', 'document:execute'],
  iat: 0,
  exp: 0,
};

const REQ = {
  id: 'req-1',
  tenant_id: 't',
  site_id: null,
  title: 'Senior Rust Engineer',
  company_id: 'co-1',
  contact_id: null,
  company_department_id: null,
  status: 'open',
  type: 'C2H',
  is_hot: true,
  openings: 3,
  openings_available: 2,
  capacity_balance: 2,
  city: 'Austin',
  state: 'TX',
  external_req_id: 'REQ-2041',
  work_arrangement: 'remote',
  created_at: '2026-05-29T00:00:00Z',
  updated_at: '2026-06-01T00:00:00Z',
  recruiter_id: 'usr-rec',
  owner_id: null,
};

const ROSTER = {
  items: [
    { user_id: 'usr-rec', email: 'rec@x.test', display_name: 'Priya Recruiter', is_active: true },
    { user_id: 'usr-own', email: 'own@x.test', display_name: 'Tom Owner', is_active: true },
  ],
};

let PIPELINES: { items: unknown[] } = { items: [] };
let REQ_STATUS = 'open';
let SCOPES: string[] = [];

const ep = (id: string, talent: string, status: string, created: string) => ({
  id, tenant_id: 't', site_id: null, talent_record_id: talent, requisition_id: 'req-1', status,
  created_at: created, updated_at: created, version: 1,
});

const TALENTS: Record<string, unknown> = {
  'tal-1': { id: 'tal-1', first_name: 'Marcus', last_name: 'Adeyemi' },
  'tal-2': { id: 'tal-2', first_name: 'Sofia', last_name: 'Ramos' },
  'tal-3': { id: 'tal-3', first_name: 'Lee', last_name: 'Chan' },
};

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function mockApi() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = urlOf(input);
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.includes('/v1/requisitions/req-1')) return json({ ...REQ, status: REQ_STATUS });
    if (url.includes('/v1/pipelines')) return json(PIPELINES);
    if (url.includes('/v1/companies/co-1')) return json({ id: 'co-1', name: 'Northwind Robotics' });
    if (url.includes('/v1/tenant/users')) return json(ROSTER);
    const talentMatch = url.match(/\/v1\/talent-records\/(tal-\d)/);
    const talentId = talentMatch?.[1];
    if (talentId !== undefined) return json(TALENTS[talentId]);
    return json({ items: [] });
  });
}

function mountDetail() {
  return render(
    <ToastProvider>
      <BreadcrumbProvider>
        <SignSubscriptionProvider subscribed>
<MemoryRouter initialEntries={['/requisitions/req-1']}>
          <Routes>
            <Route
              path="/requisitions/:reqId"
              element={<RequisitionDetailView sessionOverride={{ ...SESSION, scopes: SCOPES }} />}
            />
            <Route
              path="/requisitions/:reqId/talent/:talentId"
              element={<div data-testid="tr360-route" />}
            />
          </Routes>
        </MemoryRouter>
</SignSubscriptionProvider>
      </BreadcrumbProvider>
    </ToastProvider>,
  );
}

beforeEach(() => {
  REQ_STATUS = 'open';
  SCOPES = ['requisition:read', 'pipeline:read', 'pipeline:add', 'talent:search'];
  PIPELINES = {
    items: [
      // tal-1: an ended episode AND a re-added live one — ONE current Talent.
      ep('p1a', 'tal-1', 'not_in_consideration', '2026-06-01T00:00:00Z'),
      ep('p1b', 'tal-1', 'qualifying', '2026-06-10T00:00:00Z'),
      ep('p2', 'tal-2', 'qualified', '2026-06-11T00:00:00Z'),
      // tal-3: Not in consideration — on the requisition, not in play.
      ep('p3', 'tal-3', 'not_in_consideration', '2026-06-12T00:00:00Z'),
    ],
  };
});
afterEach(() => vi.restoreAllMocks());

describe('RequisitionDetailView — ATS-QA-1 D5 counts', () => {
  it('Talent tab label counts the collapsed current set (3), not the raw episodes (4)', async () => {
    mockApi();
    mountDetail();
    expect(await screen.findByRole('tab', { name: 'Talent (3)' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Talent (4)' })).toBeNull();
  });

  it('"in play" counts only current live episodes (2): ended and re-added episodes are not double-counted', async () => {
    mockApi();
    mountDetail();
    const hint = await screen.findByText('in play');
    const card = hint.closest('.rc-snapcard') as HTMLElement;
    expect(within(card).getByText('2')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView — ATS-QA-1 1.1 Add talent on draft / awaiting approval', () => {
  it.each([
    ['draft', 'Talent can be added once this requisition is open.'],
    ['pending_approval', 'Talent can be added once this requisition is approved.'],
  ])('%s: the header Add talent is disabled and says why', async (status, reason) => {
    REQ_STATUS = status;
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    const buttons = await screen.findAllByRole('button', { name: /Add talent/ });
    expect(buttons[0]).toBeDisabled();
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
  });

  it('open: the header Add talent is enabled', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    const buttons = await screen.findAllByRole('button', { name: /Add talent/ });
    expect(buttons[0]).not.toBeDisabled();
  });
});

describe('addTalentDisabledReason', () => {
  it('blocks draft and pending_approval only (A1 AM-1: open, on hold, lead accept talent)', () => {
    expect(addTalentDisabledReason('draft')).not.toBeNull();
    expect(addTalentDisabledReason('pending_approval')).not.toBeNull();
    for (const s of ['open', 'on_hold', 'lead']) expect(addTalentDisabledReason(s)).toBeNull();
  });
});
