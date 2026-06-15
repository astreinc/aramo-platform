import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DashboardView } from './DashboardView';
import type { DashboardView as DashboardViewModel } from './types';

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
      <DashboardView />
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
    // The header columns replaced Openings with Pipeline + Submitted.
    expect(screen.getByText('Pipeline')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
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
});
