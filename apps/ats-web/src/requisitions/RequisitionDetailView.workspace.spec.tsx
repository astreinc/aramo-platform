import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider } from '../shell/breadcrumb';

import { RequisitionDetailView } from './RequisitionDetailView';

// Requisition WORKSPACE — the role/responsibility-oriented replacement. Proves:
// scope-driven default tab + tab availability, snapshot eager cards, grounded-only
// attention (NO interviews-today / deadline-countdown), masked-by-absence
// (financial omitted-not-null), commercial read-vs-approve availability, the
// eager-vs-lazy load model (no per-placement fan-out at first paint), and
// drill-through. Data/behaviour/scopes are grounded — style is separate.

function sessionWith(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

// A base requisition view. Comp + financial keys are ABSENT (masked-by-absence);
// tests that exercise the un-masked path spread the keys in explicitly.
function reqView(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'req-1',
    tenant_id: 't',
    site_id: null,
    title: 'Staff Platform Engineer',
    requisition_number: 4041,
    company_id: 'co-1',
    contact_id: null,
    company_department_id: null,
    status: 'open',
    type: 'Contract',
    is_hot: false,
    openings: 3,
    openings_available: 2,
    capacity_balance: 2,
    client_submittal_status: null,
    client_submittal_reason: null,
    city: 'Austin',
    state: 'TX',
    work_arrangement: 'remote',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    recruiter_id: null,
    owner_id: null,
    external_req_id: null,
    version: 3,
    bookmarked: false,
    ...extra,
  };
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

interface MockOpts {
  readonly req?: Record<string, unknown>;
  readonly pipelines?: unknown[];
  readonly offers?: unknown[];
  readonly placements?: unknown[];
  readonly submittal?: Record<string, unknown> | null;
  readonly preStart?: Record<string, unknown>;
}

// Installs the app fetch and returns the captured GET urls (for fan-out proofs).
function mockApi(opts: MockOpts = {}): { urls: string[] } {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = urlOf(input);
    if ((init?.method ?? 'GET') === 'GET') urls.push(url);
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.includes('/v1/requisitions/req-1')) return json(opts.req ?? reqView());
    if (url.includes('/v1/pipelines')) return json({ items: opts.pipelines ?? [] });
    if (url.includes('/v1/offers')) return json({ items: opts.offers ?? [] });
    // CLIENT lazy read (pipeline→submittal linkage).
    if (url.includes('/v1/submittals')) {
      return json({ submittal: opts.submittal ?? null });
    }
    // Per-placement assignment/commercial/pre-start MUST come before the
    // collection match so a stray call is observable in `urls`.
    if (url.includes('/assignment')) return json({ assignment: null });
    if (url.includes('/pre-start-requirement/placements/')) {
      return json(
        opts.preStart ?? {
          materialized: true,
          ready: false,
          blocking_unresolved_count: 1,
          requirements: [],
        },
      );
    }
    if (url.includes('/v1/placements')) return json({ items: opts.placements ?? [] });
    if (url.includes('/v1/companies/co-1')) return json({ id: 'co-1', name: 'Northwind Robotics' });
    if (url.includes('/v1/tenant/users')) return json({ items: [] });
    const tm = url.match(/\/v1\/talent-records\/(tal-[\w-]+)/);
    if (tm !== null) return json({ id: tm[1], first_name: 'Marcus', last_name: 'Adeyemi', is_hot: false });
    return json({ items: [] });
  });
  return { urls };
}

function mount(scopes: string[], opts: MockOpts = {}) {
  mockApi(opts);
  return render(
    <ToastProvider>
      <BreadcrumbProvider>
        <MemoryRouter initialEntries={['/requisitions/req-1']}>
          <Routes>
            <Route
              path="/requisitions/:reqId"
              element={<RequisitionDetailView sessionOverride={sessionWith(scopes)} />}
            />
          </Routes>
        </MemoryRouter>
      </BreadcrumbProvider>
    </ToastProvider>,
  );
}

function selectedTabName(): string | null {
  const tabs = screen.getAllByRole('tab');
  return tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.textContent ?? null;
}

