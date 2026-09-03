import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider, useBreadcrumbEntity } from '../shell/breadcrumb';

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

// 2D — the re-skinned header / meta strip / Pipeline tab (funnel ribbon +
// talent table) + breadcrumb publication. The cockpit (Details tab) is
// proven in RequisitionDetailView.cockpit.spec.tsx.

const SESSION: Session = {
  sub: 'u1',
  consumer_type: 'recruiter',
  tenant_id: 't',
  // pipeline:read → the Talent tab is available and is the scope-driven default,
  // so the funnel/talent-table content renders on first paint (as before).
  scopes: ['requisition:read', 'pipeline:read'],
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

const PIPELINES = {
  items: [
    { id: 'p1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1', requisition_id: 'req-1', status: 'qualified', created_at: '2026-06-15T00:00:00Z', updated_at: '2026-06-15T00:00:00Z' },
    { id: 'p2', tenant_id: 't', site_id: null, talent_record_id: 'tal-2', requisition_id: 'req-1', status: 'qualifying', created_at: '2026-06-14T00:00:00Z', updated_at: '2026-06-14T00:00:00Z' },
  ],
};

const TALENTS: Record<string, unknown> = {
  'tal-1': { id: 'tal-1', first_name: 'Marcus', last_name: 'Adeyemi', current_pay: '$74/hr', owner_id: 'usr-own', is_hot: true },
  'tal-2': { id: 'tal-2', first_name: 'Sofia', last_name: 'Ramos', current_pay: '$76/hr', owner_id: 'usr-own', is_hot: false },
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
    if (url.includes('/v1/requisitions/req-1')) return json(REQ);
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
        <MemoryRouter initialEntries={['/requisitions/req-1']}>
          <Routes>
            <Route
              path="/requisitions/:reqId"
              element={<RequisitionDetailView sessionOverride={SESSION} />}
            />
          </Routes>
        </MemoryRouter>
      </BreadcrumbProvider>
    </ToastProvider>,
  );
}

