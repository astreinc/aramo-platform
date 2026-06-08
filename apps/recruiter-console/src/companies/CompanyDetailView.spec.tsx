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
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
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
  companyId: string,
  status: RequisitionStatus = 'active',
): RequisitionView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    title,
    company_id: companyId,
    contact_id: null,
    company_department_id: null,
    status,
    type: null,
    duration: null,
    rate_max: null,
    salary: null,
    description: null,
    notes: null,
    is_hot: false,
    openings: 1,
    openings_available: 1,
    start_date: null,
    city: null,
    state: null,
    recruiter_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    compensation_model: null,
    pay_rate_amount: null,
    pay_rate_currency: null,
    pay_rate_period: null,
    bill_rate_amount: null,
    bill_rate_currency: null,
    bill_rate_period: null,
    placement_fee_percent: null,
    placement_fee_amount: null,
    salary_amount: null,
    salary_currency: null,
    margin_amount: null,
    markup_percent: null,
    margin_percent: null,
  };
}

type FetchMap = Record<string, unknown | { status: number; body: unknown }>;

function installFetch(map: FetchMap) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    for (const [pattern, value] of Object.entries(map)) {
      if (url.includes(pattern)) {
        const isWrapped =
          typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
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
        <Route
          path="/requisitions/:reqId"
          element={<p>Req detail</p>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('CompanyDetailView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Profile tab with the company name and visibility framing', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(screen.getByText(/a client visible to you/i)).toBeInTheDocument();
    expect(screen.getByText('San Francisco, CA')).toBeInTheDocument();
    expect(screen.getByText('555-0200')).toBeInTheDocument();
    expect(screen.getByText('acme.example.com')).toBeInTheDocument();
    expect(screen.getByText('TypeScript, Postgres')).toBeInTheDocument();
  });

  it('hides scope-gated tabs when their scopes are absent', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Contacts' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Assigned reqs' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Activity' })).toBeNull();
  });

  it('shows all four tabs when all per-tab scopes are granted', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
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
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Contacts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Assigned reqs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
  });

  it('Contacts tab calls /v1/contacts?company_id=:id', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': {
        items: [makeContact('ct-1', 'Jane', 'Doe', { title: 'CTO' })],
      },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'contact:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Contacts' }));
    await waitFor(() =>
      expect(screen.getByText('Jane Doe')).toBeInTheDocument(),
    );
    expect(screen.getByText(/CTO/)).toBeInTheDocument();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const contactCall = calls.find((c) => String(c[0]).includes('/v1/contacts'));
    expect(String(contactCall?.[0])).toContain('company_id=co-1');
  });

  it('Assigned reqs tab filters reqs client-side by company_id (active only)', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/requisitions': {
        items: [
          makeReq('r-1', 'Senior Engineer', 'co-1', 'active'),
          makeReq('r-2', 'Junior Engineer', 'co-OTHER', 'active'),
          makeReq('r-3', 'Closed Role', 'co-1', 'closed'),
          makeReq('r-4', 'Open Role', 'co-1', 'on_hold'),
        ],
      },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'requisition:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Assigned reqs' }));
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // Open Role (on_hold) is active for the recruiter (R1's "open" framing).
    expect(screen.getByText('Open Role')).toBeInTheDocument();
    // The other-company req and the closed req are filtered out.
    expect(screen.queryByText('Junior Engineer')).toBeNull();
    expect(screen.queryByText('Closed Role')).toBeNull();
    // Link points at the req detail.
    expect(
      screen.getByRole('link', { name: 'Senior Engineer' }),
    ).toHaveAttribute('href', '/requisitions/r-1');
  });

  it('Assigned reqs shows the PRECISE limitation banner when the BE returns the cap (ruling 2)', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeReq(`r-${i}`, `Req ${i}`, i === 0 ? 'co-1' : 'co-OTHER', 'active'),
    );
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/requisitions': { items },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'requisition:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Assigned reqs' }));
    await waitFor(() =>
      expect(screen.getByTestId('assigned-reqs-banner')).toBeInTheDocument(),
    );
    // PRECISION test (ruling 2): the banner names the already-capped set
    // honestly — it does NOT claim completeness, and it surfaces that
    // matches beyond the page are missed.
    const banner = screen.getByTestId('assigned-reqs-banner');
    expect(banner.textContent).toMatch(/first 50 visible requisitions/i);
    expect(banner.textContent).toMatch(/matches beyond that page are not included/i);
    expect(banner.textContent).toMatch(/server-side company filtering is on the roadmap/i);
  });

  it('Assigned reqs hides the limitation banner when under the cap', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/requisitions': { items: [makeReq('r-1', 'A', 'co-1', 'active')] },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'requisition:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Assigned reqs' }));
    await waitFor(() =>
      expect(screen.getByText('A')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('assigned-reqs-banner')).toBeNull();
  });

  it('Activity tab calls subject_type=company and shows the user-honest empty-state (ruling 3)', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/activities': { items: [] },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'activity:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() =>
      expect(
        screen.getByText(/no activity recorded for this company yet/i),
      ).toBeInTheDocument(),
    );
    // RULING-3 negative assertion: the empty-state copy stays end-user-
    // honest, not architectural. A drift toward internal substrate copy
    // (mentioning emitters, services, or write paths) fails this check.
    const empty = screen.getByText(/no activity recorded for this company yet/i);
    expect(empty.textContent).not.toMatch(/emitted/i);
    expect(empty.textContent).not.toMatch(/service/i);
    expect(empty.textContent).not.toMatch(/write path/i);
    // The URL used subject_type=company.
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
      expect(
        screen.getByText(/this company is not available/i),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('link', { name: /back to companies/i }),
    ).toBeInTheDocument();
  });

  it('Contacts empty-state copy is honest', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': { items: [] },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'contact:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Contacts' }));
    await waitFor(() =>
      expect(
        screen.getByText(/no contacts for this company yet/i),
      ).toBeInTheDocument(),
    );
  });

  // R6' — the edit affordances (scope-gated).
  it('renders an "Edit" link on Profile when company:edit is granted', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'company:edit']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    const editLink = screen.getByRole('link', { name: 'Edit' });
    expect(editLink).toHaveAttribute('href', '/companies/co-1/edit');
  });

  it('hides the Profile "Edit" link when company:edit is absent', async () => {
    installFetch({ '/v1/companies/co-1': makeCompany() });
    renderAt('/companies/co-1', makeSession(['company:read']));
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('Contacts tab renders "+ New contact" when contact:create is granted', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': { items: [] },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'contact:read', 'contact:create']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Contacts' }));
    await waitFor(() =>
      expect(
        screen.getByText(/no contacts for this company yet/i),
      ).toBeInTheDocument(),
    );
    const newLink = screen.getByRole('link', { name: /\+ new contact/i });
    expect(newLink).toHaveAttribute(
      'href',
      '/companies/co-1/contacts/new',
    );
  });

  it('Contacts tab renders per-row "Edit" links when contact:edit is granted', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': {
        items: [makeContact('ct-1', 'Jane', 'Doe', { title: 'CTO' })],
      },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'contact:read', 'contact:edit']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Contacts' }));
    await waitFor(() =>
      expect(screen.getByText('Jane Doe')).toBeInTheDocument(),
    );
    const editLink = screen.getByRole('link', { name: 'Edit' });
    expect(editLink).toHaveAttribute('href', '/contacts/ct-1/edit');
  });

  it('Contacts tab hides "+ New contact" and per-row "Edit" when their scopes are absent', async () => {
    installFetch({
      '/v1/companies/co-1': makeCompany(),
      '/v1/contacts': {
        items: [makeContact('ct-1', 'Jane', 'Doe')],
      },
    });
    renderAt(
      '/companies/co-1',
      makeSession(['company:read', 'contact:read']),
    );
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Contacts' }));
    await waitFor(() =>
      expect(screen.getByText('Jane Doe')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /\+ new contact/i })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });
});
