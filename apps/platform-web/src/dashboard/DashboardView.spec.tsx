import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type PlatformDashboard } from '../platform-api';
import { ALL_TENANT_SCOPES, READ_ONLY_TENANT, renderAt, tenantSession } from '../tenants/test-utils';

import { DashboardView } from './DashboardView';

// PLATFORM-UX-1 F-3 (handoff §5; directive R-19) — tiles open the filtered list,
// the funnel's invite action is gated on :provision, the activity feed uses
// human labels, per-panel states (skeleton, error + Try again, empty), the
// Refreshed clock, and no rating metric anywhere.

const FULL: PlatformDashboard = {
  status_counts: [
    { status: 'PROVISIONED', count: 3 },
    { status: 'ACTIVE', count: 5 },
    { status: 'SUSPENDED', count: 1 },
    { status: 'OFFBOARDING', count: 0 },
    { status: 'CLOSED', count: 2 },
  ],
  onboarding: [
    { tenant_id: 't-old', name: 'Oldest Co', created_at: '2026-01-01T00:00:00.000Z', invited: true },
    { tenant_id: 't-new', name: 'Newest Co', created_at: '2026-05-01T00:00:00.000Z', invited: false },
  ],
  recent_activity: [
    {
      event_type: 'tenant.suspended',
      tenant_id: 't-susp',
      tenant_name: 'Suspended Co',
      actor_type: 'user',
      reason_code: 'payment_overdue',
      created_at: '2026-06-10T00:00:00.000Z',
    },
    {
      event_type: 'tenant.offboarding_started',
      tenant_id: 't-off',
      tenant_name: 'Leaving Co',
      actor_type: 'system',
      reason_code: null,
      created_at: '2026-06-09T00:00:00.000Z',
    },
  ],
};

const EMPTY: PlatformDashboard = {
  status_counts: FULL.status_counts.map((c) => ({ ...c, count: 0 })),
  onboarding: [],
  recent_activity: [],
};

const renderDash = (scopes = ALL_TENANT_SCOPES) =>
  renderAt(<DashboardView session={tenantSession(scopes)} />, { path: '/', url: '/', session: tenantSession(scopes) });

describe('DashboardView', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders skeletons per panel while loading', () => {
    vi.spyOn(platformApi, 'getDashboard').mockReturnValue(new Promise(() => undefined));
    renderDash();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /^Active/ })).toBeInTheDocument();
  });

  it('shows the counts as tiles that open /tenants?status=X', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderDash();
    const tile = await screen.findByRole('button', { name: /^Provisioned/ });
    expect(within(tile).getByText('3')).toBeInTheDocument();
    expect(within(tile).getByText('View tenants →')).toBeInTheDocument();
    fireEvent.click(tile);
    expect(screen.getByTestId('location')).toHaveTextContent('/tenants?status=PROVISIONED');
  });

  it('shows the funnel with the invite action gated on :provision', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    const resend = vi.spyOn(platformApi, 'resendOwnerInvite').mockResolvedValue({
      tenant_id: 't-new',
      owner_user_id: 'u',
      owner_email: 'o@x.com',
      resent: true,
    });
    renderDash();
    expect(await screen.findByRole('link', { name: 'Oldest Co' })).toHaveAttribute('href', '/tenants/t-old');
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByText('Not yet invited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend invite' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(resend).toHaveBeenCalledWith('t-new'));
    expect(await screen.findByText('Owner invite sent to Newest Co.')).toBeInTheDocument();
  });

  it('hides the invite action without :provision', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderDash(READ_ONLY_TENANT);
    await screen.findByRole('link', { name: 'Oldest Co' });
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
  });

  it('labels the activity feed in human words and deep-links to the Lifecycle tab', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderDash();
    expect(await screen.findByText('Suspended', { selector: 'b' })).toBeInTheDocument();
    expect(screen.getByText('Offboarding started')).toBeInTheDocument();
    expect(screen.getByText('Payment overdue · Operator')).toBeInTheDocument();
    expect(screen.getByText('No reason code · System')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Suspended Co' })).toHaveAttribute('href', '/tenants/t-susp?tab=lifecycle');
    expect(screen.queryByText(/tenant\.suspended|payment_overdue/)).not.toBeInTheDocument();
    expect(screen.getByText('2026-06-10 00:00 UTC')).toBeInTheDocument();
  });

  it('shows "Refreshed HH:MM UTC" and refetches on Refresh', async () => {
    const spy = vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    renderDash();
    expect(await screen.findByText(/^\d{2}:\d{2} UTC$/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('shows the designed empty states', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(EMPTY);
    renderDash();
    expect(await screen.findByText('No tenants waiting')).toBeInTheDocument();
    expect(screen.getByText("Every provisioned tenant's owner has signed in.")).toBeInTheDocument();
    expect(screen.getByText('No lifecycle events yet.')).toBeInTheDocument();
  });

  it('errors per panel with Try again', async () => {
    const spy = vi.spyOn(platformApi, 'getDashboard').mockRejectedValueOnce(new Error('boom')).mockResolvedValue(FULL);
    renderDash();
    expect(await screen.findByText("Couldn't load recent activity.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load the onboarding funnel.")).toBeInTheDocument();
    expect(screen.getByText("Couldn't load tenant counts.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try again' })[0] as HTMLElement);
    expect(await screen.findByRole('link', { name: 'Oldest Co' })).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('errors only the activity panel when only its data is missing', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue({ ...FULL, recent_activity: undefined as never });
    renderDash();
    expect(await screen.findByText(/The other panels are unaffected\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Oldest Co' })).toBeInTheDocument();
  });

  it('shows no rating metric', async () => {
    vi.spyOn(platformApi, 'getDashboard').mockResolvedValue(FULL);
    const { container } = renderDash();
    await screen.findByRole('link', { name: 'Oldest Co' });
    expect(container.textContent ?? '').not.toMatch(/health|rating|index|%/i);
  });
});
