import { useCallback, useEffect, useState } from 'react';

import { billingApi, errorMessage, type BillingAccount, type BillingPlan } from '../api';
import { Btn, ErrorBox, Loading, fmtDate } from '../ui';

// Aramo Sign launch — the organization's plan, usage and self-service billing.
// Everything shown is the backend's view (GET /v1/esign/billing/account). The
// subscription opens only when the backend has verified the payment with the
// provider: a return from checkout never asserts it, so on `?checkout=success`
// this page waits for the backend instead of trusting the redirect. Prices are
// shown on the provider's checkout page, never invented here.

const STATUS_LABEL: Record<string, [string, string]> = {
  TRIALING: ['Trial', 'blue'],
  ACTIVE: ['Active', 'ok'],
  PAST_DUE: ['Payment overdue', 'warn'],
  INCOMPLETE: ['Payment incomplete', 'warn'],
  CANCELED: ['Canceled', 'grey'],
};

function go(url: string): void {
  window.location.assign(url);
}

export function checkoutReturn(search: string = window.location.search): 'success' | 'canceled' | null {
  const v = new URLSearchParams(search).get('checkout');
  return v === 'success' || v === 'canceled' ? v : null;
}

/** Poll the backend until the subscription is sending (or give up). */
export function useAccount(waitForSending: boolean, intervalMs = 3000, maxTries = 20) {
  const [account, setAccount] = useState<BillingAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const load = useCallback(() => {
    billingApi
      .account()
      .then((a) => {
        setAccount(a);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Could not load your plan.')));
  }, []);
  useEffect(load, [load]);
  const sending = account?.allowance.subscribed === true;
  useEffect(() => {
    if (!waitForSending || sending || tries >= maxTries) return;
    const t = setTimeout(() => {
      setTries((n) => n + 1);
      load();
    }, intervalMs);
    return () => clearTimeout(t);
  }, [waitForSending, sending, tries, maxTries, intervalMs, load, account]);
  return { account, error, reload: load, waiting: waitForSending && !sending && tries < maxTries, gaveUp: waitForSending && !sending && tries >= maxTries };
}

function Usage({ a }: { a: BillingAccount }) {
  if (!a.allowance.subscribed) return null;
  const { used, limit, period_end, threshold } = a.allowance;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div data-testid="billing-usage">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <strong>
          {used} of {limit} envelopes used
        </strong>
        <span className="sg-muted">Renews {fmtDate(period_end)}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: 'var(--sg-line, #e5e7eb)', overflow: 'hidden' }} aria-hidden>
        <div style={{ width: `${pct}%`, height: '100%', background: threshold === 'OK' ? 'var(--sg-accent, #2563eb)' : threshold === 'WARNING' ? '#d97706' : '#dc2626' }} />
      </div>
      <p className="sg-help">Envelopes are counted when they are sent. Unused envelopes don’t roll over to the next period.</p>
    </div>
  );
}

function PlanCard({ plan, canBuy, onBuy, busy }: { plan: BillingPlan; canBuy: boolean; onBuy: () => void; busy: boolean }) {
  const env = plan.allowances.find((x) => x.allowance_key === 'esign.envelopes');
  return (
    <section className="sg-card" data-testid="billing-plan">
      <div className="sg-card__head">{plan.name}</div>
      <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
        {env !== undefined ? (
          <div>
            <strong>{env.included_quantity} envelopes</strong> <span className="sg-muted">per month for your organization</span>
          </div>
        ) : null}
        {plan.description !== null ? <div className="sg-muted">{plan.description}</div> : null}
        <div className="sg-muted">One signer per envelope · signature, initials, date and name fields · audit certificate.</div>
        {canBuy ? (
          <Btn variant="primary" disabled={busy || !plan.purchasable} onClick={onBuy} data-testid="billing-subscribe">
            {busy ? 'Opening checkout…' : 'Subscribe'}
          </Btn>
        ) : null}
        {canBuy && !plan.purchasable ? <p className="sg-help">Online checkout isn’t available yet.</p> : null}
        {canBuy && plan.purchasable ? <p className="sg-help">You’ll see the price and enter payment details on the secure Stripe checkout page.</p> : null}
      </div>
    </section>
  );
}

