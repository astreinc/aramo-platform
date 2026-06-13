import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequisitionsListView } from './RequisitionsListView';
import type { RequisitionStatus, RequisitionView } from './types';

function makeReq(
  id: string,
  title: string,
  status: RequisitionStatus,
  extra: Partial<RequisitionView> = {},
): RequisitionView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    title,
    company_id: 'co-1',
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
    openings: 2,
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
    job_type: null,
    labor_category: null,
    role_family: null,
    seniority_level: null,
    headcount_reason: null,
    work_arrangement: null,
    travel_percent: null,
    relocation_offered: null,
    work_authorization: null,
    end_date: null,
    duration_value: null,
    duration_unit: null,
    extension_possible: null,
    hours_per_week: null,
    source_system: null,
    external_req_id: null,
    imported_at: null,
    target_margin_percent: null,
    markup_percent_target: null,
    rate_card_id: null,
    min_bill_rate: null,
    max_bill_rate: null,
    min_pay_rate: null,
    max_pay_rate: null,
    golden_profile_id: null,
    ...extra,
  };
}

const OPEN = makeReq('req-open', 'Senior Engineer', 'active');
const HOLD = makeReq('req-hold', 'Mid Engineer', 'on_hold');
const CLOSED = makeReq('req-closed', 'Junior Engineer', 'closed');
const FILLED = makeReq('req-filled', 'Architect', 'full');
const HOT = makeReq('req-hot', 'Hot Role', 'active', { is_hot: true });

function mockFetch(items: readonly RequisitionView[]) {
  // The view also calls useSession + listCompanies; all share this mock
  // (mockImplementation → a fresh read-once Response per call).
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function renderList(props = {}) {
  return render(
    <MemoryRouter>
      <RequisitionsListView {...props} />
    </MemoryRouter>,
  );
}

describe('RequisitionsListView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders only active (non-closed) requisitions by default', async () => {
    mockFetch([OPEN, HOLD, CLOSED, FILLED]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.getByText('Mid Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();
    expect(screen.queryByText('Architect')).not.toBeInTheDocument();
  });

  it('the row title is a real link to the detail route', async () => {
    mockFetch([OPEN]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /Senior Engineer/ })).toHaveAttribute(
      'href',
      '/requisitions/req-open',
    );
  });

  it('reveals closed + filled requisitions when "Show closed" is toggled on', async () => {
    mockFetch([OPEN, CLOSED, FILLED]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show closed' }));
    expect(screen.getByText('Junior Engineer')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
  });

  it('"Only hot" filters to hot requisitions', async () => {
    mockFetch([OPEN, HOT]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Only hot' }));
    expect(screen.getByText('Hot Role')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
  });

  it('the scoped search filters by title', async () => {
    mockFetch([OPEN, HOLD]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search requisitions' }), {
      target: { value: 'mid' },
    });
    expect(screen.getByText('Mid Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
  });

  it('renders an empty-state row when no requisitions match', async () => {
    mockFetch([CLOSED, FILLED]);
    renderList();
    await waitFor(() =>
      expect(
        screen.getByText('No requisitions match these filters.'),
      ).toBeInTheDocument(),
    );
  });

  it('hides "New requisition" without requisition:create', async () => {
    mockFetch([OPEN]);
    renderList({
      sessionOverride: {
        sub: 'u1',
        consumer_type: 'recruiter',
        tenant_id: 't',
        scopes: ['requisition:read'],
        iat: 0,
        exp: 0,
      },
    });
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /new requisition/i })).toBeNull();
  });

  it('shows "New requisition" linking to /requisitions/new when scoped', async () => {
    mockFetch([OPEN]);
    renderList({
      sessionOverride: {
        sub: 'u1',
        consumer_type: 'recruiter',
        tenant_id: 't',
        scopes: ['requisition:read', 'requisition:create'],
        iat: 0,
        exp: 0,
      },
    });
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('link', { name: /new requisition/i }),
    ).toHaveAttribute('href', '/requisitions/new');
  });
});
