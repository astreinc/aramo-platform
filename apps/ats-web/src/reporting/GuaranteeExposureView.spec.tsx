import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getGuaranteeExposure } from './guarantee-exposure-api';
import { GuaranteeExposureView } from './GuaranteeExposureView';
import type { GuaranteeExposureReport } from './guarantee-exposure-types';

// Track 7 / T7-P5 §5.6 — the guarantee-exposure report surface. Money is shown PER CURRENCY only
// (never summed / FX-converted across currencies); obligation amounts are OBLIGATIONS, not
// payments (copy asserted); a zero cohort renders an explicit empty state; the from/to window is
// sent as absolute UTC instants. The report client is mocked at the module seam.

vi.mock('./guarantee-exposure-api', () => ({ getGuaranteeExposure: vi.fn() }));
const getMock = vi.mocked(getGuaranteeExposure);

function report(overrides: Partial<GuaranteeExposureReport> = {}): GuaranteeExposureReport {
  return {
    period: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    cohort_count: 2,
    exposure_by_currency: [
      { currency: 'USD', total: '20000.00', active: '20000.00', satisfied: '0.00', fell_off: '0.00', at_risk: '20000.00' },
      { currency: 'EUR', total: '9000.00', active: '9000.00', satisfied: '0.00', fell_off: '0.00', at_risk: '9000.00' },
    ],
    states: {
      active: 2,
      satisfied: 0,
      fell_off: 0,
      remedy_due: { replacement: 0, refund: 0, prorated_credit: 0 },
      remedy_completed: 0,
    },
    remedy_obligation_by_currency: [],
    falloff_rate: 0,
    ...overrides,
  };
}

async function runReport() {
  fireEvent.change(screen.getByTestId('ge-from'), { target: { value: '2026-08-01T00:00' } });
  fireEvent.change(screen.getByTestId('ge-to'), { target: { value: '2026-09-01T00:00' } });
  fireEvent.click(screen.getByTestId('ge-run'));
}

beforeEach(() => {
  getMock.mockReset();
});

describe('GuaranteeExposureView', () => {
  it('renders a PER-CURRENCY exposure table (one row per currency, never combined)', async () => {
    getMock.mockResolvedValue(report());
    render(<GuaranteeExposureView />);
    await runReport();

    expect(await screen.findByTestId('ge-results')).toBeInTheDocument();
    expect(screen.getByTestId('ge-cohort-count').textContent).toBe('2');
    // One row per currency; both currencies present as distinct rows.
    expect(screen.getByTestId('ge-exposure-row-USD')).toBeInTheDocument();
    expect(screen.getByTestId('ge-exposure-row-EUR')).toBeInTheDocument();
    // The obligation "not payments" language is present.
    expect(screen.getByText(/not payments/i)).toBeInTheDocument();
  });

  it('sends an absolute [from, to) window to the report client', async () => {
    getMock.mockResolvedValue(report());
    render(<GuaranteeExposureView />);
    await runReport();
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(1));
    const [fromIso, toIso] = getMock.mock.calls[0];
    expect(fromIso).toMatch(/Z$/);
    expect(toIso).toMatch(/Z$/);
    expect(new Date(fromIso).getTime()).toBeLessThan(new Date(toIso).getTime());
  });

  it('renders an explicit empty state for a zero cohort', async () => {
    getMock.mockResolvedValue(report({ cohort_count: 0, exposure_by_currency: [], states: { active: 0, satisfied: 0, fell_off: 0, remedy_due: { replacement: 0, refund: 0, prorated_credit: 0 }, remedy_completed: 0 } }));
    render(<GuaranteeExposureView />);
    await runReport();
    expect(await screen.findByTestId('ge-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('ge-results')).toBeNull();
  });
});
