import { render, screen, waitFor } from '@testing-library/react';
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
    requisition_rollup: {
      total: 6,
      by_status: [
        { status: 'active', count: 4 },
        { status: 'on_hold', count: 1 },
        { status: 'closed', count: 1 },
      ],
    },
    pipeline_rollup: {
      total: 15,
      by_status: [
        { status: 'contacted', count: 5 },
        { status: 'qualifying', count: 4 },
        { status: 'submitted', count: 3 },
        { status: 'placed', count: 3 },
      ],
    },
    placement: {
      placed_pipelines: 3,
      includes_core_submittal_placements: false,
    },
    upcoming_events: [
      {
        id: 'evt-1',
        tenant_id: 't',
        site_id: null,
        owner_id: 'u-1',
        type: 'meeting',
        title: 'Sync with Acme',
        description: null,
        starts_at: '2026-06-10T15:00:00Z',
        ends_at: null,
        all_day: false,
        created_at: '2026-06-09T10:00:00Z',
        updated_at: '2026-06-09T10:00:00Z',
      },
    ],
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
        created_at: '2026-06-09T09:00:00Z',
      },
    ],
    ...overrides,
  };
}

function mockFetchOk(body: unknown) {
  // R5 — per-call fresh Response (Response bodies are read-once);
  // mockImplementation NOT mockResolvedValue. Both the session probe
  // and the dashboard call share this mock.
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function mockFetchError(status: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ message: 'failure' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function renderInRouter() {
  return render(
    <MemoryRouter>
      <DashboardView />
    </MemoryRouter>,
  );
}

describe('DashboardView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the 6 tenant_counts as stat cards', async () => {
    mockFetchOk(makeDashboard());
    renderInRouter();
    // R5-corrected — wait on a POST-FETCH signal (a stat number) FIRST,
    // then assert the always-present chrome.
    await waitFor(() => {
      // Talent records count.
      expect(screen.getByText('56')).toBeInTheDocument();
    });
    expect(
      screen.getByRole('heading', { name: 'Dashboard' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Companies')).toBeInTheDocument();
    expect(screen.getByText('Contacts')).toBeInTheDocument();
    expect(screen.getByText('Talent records')).toBeInTheDocument();
    expect(screen.getByText('Saved lists')).toBeInTheDocument();
    expect(screen.getByText('Calendar events')).toBeInTheDocument();
    expect(screen.getByText('Activities')).toBeInTheDocument();
  });

  it('renders the requisition + pipeline rollups by status', async () => {
    mockFetchOk(makeDashboard());
    renderInRouter();
    await waitFor(() => {
      expect(screen.getByText('Requisitions')).toBeInTheDocument();
    });
    // Total counts visible (the requisitions rollup total is 6).
    const sixes = screen.getAllByText('6');
    expect(sixes.length).toBeGreaterThan(0);
    // Status labels rendered.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('On hold')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    // Pipeline statuses rendered.
    expect(screen.getByText('Contacted')).toBeInTheDocument();
    expect(screen.getByText('Qualifying')).toBeInTheDocument();
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByText('Placed')).toBeInTheDocument();
  });

  it('Ruling A — renders the placed count but NOT the includes_core_submittal_placements boolean', async () => {
    mockFetchOk(makeDashboard());
    const { container } = renderInRouter();
    await waitFor(() => {
      expect(screen.getByText('Placements')).toBeInTheDocument();
    });
    // The placed count is rendered (value 3 appears for the StatCard).
    // The literal-false boolean key is NOT rendered anywhere.
    expect(container.textContent).not.toContain(
      'includes_core_submittal_placements',
    );
    expect(container.textContent).not.toContain('excludes Core');
    expect(container.textContent).not.toContain('Core submittal');
  });

  it('renders upcoming events from the response', async () => {
    mockFetchOk(makeDashboard());
    renderInRouter();
    await waitFor(() => {
      expect(screen.getByText('Sync with Acme')).toBeInTheDocument();
    });
    // Event type label.
    expect(screen.getByText('Meeting')).toBeInTheDocument();
  });

  it('renders recent activity from the response', async () => {
    mockFetchOk(makeDashboard());
    renderInRouter();
    await waitFor(() => {
      expect(
        screen.getByText('Checked in with the hiring manager.'),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Note')).toBeInTheDocument();
  });

  it('empty upcoming + recent lists surface foundation Table empty messages', async () => {
    mockFetchOk(
      makeDashboard({
        upcoming_events: [],
        recent_activity: [],
      }),
    );
    renderInRouter();
    await waitFor(() => {
      // The first stat card value confirms post-fetch render before
      // we look for the empty-message strings.
      expect(screen.getByText('Companies')).toBeInTheDocument();
    });
    expect(screen.getByText('No upcoming events.')).toBeInTheDocument();
    expect(screen.getByText('No recent activity.')).toBeInTheDocument();
  });

  it('surfaces a server error via InlineAlert', async () => {
    mockFetchError(500);
    renderInRouter();
    await waitFor(() => {
      expect(
        screen.getByText(/dashboard service is temporarily unavailable/i),
      ).toBeInTheDocument();
    });
  });

  it('does NOT render any client-side limitation banner (visibility is server-side)', async () => {
    mockFetchOk(makeDashboard());
    const { container } = renderInRouter();
    await waitFor(() => {
      expect(screen.getByText('Companies')).toBeInTheDocument();
    });
    // No "some items may not be shown" / "limited view" banner. The
    // rollup numbers ARE the visibility-scoped truth (R2 posture).
    expect(container.textContent).not.toMatch(/some.*not be shown/i);
    expect(container.textContent).not.toMatch(/limited view/i);
    expect(container.textContent).not.toMatch(/your view is restricted/i);
  });
});
