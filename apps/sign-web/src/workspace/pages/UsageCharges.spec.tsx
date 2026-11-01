import { render, screen, waitFor } from '@testing-library/react';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingUsage } from '../api';

import { UsageCharges, usageMoney } from './UsageCharges';

// Sign Feature Parity D-2 (A1) — the metered-usage card on Plan & billing. Hidden while dark (the
// backend answers enabled false), when the period has nothing sold or used, and on a failed read.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(res: Response) {
  return vi.fn(async (input: RequestInfo | URL) => (String(input).endsWith('/v1/sign/billing/usage') ? res : json({ error: { code: 'NOT_FOUND' } }, 404)));
}

const PERIOD: NonNullable<BillingUsage['period']> = {
  start: '2026-11-01T00:00:00.000Z',
  end: '2026-12-01T00:00:00.000Z',
  currency: 'USD',
  units: [
    { unit_key: 'sign.sms_message', name: 'SMS delivery', quantity_label: 'message', quantity: 3, unit_price_minor: 36, amount_minor: 108 },
    { unit_key: 'sign.id_verification', name: 'ID verification', quantity_label: 'verification', quantity: 1, unit_price_minor: null, amount_minor: 240 },
  ],
  total_amount_minor: 348,
};

describe('UsageCharges', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing while metered billing is dark (enabled false)', async () => {
    const fetch = stub(json({ enabled: false, period: null }));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<UsageCharges />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('billing-metered-usage')).toBeNull();
  });

  it('renders nothing when the period has no unit sold or used', async () => {
    const fetch = stub(json({ enabled: true, period: { ...PERIOD, units: [], total_amount_minor: 0 } }));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<UsageCharges />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a failed read', async () => {
    const fetch = stub(json({ error: { code: 'INTERNAL_ERROR' } }, 500));
    vi.stubGlobal('fetch', fetch);
    const { container } = render(<UsageCharges />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('enabled: per-unit quantity, price and amount, a unit no longer sold, and the period total', async () => {
    vi.stubGlobal('fetch', stub(json({ enabled: true, period: PERIOD })));
    render(<UsageCharges />);
    expect(await screen.findByTestId('billing-metered-usage')).toBeInTheDocument();
    expect(screen.getByTestId('billing-metered-sign.sms_message')).toHaveTextContent('SMS delivery · 3 messages × $0.36$1.08');
    expect(screen.getByTestId('billing-metered-sign.id_verification')).toHaveTextContent('ID verification · 1 verification · no longer on your plan$2.40');
    expect(screen.getByTestId('billing-metered-total')).toHaveTextContent('$3.48');
  });

  it('formats minor units with two decimals', () => {
    expect(usageMoney(36, 'USD')).toBe('$0.36');
    expect(usageMoney(1000, 'USD')).toBe('$10.00');
  });
});
