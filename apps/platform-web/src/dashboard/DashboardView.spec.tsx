import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type PlatformDashboard } from '../platform-api';

import { DashboardView } from './DashboardView';

// Inc-3 PR-3.8 (Workstream C) — the operator dashboard screen. First render test
// in platform-web. platformApi rides apiClient → fetch; we stub getDashboard
// directly. Covers: status tiles, onboarding rows + links + invited distinction,
// activity feed deep-links (?tab=lifecycle), honest empty states, and the error
// path.

const FULL: PlatformDashboard = {
  status_counts: [
    { status: 'PROVISIONED', count: 3 },
    { status: 'ACTIVE', count: 5 },
    { status: 'SUSPENDED', count: 1 },
    { status: 'OFFBOARDING', count: 0 },
    { status: 'CLOSED', count: 2 },
  ],
  onboarding: [
    {
      tenant_id: 't-old',
      name: 'Oldest Co',
      created_at: '2026-01-01T00:00:00.000Z',
      invited: true,
    },
    {
      tenant_id: 't-new',
      name: 'Newest Co',
      created_at: '2026-05-01T00:00:00.000Z',
      invited: false,
    },
  ],
  recent_activity: [
    {
      event_type: 'tenant.suspended',
      tenant_id: 't-susp',
      tenant_name: 'Suspended Co',
      actor_type: 'user',
      reason_code: 'ops_hold',
      created_at: '2026-06-10T00:00:00.000Z',
    },
  ],
};

const EMPTY: PlatformDashboard = {
  status_counts: [
    { status: 'PROVISIONED', count: 0 },
    { status: 'ACTIVE', count: 0 },
    { status: 'SUSPENDED', count: 0 },
    { status: 'OFFBOARDING', count: 0 },
    { status: 'CLOSED', count: 0 },
  ],
  onboarding: [],
  recent_activity: [],
};

function renderView() {
  return render(
    <MemoryRouter>
      <DashboardView />
    </MemoryRouter>,
  );
}

describe('DashboardView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders status-count tiles for every lifecycle status', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderView();

    const tiles = await screen.findByLabelText('Tenant status counts');
    for (const status of [
      'PROVISIONED',
      'ACTIVE',
      'SUSPENDED',
      'OFFBOARDING',
      'CLOSED',
    ]) {
      expect(within(tiles).getByText(status)).toBeInTheDocument();
    }
    // Counts are present (5 = ACTIVE, 0 = OFFBOARDING zero-fill).
    expect(within(tiles).getByText('5')).toBeInTheDocument();
    expect(within(tiles).getByText('3')).toBeInTheDocument();
    expect(within(tiles).getByText('0')).toBeInTheDocument();
  });

  it('lists onboarding tenants with detail links and the invited distinction', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderView();

    const oldest = await screen.findByRole('link', { name: 'Oldest Co' });
    expect(oldest).toHaveAttribute('href', '/tenants/t-old');
    expect(screen.getByRole('link', { name: 'Newest Co' })).toHaveAttribute(
      'href',
      '/tenants/t-new',
    );
    // Invited distinction visible.
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByText('Not yet invited')).toBeInTheDocument();
  });

  it('renders the activity feed deep-linking into the audit tab', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderView();

    const link = await screen.findByRole('link', { name: 'Suspended Co' });
    expect(link).toHaveAttribute('href', '/tenants/t-susp?tab=lifecycle');
    expect(screen.getByText('tenant.suspended')).toBeInTheDocument();
    expect(screen.getByText(/ops_hold/)).toBeInTheDocument();
  });

  it('shows honest empty states when the estate is quiet', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(EMPTY);
    renderView();

    expect(
      await screen.findByText('No tenants are waiting to onboard.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('No recent lifecycle activity.'),
    ).toBeInTheDocument();
  });

  it('surfaces a load error', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockRejectedValue(new Error('boom'));
    renderView();

    await waitFor(() =>
      expect(
        screen.getByText('Failed to load the dashboard.'),
      ).toBeInTheDocument(),
    );
  });
});
