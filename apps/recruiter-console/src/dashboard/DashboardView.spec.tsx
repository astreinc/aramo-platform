import type { Session } from '@aramo/fe-foundation';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardView } from './DashboardView';
import type { DashboardView as DashboardViewModel } from './types';

const SESSION: Session = {
  sub: 'u-1',
  consumer_type: 'recruiter',
  tenant_id: 't',
  scopes: ['dashboard:read', 'task:read'],
  iat: 0,
  exp: 0,
};

// A calendar event today at 14:00, owned by the principal — for the agenda.
function eventToday() {
  const d = new Date();
  d.setHours(14, 0, 0, 0);
  return {
    id: 'cal-1',
    tenant_id: 't',
    site_id: null,
    owner_id: 'u-1',
    type: 'interview' as const,
    title: 'Panel — Sofia Reyes',
    description: null,
    starts_at: d.toISOString(),
    ends_at: null,
    all_day: false,
    created_at: d.toISOString(),
    updated_at: d.toISOString(),
  };
}

function makeDashboard(
  overrides: Partial<DashboardViewModel> = {},
): DashboardViewModel {
  return {
    tenant_counts: {
      companies: 12,
      contacts: 34,
      talent_records: 56,
      saved_lists: 7,
      calendar_events: 8,
      activities: 90,
    },
    requisition_rollup: { total: 6, by_status: [] },
    pipeline_rollup: { total: 15, by_status: [] },
    placement: { placed_pipelines: 3, includes_core_submittal_placements: false },
    upcoming_events: [],
    recent_activity: [
      {
        id: 'act-1',
        tenant_id: 't',
        site_id: null,
        type: 'note',
        subject_type: 'requisition',
        subject_id: 'req-1',
        notes: 'Checked in with the hiring manager.',
        created_by_id: 'u-1',
        created_at: '2026-06-11T09:00:00Z',
      },
    ],
    ...overrides,
  };
}

const REQS = {
  items: [
    {
      id: 'req-1',
      title: 'Senior Rust Engineer',
      company_id: 'co-1',
      external_req_id: 'REQ-2041',
      status: 'active',
      is_hot: true,
      openings: 3,
      openings_available: 2,
      created_at: '2026-05-30T09:00:00Z',
    },
    {
      id: 'req-2',
      title: 'Data Platform Lead',
      company_id: 'co-2',
      external_req_id: 'REQ-2038',
      status: 'closed',
      is_hot: false,
      openings: 1,
      openings_available: 0,
      created_at: '2026-06-01T09:00:00Z',
    },
  ],
};

const TASKS = {
  items: [
    {
      id: 'task-1',
      title: 'Send references to D. Okafor',
      description: null,
      due_date: '2020-01-01T00:00:00Z', // past → overdue
      status: 'open',
      assignee_id: 'me',
      created_by_user_id: 'u-1',
      owner_type: 'requisition',
      owner_id: 'req-1',
      created_at: '2026-06-10T09:00:00Z',
      updated_at: '2026-06-10T09:00:00Z',
    },
  ],
};

const COMPANIES = {
  items: [
    { id: 'co-1', name: 'Northwind Robotics' },
    { id: 'co-2', name: 'Cobalt Health' },
  ],
};

const PIPELINES = {
  items: [
    { id: 'p1', requisition_id: 'req-1', status: 'no_contact' },
    { id: 'p2', requisition_id: 'req-1', status: 'submitted' },
    { id: 'p3', requisition_id: 'req-1', status: 'interviewing' },
  ],
};

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function mockRoutes(opts: {
  dashboard?: unknown;
  dashboardStatus?: number;
  reqs?: unknown;
  tasks?: unknown;
  companies?: unknown;
  pipelines?: unknown;
} = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = urlOf(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (url.includes('/v1/dashboard')) {
      return json(opts.dashboard ?? makeDashboard(), opts.dashboardStatus ?? 200);
    }
    if (url.includes('/v1/pipelines')) return json(opts.pipelines ?? PIPELINES);
    if (url.includes('/v1/requisitions')) return json(opts.reqs ?? REQS);
    if (url.includes('/v1/tasks')) return json(opts.tasks ?? TASKS);
    if (url.includes('/v1/companies')) return json(opts.companies ?? COMPANIES);
    return json({ message: 'not found' }, 404);
  });
}

function renderDesk() {
  return render(
    <MemoryRouter>
      <DashboardView session={SESSION} />
    </MemoryRouter>,
  );
}

