import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ApplyDeadline,
  ExceptionCountTile,
  NotEnabledState,
  PaymentDueIndicator,
  RenewalRemainingPill,
  TAX_NOT_ENABLED,
  UsageReconBanner,
  WithdrawFailedActivationDialog,
  WithheldAmount,
  WithheldPrice,
  applyDeadlineText,
  paymentDueState,
} from './index';

// CCP-UI-V12 — the NEW typed components (CCP-UI v1.1 handoff §13.10; v1.2 §17.4; R-3).

const NOW = new Date('2026-10-24T14:00:00Z');

describe('CCP-UI-V12 components', () => {
  it('WithheldAmount: "Withheld" with a lock, tooltip and aria-label; cell and stat sizes; no amount prop', () => {
    const { container } = render(<><WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="cell" /><WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="stat" /></>);
    const [cell, stat] = screen.getAllByRole('img', { name: 'Amount withheld: finance access required' });
    expect(cell).toHaveAttribute('title', 'Finance access required (amount-read)');
    expect(cell).toHaveClass('pw-withheld--cell');
    expect(stat).toHaveClass('pw-withheld--stat');
    expect(cell).toHaveTextContent('Withheld');
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('PaymentDueIndicator: Not due / Due / Overdue (muted / warn / danger) from the FA-4 booleans', () => {
    expect(paymentDueState({ payment_due: true, payment_overdue: true })).toBe('OVERDUE');
    expect(paymentDueState({ payment_due: true })).toBe('DUE');
    expect(paymentDueState({})).toBe('NOT_DUE');
    render(<><PaymentDueIndicator state="NOT_DUE" /><PaymentDueIndicator state="DUE" /><PaymentDueIndicator state="OVERDUE" /></>);
    expect(screen.getByText('Not due').closest('[data-tone]')).toHaveAttribute('data-tone', 'muted');
    expect(screen.getByText('Due').closest('[data-tone]')).toHaveAttribute('data-tone', 'warn');
    expect(screen.getByText('Overdue').closest('[data-tone]')).toHaveAttribute('data-tone', 'danger');
  });

  it('NotEnabledState, ExceptionCountTile, WithheldPrice, RenewalRemainingPill', () => {
    render(
      <>
        <NotEnabledState title={TAX_NOT_ENABLED.title} reason={TAX_NOT_ENABLED.reason} />
        <ExceptionCountTile count={4} />
        <WithheldPrice reason="non-USD" currency="EUR" />
        <RenewalRemainingPill endDate={new Date('2026-11-10T00:00:00Z')} now={NOW} />
        <RenewalRemainingPill endDate={new Date('2026-10-20T00:00:00Z')} now={NOW} days={-4} />
      </>,
    );
    expect(screen.getByTestId('not-enabled')).toHaveTextContent('Tax not enabled — pending Stripe Tax registration.Prices are shown before tax.');
    expect(screen.getByTestId('exception-count')).toHaveTextContent('Exceptions4');
    expect(screen.getByText('Reason: non-USD (EUR)')).toBeInTheDocument();
    expect(screen.getByText('16 days left').closest('[data-tone]')).toHaveAttribute('data-tone', 'info');
    expect(screen.getByText('Lapsed 4 d ago').closest('[data-tone]')).toHaveAttribute('data-tone', 'warn');
  });

  it('UsageReconBanner: status / alert roles and copy', () => {
    const { rerender } = render(<UsageReconBanner status="RECONCILED" lastRun={{ at: NOW, mode: 'INCREMENTAL' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconciled. Roll-ups match Sign records. Last run 2026-10-24 14:00 UTC · Incremental.');
    rerender(<UsageReconBanner status="NOT_RECONCILED" mismatches={3} lastRun={{ at: NOW }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Not reconciled · 3 mismatches.');
  });

  it('ApplyDeadline: null renders "No apply deadline (policy v{n})"; a deadline names the UTC time and turns amber under the lead', () => {
    expect(applyDeadlineText({ applyBy: null, policyVersion: 1, state: 'APPROVED', variant: 'fact', now: NOW, nearHours: 12 }).text).toBe('No apply deadline (policy v1) · requester applies');
    expect(applyDeadlineText({ applyBy: new Date('2026-10-24T22:00:00Z'), policyVersion: 2, state: 'APPROVED', variant: 'cell', now: NOW, nearHours: 12 })).toEqual({ text: 'Apply within 8 h', tone: 'warn' });
    render(<ApplyDeadline applyBy={new Date('2026-10-24T22:00:00Z')} policyVersion={2} isRequester state="APPROVED" variant="stepper" now={NOW} nearHours={12} />);
    expect(screen.getByTestId('apply-deadline')).toHaveTextContent('Approved · apply by 2026-10-24 22:00 UTC');
  });

  it('WithdrawFailedActivationDialog: success closes; "already applied" keeps commit disabled', async () => {
    const onWithdrawn = vi.fn();
    const onWithdraw = vi.fn().mockResolvedValueOnce('ALREADY_APPLIED');
    render(<WithdrawFailedActivationDialog open onOpenChange={() => undefined} requestLabel="CR-1053" policyVersion={2} onWithdraw={onWithdraw} onWithdrawn={onWithdrawn} />);
    expect(screen.getByRole('dialog', { name: 'Withdraw CR-1053 · Activate policy v2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This activation was applied. It can’t be withdrawn.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeDisabled());
    expect(onWithdrawn).not.toHaveBeenCalled();
  });
});
