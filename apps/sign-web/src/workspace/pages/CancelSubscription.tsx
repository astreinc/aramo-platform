import { useCallback, useEffect, useState } from 'react';

import { billingApi, errorMessage, type SelfServiceBilling } from '../api';
import { Btn, ErrorBox } from '../ui';

// Remaining-Work Consolidated Directive (32e5e3e1) A4 — Settings → Billing → "Cancel subscription".
// The backend is the authority (GET/POST /v1/sign/billing/self-service[/cancel], CCP-C7): the button
// shows only when the self-service view says the cancel is available, and the confirmation states
// exactly when the cancellation takes effect (the end of the current monthly period; ToS v2.0 B5.1)
// and what happens to the account's data (Business: ToS B7.5, 90 calendar days to download completed
// documents and evidence; Personal: back to the Free plan, documents stay).
//
// Inside the commitment the backend refuses an early cancel (DR-C2-1): the cancel becomes available
// in the last month of the commitment, effective at its end. After a cancel is requested and before
// it takes effect, "Keep my subscription" opens the Stripe billing page, where the subscription can
// be renewed: the provider adapter has no resume command (reported gap), so no undo is invented here.

export const EXPORT_DAYS_AFTER_END = 90;

/** A date with its year (a commitment end can be a year away). */
export function fullDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/** The confirmation's lines: when it takes effect, what it costs, and what happens to the data. */
export function cancelConfirmationLines(personal: boolean, effective: string | null): string[] {
  const when = effective !== null ? fullDate(effective) : 'the end of the current monthly billing period';
  return [
    `Your subscription ends on ${when}, the end of the current monthly billing period. You won’t be charged after that date, and fees already paid aren’t refunded.`,
    'Until then everything keeps working as it does today.',
    personal
      ? 'When it ends, your account returns to the Free plan. Your documents stay in your account.'
      : `When it ends, new envelopes can’t be sent. Envelopes already sent can still be signed, and you can download completed documents and their evidence for ${EXPORT_DAYS_AFTER_END} calendar days after the subscription ends.`,
  ];
}

/** Why the cancel is not offered, in the owner's words (null: say nothing). */
export function cancelUnavailableText(view: SelfServiceBilling): string | null {
  const reason = view.actions.cancel.reason;
  const commitmentEnd = view.subscription?.commitment_end ?? null;
  switch (reason) {
    case 'FINANCIAL_TREATMENT_UNDEFINED':
      return commitmentEnd !== null
        ? `Your plan has a commitment that ends on ${fullDate(commitmentEnd)}. You can cancel online during its last month; the cancellation then takes effect on that date.`
        : 'This subscription can’t be cancelled online. Contact Aramo to cancel.';
    case 'PROVIDER_CHANGE_PENDING':
      return 'A change to your subscription is still being confirmed. Try again later.';
    case 'SELF_SERVICE_TERMS_NOT_APPROVED':
    case 'ACTIVATION_PENDING':
    case 'CONVERSION_IN_PROGRESS':
      return 'Cancelling online isn’t available for this subscription right now. Contact Aramo to cancel.';
    default:
      return null;
  }
}

export function CancelSubscription({
  personal,
  onChanged,
  onKeep,
  busy = false,
  loader = billingApi.selfService,
  cancel = billingApi.selfServiceCancel,
}: {
  personal: boolean;
  onChanged?: () => void;
  onKeep: () => void;
  busy?: boolean;
  loader?: () => Promise<SelfServiceBilling>;
  cancel?: typeof billingApi.selfServiceCancel;
}) {
  const [view, setView] = useState<SelfServiceBilling | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    loader()
      .then(setView)
      // The view is advisory: without it the cancel is simply not offered (Manage billing stays).
      .catch(() => setView(null));
  }, [loader]);
  useEffect(load, [load]);

  const sub = view?.subscription ?? null;
  if (view === null || sub === null || !view.can_manage_billing) return null;

  const submit = () => {
    setSending(true);
    setError(null);
    cancel()
      .then(() => {
        setRequested(true);
        setConfirming(false);
        load();
        onChanged?.();
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Could not cancel your subscription.')))
      .finally(() => setSending(false));
  };

  if (sub.cancel_at_period_end || requested) {
    // The confirmed end date itself is shown by the plan card (account view); this adds the
    // pending state and the way back.
    const pending = !sub.cancel_at_period_end || view.pending_provider;
    return (
      <div className="sg-grid" style={{ gap: 8 }} data-testid="billing-cancel-scheduled">
        {pending ? (
          <div className="sg-note" data-testid="billing-cancel-pending">
            Cancellation requested. Stripe is confirming it
            {sub.current_period_end !== null ? `; your subscription will end on ${fullDate(sub.current_period_end)}.` : '.'}
          </div>
        ) : (
          <div>
            <Btn disabled={busy} onClick={onKeep} data-testid="billing-keep-subscription">
              Keep my subscription
            </Btn>
            <p className="sg-help">Changed your mind? Renew the subscription on the Stripe billing page before it ends.</p>
          </div>
        )}
      </div>
    );
  }

  if (!view.actions.cancel.available) {
    const text = cancelUnavailableText(view);
    return text === null ? null : (
      <p className="sg-help" data-testid="billing-cancel-unavailable">
        {text}
      </p>
    );
  }

  return (
    <div className="sg-grid" style={{ gap: 8 }}>
      {!confirming ? (
        <div>
          <Btn variant="danger" disabled={busy} onClick={() => setConfirming(true)} data-testid="billing-cancel-open">
            Cancel subscription
          </Btn>
        </div>
      ) : (
        <div className="sg-note" role="alertdialog" aria-labelledby="billing-cancel-title" data-testid="billing-cancel-confirm">
          <strong id="billing-cancel-title">Cancel your subscription?</strong>
          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            {cancelConfirmationLines(personal, sub.current_period_end).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="danger" disabled={sending} onClick={submit} data-testid="billing-cancel-submit">
              {sending ? 'Cancelling…' : 'Cancel subscription'}
            </Btn>
            <Btn disabled={sending} onClick={() => setConfirming(false)} data-testid="billing-cancel-keep">
              Keep my subscription
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
