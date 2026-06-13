import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BreadcrumbProvider, useBreadcrumbEntity } from '../shell/breadcrumb';

import { RequisitionDetailView } from './RequisitionDetailView';

// 2D — the re-skinned header / meta strip / Pipeline tab (funnel ribbon +
// candidate table) + breadcrumb publication. The cockpit (Details tab) is
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
  recruiter_id: null,
  owner_id: null,
};

const PIPELINES = {
  items: [
    { id: 'p1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1', requisition_id: 'req-1', status: 'interviewing', created_at: 'x', updated_at: 'x' },
    { id: 'p2', tenant_id: 't', site_id: null, talent_record_id: 'tal-2', requisition_id: 'req-1', status: 'submitted', created_at: 'x', updated_at: 'x' },
  ],
};

const TALENTS: Record<string, unknown> = {
  'tal-1': { id: 'tal-1', first_name: 'Marcus', last_name: 'Adeyemi' },
  'tal-2': { id: 'tal-2', first_name: 'Sofia', last_name: 'Ramos' },
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
    expect(screen.getByText('Hot')).toBeInTheDocument();
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

  it('Pipeline tab: funnel ribbon counts + talent table with stage pills + talent links', async () => {
    mockApi();
    mountDetail();
    await screen.findByRole('heading', { name: /Senior Rust Engineer/ });
    // Funnel buckets present (the funnel "Submitted" label + the row's stage
    // pill both read "Submitted", so assert at least one).
    expect(screen.getAllByText('Submitted').length).toBeGreaterThan(0);
    expect(screen.getByText('Interview')).toBeInTheDocument();
    // Candidate rows resolved + linked.
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
