import { ApiError, ToastProvider } from '@aramo/fe-foundation';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CompleteRemedyDialog } from './CompleteRemedyDialog';
import { RecordFalloffDialog } from './RecordFalloffDialog';
import { SatisfyGuaranteeDialog } from './SatisfyGuaranteeDialog';
import { FALLOFF_REASON_CODES } from './falloff-reason-labels';
import type { PermanentPlacementRemedyView } from './permanent-placement-types';

// Track 7 / T7-P5 — the lifecycle dialog proofs. Each dialog is driven through its injected
// *Fn seam (mirroring the house pattern) so the dialog→client binding is genuinely exercised
// without a real network. Proven here: the exact request bodies (no amount, no actor ever sent),
// governed-error → actionable copy mapping, the falloff CLOSED reason vocabulary (7 codes, no
// free text), and the REPLACEMENT-vs-monetary remedy evidence branch (read-only obligation
// amount, "not a payment" language). On failure the success callback is NEVER fired (no
// optimistic flip).

function wrap(ui: JSX.Element) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

function remedy(overrides: Partial<PermanentPlacementRemedyView> = {}): PermanentPlacementRemedyView {
  return {
    remedy_type: 'REPLACEMENT',
    calculated_amount: null,
    currency: null,
    remaining_days: null,
    falloff_effective_date: '2026-06-01',
    due_at: '2026-09-01T00:00:00.000Z',
    completed_at: null,
    completed_by: null,
    completion_reference: null,
    replacement_placement_process_id: null,
    ...overrides,
  };
}

describe('SatisfyGuaranteeDialog', () => {
  it('confirm calls the satisfy client + re-reads on success', async () => {
    const satisfyFn = vi.fn().mockResolvedValue({});
    const onSatisfied = vi.fn();
    wrap(<SatisfyGuaranteeDialog open placementId="p1" onClose={vi.fn()} onSatisfied={onSatisfied} satisfyFn={satisfyFn} />);

    fireEvent.click(screen.getByTestId('guarantee-satisfy-confirm'));
    await waitFor(() => expect(satisfyFn).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(onSatisfied).toHaveBeenCalledTimes(1));
  });

  it('maps a premature GUARANTEE_WINDOW_INVALID 422 to actionable copy and does NOT re-read', async () => {
    const satisfyFn = vi.fn().mockRejectedValue(new ApiError(422, 'x', 'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID'));
    const onSatisfied = vi.fn();
    wrap(<SatisfyGuaranteeDialog open placementId="p1" onClose={vi.fn()} onSatisfied={onSatisfied} satisfyFn={satisfyFn} />);

    fireEvent.click(screen.getByTestId('guarantee-satisfy-confirm'));
    expect(await screen.findByText(/can only be satisfied on or after the guarantee end date/i)).toBeInTheDocument();
    expect(onSatisfied).not.toHaveBeenCalled();
  });
});

