import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformTenantSign } from '../platform-api';

import { TenantSignPanel, storageLine, usageLine } from './TenantSignPanel';

// PLATFORM-UX-1 F-5 (handoff §6.3 Aramo Sign) — read-only: plan + subscription
// pill (never "—"), Source labels including FREE, the unsubscribed allowance
// state, the usage bar, eligibility, billing events with human labels, and no
// action controls.

const SUBSCRIBED: PlatformTenantSign = {
  tenant_id: 't1',
  tenant_kind: 'BUSINESS',
  capabilities: ['core', 'sign'],
  sign_entitled: true,
  subscription: {
    plan_key: 'aramo-sign-business-v1',
    plan_name: 'Aramo Sign Business',
    source: 'SELF_SERVICE',
    status: 'PAST_DUE',
    sending: false,
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
  allowance: { subscribed: true, limit: 250, used: 88, remaining: 162, period_start: '2026-10-18T00:00:00Z', period_end: '2026-11-18T00:00:00Z' },
  storage: { capacity_key: 'sign.storage_bytes', limit: 10 * 1024 ** 3, unlimited: false, used: 512 * 1024 ** 2 },
  billing_available: true,
  billing_events: [
    { event_type: 'invoice.payment_failed', outcome: 'APPLIED', detail: 'ACTIVE -> PAST_DUE', event_created_at: '2026-10-21T04:10:00Z', received_at: '2026-10-21T04:10:01Z' },
  ],
};

describe('usage / storage lines', () => {
  it('shows N of M envelopes with a bar, unlimited without one, and the unsubscribed state', () => {
    expect(usageLine(SUBSCRIBED.allowance)).toEqual({ text: '88 of 250 envelopes', pct: 35 });
    expect(usageLine({ ...SUBSCRIBED.allowance, limit: null } as PlatformTenantSign['allowance']).pct).toBeNull();
    expect(usageLine({ subscribed: false, state: 'PAST_DUE' }).text).toBe('Not metered · Past due');
    expect(usageLine({ subscribed: false }).text).toBe('Not metered · No subscription');
  });
  it('formats storage', () => {
    expect(storageLine(SUBSCRIBED.storage)).toBe('512 MB of 10 GB');
    expect(storageLine(null)).toBe('Not metered');
  });
});

describe('TenantSignPanel', () => {
  it('renders the subscription read-only with human labels', () => {
    render(<TenantSignPanel data={SUBSCRIBED} failed={false} onRetry={() => undefined} />);
    expect(screen.getByRole('note')).toHaveTextContent(/Read-only\. Plan, subscription and capability changes/);
    expect(screen.getByTestId('tenant-sign-plan')).toHaveTextContent('Aramo Sign Business');
    expect(screen.getByTestId('tenant-sign-plan')).toHaveTextContent('Past due');
    expect(screen.getByText('(not sending)')).toBeInTheDocument();
    expect(screen.getByText('Self-service')).toBeInTheDocument();
    expect(screen.getByText('SELF_SERVICE')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-sign-eligibility')).toHaveTextContent('Lapsed');
    expect(screen.getByTestId('tenant-sign-usage')).toHaveTextContent('88 of 250 envelopes');
    expect(screen.getByText('Payment failed')).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-sign-commitment')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('labels the FREE source "Free (Sign Personal)"', () => {
    const sub = SUBSCRIBED.subscription;
    if (sub === null) throw new Error('fixture');
    render(
      <TenantSignPanel
        data={{ ...SUBSCRIBED, subscription: { ...sub, source: 'FREE', plan_name: 'Sign Personal', status: 'ACTIVE' } }}
        failed={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('Free (Sign Personal)')).toBeInTheDocument();
    expect(screen.getByText('FREE')).toBeInTheDocument();
  });

  it('shows "No subscription", never "—"', () => {
    render(
      <TenantSignPanel
        data={{ ...SUBSCRIBED, subscription: null, allowance: { subscribed: false, state: 'NONE' }, sign_entitled: false }}
        failed={false}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText('No subscription')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-sign-plan')).toHaveTextContent('This tenant has no Sign subscription. Sign enabled: No.');
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('shows the unsubscribed allowance state on a subscription that stopped metering', () => {
    render(
      <TenantSignPanel data={{ ...SUBSCRIBED, allowance: { subscribed: false, state: 'INCOMPLETE' } }} failed={false} onRetry={() => undefined} />,
    );
    expect(screen.getByTestId('tenant-sign-usage')).toHaveTextContent('Not metered · Incomplete');
  });

  it('shows the per-panel error with Try again, and a skeleton while loading', () => {
    const retry = vi.fn();
    const { rerender } = render(<TenantSignPanel data={null} failed onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
    rerender(<TenantSignPanel data={null} failed={false} onRetry={retry} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});