describe('RequisitionDetailView workspace — scope-driven default order', () => {
  afterEach(() => vi.restoreAllMocks());

  it('commercials:approve → default Commercial', async () => {
    mount(['requisition:read', 'assignment:commercials:read', 'assignment:commercials:approve']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Commercial/));
  });

  it('pipeline:read → default Talent', async () => {
    mount(['requisition:read', 'pipeline:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Talent/));
  });

  it('assignment:extend (+placement:read) → default Assignments', async () => {
    mount(['requisition:read', 'assignment:extend', 'placement:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Assignments/));
  });

  it('no emphasis scope → default Overview', async () => {
    mount(['requisition:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Overview/));
  });
});

describe('RequisitionDetailView workspace — tab availability (scope-gated)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('read scopes reveal their tabs; commercial read-vs-approve gates the Commercial tab', async () => {
    mount([
      'requisition:read',
      'pipeline:read',
      'offer:create',
      'pre_start_requirement:read',
      'placement:read',
      'assignment:commercials:read',
    ]);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(screen.getByRole('tab', { name: /Talent/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Offers/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Pre-Start/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Assignments/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Commercial/ })).toBeTruthy();
  });

  it('no commercial:read → NO Commercial tab (and no commercial read issued)', async () => {
    const cap = mockApi();
    render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={
                  <RequisitionDetailView
                    sessionOverride={sessionWith(['requisition:read', 'pipeline:read'])}
                  />
                }
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(screen.queryByRole('tab', { name: /Commercial/ })).toBeNull();
    expect(cap.urls.some((u) => u.includes('/commercials'))).toBe(false);
  });
});

describe('RequisitionDetailView workspace — prototype structure (no MetaStrip / no company icon)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders header → snapshot → attention → tabs, with NO MetaStrip and NO header company icon', async () => {
    mockApi({ req: reqView({ capacity_balance: -1 }) }); // capacity<0 → attention present
    const { container } = render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={
                  <RequisitionDetailView sessionOverride={sessionWith(['requisition:read', 'pipeline:read'])} />
                }
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    // MetaStrip DELETED.
    expect(container.querySelector('.rc-meta')).toBeNull();
    // No company icon (svg) in the header company line → no gray box.
    expect(container.querySelector('.rc-dhead__co svg')).toBeNull();
    // Snapshot strip + attention card + underline tabs all present.
    const snap = container.querySelector('.rc-snap');
    const attn = container.querySelector('.rc-attn');
    const tabs = container.querySelector('.rc-ws-tabs');
    if (snap === null || attn === null || tabs === null) {
      throw new Error('missing snapshot / attention / tabs');
    }
    // Order: snapshot before attention before tabs.
    expect(snap.compareDocumentPosition(attn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attn.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('RequisitionDetailView workspace — snapshot + attention (grounded only)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders eager snapshot cards from requisition-grain data', async () => {
    mount(['requisition:read', 'pipeline:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(screen.getByText('Capacity')).toBeInTheDocument();
    expect(screen.getByText('Client status')).toBeInTheDocument();
    expect(screen.getByText('Aging')).toBeInTheDocument();
  });

  it('attention shows only grounded rows (over-capacity, client paused, offer expiring) — never interviews-today or a deadline countdown', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mount(
      ['requisition:read', 'pipeline:read', 'offer:create'],
      {
        req: reqView({
          capacity_balance: -1,
          client_submittal_status: 'paused',
          client_submittal_reason: 'manual_hold',
        }),
        offers: [
          {
            id: 'o1', tenant_id: 't', submittal_id: 's1', requisition_id: 'req-1',
            talent_record_id: 'tal-1', state: 'SENT', proposed_start_date: null,
            offer_expires_at: soon, client_offer_reference: null, offer_terms_summary: null,
            decline_reason: null, created_at: '2026-08-01T00:00:00Z',
          },
        ],
      },
    );
    const attn = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attn).getByText(/Over capacity by 1/)).toBeInTheDocument();
    expect(within(attn).getByText(/Client submittals paused/)).toBeInTheDocument();
    expect(within(attn).getByText(/offers? expiring soon/)).toBeInTheDocument();
    // The prototype's ungrounded values are OMITTED, never mocked.
    expect(within(attn).queryByText(/interviews today/i)).toBeNull();
    expect(within(attn).queryByText(/deadline/i)).toBeNull();
    expect(within(attn).queryByText(/Aug 29/)).toBeNull();
  });

  it('the presentation role in the attention header is scope-derived, not persona authority', async () => {
    mount(['requisition:read', 'assignment:commercials:read', 'assignment:commercials:approve'], {
      req: reqView({ capacity_balance: -1 }),
    });
    const attn = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(attn).getByText(/as commercial approver/)).toBeInTheDocument();
  });
});

describe('RequisitionDetailView workspace — masked-by-absence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('financial-planning fields render only when PRESENT in the payload (omitted, not nulled)', async () => {
    // Absent → no Financial planning section.
    mount(['requisition:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(screen.queryByText('Financial planning')).toBeNull();
    vi.restoreAllMocks();

    // Present (un-masked actor) → the section + a financial field render.
    mount(['requisition:read'], {
      req: reqView({ target_margin_percent: '32.0', max_pay_rate: '95.00' }),
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(await screen.findByText('Financial planning')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView workspace — load model (no first-paint fan-out) + drill-through', () => {
  afterEach(() => vi.restoreAllMocks());

  const FULL_SCOPES = [
    'requisition:read',
    'pipeline:read',
    'offer:create',
    'pre_start_requirement:read',
    'placement:read',
    'assignment:read',
    'assignment:commercials:read',
  ];

  const PLACEMENTS = [
    {
      id: 'pl-1', tenant_id: 't', submittal_id: 's1', requisition_id: 'req-1',
      talent_record_id: 'tal-1', state: 'STARTED', offered_at: '2026-08-01T00:00:00Z',
      proposed_start_date: '2026-09-01', offer_expires_at: null, client_offer_reference: null,
      offer_terms_summary: null, created_at: '2026-08-01T00:00:00Z',
    },
  ];

  it('first paint issues requisition-grain reads only — no per-placement assignment/pre-start/commercial fan-out', async () => {
    const cap = mockApi({ placements: PLACEMENTS });
    render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={<RequisitionDetailView sessionOverride={sessionWith(FULL_SCOPES)} />}
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    // Requisition-grain reads happened.
    await waitFor(() =>
      expect(cap.urls.some((u) => u.includes('/v1/placements?requisition_id=req-1'))).toBe(true),
    );
    // NO per-placement detail reads at first paint.
    expect(cap.urls.some((u) => /\/v1\/placements\/pl-1\/assignment/.test(u))).toBe(false);
    expect(cap.urls.some((u) => u.includes('/pre-start-requirement/placements/'))).toBe(false);
    expect(cap.urls.some((u) => u.includes('/commercials'))).toBe(false);
  });

  it('opening the Assignments tab + expanding a row LAZILY issues the per-placement assignment read (drill-through)', async () => {
    const cap = mockApi({ placements: PLACEMENTS });
    render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={<RequisitionDetailView sessionOverride={sessionWith(FULL_SCOPES)} />}
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(cap.urls.some((u) => /\/assignment/.test(u))).toBe(false);

    // Drill: open the Assignments tab, then expand the placement row.
    fireEvent.click(screen.getByRole('tab', { name: /Assignments/ }));
    fireEvent.click(await screen.findByRole('button', { name: /STARTED|Started/ }));
    await waitFor(() =>
      expect(cap.urls.some((u) => /\/v1\/placements\/pl-1\/assignment/.test(u))).toBe(true),
    );
  });

  it('a snapshot card drills through to its tab', async () => {
    mount(['requisition:read', 'pipeline:read', 'offer:create']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    // Default is Talent; the Offers snapshot card switches to the Offers tab.
    fireEvent.click(screen.getByRole('button', { name: /Offers/ }));
    await waitFor(() => expect(selectedTabName()).toMatch(/Offers/));
    expect(await screen.findByText(/No offers on this requisition yet\./)).toBeInTheDocument();
  });

  const PIPELINE_TAL1 = [
    {
      id: 'pp-1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1',
      requisition_id: 'req-1', status: 'submitted',
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    },
  ];

  it('opening a Talent row LAZILY populates the Client + Pre-Start cells with that talent\'s own reads, and caches them (reopen does NOT refetch)', async () => {
    const cap = mockApi({
      pipelines: PIPELINE_TAL1,
      placements: PLACEMENTS,
      submittal: { id: 'sub-1', talent_id: 'tal-1', job_id: 'req-1', state: 'confirmed' },
      preStart: { materialized: true, ready: false, blocking_unresolved_count: 2, requirements: [] },
    });
    render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={
                  <RequisitionDetailView
                    sessionOverride={sessionWith([
                      'requisition:read', 'pipeline:read',
                      'submittal:create', 'pre_start_requirement:read', 'placement:read',
                    ])}
                  />
                }
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });

    const submittalCalls = () => cap.urls.filter((u) => u.includes('/v1/submittals')).length;
    const preStartCalls = () =>
      cap.urls.filter((u) => u.includes('/pre-start-requirement/placements/pl-1/requirements')).length;

    // First paint (row NOT opened) → no per-talent reads.
    expect(submittalCalls()).toBe(0);
    expect(preStartCalls()).toBe(0);

    // Open the row → exactly this talent's submittal + pre-start reads fire.
    fireEvent.click(await screen.findByRole('button', { name: /Marcus Adeyemi/ }));
    await waitFor(() => expect(submittalCalls()).toBe(1));
    await waitFor(() => expect(preStartCalls()).toBe(1));
    // Cells populated with the authoritative summaries.
    expect(await screen.findByText('Confirmed')).toBeInTheDocument();
    expect(await screen.findByText('Blocked · 2')).toBeInTheDocument();

    // Close + reopen the SAME row → cache hit, NO refetch.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('button', { name: /Marcus Adeyemi/ }));
    await screen.findByText('Workflow status'); // panel reopened
    expect(submittalCalls()).toBe(1);
    expect(preStartCalls()).toBe(1);
  });
});
