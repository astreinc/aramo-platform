import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RequisitionsListView } from './RequisitionsListView';
import type { RecruitingStatus, RequisitionView } from './types';

function makeReq(
  id: string,
  title: string,
  status: RecruitingStatus,
  extra: Partial<RequisitionView> = {},
): RequisitionView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    title,
    requisition_number: 1000,
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
    capacity_balance: 1,
    client_submittal_status: null,
    client_submittal_reason: null,
    start_date: null,
    city: null,
    state: null,
    recruiter_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    version: 0, // T1-e — read-then-write concurrency token
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

const OPEN = makeReq('req-open', 'Senior Engineer', 'open');
const HOLD = makeReq('req-hold', 'Mid Engineer', 'on_hold');
const CLOSED = makeReq('req-closed', 'Junior Engineer', 'closed');
const FILLED = makeReq('req-filled', 'Architect', 'submittals_closed');
const HOT = makeReq('req-hot', 'Hot Role', 'open', { is_hot: true });

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
  pipelines?: ReadonlyArray<{ id: string; requisition_id: string; status: string; talent_record_id?: string }>;
  roster?: ReadonlyArray<{ user_id: string; display_name: string }>;
}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const body = url.includes('/v1/pipelines')
      ? // E6 Q-4 — the rollup collapses by (talent, req); real /v1/pipelines always
        // carries talent_record_id. Default each mock entry to a DISTINCT talent
        // (its unique id) so entries stay distinct people unless a test sets it.
        { items: (opts.pipelines ?? []).map((p) => ({ talent_record_id: p.id, ...p })) }
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

  it('L8-B2: Client Status renders the authoritative tri-state (null ⇒ Open, never Unknown); Pipeline is its own column', async () => {
    mockFetch([
      makeReq('r-open', 'Open Req', 'open', { client_submittal_status: 'open', client_submittal_reason: null }),
      makeReq('r-paused', 'Paused Req', 'open', { client_submittal_status: 'paused', client_submittal_reason: 'manual_hold' }),
      makeReq('r-closed', 'Closed Req', 'open', { client_submittal_status: 'closed', client_submittal_reason: 'limit_reached' }),
      makeReq('r-null', 'Default Req', 'open', { client_submittal_status: null, client_submittal_reason: null }),
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText('Closed Req')).toBeInTheDocument());

    // Three distinct columns — Pipeline, Capacity, Client Status.
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
    expect(screen.getByText('Capacity')).toBeInTheDocument();
    expect(screen.getByText('Client Status')).toBeInTheDocument();

    // Authoritative chips; a null status renders Open (R-DEFAULT-OPEN), never "Unknown".
    const has = (c: string) =>
      Array.from(document.querySelectorAll('.rc-cs')).filter((el) => el.classList.contains(c));
    expect(has('rc-cs--closed')).toHaveLength(1);
    expect(has('rc-cs--paused')).toHaveLength(1);
    expect(has('rc-cs--open')).toHaveLength(2); // explicit open + null-default
    expect(screen.queryByText('Unknown')).not.toBeInTheDocument();

    // Pipeline column restored as its own cell (one distribution bar per requisition).
    expect(document.querySelectorAll('.rc-rt__pipe')).toHaveLength(4);
  });

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

  it('D1-a: selecting a terminal status in the dropdown reveals those reqs (closed hidden by default)', async () => {
    mockFetch([OPEN, CLOSED, FILLED]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // Default view hides the closed req.
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();

    // Explicitly filter to "closed" via the dropdown — it is authoritative.
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'closed' },
    });
    // The closed req now surfaces; the explicit status is authoritative, so the
    // active + filled rows are excluded (by the status filter, not hidden).
    expect(screen.getByText('Junior Engineer')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
    expect(screen.queryByText('Architect')).not.toBeInTheDocument();

    // "submittals_closed" (the former "full") is also a terminal status (the
    // surprising one) — it works too.
    fireEvent.change(screen.getByLabelText('Filter by status'), {
      target: { value: 'submittals_closed' },
    });
    expect(screen.getByText('Architect')).toBeInTheDocument();
    expect(screen.queryByText('Junior Engineer')).not.toBeInTheDocument();
  });

  it('"Priority" filters to is_hot requisitions', async () => {
    mockFetch([OPEN, HOT]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    // The recruiter-facing label is "Priority" (the underlying is_hot flag and
    // internal 'hot' filter mode are unchanged).
    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    expect(screen.getByText('Hot Role')).toBeInTheDocument();
    expect(screen.queryByText('Senior Engineer')).not.toBeInTheDocument();
  });

  it('the Owner dropdown narrows to owned/recruited rows (Me) for a read:all principal', async () => {
    const MINE = makeReq('req-mine', 'My Req', 'open', { owner_id: 'u1' });
    const THEIRS = makeReq('req-theirs', 'Their Req', 'open', {
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
    // Default (Owner: Any) shows both.
    await waitFor(() => expect(screen.getByText('My Req')).toBeInTheDocument());
    expect(screen.getByText('Their Req')).toBeInTheDocument();
    // Owner: Me narrows to owned/recruited rows.
    fireEvent.change(screen.getByLabelText('Filter by owner'), {
      target: { value: 'me' },
    });
    expect(screen.getByText('My Req')).toBeInTheDocument();
    expect(screen.queryByText('Their Req')).not.toBeInTheDocument();
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

  // P2-A (REQ-PIXEL-PARITY-1-A2) — inline talent-preview expander (truthful:
  // real pipeline rows, name from the talent SOR, stage from status, NEW from
  // created_at). No source/next-step (P2-D).
  it('opens an inline talent preview on row click (name · stage · NEW) and toggles', async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const body = url.includes('/v1/pipelines')
        ? {
            items: [
              {
                id: 'pl-1',
                tenant_id: 't',
                site_id: null,
                talent_record_id: 'tal-1',
                requisition_id: 'req-open',
                status: 'submitted',
                created_at: recent,
                updated_at: recent,
              },
            ],
          }
        : url.includes('/v1/talent-records/tal-1')
          ? { id: 'tal-1', first_name: 'Sarah', last_name: 'Nolan' }
          : url.includes('/v1/requisitions')
            ? { items: [OPEN] }
            : { items: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    renderList();
    const title = await screen.findByText('Senior Engineer');
    // Collapsed by default.
    expect(
      screen.queryByText('Talent on this requisition'),
    ).not.toBeInTheDocument();
    // Click the row (not the title link) → expands with real data.
    const article = title.closest('article') as Element;
    fireEvent.click(article);
    expect(screen.getByText('Talent on this requisition')).toBeInTheDocument();
    expect(await screen.findByText('Sarah Nolan')).toBeInTheDocument();
    expect(
      screen.getByText('Submitted', { selector: '.rc-tcard__stage' }),
    ).toBeInTheDocument();
    // Derived Next Action for the 'submitted' stage.
    expect(screen.getByText('Await client feedback')).toBeInTheDocument();
    expect(screen.getByText('NEW')).toBeInTheDocument();
    // The talent card is a button that opens the slide-in detail panel.
    const talentCard = screen
      .getByText('Sarah Nolan')
      .closest('button') as HTMLButtonElement;
    fireEvent.click(talentCard);
    expect(
      screen.getByRole('dialog', { name: /talent detail/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Workflow status')).toBeInTheDocument();
    // Close the panel before asserting the expander collapse.
    fireEvent.click(screen.getByLabelText('Close'));
    // Click again collapses.
    fireEvent.click(article);
    expect(
      screen.queryByText('Talent on this requisition'),
    ).not.toBeInTheDocument();
  });

  // The user's loop: an empty extender contact cell → edit in the SIDE PANEL →
  // the read-only extender cell reflects the just-entered value (propagation),
  // while the extender itself remains READ-ONLY (no editors in it).
  it('a panel talent-field save propagates to the read-only extender cell (no editor in the extender)', async () => {
    const patches: Array<{ url: string; body: unknown }> = [];
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      const method = init?.method ?? 'GET';
      if (url.includes('/v1/talent-records/tal-1') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        patches.push({ url, body });
        return json({ id: 'tal-1', first_name: 'Sarah', last_name: 'Nolan', ...body });
      }
      const body = url.includes('/v1/pipelines')
        ? {
            items: [
              {
                id: 'pl-1', tenant_id: 't', site_id: null, talent_record_id: 'tal-1',
                requisition_id: 'req-open', status: 'submitted',
                created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
                // No email enrichment → the extender cell shows "—" until edited.
              },
            ],
          }
        : url.includes('/v1/talent-records/tal-1')
          ? { id: 'tal-1', first_name: 'Sarah', last_name: 'Nolan' }
          : url.includes('/v1/requisitions')
            ? { items: [OPEN] }
            : { items: [] };
      return json(body);
    });

    render(
      <ToastProvider>
        <MemoryRouter>
          <RequisitionsListView
            sessionOverride={{
              sub: 'u1', consumer_type: 'recruiter', tenant_id: 't',
              scopes: ['requisition:read', 'talent:edit'], iat: 0, exp: 0,
            }}
          />
        </MemoryRouter>
      </ToastProvider>,
    );
    const title = await screen.findByText('Senior Engineer');
    fireEvent.click(title.closest('article') as Element); // expand
    const table = await screen.findByRole('table');
    // Extender is READ-ONLY: no inline "Edit …" affordances in the table.
    expect(within(table).queryByRole('button', { name: /^Edit / })).toBeNull();
    // Open the side panel and edit Email there.
    fireEvent.click((await screen.findByText('Sarah Nolan')).closest('button') as HTMLButtonElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Email' }));
    const input = screen.getByLabelText('Email') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'vinodhini@x.test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // The single-column PATCH fired…
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body).toEqual({ email1: 'vinodhini@x.test' });
    // …and the read-only extender cell now reflects the new value (propagation).
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() =>
      expect(
        within(screen.getByRole('table')).getByText('vinodhini@x.test'),
      ).toBeInTheDocument(),
    );
  });

  it('the ★ star click does not toggle the preview (stopPropagation)', async () => {
    mockFetch([OPEN]);
    renderList();
    await screen.findByText('Senior Engineer');
    fireEvent.click(screen.getByRole('button', { name: 'Bookmark' }));
    expect(
      screen.queryByText('Talent on this requisition'),
    ).not.toBeInTheDocument();
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
    const REQ = makeReq('req-r', 'Platform Engineer', 'open', {
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
    // total in pipeline = 4 (every entry) → shown as the stat block "In pipeline"
    // count. (The distribution bar was replaced by the Capacity cell.)
    const inPipeline = screen
      .getByText('In pipeline')
      .closest('.rc-stat')
      ?.querySelector('.num');
    expect(inPipeline?.textContent).toBe('4');
  });

  it('Capacity cell shows avail/openings + the derived state (Available / Fully consumed / Over capacity)', async () => {
    const AVAIL = makeReq('req-a', 'Has Capacity', 'open', {
      openings: 2,
      openings_available: 1,
      capacity_balance: 1,
    });
    const FULL = makeReq('req-f', 'Fully Consumed', 'open', {
      openings: 1,
      openings_available: 0,
      capacity_balance: 0,
    });
    const OVER = makeReq('req-o', 'Over Capacity', 'open', {
      openings: 2,
      openings_available: 0,
      capacity_balance: -1,
    });
    mockEndpoints({
      reqs: [AVAIL, FULL, OVER],
      companies: [{ id: 'co-1', name: 'Northwind' }],
    });
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Has Capacity')).toBeInTheDocument(),
    );
    // Positive balance → Available; 0 → Fully consumed; negative → Over capacity.
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Fully consumed')).toBeInTheDocument();
    expect(screen.getByText('Over capacity')).toBeInTheDocument();
    // The full phrasing rides the title tooltip — assert one unambiguous node.
    expect(
      screen.getByTitle('2 openings · 0 available · Over capacity'),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle('1 opening · 0 available · Fully consumed'),
    ).toBeInTheDocument();
  });

  it('R2b: stat counts are cumulative "reached" — a talent past a stage still counts toward it', async () => {
    // Regression: a talent currently at `offered` had already been Submitted and
    // Interviewed. The stat block must reflect that (Submitted:1, Interview:1) —
    // the earlier current-stage tally showed 0/0 the moment the talent advanced.
    const REQ = makeReq('req-c', 'Business Analyst Associate', 'open', {
      recruiter_id: 'usr-1',
    });
    mockEndpoints({
      reqs: [REQ],
      companies: [{ id: 'co-1', name: 'Northwind' }],
      roster: [{ user_id: 'usr-1', display_name: 'Priya Recruiter' }],
      pipelines: [
        { id: 'c1', requisition_id: 'req-c', status: 'contacted' }, // sourced — not reached
        { id: 'c2', requisition_id: 'req-c', status: 'offered' }, // reached submitted + interview
      ],
    });
    renderList();
    await waitFor(() =>
      expect(
        screen.getByText('Business Analyst Associate'),
      ).toBeInTheDocument(),
    );
    const numFor = (label: string): string | null =>
      screen
        .getByText(label, { selector: '.rc-stat__l' })
        .closest('.rc-stat')
        ?.querySelector('.num')?.textContent ?? null;
    // Cumulative: the `offered` talent counts toward BOTH earlier stages.
    expect(numFor('Submitted')).toBe('1');
    expect(numFor('Interview')).toBe('1');
    // `contacted` never reached submittal → excluded from both.
    expect(numFor('In pipeline')).toBe('2');
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
    const WITH = makeReq('req-w', 'With Code', 'open', {
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
    const WITHOUT = makeReq('req-x', 'No Code', 'open');
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

  it('the row sub-line leads with REQ-{requisition_number} (mono); external follows as secondary', async () => {
    // PR-15 self-consistency: the internal number is the PRIMARY id on the row,
    // exactly as on the detail header. It leads; external_req_id follows.
    const R = makeReq('req-n', 'Numbered', 'open', {
      requisition_number: 1042,
      external_req_id: 'VMS-9',
    });
    mockEndpoints({
      reqs: [R],
      companies: [{ id: 'co-1', name: 'Northwind' }],
    });
    renderList();
    const title = await screen.findByRole('link', { name: 'Numbered' });
    const sub = title.closest('.rc-rt__req')?.querySelector('.rc-rt__sub');
    const text = sub?.textContent ?? '';
    expect(text).toContain('REQ-1042');
    // Primary → it precedes the VMS id.
    expect(text.indexOf('REQ-1042')).toBeLessThan(text.indexOf('VMS-9'));
    // Rendered mono, matching the detail-header treatment.
    expect(sub?.querySelector('.mono')?.textContent).toContain('REQ-1042');
  });

  it('a manually-created req (no external id) still leads with REQ-{number}', async () => {
    const R = makeReq('req-m', 'Manual', 'open', {
      requisition_number: 1007,
      external_req_id: null,
    });
    mockEndpoints({
      reqs: [R],
      companies: [{ id: 'co-1', name: 'Northwind' }],
    });
    renderList();
    const title = await screen.findByRole('link', { name: 'Manual' });
    const sub = title.closest('.rc-rt__req')?.querySelector('.rc-rt__sub');
    expect(sub?.textContent ?? '').toContain('REQ-1007');
  });

  it('the is_hot badge is labelled "Priority" (not "Hot", not a star)', async () => {
    mockFetch([HOT]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Hot Role')).toBeInTheDocument(),
    );
    // Recruiter-facing team-wide priority signal — the row badge reads "Priority".
    expect(
      screen.getByText('Priority', { selector: '.rc-rt__hot' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Hot', { selector: '.rc-rt__hot' })).toBeNull();
  });

  it('R5: the summary line uses only real enum values (open / on hold / closed), no derived bucket', async () => {
    mockFetch([OPEN, HOLD, CLOSED]);
    renderList();
    await waitFor(() =>
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument(),
    );
    expect(
      screen.getByText('1 open · 1 on hold · 1 closed'),
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