export function BillingPanel({ onSending, pollMs = 3000 }: { onSending?: () => void; pollMs?: number } = {}) {
  const returned = checkoutReturn();
  const { account, error, waiting, gaveUp, reload } = useAccount(returned === 'success', pollMs);
  const [plans, setPlans] = useState<BillingPlan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    billingApi
      .plans()
      .then((p) => setPlans(p.plans))
      .catch(() => setPlans([]));
  }, []);
  const sending = account?.allowance.subscribed === true;
  useEffect(() => {
    if (sending && returned === 'success') onSending?.();
  }, [sending, returned, onSending]);

  const act = (fn: () => Promise<{ url: string }>) => {
    setBusy(true);
    setActionError(null);
    fn()
      .then((r) => go(r.url))
      .catch((e: unknown) => {
        setActionError(errorMessage(e));
        setBusy(false);
      });
  };

  if (error !== null) return <ErrorBox>{error}</ErrorBox>;
  if (account === null) return <Loading label="Loading your plan…" />;
  const sub = account.subscription;
  const status = sub === null ? null : (STATUS_LABEL[sub.status] ?? [sub.status, 'grey']);
  const canBuy = account.can_manage_billing && account.self_service_eligible && (sub === null || !sub.sending || sub.source !== 'SELF_SERVICE');

  return (
    <div className="sg-grid" data-testid="billing-panel">
      {returned === 'success' && waiting ? (
        <div className="sg-note" data-testid="billing-confirming">
          Payment received by Stripe. Confirming your subscription with Aramo…
        </div>
      ) : null}
      {returned === 'success' && gaveUp ? (
        <div className="sg-note" data-testid="billing-confirm-slow">
          Your subscription hasn’t been confirmed yet. This can take a few minutes. <Btn size="sm" onClick={reload}>Check again</Btn>
        </div>
      ) : null}
      {returned === 'canceled' ? <div className="sg-note">Checkout was canceled. You haven’t been charged.</div> : null}
      {actionError !== null ? <ErrorBox>{actionError}</ErrorBox> : null}

      <section className="sg-card" data-testid="billing-current">
        <div className="sg-card__head">
          Current plan
          {status !== null ? <span className={`sg-card__end sg-tag sg-tag--${status[1]}`}>{status[0]}</span> : null}
        </div>
        <div className="sg-card__body sg-grid" style={{ gap: 12 }}>
          {sub === null ? (
            <div data-testid="billing-none">Your organization doesn’t have an Aramo Sign plan yet, so envelopes can’t be sent.</div>
          ) : (
            <>
              <div>
                <strong>{sub.plan_name}</strong>
                {sub.source !== 'SELF_SERVICE' ? <span className="sg-muted"> · arranged with Aramo</span> : null}
              </div>
              {sub.status === 'PAST_DUE' && sub.grace_until !== null && sub.sending ? (
                <div className="sg-note">The latest payment failed. Sending continues until {fmtDate(sub.grace_until)}; update your payment method to keep sending.</div>
              ) : null}
              {sub.status === 'PAST_DUE' && !sub.sending ? (
                <div className="sg-note">The latest payment failed, so new envelopes can’t be sent. Envelopes already sent can still be signed.</div>
              ) : null}
              {sub.cancel_at_period_end && sub.current_period_end !== null ? (
                <div className="sg-note">Your subscription ends on {fmtDate(sub.current_period_end)}. Envelopes already sent can still be signed after that.</div>
              ) : null}
              {sub.status === 'CANCELED' ? <div className="sg-muted">This subscription ended on {fmtDate(sub.ended_at)}.</div> : null}
              <Usage a={account} />
            </>
          )}
          {account.can_manage_billing && sub?.billing_managed === true ? (
            <div>
              <Btn disabled={busy} onClick={() => act(billingApi.portal)} data-testid="billing-manage">
                Manage billing
              </Btn>
              <p className="sg-help">Update your payment method, download invoices or cancel on the Stripe billing page.</p>
            </div>
          ) : null}
          {!account.can_manage_billing ? <p className="sg-help">Only an organization admin can change the plan.</p> : null}
          {!account.self_service_eligible ? <p className="sg-help">Plans for personal accounts aren’t available yet.</p> : null}
        </div>
      </section>

      {canBuy && plans !== null && plans.length > 0 ? (
        <div className="sg-grid sg-grid--2" style={{ alignItems: 'start' }}>
          {plans.map((p) => (
            <PlanCard key={p.key} plan={p} canBuy={canBuy} busy={busy} onBuy={() => act(() => billingApi.checkout(p.key))} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
