import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelfServiceBilling } from '../api';

import { CancelSubscription, cancelConfirmationLines, cancelUnavailableText } from './CancelSubscription';

// Remaining-Work Consolidated Directive (32e5e3e1) A4 — Settings → Billing → Cancel subscription.
// The backend's self-service view decides whether the cancel is offered; the confirmation states
// when it takes effect and what happens to the data; a scheduled cancel offers the way back.

const PERIOD_END = '2027-10-18T12:00:00Z';
const COMMITMENT_END = '2027-10-18T12:00:00Z';

function view(over: Partial<SelfServiceBilling> = {}, sub: Partial<NonNullable<SelfServiceBilling['subscription']>> = {}): SelfServiceBilling {
  return {
    product_key: 'sign',
    terms: { state: 'APPROVED', document_key: 'sign.terms_of_service', version: '2.0', url: 'https://legal.test/terms' },
    subscription: { plan_key: 'aramo-sign-standard-business-v1', status: 'ACTIVE', current_period_end: PERIOD_END, cancel_at_period_end: false, commitment_end: COMMITMENT_END, ...sub },
    pending_provider: false,
    pending_changes: [],
    actions: { cancel: { available: true, reason: null }, upgrade: { available: false, reason: 'FINANCIAL_TREATMENT_UNDEFINED' } },
    can_manage_billing: true,
    ...over,
  };
}

const ACCEPTED = { request_id: 'r1', action: 'CANCEL_AT_PERIOD_END' as const, status: 'PENDING_PROVIDER' as const, pending_provider: true, replayed: false };

describe('CancelSubscription', () => {
  beforeEach(() => configureAuthConsumer('sign'));

  it('the confirmation states the effective date, no further charge, and the 90-day download window (Business)', () => {
    const lines = cancelConfirmationLines(false, PERIOD_END);
    expect(lines[0]).toBe('Your subscription ends on October 18, 2027, the end of the current monthly billing period. You won’t be charged after that date, and fees already paid aren’t refunded.');
    expect(lines[2]).toBe('When it ends, new envelopes can’t be sent. Envelopes already sent can still be signed, and you can download completed documents and their evidence for 90 calendar days after the subscription ends.');
    expect(cancelConfirmationLines(true, PERIOD_END)[2]).toBe('When it ends, your account returns to the Free plan. Your documents stay in your account.');
  });

  it('Cancel subscription → confirm → the self-service cancel; then the pending state', async () => {
    const loader = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(view({ pending_provider: true }));
    const cancel = vi.fn().mockResolvedValue(ACCEPTED);
    const onChanged = vi.fn();
    render(<CancelSubscription personal={false} onKeep={vi.fn()} onChanged={onChanged} loader={loader} cancel={cancel} />);
    fireEvent.click(await screen.findByTestId('billing-cancel-open'));
    const dialog = screen.getByTestId('billing-cancel-confirm');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveTextContent('Your subscription ends on October 18, 2027');
    expect(dialog).toHaveTextContent('90 calendar days');
    // "Keep my subscription" closes the confirmation without a request.
    fireEvent.click(screen.getByTestId('billing-cancel-keep'));
    expect(screen.queryByTestId('billing-cancel-confirm')).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('billing-cancel-open'));
    fireEvent.click(screen.getByTestId('billing-cancel-submit'));
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId('billing-cancel-pending')).toHaveTextContent('Cancellation requested. Stripe is confirming it; your subscription will end on October 18, 2027.');
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('billing-keep-subscription')).toBeNull();
  });

  it('a refused cancel shows the error and keeps the confirmation open', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('nope'));
    render(<CancelSubscription personal={false} onKeep={vi.fn()} loader={vi.fn().mockResolvedValue(view())} cancel={cancel} />);
    fireEvent.click(await screen.findByTestId('billing-cancel-open'));
    fireEvent.click(screen.getByTestId('billing-cancel-submit'));
    await waitFor(() => expect(cancel).toHaveBeenCalled());
    expect(screen.getByTestId('billing-cancel-confirm')).toBeInTheDocument();
  });

  it('a confirmed scheduled cancel offers "Keep my subscription" (the Stripe billing page)', async () => {
    const onKeep = vi.fn();
    render(<CancelSubscription personal onKeep={onKeep} loader={vi.fn().mockResolvedValue(view({ actions: { cancel: { available: false, reason: 'ALREADY_CANCELING' }, upgrade: { available: false, reason: null } } }, { cancel_at_period_end: true }))} />);
    fireEvent.click(await screen.findByTestId('billing-keep-subscription'));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('billing-cancel-open')).toBeNull();
  });

  it('inside the commitment the cancel is not offered; the owner is told when it becomes available', async () => {
    const v = view({ actions: { cancel: { available: false, reason: 'FINANCIAL_TREATMENT_UNDEFINED' }, upgrade: { available: false, reason: null } } });
    expect(cancelUnavailableText(v)).toBe('Your plan has a commitment that ends on October 18, 2027. You can cancel online during its last month; the cancellation then takes effect on that date.');
    render(<CancelSubscription personal={false} onKeep={vi.fn()} loader={vi.fn().mockResolvedValue(v)} />);
    expect(await screen.findByTestId('billing-cancel-unavailable')).toHaveTextContent('during its last month');
    expect(screen.queryByTestId('billing-cancel-open')).toBeNull();
  });

  it('says nothing without a subscription, without billing authority, or when the view fails', async () => {
    expect(cancelUnavailableText(view({ actions: { cancel: { available: false, reason: 'NO_SELF_SERVICE_SUBSCRIPTION' }, upgrade: { available: false, reason: null } } }))).toBeNull();
    expect(cancelUnavailableText(view({ actions: { cancel: { available: false, reason: 'SELF_SERVICE_TERMS_NOT_APPROVED' }, upgrade: { available: false, reason: null } } }))).toContain('Contact Aramo to cancel');
    const { container, rerender } = render(<CancelSubscription personal={false} onKeep={vi.fn()} loader={vi.fn().mockResolvedValue(view({ subscription: null }))} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    rerender(<CancelSubscription personal={false} onKeep={vi.fn()} loader={vi.fn().mockResolvedValue(view({ can_manage_billing: false }))} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    rerender(<CancelSubscription personal={false} onKeep={vi.fn()} loader={vi.fn().mockRejectedValue(new Error('503'))} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
