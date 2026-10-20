import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { platformApi, type PlatformTenantSign } from '../platform-api';

import { TenantSignPanel } from './TenantSignPanel';

// Aramo Sign launch — the operator's read-only Sign account panel: plan, status,
// usage and billing events as the backend reports them; no action controls.

const DATA: PlatformTenantSign = {
  tenant_id: 't1',
  tenant_kind: 'BUSINESS',
  capabilities: ['core', 'sign'],
  sign_entitled: true,
  subscription: {
    plan_key: 'aramo-sign-business-v1',
    plan_name: 'Aramo Sign Business',
    source: 'SELF_SERVICE',
    status: 'PAST_DUE',
    sending: true,
    started_at: '2026-10-18T00:00:00Z',
    ended_at: null,
    current_period_end: '2026-11-18T00:00:00Z',
    cancel_at_period_end: false,
    grace_until: '2026-10-25T00:00:00Z',
    billing_managed: true,
    commitment_end: '2027-10-18T00:00:00Z',
    cancel_requested_within_commitment: true,
    eligibility_state: 'LAPSED',
  },
  allowance: { subscribed: true, limit: null, used: 42, remaining: null, period_start: '2026-10-18T00:00:00Z', period_end: '2026-11-18T00:00:00Z' },
  storage: { capacity_key: 'sign.storage_bytes', limit: 10 * 1024 ** 3, unlimited: false, used: 512 * 1024 ** 2 },
  billing_available: true,
  billing_events: [{ event_type: 'invoice.payment_failed', outcome: 'APPLIED', detail: 'ACTIVE -> PAST_DUE', event_created_at: '2026-10-18T00:00:00Z', received_at: '2026-10-18T00:00:01Z' }],
};

describe('TenantSignPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows plan, status, usage and billing events, and offers no actions', async () => {
    vi.spyOn(platformApi, 'getTenantSign').mockResolvedValue(DATA);
    render(<TenantSignPanel tenantId="t1" />);
    expect(await screen.findByTestId('tenant-sign-plan')).toHaveTextContent('Aramo Sign Business · PAST_DUE');
    expect(screen.getByTestId('tenant-sign-usage')).toHaveTextContent('42 envelopes (unlimited)');
    expect(screen.getByTestId('tenant-sign-storage')).toHaveTextContent('512 MB of 10 GB');
    expect(screen.getByTestId('tenant-sign-commitment')).toHaveTextContent('cancellation requested inside the commitment');
    expect(screen.getByTestId('tenant-sign-eligibility')).toHaveTextContent('Lapsed');
    expect(screen.getByText('Self-service (Stripe)')).toBeInTheDocument();
    expect(screen.getByText('invoice.payment_failed')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a tenant without a subscription and the error path', async () => {
    vi.spyOn(platformApi, 'getTenantSign').mockResolvedValueOnce({ ...DATA, subscription: null, allowance: { subscribed: false, state: 'NONE' }, billing_events: [] });
    const { unmount } = render(<TenantSignPanel tenantId="t1" />);
    expect(await screen.findByTestId('tenant-sign-plan')).toHaveTextContent('No subscription');
    unmount();
    vi.spyOn(platformApi, 'getTenantSign').mockRejectedValueOnce(new Error('x'));
    render(<TenantSignPanel tenantId="t1" />);
    expect(await screen.findByText('Could not load the Aramo Sign account.')).toBeInTheDocument();
  });
});
