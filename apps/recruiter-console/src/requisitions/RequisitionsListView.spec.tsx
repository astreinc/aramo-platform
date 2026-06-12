import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequisitionsListView } from './RequisitionsListView';
import type { RequisitionStatus, RequisitionView } from './types';

function makeReq(
  id: string,
  title: string,
  status: RequisitionStatus,
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
  };
}

const OPEN = makeReq('req-open', 'Senior Engineer', 'active');
const HOLD = makeReq('req-hold', 'Mid Engineer', 'on_hold');
const CLOSED = makeReq('req-closed', 'Junior Engineer', 'closed');
const FILLED = makeReq('req-filled', 'Architect', 'full');

function mockFetch(items: readonly RequisitionView[]) {
  // R4 — the view now also calls useSession (for the requisition:create
  // gate); both fetches share this mock. Use mockImplementation so each
  // call gets a fresh Response (Response bodies are read-once).
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('RequisitionsListView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders only active (non-closed) requisitions by default', async () => {
    mockFetch([OPEN, HOLD, CLOSED, FILLED]);
    render(
      <MemoryRouter>
        <RequisitionsListView />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.getByText('Mid Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();
    expect(screen.queryByText('Architect')).not.toBeInTheDocument();
  });

  it('reveals closed and filled requisitions when "Show closed" toggles on', async () => {
    mockFetch([OPEN, CLOSED, FILLED]);
    render(
      <MemoryRouter>
        <RequisitionsListView />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch'));

    expect(screen.getByText('Junior Engineer')).toBeInTheDocument();
    expect(screen.getByText('Architect')).toBeInTheDocument();
  });

  it('renders the empty-state copy when no active requisitions exist', async () => {
    mockFetch([CLOSED, FILLED]);
    render(
      <MemoryRouter>
        <RequisitionsListView />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/no open requisitions/i)).toBeInTheDocument(),
    );
  });

  // R4 — the "+ New requisition" CTA is gated by the requisition:create
  // scope. Hidden for read-only recruiters; visible (and links to
  // /requisitions/new) when the scope is held.
  it('hides "+ New requisition" when requisition:create is not held', async () => {
    mockFetch([OPEN]);
    render(
      <MemoryRouter>
        <RequisitionsListView
          sessionOverride={{
            sub: 'u1',
            consumer_type: 'recruiter',
            tenant_id: 't',
            scopes: ['requisition:read'],
            iat: 0,
            exp: 0,
          }}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /\+ new requisition/i })).toBeNull();
  });

  it('shows "+ New requisition" linking to /requisitions/new when requisition:create is held', async () => {
    mockFetch([OPEN]);
    render(
      <MemoryRouter>
        <RequisitionsListView
          sessionOverride={{
            sub: 'u1',
            consumer_type: 'recruiter',
            tenant_id: 't',
            scopes: ['requisition:read', 'requisition:create'],
            iat: 0,
            exp: 0,
          }}
        />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    const link = screen.getByRole('link', { name: /\+ new requisition/i });
    expect(link).toHaveAttribute('href', '/requisitions/new');
  });
});
