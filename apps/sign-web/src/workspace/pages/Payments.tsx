import { useEffect, useState } from 'react';
import { Dialog } from '@aramo/fe-foundation';

import { errorMessage, formatUsd, senderApi, type PaymentAccount } from '../api';
import { Btn, ErrorBox, Loading, fmtDate } from '../ui';
import { useWorkspace } from '../workspace';

// Aramo Sign 1.14 — Settings → Payments. The organization connects its OWN Stripe account
// (Stripe Connect, Standard): signers pay on Stripe's hosted page and the money goes straight
// to that account (Aramo never holds it). The backend decides availability (feature, Connect
// configuration, plan) and who may manage (can_manage, sign:settings:manage).

const UNAVAILABLE: Record<NonNullable<PaymentAccount['unavailable_reason']>, string> = {
  feature_not_available: 'Payment collection is not available in Aramo Sign yet.',
  payments_not_configured: 'Payment collection is not switched on for this deployment.',
  plan_not_entitled: 'Payment collection is included in the Professional and Enterprise plans.',
};

export function PaymentsSection() {
  const { toast } = useWorkspace();
  const [state, setState] = useState<PaymentAccount | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    // Returning from Stripe's onboarding (?onboarding=return|refresh): read the account through once.
    const returning = new URLSearchParams(window.location.search).has('onboarding');
    (returning ? senderApi.refreshPaymentAccount().catch(() => senderApi.paymentAccount()) : senderApi.paymentAccount())
      .then(setState)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    run(async () => {
      const link = await senderApi.paymentOnboardingLink();
      window.location.assign(link.url);
    });
  const refresh = () =>
    run(async () => {
      setState(await senderApi.refreshPaymentAccount());
      toast('Stripe account status updated');
    });
  const disconnect = () =>
    run(async () => {
      setState(await senderApi.disconnectPaymentAccount());
      setConfirmDisconnect(false);
      toast('Stripe account disconnected');
    });

  if (error !== '' && state === null) return <ErrorBox>{error}</ErrorBox>;
  if (state === null) return <Loading />;
  const a = state.account !== null && state.account.status === 'CONNECTED' ? state.account : null;

  return (
    <section className="sg-card" data-testid="payments-card">
      <div className="sg-card__head">
        Payments
        {a !== null ? <span className={`sg-card__end sg-tag ${a.charges_enabled ? 'sg-tag--ok' : 'sg-tag--grey'}`}>{a.charges_enabled ? 'Ready' : 'Setup incomplete'}</span> : null}
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
        <p className="sg-help" style={{ marginTop: 0 }}>
          Collect a payment when someone signs. Signers pay on Stripe&rsquo;s secure page, and the money goes directly to your organization&rsquo;s own Stripe account.
          Refunds are made from the envelope.
        </p>
        {!state.available && state.unavailable_reason !== null ? <p className="sg-help">{UNAVAILABLE[state.unavailable_reason]}</p> : null}
        {a !== null ? (
          <div className="sg-help" data-testid="payments-account">
            Connected {fmtDate(a.connected_at)} · {a.charges_enabled ? 'accepting payments' : 'finish setup on Stripe to accept payments'}
            {a.payouts_enabled ? ' · payouts on' : ''}
            {a.live ? '' : ' · test mode'}
            {state.application_fee_minor > 0 ? ` · Aramo fee ${formatUsd(state.application_fee_minor)} per payment` : ''}
          </div>
        ) : null}
        {state.can_manage && state.available ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {a === null || !a.details_submitted ? (
              <Btn variant="primary" disabled={busy} onClick={() => void connect()} data-testid="payments-connect">
                {a === null ? 'Connect Stripe account' : 'Continue setup on Stripe'}
              </Btn>
            ) : null}
            {a !== null ? (
              <Btn disabled={busy} onClick={() => void refresh()} data-testid="payments-refresh">
                Refresh status
              </Btn>
            ) : null}
            {a !== null ? (
              <Btn disabled={busy} onClick={() => setConfirmDisconnect(true)} data-testid="payments-disconnect">
                Disconnect
              </Btn>
            ) : null}
          </div>
        ) : !state.can_manage ? (
          <p className="sg-help">Only an Aramo Sign administrator can connect a Stripe account.</p>
        ) : null}
        {error !== '' && !confirmDisconnect ? <ErrorBox>{error}</ErrorBox> : null}
      </div>
      <Dialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect Stripe account?"
        description="New envelopes can't collect payments until you connect again. Payments already made stay in your Stripe account."
        size="sm"
        footer={
          <>
            <Btn onClick={() => setConfirmDisconnect(false)}>Cancel</Btn>
            <Btn variant="danger" disabled={busy} onClick={() => void disconnect()} data-testid="payments-disconnect-confirm">
              Disconnect
            </Btn>
          </>
        }
      >
        {error !== '' ? <ErrorBox>{error}</ErrorBox> : null}
      </Dialog>
    </section>
  );
}
