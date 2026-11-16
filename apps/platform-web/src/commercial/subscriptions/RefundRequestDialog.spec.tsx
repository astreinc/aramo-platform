import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RefundRequestDialog } from './RefundRequestDialog';
import { subscriptionsApi, type RefundablePayment, type RefundablePayments } from './subscriptions-api';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 items 2 and 5 — the dialog creates and
// submits ONE REFUND change request whose payload is the server's closed key set, with the policy
// reference from the ACTIVE policy (read-only). Amendment A2: Commercial ops requests, Finance and
// the Owner approve, the requester applies.

const PAY = (over: Partial<RefundablePayment> = {}): RefundablePayment => ({
  invoice_ref: 'in_1abc',
  number: 'ARAMO-0001',
  payment_ref: 'pi_1abc',
  currency: 'USD',
  amount_paid_minor: 1000,
  created_at: '2026-11-15T10:00:00.000Z',
  period_start: null,
  period_end: null,
  refunded_minor: 0,
  reserved_minor: 0,
  disputed_lost_minor: 0,
  remainder_minor: 1000,
  refusal: null,
  live: true,
  ...over,
});
const READ = (payments: RefundablePayment[], over: Partial<RefundablePayments> = {}): RefundablePayments => ({
  tenant_id: 't1',
  product_key: 'sign',
  availability: 'AVAILABLE',
  mode: 'live',
  subscription_id: 'sub-1',
  payments,
  detail: null,
  read_at: '2026-11-16T00:00:00.000Z',
  ...over,
});

afterEach(() => vi.restoreAllMocks());

function renderDialog(read: RefundablePayments, policyRef = 'ARAMO-COM-REFUND-POL-001@1.0') {
  const onDone = vi.fn();
  render(<RefundRequestDialog tenantId="t1" tenantName="Acme" policyRef={policyRef} policy={{ version_number: 2, approval_expiry_hours: 72 }} onClose={() => undefined} onDone={onDone} load={async () => read} />);
  return onDone;
}

describe('RefundRequestDialog', () => {
  it('defaults to the newest refundable payment for its full remainder and submits the closed REFUND payload', async () => {
    const request = vi.spyOn(subscriptionsApi, 'request').mockResolvedValue({ id: 'cr-1', state: 'PENDING_APPROVAL' } as never);
    const onDone = renderDialog(READ([PAY({ invoice_ref: 'in_0old', number: 'OLD', remainder_minor: 0 }), PAY()]));
    await waitFor(() => expect(screen.getByLabelText(/Amount/)).toHaveValue('10.00'));
    expect(screen.getByTestId('refund-policy-ref')).toHaveTextContent('ARAMO-COM-REFUND-POL-001@1.0');
    fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'R7_GOODWILL' } });
    fireEvent.change(screen.getByLabelText(/Basis/), { target: { value: 'launch proof' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'live integration test' } });
    fireEvent.change(screen.getByLabelText('Evidence'), { target: { value: 'go-live log 2026-11-16' } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for approval' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const call = request.mock.calls[0]![0];
    expect(call.action_type).toBe('REFUND');
    expect(call.submit).toBe(true);
    expect(call.payload).toEqual({
      amount_minor: 1000,
      currency: 'USD',
      provider_invoice_ref: 'in_1abc',
      provider_payment_ref: 'pi_1abc',
      category: 'R7_GOODWILL',
      basis: 'launch proof',
      refund_policy_ref: 'ARAMO-COM-REFUND-POL-001@1.0',
      subscription_id: 'sub-1',
    });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('shows the designed empty state when the subscription has ended (Q2 (a)) and submits nothing', async () => {
    const request = vi.spyOn(subscriptionsApi, 'request');
    renderDialog(READ([], { availability: 'NO_OPEN_SUBSCRIPTION', detail: 'a refund binds the open self-service subscription; this subscription has ended' }));
    await waitFor(() => expect(screen.getByText(/subscription has ended/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
    expect(request).not.toHaveBeenCalled();
  });

  it('says so when no payment has anything left to refund', async () => {
    renderDialog(READ([PAY({ remainder_minor: 0 })]));
    await waitFor(() => expect(screen.getByText('No payment has anything left to refund.')).toBeInTheDocument());
  });

  it('chain strip: Finance → Owner (refund policy v1.0 §5)', async () => {
    renderDialog(READ([PAY()]));
    await waitFor(() => expect(screen.getByText(/until Finance and the Owner sign/)).toBeInTheDocument());
  });
});
