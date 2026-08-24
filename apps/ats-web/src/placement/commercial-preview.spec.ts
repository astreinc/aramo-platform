import { describe, expect, it } from 'vitest';

import { computeMarginPreview } from './commercial-preview';

// Slice #4 — the live margin preview helper. Integer-cent math (no float drift); exact
// display strings. Percent = (bill − pay) / bill × 100 to 2dp; deltas are signed.

describe('computeMarginPreview', () => {
  const base = {
    currentPay: '80.00' as string | undefined,
    currentBill: '120.00' as string | undefined,
    currentCurrency: 'USD',
    currentRatePeriod: 'HOURLY',
    proposedCurrency: 'USD',
    proposedRatePeriod: 'HOURLY',
  };

  it('returns null until BOTH proposed amounts are valid money', () => {
    expect(computeMarginPreview({ ...base, proposedPay: '', proposedBill: '150.00' })).toBeNull();
    expect(computeMarginPreview({ ...base, proposedPay: '90.00', proposedBill: 'abc' })).toBeNull();
  });

  it('computes current, proposed and signed deltas verbatim', () => {
    const p = computeMarginPreview({ ...base, proposedPay: '90.00', proposedBill: '150.00' });
    expect(p).not.toBeNull();
    expect(p!.current.pay).toBe('80.00 USD/hr');
    expect(p!.current.bill).toBe('120.00 USD/hr');
    expect(p!.current.margin).toBe('33.33%');
    expect(p!.proposed.pay).toBe('90.00 USD/hr');
    expect(p!.proposed.bill).toBe('150.00 USD/hr');
    expect(p!.proposed.margin).toBe('40.00%');
    expect(p!.payDelta).toBe('+10.00 USD/hr');
    expect(p!.billDelta).toBe('+30.00 USD/hr');
    expect(p!.marginPointDelta).toBe('+6.67');
  });

  it('renders a negative delta with a leading minus', () => {
    const p = computeMarginPreview({ ...base, proposedPay: '100.00', proposedBill: '110.00' });
    expect(p!.payDelta).toBe('+20.00 USD/hr');
    expect(p!.billDelta).toBe('-10.00 USD/hr');
    // margin drops from 33.33% to ~9.09% → negative point delta
    expect(p!.marginPointDelta.startsWith('-')).toBe(true);
  });

  it('masks the current side and every dependent delta when current pay/bill are omitted', () => {
    const p = computeMarginPreview({
      ...base,
      currentPay: undefined,
      currentBill: undefined,
      proposedPay: '90.00',
      proposedBill: '150.00',
    });
    expect(p!.current.pay).toBe('—');
    expect(p!.current.bill).toBe('—');
    expect(p!.current.margin).toBe('—');
    expect(p!.payDelta).toBe('—');
    expect(p!.billDelta).toBe('—');
    expect(p!.marginPointDelta).toBe('—');
    // proposed side is still fully computed.
    expect(p!.proposed.margin).toBe('40.00%');
  });
});
