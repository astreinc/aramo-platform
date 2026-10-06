import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider } from '../shell/breadcrumb';

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
  readonly profile?: Record<string, unknown>;
  // Workspace reads — the Talent Board projection + the interview calendar window.
  readonly board?: Record<string, unknown>;
  readonly interviews?: Record<string, unknown>;
}

const EMPTY_BOARD = {
  requisition_id: 'req-1',
  columns: [],
  closed: { total: 0, by_reason: [] },
  total_active: 0,
};

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
    // Profile read must be matched BEFORE the generic requisition GET.
    if (url.includes('/v1/requisitions/req-1/profile')) {
      return json(opts.profile ?? { has_profile: false });
    }
    // Workspace Talent-Board + interview-calendar reads (requisition-grain) — must
    // also be matched BEFORE the generic requisition GET.
    if (url.includes('/talent-board')) return json(opts.board ?? EMPTY_BOARD);
    if (url.includes('/v1/interviews')) {
      return json(opts.interviews ?? { interviews: [], window: { from: '', to: '' } });
    }
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

describe('RequisitionDetailView workspace — Workspace is the default tab for everyone', () => {
  afterEach(() => vi.restoreAllMocks());

  // The scope-driven emphasis is gone: Workspace opens first for EVERY actor
  // (clamped to the available set — Workspace is always available). The per-tab
  // scope gates are unchanged, so each test ALSO proves the scope-specific tab
  // is available/gated.

  it('commercials:approve → default Workspace; Commercial tab available', async () => {
    mount(['requisition:read', 'assignment:commercials:read', 'assignment:commercials:approve']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Workspace/));
    expect(screen.getByRole('tab', { name: /Commercial/ })).toBeTruthy();
  });

  it('pipeline:read → default Workspace; Talent tab available', async () => {
    mount(['requisition:read', 'pipeline:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Workspace/));
    expect(screen.getByRole('tab', { name: /Talent/ })).toBeTruthy();
  });

  it('assignment:extend (+placement:read) → default Workspace; Assignments tab available', async () => {
    mount(['requisition:read', 'assignment:extend', 'placement:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Workspace/));
    expect(screen.getByRole('tab', { name: /Assignments/ })).toBeTruthy();
  });

  it('a plain reader (no downstream scope) → default Workspace; only Details/Activity/Attachments', async () => {
    mount(['requisition:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Workspace/));
    expect(screen.getByRole('tab', { name: 'Details' })).toBeTruthy();
    // Scope-gated tabs stay hidden without their read scope.
    expect(screen.queryByRole('tab', { name: /Talent/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Commercial/ })).toBeNull();
  });
});

describe('RequisitionDetailView workspace — tab availability (scope-gated)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('read scopes reveal their tabs; commercial read-vs-approve gates the Commercial tab', async () => {
    mount([
      'requisition:read',
      'pipeline:read',
      'offer:read',
      'offer:create',
      'pre_start_requirement:read',
      'placement:read',
      'assignment:commercials:read',
    ]);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(screen.getByRole('tab', { name: /Talent/ })).toBeTruthy();
    // §5.1 — the Offers (& starts) tab is gated on the real read authority offer:read.
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

  it('renders the eager snapshot cards (prototype)', async () => {
    mount(['requisition:read', 'pipeline:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(screen.getByText('Capacity')).toBeInTheDocument();
    expect(screen.getByText('Aging')).toBeInTheDocument();
  });

  it('attention shows only grounded rows (over-capacity, client paused, offer expiring) — never interviews-today or a deadline countdown', async () => {
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mount(
      ['requisition:read', 'pipeline:read', 'offer:read'],
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
            // Server-computed canonical offer timing (expiring within the window).
            offer_timing: { awaiting_response: true, expiring_soon: true, expired_by_time: false, days_until_expiry: 2 },
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
    // The form lives in the Details tab (Workspace is now the default), so open
    // Details before asserting on the form's financial section.
    // Absent → no Financial planning section.
    const first = mount(['requisition:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    expect(screen.queryByText('Financial planning')).toBeNull();
    first.unmount();
    vi.restoreAllMocks();

    // Present (un-masked actor) → the section + a financial field render.
    mount(['requisition:read'], {
      req: reqView({ target_margin_percent: '32.0', max_pay_rate: '95.00' }),
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
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

  it('selecting the Offers tab shows the Offers panel', async () => {
    mount(['requisition:read', 'pipeline:read', 'offer:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    // Navigate via the tab (unambiguous vs. the snapshot Offers card).
    fireEvent.click(screen.getByRole('tab', { name: /Offers/ }));
    await waitFor(() => expect(selectedTabName()).toMatch(/Offers/));
    // §11 (ruling B) — the tab IS the board-sourced Offers & Starts list; empty when no offer+ cards.
    expect(await screen.findByText(/No offers or starts on this requisition/)).toBeInTheDocument();
  });

  it('§11 (ruling B) — Offers & Starts list renders board offer+ rows, each Continuing into /offer-start/:pipelineId', async () => {
    const offerStartBoard = {
      requisition_id: 'req-1',
      total_active: 1,
      closed: { total: 0, by_reason: [] },
      columns: [
        {
          key: 'selected',
          owner: 'client_selection',
          count: 1,
          cards: [
            {
              talent_record_id: 'tal-9', pipeline_id: 'pp-9', column: 'selected',
              owner: 'client_selection', source_object_id: 'cs-9', owner_state: 'selected',
              resume: { resume_edition_id: null, source: 'none', locked: false },
              rtr_state: null, readiness: null, days_in_stage: null, stage_entered_at: null,
              assigned_recruiter_user_id: null, next_actions: [], handoff: false,
            },
          ],
        },
      ],
    };
    mount(['requisition:read', 'pipeline:read', 'offer:read'], { board: offerStartBoard });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    fireEvent.click(screen.getByRole('tab', { name: /Offers/ }));
    const cont = await screen.findByTestId('offers-continue');
    // Authoritative board pipeline_id — no FE pairing of offer↔pipeline.
    expect(cont.getAttribute('href')).toBe('/offer-start/pp-9');
  });

  const PIPELINE_TAL1 = [
    {
      id: 'pp-1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1',
      requisition_id: 'req-1', status: 'qualifying',
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    },
  ];

  it('opening a Talent row LAZILY populates the Client + Pre-Start cells with that talent\'s own reads, and caches them (reopen does NOT refetch)', async () => {
    // The talent surface defaults to Board now; this spec opens a LIST row.
    try {
      localStorage.setItem('aramo.req.talentView.v2', 'list');
    } catch {
      /* jsdom localStorage */
    }
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
    // Workspace is the default tab — open the Talent tab to reach the journey grid.
    fireEvent.click(screen.getByRole('tab', { name: /Talent/ }));

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
    await screen.findByRole('list', { name: 'Talent journey' }); // panel reopened
    expect(submittalCalls()).toBe(1);
    expect(preStartCalls()).toBe(1);
  });
});

describe('RequisitionDetailView workspace — Workspace panel sections', () => {
  afterEach(() => vi.restoreAllMocks());
  // Talent-in-play now defaults to the embedded Board (shared preference). These
  // section specs assert the LIST (funnel) rows, so pin the preference to list;
  // the Board default is covered by its own test below.
  beforeEach(() => {
    try {
      localStorage.setItem('aramo.req.talentView.v2', 'list');
    } catch {
      /* jsdom localStorage */
    }
  });

  const PIPELINE_TAL1 = [
    {
      id: 'pp-1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1',
      requisition_id: 'req-1', status: 'qualifying',
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
    },
  ];

  // A Board card hand-mirroring the backend projection DTO (state enums only).
  function card(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      talent_record_id: 'tal-1', pipeline_id: 'pp-1', column: 'qualified',
      owner: 'pipeline', source_object_id: 'pp-1', owner_state: 'qualified',
      resume: { resume_edition_id: null, source: 'none', locked: false },
      rtr_state: 'NOT_EXECUTED',
      readiness: {
        requisition_state: 'open', requisition_reason: null,
        blockers: ['rtr_not_executed'], band: 'needs_action',
      },
      days_in_stage: 4, stage_entered_at: '2026-08-01T00:00:00Z',
      assigned_recruiter_user_id: null,
      next_actions: [
        {
          key: 'pipeline.advance', label: 'Advance stage', owner: 'pipeline',
          command_route: '/x', required_scope: 'pipeline:change-status',
        },
      ],
      handoff: false,
      ...extra,
    };
  }

  function boardWith(columns: unknown[]): Record<string, unknown> {
    return {
      requisition_id: 'req-1', total_active: 1,
      closed: { total: 0, by_reason: [] }, columns,
    };
  }

  it('Talent in play defaults to the embedded Board (shared preference) with a List | Board toggle — the SAME board as the Talent tab', async () => {
    localStorage.setItem('aramo.req.talentView.v2', 'board');
    mount(['requisition:read', 'pipeline:read'], {
      pipelines: PIPELINE_TAL1,
      board: boardWith([{ key: 'qualified', owner: 'pipeline', count: 1, cards: [card()] }]),
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    // The shared List | Board segmented control is present in the Workspace.
    expect(screen.getByRole('tab', { name: 'Board' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'List' })).toBeInTheDocument();
    // The embedded Board renders by default (not the funnel List rows).
    const tip = screen
      .getByRole('heading', { name: 'Talent in play' })
      .closest('.rc-tip');
    expect(tip?.querySelector('.rc-tip__board')).not.toBeNull();
  });

  it('is the default tab, labels the record form tab "Details" (not "Overview"), and renders all six sections', async () => {
    mount(['requisition:read']);
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await waitFor(() => expect(selectedTabName()).toMatch(/Workspace/));
    expect(screen.getByRole('tab', { name: 'Details' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Overview' })).toBeNull();
    for (const name of [
      'Needs attention', 'Pipeline', 'Talent in play',
      'Requisition context', 'Upcoming & tasks', 'Recent activity',
    ]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('Pipeline tile + With-the-client counts come from the Talent Board projection', async () => {
    mount(['requisition:read', 'pipeline:read'], {
      board: boardWith([
        { key: 'qualified', owner: 'pipeline', count: 3, cards: [] },
        { key: 'submitted', owner: 'submittal', count: 2, cards: [] },
      ]),
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    // 'Qualified' is a 1:1 recruiting tile → reads the authoritative column count.
    const qualifiedTile = (await screen.findByText('Qualified')).closest('.rc-pipe__tile');
    expect(qualifiedTile?.textContent).toContain('3');
    // Downstream (submitted) is summarised in the 'With the client' line, not a tile.
    expect(screen.getByText(/submitted to client/).textContent).toContain('2');
  });

  it('Talent in play renders a row with the Board stage, age and the grounded funnel (RTR from the backend verdict)', async () => {
    mount(['requisition:read', 'pipeline:read'], {
      pipelines: PIPELINE_TAL1,
      board: boardWith([{ key: 'qualified', owner: 'pipeline', count: 1, cards: [card()] }]),
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    const nameEl = await screen.findByText('Marcus Adeyemi');
    const row = nameEl.closest('.rc-tip__row');
    if (row === null) throw new Error('no talent-in-play row');
    expect(within(row).getByText('Qualified')).toBeInTheDocument(); // authoritative stage pill
    expect(row.textContent).toContain('4 days'); // days_in_stage, humanised
    // Funnel milestones are read projections of the single authoritative stage +
    // rtr_state; RTR is 'Required' only because the backend flagged NOT_EXECUTED.
    expect(within(row).getByText('Required')).toBeInTheDocument();
    expect(within(row).getAllByText('✓ Complete').length).toBeGreaterThanOrEqual(1);
  });

  it('a next-action CTA is hidden from an actor lacking its required scope, shown to one who holds it', async () => {
    const board = boardWith([{ key: 'qualified', owner: 'pipeline', count: 1, cards: [card()] }]);
    // Restricted — pipeline:read only (can SEE the Board, cannot advance).
    const restricted = mount(['requisition:read', 'pipeline:read'], { pipelines: PIPELINE_TAL1, board });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await screen.findByText('Marcus Adeyemi');
    expect(screen.queryByRole('button', { name: 'Advance stage' })).toBeNull();
    restricted.unmount();
    vi.restoreAllMocks();

    // Authorised — + pipeline:change-status → the CTA renders.
    mount(['requisition:read', 'pipeline:read', 'pipeline:change-status'], {
      pipelines: PIPELINE_TAL1, board,
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    await screen.findByText('Marcus Adeyemi');
    expect(await screen.findByRole('button', { name: 'Advance stage' })).toBeInTheDocument();
  });

  it('renders useful empty states when there is no talent / attention / interviews / activity', async () => {
    mount(['requisition:read', 'pipeline:read']); // empty board + empty reads (defaults)
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    expect(await screen.findByText('No talent in play yet.')).toBeInTheDocument();
    // Pipeline always shows the 5 recruiting tiles (zeroed) — there is no
    // "empty pipeline" copy any more.
    expect(
      screen.getByText('Nothing needs attention on this requisition right now.'),
    ).toBeInTheDocument();
    expect(screen.getByText('None scheduled')).toBeInTheDocument();
    expect(screen.getByText('No activity yet.')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView Overview — edit does not blank (real RequirementSkills)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('entering edit renders the form even when the profile omits skill arrays', async () => {
    // The profile endpoint returns a shape WITHOUT required/preferred arrays —
    // previously this threw in the skills section and blanked the whole Overview.
    mount(['requisition:read', 'requisition:edit'], {
      profile: { has_profile: false },
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The form still renders (no blank) — Job title input + the skills section.
    expect(await screen.findByLabelText('Job title')).toBeInTheDocument();
    expect(screen.getByText('Requirement skills')).toBeInTheDocument();
  });
});

describe('RequisitionDetailView Overview — edit renders with a realistic profile', () => {
  afterEach(() => vi.restoreAllMocks());

  it('edit mode renders the edit bar + fields for a req with a full profile', async () => {
    mount(['requisition:read', 'requisition:edit', 'requisition:profile:edit'], {
      req: reqView({
        duration_value: 12,
        duration_unit: null,
        job_type: null,
        work_arrangement: null,
      }),
      profile: {
        has_profile: true,
        jd_text: 'Analyze workflows.',
        role_family: 'business_analyst',
        seniority_level: null,
        required_skills: [{ name: 'Business analysis' }],
        preferred_skills: [{ name: 'Multi-family lending' }],
        critical_skills: [],
        generated_by: 'manual',
      },
    });
    await screen.findByRole('heading', { name: /Staff Platform Engineer/ });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    // The edit bar + form must render (a throw anywhere blanks the whole panel).
    expect(await screen.findByText(/Editing REQ-/)).toBeInTheDocument();
    expect(screen.getByLabelText('Job title')).toBeInTheDocument();
    expect(screen.getByText('Business analysis')).toBeInTheDocument();
  });
});