describe('DashboardView (My desk)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the backed metric cards (no deltas/goals — gap #6)', async () => {
    mockRoutes();
    const { container } = renderDesk();
    await waitFor(() => expect(screen.getByText('Open reqs')).toBeInTheDocument());
    // Open reqs = 1 (req-2 is closed); Talent 56; In pipeline 15; Placements 3.
    // Scope each value to its metric card — a bare getByText('15') would collide
    // with a date-dependent "days open" cell in the my-open-reqs table.
    const metric = (label: string) => {
      const card = screen.getByText(label).closest('.rc-metric');
      if (card === null) throw new Error(`no metric card for ${label}`);
      return within(card as HTMLElement);
    };
    expect(metric('Talent').getByText('56')).toBeInTheDocument();
    expect(metric('In pipeline').getByText('15')).toBeInTheDocument();
    expect(metric('Open reqs').getByText('1 hot')).toBeInTheDocument();
    expect(screen.getByText('Placements')).toBeInTheDocument();
    // No fabricated delta windows.
    expect(container.textContent).not.toMatch(/this week|MTD|\+\d/);
  });

  it('lists only OPEN reqs in the table, with the company name resolved (gap #8)', async () => {
    mockRoutes();
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Senior Rust Engineer')).toBeInTheDocument(),
    );
    // company_id resolved to a name — never a raw UUID.
    expect(screen.getByText(/Northwind Robotics · REQ-2041/)).toBeInTheDocument();
    // The closed req is filtered out of "my open reqs".
    expect(screen.queryByText('Data Platform Lead')).not.toBeInTheDocument();
    // The req title is a real link to the detail route.
    expect(screen.getByRole('link', { name: /Senior Rust Engineer/ })).toHaveAttribute(
      'href',
      '/requisitions/req-1',
    );
  });

  it('parity: my-open-reqs table shows Pipeline/Submitted counts (one /v1/pipelines call)', async () => {
    mockRoutes();
    const { container } = renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Senior Rust Engineer')).toBeInTheDocument(),
    );
    // The header columns replaced Openings with Pipeline + Submitted. Scope to
    // the reqs card — "Submitted" is also a funnel-bucket label on the desk.
    const reqCard = screen.getByText('My open reqs').closest('.rc-card') as HTMLElement;
    expect(within(reqCard).getByText('Pipeline')).toBeInTheDocument();
    expect(within(reqCard).getByText('Submitted')).toBeInTheDocument();
    // req-1 rollup: active = 3 (no terminal), submitted+ = 2 (submitted +
    // interviewing). Scope to the req row to avoid colliding with the metrics.
    const row = screen.getByRole('link', { name: /Senior Rust Engineer/ })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    // No fabricated delta windows leaked in.
    expect(container.textContent).not.toMatch(/this week|MTD|\+\d/);
  });

  it('aggregates my open tasks into "Needs you today" (overdue marked)', async () => {
    mockRoutes();
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Send references to D. Okafor')).toBeInTheDocument(),
    );
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/requisitions/req-1',
    );
  });

  it('renders the recent-activity feed', async () => {
    mockRoutes();
    renderDesk();
    await waitFor(() =>
      expect(
        screen.getByText('Checked in with the hiring manager.'),
      ).toBeInTheDocument(),
    );
  });

  it('shows honest empty states when there is nothing to do', async () => {
    mockRoutes({
      reqs: { items: [] },
      tasks: { items: [] },
      dashboard: makeDashboard({ recent_activity: [] }),
    });
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument(),
    );
    expect(screen.getByText('No open requisitions in your view.')).toBeInTheDocument();
    expect(screen.getByText('No recent activity.')).toBeInTheDocument();
  });

  it('degrades gracefully when tasks/companies 403 (only dashboard is the spine)', async () => {
    // tasks + companies reject (403); dashboard + reqs succeed.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = urlOf(input);
      const json = (b: unknown, s = 200) =>
        new Response(JSON.stringify(b), {
          status: s,
          headers: { 'Content-Type': 'application/json' },
        });
      if (url.includes('/v1/dashboard')) return json(makeDashboard());
      if (url.includes('/v1/requisitions')) return json(REQS);
      if (url.includes('/v1/tasks')) return json({ message: 'forbidden' }, 403);
      if (url.includes('/v1/companies')) return json({ message: 'forbidden' }, 403);
      return json({}, 404);
    });
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Senior Rust Engineer')).toBeInTheDocument(),
    );
    // No company name (unresolved) but never a UUID, and the page is coherent.
    expect(screen.getByText('Nothing needs you right now.')).toBeInTheDocument();
    expect(screen.queryByText(/co-1/)).not.toBeInTheDocument();
  });

  it('surfaces a server error when the dashboard call fails', async () => {
    mockRoutes({ dashboardStatus: 500, dashboard: { message: 'boom' } });
    renderDesk();
    await waitFor(() =>
      expect(
        screen.getByText(/dashboard service is temporarily unavailable/i),
      ).toBeInTheDocument(),
    );
  });

  it('shows a FACTS-ONLY briefing (real counts, no verdict/AI/focus)', async () => {
    mockRoutes();
    const { container } = renderDesk();
    await waitFor(() => expect(screen.getByText('Open reqs')).toBeInTheDocument());
    // 1 overdue task (due 2020) + 1 hot req (req-1) — deterministic counts.
    expect(screen.getByText('task overdue')).toBeInTheDocument();
    expect(screen.getByText('hot requisition')).toBeInTheDocument();
    // No prescriptive/AI framing survived the charter §3 removals.
    expect(container.textContent).not.toMatch(
      /AI-assisted|Suggested focus|Viewing as/i,
    );
  });

  it('renders "My active pipeline" funnel from the backed rollup', async () => {
    mockRoutes({
      dashboard: makeDashboard({
        pipeline_rollup: {
          total: 4,
          by_status: [
            { status: 'no_contact', count: 2 },
            { status: 'submitted', count: 1 },
            { status: 'placed', count: 1 },
          ],
        },
      }),
    });
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('My active pipeline')).toBeInTheDocument(),
    );
    // Sourced bucket = no_contact (2); Placed = 1. Scope to the funnel card.
    const card = screen
      .getByText('My active pipeline')
      .closest('.rc-card') as HTMLElement;
    const stage = (label: string) =>
      within(card).getByText(label).closest('.rc-fstage') as HTMLElement;
    expect(within(stage('Sourced')).getByText('2')).toBeInTheDocument();
    expect(within(stage('Placed')).getByText('1')).toBeInTheDocument();
  });

  it('lists only TODAY’s agenda items owned by the principal', async () => {
    mockRoutes({
      dashboard: makeDashboard({ upcoming_events: [eventToday()] }),
    });
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Panel — Sofia Reyes')).toBeInTheDocument(),
    );
  });

  it('hides agenda items owned by another user (my desk only)', async () => {
    const other = { ...eventToday(), id: 'cal-2', owner_id: 'someone-else' };
    mockRoutes({ dashboard: makeDashboard({ upcoming_events: [other] }) });
    renderDesk();
    await waitFor(() =>
      expect(screen.getByText('Nothing scheduled today.')).toBeInTheDocument(),
    );
    expect(screen.queryByText('Panel — Sofia Reyes')).not.toBeInTheDocument();
  });

  it('priority-sorts the queue and gives a consent task a Refresh action', async () => {
    mockRoutes({
      tasks: {
        items: [
          {
            id: 'low-1',
            title: 'Low priority admin',
            description: null,
            due_date: null,
            status: 'open',
            type: 'admin',
            priority: 'low',
            source: 'manual',
            assignee_id: 'me',
            created_by_user_id: 'u-1',
            owner_type: 'requisition',
            owner_id: 'req-9',
            created_at: '2026-06-10T09:00:00Z',
            updated_at: '2026-06-10T09:00:00Z',
          },
          {
            id: 'high-1',
            title: 'Refresh consent for D. Okafor',
            description: null,
            due_date: null,
            status: 'open',
            type: 'consent',
            priority: 'high',
            source: 'manual',
            assignee_id: 'me',
            created_by_user_id: 'u-1',
            owner_type: 'talent_record',
            owner_id: 'tal-1',
            created_at: '2026-06-10T09:00:00Z',
            updated_at: '2026-06-10T09:00:00Z',
          },
        ],
      },
    });
    const { container } = renderDesk();
    await waitFor(() =>
      expect(
        screen.getByText('Refresh consent for D. Okafor'),
      ).toBeInTheDocument(),
    );
    // High priority sorts above low.
    const rows = container.querySelectorAll('.rc-action');
    expect(rows[0]).toHaveTextContent('Refresh consent for D. Okafor');
    expect(rows[1]).toHaveTextContent('Low priority admin');
    // Consent task → "Refresh" action linking to the talent owner.
    expect(screen.getByRole('link', { name: 'Refresh' })).toHaveAttribute(
      'href',
      '/talent/tal-1',
    );
    // The consent badge is shown.
    expect(screen.getByText('Consent')).toBeInTheDocument();
  });
});
