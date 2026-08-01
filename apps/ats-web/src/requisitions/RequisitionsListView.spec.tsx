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

// A per-endpoint mock so company names + pipelines resolve for real.
function mockEndpoints(opts: {
  reqs: readonly RequisitionView[];
  companies?: ReadonlyArray<{ id: string; name: string }>;
  pipelines?: ReadonlyArray<{ id: string; requisition_id: string; status: string }>;
  roster?: ReadonlyArray<{ user_id: string; display_name: string }>;
}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const body = url.includes('/v1/pipelines')
      ? { items: opts.pipelines ?? [] }
      : url.includes('/v1/tenant/users')
        ? { items: opts.roster ?? [] }
        : url.includes('/v1/companies')
          ? { items: opts.companies ?? [] }
          : { items: opts.reqs };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
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

  it('D1-a: selecting a terminal status in the dropdown reveals those reqs even with "Show closed" off', async () => {
    mockFetch([OPEN, CLOSED, FILLED]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // Default view hides the closed req (Show closed is off).
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();

    // Explicitly filter to "closed" via the dropdown — the chip stays OFF.
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'closed' },
    });
    // The closed req now surfaces; the explicit status is authoritative, so the
    // active + filled rows are excluded (by the status filter, not hidden).
    expect(screen.getByText('Junior Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
    expect(screen.queryByText('Architect')).not.toBeInTheDocument();

    // "full" is also a terminal status (the surprising one) — it works too.
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'full' },
    });
    expect(screen.getByText('Architect')).toBeInTheDocument();
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();
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
    mockFetch([OPEN, HOLD]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: 'My reqs' }),
    ).toHaveAttribute('aria-pressed', 'true');
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
    await waitFor(() => expect(screen.getByText('My Req')).toBeInTheDocument());
    expect(screen.queryByText('Their Req')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Their Req')).toBeInTheDocument();
  });

  it('"Needs sourcing" filters to active reqs with an empty pipeline', async () => {
    mockFetch([OPEN]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Needs sourcing' }));
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
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

  // ── PR-REQ rulings ──

  it('R2: Talent stat block shows total in pipeline + Submitted + Interview from one /v1/pipelines call', async () => {
    const REQ = makeReq('req-r', 'Platform Engineer', 'active', {
      recruiter_id: 'usr-1',
    });
    mockEndpoints({
      reqs: [REQ],
      companies: [{ id: 'co-1', name: 'Northwind' }],
      roster: [{ user_id: 'usr-1', display_name: 'Priya Recruiter' }],
      pipelines: [
        { id: 'p1', requisition_id: 'req-r', status: 'no_contact' }, // sourced
        { id: 'p2', requisition_id: 'req-r', status: 'submitted' }, // submitted
        { id: 'p3', requisition_id: 'req-r', status: 'interviewing' }, // interview
        { id: 'p4', requisition_id: 'req-r', status: 'placed' }, // placed
      ],
    });
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Platform Engineer')).toBeInTheDocument(),
    );
    // Recruiter resolves via the roster; the owner cell is avatar-only (mockup
    // parity), so the resolved name is carried on the cell's title tooltip.
    await waitFor(() =>
      expect(screen.getByTitle('Priya Recruiter')).toBeInTheDocument(),
    );
    expect(screen.getByText('In pipeline')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Interview')).toBeInTheDocument();
    // total in pipeline = 4 (every entry) → appears in the stat block AND the
    // distribution-bar total.
    expect(screen.getAllByText('4').length).toBeGreaterThanOrEqual(2);
  });

  it('R1: NO Match/Matches affordance on the list surface (reserved seam is detail-only)', async () => {
    mockFetch([OPEN, HOT]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // No disabled "Matches" filter chip, no per-row "AI matching" seam, no
    // "coming with Aramo Core" copy — Match/Matches lives only on the detail.
    expect(screen.queryByText(/coming with Aramo Core/i)).toBeNull();
    expect(screen.queryByText(/AI matching/i)).toBeNull();
    expect(
      screen.queryByRole('button', { name: /match/i }),
    ).toBeNull();
  });

  it('R4: the identity sub-line renders external_req_id when present and reads cleanly when absent', async () => {
    const WITH = makeReq('req-w', 'With Code', 'active', {
      external_req_id: 'VMS-9',
    });
    mockEndpoints({
      reqs: [WITH],
      companies: [{ id: 'co-1', name: 'Northwind' }],
    });
    const { unmount } = renderList();
    const withTitle = await screen.findByRole('link', { name: 'With Code' });
    // Scope to the requisition cell's sub-line (company name also appears in
    // the client-filter <option>, so a global getByText would be ambiguous).
    const withSub = withTitle
      .closest('.rc-rt__req')
      ?.querySelector('.rc-rt__sub');
    expect(withSub?.textContent).toContain('VMS-9');
    expect(withSub?.textContent).toContain('Northwind');
    unmount();
    vi.restoreAllMocks();

    // Absent (the common case for a manually-created req): the sub-line still
    // renders the company with NO dangling leading separator.
    const WITHOUT = makeReq('req-x', 'No Code', 'active');
    mockEndpoints({
      reqs: [WITHOUT],
      companies: [{ id: 'co-1', name: 'Northwind' }],
    });
    renderList();
    const title = await screen.findByRole('link', { name: 'No Code' });
    expect(screen.queryByText('null')).toBeNull();
    const sub = title.closest('.rc-rt__req')?.querySelector('.rc-rt__sub');
    expect(sub?.textContent ?? '').toContain('Northwind');
    expect((sub?.textContent ?? '').trim().startsWith('·')).toBe(false);
  });

  it('R5: the summary line uses only real enum values (active / on hold / closed), no derived "open"', async () => {
    mockFetch([OPEN, HOLD, CLOSED]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('1 active · 1 on hold · 1 closed'),
    ).toBeInTheDocument();
  });

  it('shows the real 6-value status pill (On hold renders, not collapsed to a 3-bucket)', async () => {
    mockFetch([HOLD]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Mid Engineer')).toBeInTheDocument(),
    );
    // The status PILL (the status-filter <option> also carries the label).
    expect(
      screen.getByText('On hold', { selector: '.rc-pill' }),
    ).toBeInTheDocument();
  });

  it('shows the unassigned state in the owner cell and offers no reassign action', async () => {
    mockFetch([OPEN]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // Owner cell is avatar-only (mockup parity); the unassigned state is carried
    // on the cell's title tooltip, and there is no reassign affordance.
    expect(screen.getByTitle('Unassigned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /assign/i })).toBeNull();
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
