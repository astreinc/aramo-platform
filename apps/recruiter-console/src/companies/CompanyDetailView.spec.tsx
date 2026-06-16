import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import type { RequisitionStatus, RequisitionView } from '../requisitions/types';

import { CompanyDetailView } from './CompanyDetailView';
import type { CompanyView, ContactView } from './types';

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes,
    iat: 0,
    exp: 0,
  };
}

function makeCompany(overrides: Partial<CompanyView> = {}): CompanyView {
  return {
    id: 'co-1',
    tenant_id: 't',
    site_id: null,
    name: 'Acme Corp',
    address: null,
    address2: null,
    city: 'San Francisco',
    state: 'CA',
    zip: null,
    phone1: '555-0200',
    phone2: null,
    fax_number: null,
    url: 'acme.example.com',
    key_technologies: 'TypeScript, Postgres',
    notes: null,
    is_hot: false,
    billing_contact_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2023-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    status: 'active',
    description: 'A robotics automation firm.',
    industry: 'Robotics',
    country: null,
    employee_count_band: null,
    annual_revenue_band: null,
    founded_year: null,
    ownership_type: null,
    registration_number: null,
    source: null,
    client_tier: 'a',
    supplier_status: null,
    exclusivity: false,
    tags: [],
    general_email: null,
    last_activity_at: null,
    next_action_at: null,
    address_provider_place_id: null,
    address_provider: null,
    ...overrides,
  };
}

function makeContact(
  id: string,
  first: string,
  last: string,
  overrides: Partial<ContactView> = {},
): ContactView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    first_name: first,
    last_name: last,
    title: null,
    email1: null,
    email2: null,
    phone_work: null,
    phone_cell: null,
    phone_other: null,
    address: null,
    company_id: 'co-1',
    company_department_id: null,
    is_hot: false,
    notes: null,
    left_company: false,
    reports_to_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeReq(
  id: string,
  title: string,
  status: RequisitionStatus = 'active',
): RequisitionView {
  return { id, title, company_id: 'co-1', status } as unknown as RequisitionView;
}

type FetchMap = Record<string, unknown | { status: number; body: unknown }>;

function installFetch(map: FetchMap) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, value] of Object.entries(map)) {
      if (url.includes(pattern)) {
        const isWrapped =
          typeof value === 'object' &&
          value !== null &&
          'status' in value &&
          'body' in value;
        const body = isWrapped ? (value as { body: unknown }).body : value;
        const status = isWrapped ? (value as { status: number }).status : 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

function renderAt(path: string, session: Session) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/companies/:companyId"
          element={<CompanyDetailView sessionOverride={session} />}
        />
        <Route path="/companies" element={<p>Companies list</p>} />
        <Route path="/requisitions/:reqId" element={<p>Req detail</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CompanyDetailView (account hub)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the account header, KPI strip and the reserved-seam briefing', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    // header meta (location also appears in Overview "Key facts → Headquarters")
    expect(screen.getAllByText('San Francisco, CA').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'acme.example.com' })).toBeInTheDocument();
    expect(screen.getByText(/Client since 2023/i)).toBeInTheDocument();
    // status active → "Client" pill; tier a → "Key account"
    expect(screen.getByText('Client')).toBeInTheDocument();
    // KPI strip + reserved seam (NOT a fabricated metric)
    expect(screen.getByText('Open reqs')).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: /Account briefing/i }),
    ).toBeInTheDocument();
  });

  it('hides scope-gated tabs when their scopes are absent', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('tab', { name: /Contacts/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Jobs/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Activity/ })).toBeNull();
  });

  it('shows all tabs when the per-tab scopes are granted', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': { items: [] },
      '/v1/requisitions': { items: [] },
      '/v1/activities': { items: [] },
    });
    renderAt(
      '/companies/co-1',
      makeSession([
        'company:read',
        'contact:read',
        'requisition:read',
        'activity:read',
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: /Contacts/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Jobs/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Activity/ })).toBeInTheDocument();
  });

  it('Contacts tab calls /v1/contacts?company_id=:id and lists contacts', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': {
        items: [makeContact('ct-1', 'Jane', 'Doe', { title: 'CTO' })],
      },
    });
    renderAt('/companies/co-1', makeSession(['company:read', 'contact:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Contacts/ }));
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const contactCall = calls.find((c) => String(c[0]).includes('/v1/contacts'));
    expect(String(contactCall?.[0])).toContain('company_id=co-1');
  });

  it('Jobs tab calls /v1/requisitions?company_id=<id> and filters closed client-side', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/requisitions': {
        items: [
          makeReq('r-1', 'Senior Engineer', 'active'),
          makeReq('r-3', 'Closed Role', 'closed'),
          makeReq('r-4', 'Open Role', 'on_hold'),
        ],
      },
    });
    renderAt('/companies/co-1', makeSession(['company:read', 'requisition:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Jobs/ }));
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.getByText('Open Role')).toBeInTheDocument();
    expect(screen.queryByText('Closed Role')).toBeNull();
    expect(screen.getByRole('link', { name: 'Senior Engineer' })).toHaveAttribute(
      'href',
      '/requisitions/r-1',
    );
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const reqCall = calls.find((c) => String(c[0]).includes('/v1/requisitions'));
    expect(String(reqCall?.[0])).toContain('company_id=co-1');
  });

  it('Activity tab calls subject_type=company and shows the user-honest empty-state', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/activities': { items: [] },
    });
    renderAt('/companies/co-1', makeSession(['company:read', 'activity:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: /Activity/ }));
    await waitFor(() =>
      expect(
        screen.getByText(/no activity recorded for this company yet/i),
      ).toBeInTheDocument(),
    );
    const empty = screen.getByText(/no activity recorded for this company yet/i);
    expect(empty.textContent).not.toMatch(/emitted/i);
    expect(empty.textContent).not.toMatch(/write path/i);
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const activityCall = calls.find((c) => String(c[0]).includes('/v1/activities'));
    expect(String(activityCall?.[0])).toContain('subject_type=company');
    expect(String(activityCall?.[0])).toContain('subject_id=co-1');
  });

  it('surfaces the detail error when the company fetch returns 404 (D4b invisible)', async () => {
    installFetch({
      '/v1/companies/co-1': { status: 404, body: { message: 'not found' } },
    });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByText(/this company is not available/i)).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('link', { name: /back to companies/i }),
    ).toBeInTheDocument();
  });

  it('renders the header "Edit" link only when company:edit is granted', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    const { unmount } = renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'company:edit']),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /Edit/i })).toHaveAttribute(
      'href',
      '/companies/co-1/edit',
    );
    unmount();
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /Edit/i })).toBeNull();
  });

  it('renders the "Add contact" header action when contact:create is granted', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': { items: [] },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'contact:read', 'contact:create']),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Corp/i })).toBeInTheDocument(),
    );
    const links = screen.getAllByRole('link', { name: /add contact/i });
    expect(links[0]).toHaveAttribute('href', '/companies/co-1/contacts/new');
  });
});
