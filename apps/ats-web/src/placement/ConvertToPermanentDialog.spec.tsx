import { ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { GuaranteeTermVersionView } from '../requisitions/guarantee-terms-types';

import { ConvertToPermanentDialog } from './ConvertToPermanentDialog';
import type { ConvertToPermanentResponse } from './types';

// Track 7 / T7-PX — the conversion confirmation dialog. Driven through its injected seams: the
// convert client + the effective-terms preview client. Proves the §14 contract: it previews the
// governed effective guarantee terms, performs ONE POST, hands the parent the server result (for
// navigation), warns when no governed terms are in effect, and on failure never fires onConverted.

function terms(overrides: Partial<GuaranteeTermVersionView> = {}): GuaranteeTermVersionView {
  return {
    id: 'v1', tenant_id: 't1', requisition_id: 'r1', effective_from: '2026-01-01', effective_to: null,
    guarantee_duration_days: 365, remedy_policy: 'REFUND', guarantee_exposure_amount: '50000.00', currency: 'USD',
    source_type: 'MANUAL', source_reference: null, source_version: null, recorded_by: 'u1',
    recorded_at: '2026-01-01T00:00:00.000Z', supersedes_version_id: null, correlation_id: null,
    created_at: '2026-01-01T00:00:00.000Z', ...overrides,
  } as GuaranteeTermVersionView;
}

const RESULT: ConvertToPermanentResponse = {
  replayed: false,
  source_placement_process_id: 'p1',
  source_contract_assignment_id: 'a1',
  target_placement_process_id: 'target-1',
  target_permanent_placement_id: 'perm-1',
};

function wrap(ui: JSX.Element) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('ConvertToPermanentDialog', () => {
  it('previews the effective governed guarantee terms', async () => {
    wrap(
      <ConvertToPermanentDialog open placementId="p1" requisitionId="r1" onClose={vi.fn()} onConverted={vi.fn()}
        convertFn={vi.fn()} effectiveTermsFn={vi.fn().mockResolvedValue(terms())} />,
    );
    expect(await screen.findByTestId('convert-terms-preview')).toBeInTheDocument();
    expect(screen.getByTestId('convert-terms-duration').textContent).toContain('365');
    expect(screen.getByTestId('convert-terms-exposure').textContent).toContain('USD');
    expect(screen.getByTestId('convert-terms-remedy').textContent).toBe('Refund');
    // The explainer states the contract ends + commercials stop + start = conversion date.
    expect(screen.getByTestId('convert-explainer').textContent).toMatch(/contract assignment ends/i);
  });

  it('warns (no confirm value fabricated) when no governed terms are in effect', async () => {
    wrap(
      <ConvertToPermanentDialog open placementId="p1" requisitionId="r1" onClose={vi.fn()} onConverted={vi.fn()}
        convertFn={vi.fn()} effectiveTermsFn={vi.fn().mockRejectedValue(new Error('404'))} />,
    );
    expect(await screen.findByText(/no governed guarantee terms are in effect/i)).toBeInTheDocument();
  });

  it('performs ONE POST and hands the parent the server result on success', async () => {
    const convertFn = vi.fn().mockResolvedValue(RESULT);
    const onConverted = vi.fn();
    wrap(
      <ConvertToPermanentDialog open placementId="p1" requisitionId="r1" onClose={vi.fn()} onConverted={onConverted}
        convertFn={convertFn} effectiveTermsFn={vi.fn().mockResolvedValue(terms())} />,
    );
    fireEvent.click(await screen.findByTestId('convert-to-permanent-confirm'));
    await waitFor(() => expect(convertFn).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(onConverted).toHaveBeenCalledWith(RESULT));
    expect(convertFn).toHaveBeenCalledTimes(1);
  });

  it('surfaces an error and does NOT navigate (onConverted not fired) on failure', async () => {
    const onConverted = vi.fn();
    wrap(
      <ConvertToPermanentDialog open placementId="p1" requisitionId="r1" onClose={vi.fn()} onConverted={onConverted}
        convertFn={vi.fn().mockRejectedValue(new Error('boom'))} effectiveTermsFn={vi.fn().mockResolvedValue(terms())} />,
    );
    fireEvent.click(await screen.findByTestId('convert-to-permanent-confirm'));
    expect(await screen.findByText(/could not convert this placement/i)).toBeInTheDocument();
    expect(onConverted).not.toHaveBeenCalled();
  });
});
