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
  // The view also calls useSession + listCompanies + /v1/pipelines + roster;
  // all share this mock (mockImplementation → a fresh read-once Response).
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
    // The title link (the chevron is a second, descriptively-labelled link to
    // the same detail — selecting by the exact title name targets the title).
    expect(
      screen.getByRole('link', { name: 'Senior Engineer' }),
    ).toHaveAttribute('href', '/requisitions/req-open');
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

  it('"Hot" filters to hot requisitions', async () => {
    mockFetch([OPEN, HOT]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hot' }));
    expect(screen.getByText('Hot Role')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
  });

  it('default "My reqs" shows the whole visible payload for a non-read:all principal (server already scoped it)', async () => {
    // No read:all → isMine is true for every visible row → "My reqs" == "All".
    mockFetch([OPEN, HOLD]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'My reqs' }),
    ).toHaveAttribute('aria-pressed', 'true');
    // Both visible (active) reqs render — not blanked by the owner-field test.
    expect(screen.getByText('Mid Engineer')).toBeInTheDocument();
  });

  it('"My reqs" narrows to owned/recruited rows for a read:all principal', async () => {
    const MINE = makeReq('req-mine', 'My Req', 'active', { owner_id: 'u1' });
    const THEIRS = makeReq('req-theirs', 'Their Req', 'active', {
      owner_id: 'u2',
    });
    mockFetch([MINE, THEIRS]);
    renderList({
      sessionOverride: {
        sub: 'u1',
        consumer_type: 'recruiter',
        tenant_id: 't',
        scopes: ['requisition:read', 'requisition:read:all'],
        iat: 0,
        exp: 0,
      },
    });
    // Default My reqs + read:all → only the owned row.
    await waitFor(() => expect(screen.getByText('My Req')).toBeInTheDocument());
    expect(screen.queryByText('Their Req')).not.toBeInTheDocument();
    // "All" reveals the tenant-wide row.
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Their Req')).toBeInTheDocument();
  });

  it('"Needs sourcing" filters to active reqs with an empty pipeline', async () => {
    // OPEN has no pipeline rows in the mock → active count 0 → needs sourcing.
    mockFetch([OPEN]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Needs sourcing' }));
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
  });

  it('"Matches — coming with Aramo Core" chip is rendered DISABLED (no count, R10 seam)', async () => {
    mockFetch([OPEN]);
    renderList();
    const chip = await screen.findByRole('button', {
      name: /Matches — coming with Aramo Core/,
    });
    expect(chip).toBeDisabled();
  });

  it('the scoped search filters by title', async () => {
    mockFetch([OPEN, HOLD]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Search requisitions' }),
      { target: { value: 'mid' } },
    );
    expect(screen.getByText('Mid Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
  });

  it('renders an empty-state when no requisitions match', async () => {
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
    expect(
      screen.queryByRole('link', { name: /new requisition/i }),
    ).toBeNull();
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

  it('parity: Pipeline/Submitted counts (one /v1/pipelines call, grouped) + Recruiter name (roster)', async () => {
    const REQ = makeReq('req-r', 'Platform Engineer', 'active', {
      recruiter_id: 'usr-1',
    });
    const PIPELINES = [
      { id: 'p1', requisition_id: 'req-r', status: 'no_contact' },
      { id: 'p2', requisition_id: 'req-r', status: 'submitted' },
      { id: 'p3', requisition_id: 'req-r', status: 'interviewing' },
      { id: 'p4', requisition_id: 'req-r', status: 'placed' },
    ];
    const ROSTER = {
      items: [
        {
          user_id: 'usr-1',
          email: 'p@x.test',
          display_name: 'Priya Recruiter',
          is_active: true,
        },
      ],
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const body = url.includes('/v1/pipelines')
        ? { items: PIPELINES }
        : url.includes('/v1/tenant/users')
          ? ROSTER
          : url.includes('/v1/companies')
            ? { items: [{ id: 'co-1', name: 'Northwind' }] }
            : { items: [REQ] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Platform Engineer')).toBeInTheDocument(),
    );
    // Recruiter resolved via the roster.
    await waitFor(() =>
      expect(screen.getByText('Priya Recruiter')).toBeInTheDocument(),
    );
    // active = 4 minus the placed (terminal) = 3; submitted+ = submitted +
    // interviewing + placed = 3.
    const cells = screen.getAllByText('3');
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });

  it('shows "Unassigned" in the owner cell and offers no reassign action', async () => {
    // OPEN has recruiter_id + owner_id null.
    mockFetch([OPEN]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(screen.getByText('Unassigned')).toBeInTheDocument();
    // Reassignment is deferred — no assign control on the surface.
    expect(screen.queryByRole('button', { name: /assign/i })).toBeNull();
  });

  it('renders the AI-matching seam DISABLED with the fixed coming-soon label', async () => {
    mockFetch([OPEN]);
    renderList();
    const pill = await screen.findByRole('button', { name: /AI matching/i });
    expect(pill).toBeDisabled();
    // Pinning the exact label proves the reserved seam surfaces no ordinal
    // verdict vocabulary (no tiers/verdicts) — it is a non-functional seam.
    expect(pill).toHaveTextContent('AI matching — coming with Aramo Core');
  });

  it('surfaces a needs-attention banner for hot requisitions', async () => {
    mockFetch([HOT]);
    renderList();
    await waitFor(() =>
      expect(
        screen.getByText(/requisition.*need.*attention/i),
      ).toBeInTheDocument(),
    );
  });
});
