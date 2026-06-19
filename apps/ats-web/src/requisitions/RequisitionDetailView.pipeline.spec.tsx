import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider, useBreadcrumbEntity } from '../shell/breadcrumb';

import { RequisitionDetailView } from './RequisitionDetailView';

// 2D — the re-skinned header / meta strip / Pipeline tab (funnel ribbon +
// talent table) + breadcrumb publication. The cockpit (Details tab) is
// proven in RequisitionDetailView.cockpit.spec.tsx.

const SESSION: Session = {
  sub: 'u1',
  consumer_type: 'recruiter',
  tenant_id: 't',
  scopes: ['requisition:read'],
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
  status: 'active',
  type: 'C2H',
  is_hot: true,
  openings: 3,
  openings_available: 2,
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
    { id: 'p1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1', requisition_id: 'req-1', status: 'interviewing', created_at: '2026-06-15T00:00:00Z', updated_at: '2026-06-15T00:00:00Z' },
    { id: 'p2', tenant_id: 't', site_id: null, talent_record_id: 'tal-2', requisition_id: 'req-1', status: 'submitted', created_at: '2026-06-14T00:00:00Z', updated_at: '2026-06-14T00:00:00Z' },
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

  it('renders the header: title, Hot + Open pills, company name link, REQ code', async () => {
    mockApi();
    mountDetail();
    expect(
      await screen.findByRole('heading', { name: /Senior Rust Engineer/ }),
    ).toBeInTheDocument();
    // "Hot" appears as the header pill AND the talent-table column header.
    expect(screen.getAllByText('Hot').length).toBeGreaterThan(0);
    expect(screen.getByText('Open')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Northwind Robotics' }),
      ).toHaveAttribute('href', '/companies/co-1'),
    );
    expect(screen.getByText(/REQ-2041/)).toBeInTheDocument();
  });

  it('renders the meta strip (Type / Location / Openings / Opened); no masked Max rate', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    expect(screen.getByText('Type')).toBeInTheDocument();
    expect(screen.getByText('C2H')).toBeInTheDocument();
    expect(screen.getByText('Austin, TX')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
    // Comp masked-by-absence → no Max rate cell.
    expect(screen.queryByText('Max rate')).toBeNull();
  });

  it('parity: Recruiter meta cell + Rate(stated)/Owner columns + Remote suffix + pipeline toolbar', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // Recruiter name resolved via the roster (gap #8).
    await waitFor(() => expect(screen.getByText('Priya Recruiter')).toBeInTheDocument());
    // Stated rate (freetext, gap #3) + owner name in the talent table.
    expect(screen.getByText('$74/hr')).toBeInTheDocument();
    expect(screen.getAllByText('Tom Owner').length).toBeGreaterThan(0);
    // Location carries the work-arrangement suffix (work_arrangement=remote).
    expect(screen.getByText('· Remote ok')).toBeInTheDocument();
    // The pipeline toolbar.
    expect(screen.getByRole('button', { name: 'All stages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Active only' })).toBeInTheDocument();
  });

  it('parity: Hot toggle column reflects is_hot — read-only (disabled) without talent:edit', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Marcus Adeyemi' })).toBeInTheDocument(),
    );
    // tal-1 is_hot=true → pressed; tal-2 is_hot=false → not pressed.
    const marcusHot = await screen.findByRole('button', {
      name: /Marcus Adeyemi is marked hot/,
    });
    expect(marcusHot).toHaveAttribute('aria-pressed', 'true');
    const sofiaHot = screen.getByRole('button', { name: /Mark Sofia Ramos as hot/ });
    expect(sofiaHot).toHaveAttribute('aria-pressed', 'false');
    // No talent:edit scope → the toggles are read-only (disabled).
    expect(marcusHot).toBeDisabled();
    expect(sofiaHot).toBeDisabled();
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

  it('Pipeline tab: funnel ribbon counts + talent table with stage pills + talent links', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // Funnel buckets present (the funnel "Submitted" label + the row's stage
    // pill both read "Submitted", so assert at least one).
    expect(screen.getAllByText('Submitted').length).toBeGreaterThan(0);
    expect(screen.getByText('Interview')).toBeInTheDocument();
    // Talent rows resolved + linked.
    await waitFor(() =>
      expect(
        screen.getByRole('link', { name: 'Marcus Adeyemi' }),
      ).toHaveAttribute('href', '/talent/tal-1'),
    );
    expect(screen.getByRole('link', { name: 'Sofia Ramos' })).toBeInTheDocument();
    // Stage pill for the interviewing row.
    expect(screen.getByText('Interviewing')).toBeInTheDocument();
  });

  it('right column has an at-a-glance card and the R10 reserved Match-insight seam (no scores)', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    expect(screen.getByText('This req at a glance')).toBeInTheDocument();
    const seam = screen.getByRole('region', { name: 'Match insight' });
    expect(seam.textContent).toContain('no scores');
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
      scopes: ['requisition:read', 'talent:edit'],
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
    // Sofia is not hot → clicking marks her hot via PATCH talent-records/tal-2.
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