describe('RequisitionDetailView — header / meta / pipeline (2D)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the header: title, Priority + Open pills, company name link, REQ code', async () => {
    mockApi();
    mountDetail();
    expect(
      await screen.findByRole('heading', { name: /Senior Rust Engineer/ }),
    ).toBeInTheDocument();
    // The requisition priority signal renders as the "Priority" header pill.
    expect(
      screen.getByText('Priority', { selector: '.rc-pill' }),
    ).toBeInTheDocument();
    // The RecruitingStatus header pill. (The Client-status snapshot card also
    // reads "Open" for a null client_submittal_status, so scope to the pill.)
    expect(screen.getByText('Open', { selector: '.rc-pill' })).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Northwind Robotics' }),
      ).toHaveAttribute('href', '/companies/co-1'),
    );
    expect(screen.getByText(/REQ-2041/)).toBeInTheDocument();
  });

  it('NO MetaStrip (prototype removal); header line 2 carries location + type; Capacity is a snapshot card', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // The old MetaStrip is gone — its labels no longer render.
    expect(screen.queryByText('Max rate')).toBeNull();
    expect(screen.queryByText('Opened')).toBeNull();
    expect(screen.queryByText('1 of 3')).toBeNull();
    // The data moved to the header line 2 (as " · {value}" clauses).
    expect(screen.getByText(/Austin, TX/)).toBeInTheDocument();
    expect(screen.getByText(/· C2H/)).toBeInTheDocument();
    // Capacity is a derived snapshot card (never a status).
    expect(screen.getByText('Capacity')).toBeInTheDocument();
    expect(screen.getByText('1/3 filled')).toBeInTheDocument();
  });

  it('header owner (recruiter) resolved via the roster + work-arrangement suffix in meta', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // Owner = recruiter_id ?? owner_id, resolved via the roster (gap #8) — now
    // in the header, not a meta cell.
    await waitFor(() => expect(screen.getByText('Priya Recruiter')).toBeInTheDocument());
    // Location carries the work-arrangement suffix (work_arrangement=remote).
    expect(screen.getByText('· Remote ok')).toBeInTheDocument();
  });

  it('Option A: HOT triage moved OFF the grid INTO the side panel; read-only (disabled) without talent:edit', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // No inline hot toggle on the journey grid.
    expect(screen.queryByRole('button', { name: /is marked hot|Mark .* as hot/ })).toBeNull();
    // Open the talent row → the side panel owns the HOT toggle.
    fireEvent.click(await screen.findByRole('button', { name: /Marcus Adeyemi/ }));
    const marcusHot = await screen.findByRole('button', {
      name: /Marcus Adeyemi is marked hot/,
    });
    expect(marcusHot).toHaveAttribute('aria-pressed', 'true');
    // No talent:edit scope → the panel toggle is read-only (disabled).
    expect(marcusHot).toBeDisabled();
  });

  it('parity: Attachments tab present with count', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // The mock returns no attachments → tab shows "(0)".
    expect(
      screen.getByRole('tab', { name: /Attachments \(0\)/ }),
    ).toBeInTheDocument();
  });

  it('Talent tab is the journey GRID: TALENT|PIPELINE|CLIENT|OFFER|PRE-START|ASSIGNMENT headers + status pills; talent opens the panel', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // Grid header columns.
    const grid = screen.getByRole('table', { name: 'Talent journey' });
    // Ruling 2 — canonical journey column labels.
    for (const h of ['Talent', 'Recruiting', 'Client', 'Offer', 'Pre-Start', 'Employment']) {
      expect(within(grid).getByText(h)).toBeInTheDocument();
    }
    // Pipeline cell = status pill (human label + tone); no funnel ribbon.
    expect(screen.getByText('Qualified')).toBeInTheDocument();
    expect(screen.getByText('Qualifying')).toBeInTheDocument();
    // Talent cell is a button (opens the side panel), not a router link.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Marcus Adeyemi/ })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Sofia Ramos/ })).toBeInTheDocument();
    // Drill-through: clicking the talent opens the owning side panel, which
    // renders the backend-owned journey rail (scoped to the dialog to avoid the
    // grid's own "Talent journey" heading).
    fireEvent.click(screen.getByRole('button', { name: /Marcus Adeyemi/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByRole('list', { name: 'Talent journey' }),
    ).toBeInTheDocument();
  });

  it('no leftover old-styled surfaces: no funnel ribbon / at-a-glance card / reserved seam / inline MoveToMenu', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    expect(screen.queryByText('This req at a glance')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Match insight' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All stages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
  });

  it('editable Hot (talent:edit): clicking the toggle PATCHes /v1/talent-records/:id is_hot', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = urlOf(input);
      const method = init?.method ?? 'GET';
      let body: unknown;
      try {
        body = init?.body != null ? JSON.parse(String(init.body)) : undefined;
      } catch {
        body = undefined;
      }
      calls.push({ url, method, body });
      const json = (b: unknown, s = 200) =>
        new Response(JSON.stringify(b), {
          status: s,
          headers: { 'Content-Type': 'application/json' },
        });
      const m = url.match(/\/v1\/talent-records\/(tal-\d)/);
      if (m?.[1] !== undefined && method === 'PATCH') {
        return json({ ...TALENTS[m[1]], ...(body as object) });
      }
      if (url.includes('/v1/requisitions/req-1')) return json(REQ);
      if (url.includes('/v1/pipelines')) return json(PIPELINES);
      if (url.includes('/v1/companies/co-1')) return json({ id: 'co-1', name: 'Northwind Robotics' });
      if (url.includes('/v1/tenant/users')) return json(ROSTER);
      if (m?.[1] !== undefined) return json(TALENTS[m[1]]);
      return json({ items: [] });
    });

    const editorSession: Session = {
      ...SESSION,
      scopes: ['requisition:read', 'pipeline:read', 'talent:edit'],
    };
    render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={<RequisitionDetailView sessionOverride={editorSession} />}
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // Option A — the move IS the panel: open Sofia's row, then toggle HOT there.
    fireEvent.click(await screen.findByRole('button', { name: /Sofia Ramos/ }));
    const sofiaHot = await screen.findByRole('button', {
      name: /Mark Sofia Ramos as hot/,
    });
    expect(sofiaHot).not.toBeDisabled();
    fireEvent.click(sofiaHot);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === 'PATCH' &&
            c.url.includes('/v1/talent-records/tal-2') &&
            (c.body as { is_hot?: boolean })?.is_hot === true,
        ),
      ).toBe(true),
    );
  });

  it('publishes the requisition title to the breadcrumb', async () => {
    mockApi();
    render(
      <ToastProvider>
        <BreadcrumbProvider>
          <MemoryRouter initialEntries={['/requisitions/req-1']}>
            <CrumbProbe />
            <Routes>
              <Route
                path="/requisitions/:reqId"
                element={<RequisitionDetailView sessionOverride={SESSION} />}
              />
            </Routes>
          </MemoryRouter>
        </BreadcrumbProvider>
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('crumb')).toHaveTextContent('Senior Rust Engineer'),
    );
  });
});

function CrumbProbe() {
  const entity = useBreadcrumbEntity();
  return <div data-testid="crumb">{entity ?? 'none'}</div>;
}