describe('RecordFalloffDialog', () => {
  it('offers exactly the 7 governed reasons with NO free-text field', () => {
    wrap(<RecordFalloffDialog open placementId="p1" onClose={vi.fn()} onRecorded={vi.fn()} recordFalloffFn={vi.fn()} />);
    expect(screen.getAllByRole('radio')).toHaveLength(FALLOFF_REASON_CODES.length);
    expect(FALLOFF_REASON_CODES).toHaveLength(7);
    // No free-text reason box (only the calendar date input is a textbox-like control).
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('posts { effective_date, reason } with the chosen governed code and re-reads', async () => {
    const recordFalloffFn = vi.fn().mockResolvedValue({});
    const onRecorded = vi.fn();
    wrap(<RecordFalloffDialog open placementId="p1" onClose={vi.fn()} onRecorded={onRecorded} recordFalloffFn={recordFalloffFn} />);

    fireEvent.change(screen.getByTestId('falloff-date-input'), { target: { value: '2026-06-01' } });
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    fireEvent.click(radios[1]);
    const chosen = radios[1].value;
    fireEvent.click(screen.getByTestId('falloff-record-confirm'));

    await waitFor(() => expect(recordFalloffFn).toHaveBeenCalledWith('p1', { effective_date: '2026-06-01', reason: chosen }));
    await waitFor(() => expect(onRecorded).toHaveBeenCalledTimes(1));
  });

  it('maps FALLOFF_WINDOW_INVALID to actionable copy and does NOT re-read', async () => {
    const recordFalloffFn = vi.fn().mockRejectedValue(new ApiError(422, 'x', 'PERMANENT_PLACEMENT_FALLOFF_WINDOW_INVALID'));
    const onRecorded = vi.fn();
    wrap(<RecordFalloffDialog open placementId="p1" onClose={vi.fn()} onRecorded={onRecorded} recordFalloffFn={recordFalloffFn} />);

    fireEvent.change(screen.getByTestId('falloff-date-input'), { target: { value: '2027-06-01' } });
    fireEvent.click(screen.getByTestId('falloff-record-confirm'));
    expect(await screen.findByText(/must fall within the guarantee window/i)).toBeInTheDocument();
    expect(onRecorded).not.toHaveBeenCalled();
  });
});

describe('CompleteRemedyDialog', () => {
  it('REPLACEMENT: shows the placement-reference input (no amount) and posts replacement_placement_process_id', async () => {
    const completeRemedyFn = vi.fn().mockResolvedValue({});
    const onCompleted = vi.fn();
    wrap(
      <CompleteRemedyDialog open placementId="p1" remedy={remedy()} onClose={vi.fn()} onCompleted={onCompleted} completeRemedyFn={completeRemedyFn} />,
    );

    expect(screen.getByTestId('remedy-replacement-input')).toBeInTheDocument();
    expect(screen.queryByTestId('remedy-reference-input')).toBeNull();
    expect(screen.queryByTestId('remedy-dialog-amount')).toBeNull();

    fireEvent.change(screen.getByTestId('remedy-replacement-input'), { target: { value: 'repl-123' } });
    fireEvent.click(screen.getByTestId('remedy-complete-confirm'));
    await waitFor(() => expect(completeRemedyFn).toHaveBeenCalledWith('p1', { replacement_placement_process_id: 'repl-123' }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
  });

  it('REFUND: shows a read-only obligation amount ("not a payment") + reference input and posts external_reference', async () => {
    const completeRemedyFn = vi.fn().mockResolvedValue({});
    wrap(
      <CompleteRemedyDialog
        open
        placementId="p1"
        remedy={remedy({ remedy_type: 'REFUND', calculated_amount: '5863.01', currency: 'USD' })}
        onClose={vi.fn()}
        onCompleted={vi.fn()}
        completeRemedyFn={completeRemedyFn}
      />,
    );

    const amount = screen.getByTestId('remedy-dialog-amount');
    expect(amount.textContent).toMatch(/not a payment/i);
    expect(amount.textContent).toContain('USD');
    expect(screen.getByTestId('remedy-reference-input')).toBeInTheDocument();
    expect(screen.queryByTestId('remedy-replacement-input')).toBeNull();

    fireEvent.change(screen.getByTestId('remedy-reference-input'), { target: { value: 'CN-2026-0001' } });
    fireEvent.click(screen.getByTestId('remedy-complete-confirm'));
    await waitFor(() => expect(completeRemedyFn).toHaveBeenCalledWith('p1', { external_reference: 'CN-2026-0001' }));
  });

  it('maps a REMEDY_INVALID reason detail to the specific replacement guidance', async () => {
    const completeRemedyFn = vi
      .fn()
      .mockRejectedValue(new ApiError(422, 'x', 'PERMANENT_PLACEMENT_REMEDY_INVALID', { reason: 'replacement_not_started' }));
    const onCompleted = vi.fn();
    wrap(
      <CompleteRemedyDialog open placementId="p1" remedy={remedy()} onClose={vi.fn()} onCompleted={onCompleted} completeRemedyFn={completeRemedyFn} />,
    );

    fireEvent.change(screen.getByTestId('remedy-replacement-input'), { target: { value: 'repl-123' } });
    fireEvent.click(screen.getByTestId('remedy-complete-confirm'));
    expect(await screen.findByText(/replacement placement must have started/i)).toBeInTheDocument();
    expect(onCompleted).not.toHaveBeenCalled();
  });
});
