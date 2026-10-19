import { useCallback, useEffect, useState } from 'react';

import { billingApi, errorMessage, type BillingAccount, type BillingCatalog, type BillingPlan, type Money } from '../api';
import { Btn, Check, ErrorBox, Loading, fmtDate } from '../ui';

// Aramo Sign launch — the organization's plan, usage and self-service billing.
// Everything shown is the backend's view (GET /v1/esign/billing/*). The
// subscription opens only when the backend has verified the payment with the
// provider: a return from checkout never asserts it, so on `?checkout=success`
// this page waits for the backend instead of trusting the redirect.
//
// Commercial Plans Amendment A1 — the four-plan catalog: list prices with their
// commitment and tax wording; a comparison price only when the backend marks it
// substantiated; Standard Professional only for ATS-eligible organizations;
// Enterprise is "Contact sales"; unlimited usage is a count without a ceiling;
// storage is metered against the plan; terms are offered only once approved.

const STATUS_LABEL: Record<string, [string, string]> = {
  TRIALING: ['Trial', 'blue'],
  ACTIVE: ['Active', 'ok'],
  PAST_DUE: ['Payment overdue', 'warn'],
  INCOMPLETE: ['Payment incomplete', 'warn'],
  CANCELED: ['Canceled', 'grey'],
};

const FEATURE_LABEL: Record<string, string> = {
  'esign.ai_assist_summary': 'AI assist summary',
  'esign.team_collaboration': 'Team collaboration',
  'esign.advanced_analytics': 'Advanced analytics',
  'esign.custom_domain': 'Custom domain',
};

function go(url: string): void {
  window.location.assign(url);
}

export function money(m: Money): string {
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, minimumFractionDigits: m.amount_minor % 100 === 0 ? 0 : 2 }).format(m.amount_minor / 100);
  return m.interval === 'MONTH' ? `${amount}/month` : amount;
}

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
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

function Meter({ used, limit, testId }: { used: number; limit: number; testId: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  const color = pct < 80 ? 'var(--sg-accent, #2563eb)' : pct < 100 ? '#d97706' : '#dc2626';
  return (
    <div style={{ height: 8, borderRadius: 4, background: 'var(--sg-line, #e5e7eb)', overflow: 'hidden' }} aria-hidden data-testid={testId}>
      <div style={{ width: `${pct}%`, height: '100%', background: color }} />
    </div>
  );
}

function Usage({ a }: { a: BillingAccount }) {
  const storage = a.storage ?? null;
  return (
    <>
      {a.allowance.subscribed ? (
        <div data-testid="billing-usage">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong>
              {a.allowance.limit === null ? `${a.allowance.used} envelopes sent this period · unlimited` : `${a.allowance.used} of ${a.allowance.limit} envelopes used`}
            </strong>
            <span className="sg-muted">Period renews {fmtDate(a.allowance.period_end)}</span>
          </div>
          {a.allowance.limit !== null ? <Meter used={a.allowance.used} limit={a.allowance.limit} testId="billing-usage-meter" /> : null}
          {a.allowance.limit !== null ? <p className="sg-help">Envelopes are counted when they are sent. Unused envelopes don’t roll over.</p> : null}
        </div>
      ) : null}
      {storage !== null ? (
        <div data-testid="billing-storage">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
            <strong>{storage.limit === null ? `${bytes(storage.used)} storage used` : `${bytes(storage.used)} of ${bytes(storage.limit)} storage used`}</strong>
          </div>
          {storage.limit !== null ? <Meter used={storage.used} limit={storage.limit} testId="billing-storage-meter" /> : null}
          <p className="sg-help">Uploaded documents, signed copies and certificates count toward storage. A full allocation stops new uploads; nothing stored is removed.</p>
        </div>
      ) : null}
    </>
  );
}

function allowanceLine(p: BillingPlan, key: string, noun: string): string | null {
  const a = p.allowances.find((x) => x.allowance_key === key);
  if (a === undefined) return null;
  return a.unlimited ? `Unlimited ${noun}` : `${a.included_quantity ?? 0} ${noun} per month`;
}

function capacityLine(p: BillingPlan, key: string, noun: (n: number) => string, unlimitedText: string): string | null {
  const c = p.capacities.find((x) => x.capacity_key === key);
  if (c === undefined) return null;
  return c.unlimited || c.limit === null ? unlimitedText : noun(c.limit);
}

function PlanCard({
  plan,
  canBuy,
  onBuy,
  busy,
  termsAccepted,
  needsTerms,
  salesUrl,
}: {
  plan: BillingPlan;
  canBuy: boolean;
  onBuy: () => void;
  busy: boolean;
  termsAccepted: boolean;
  needsTerms: boolean;
  salesUrl: string | null;
}) {
  const lines = [
    allowanceLine(plan, 'esign.envelopes', 'E-Signs'),
    allowanceLine(plan, 'esign.forms', 'forms'),
    capacityLine(plan, 'esign.templates', (n) => `${n} template${n === 1 ? '' : 's'}`, 'Unlimited templates'),
    capacityLine(plan, 'esign.storage_bytes', (n) => `${bytes(n)} storage`, 'Storage by agreement'),
    ...plan.features.filter((f) => f.enabled).map((f) => FEATURE_LABEL[f.feature_key] ?? f.feature_key),
    plan.support_tier === 'BASIC' ? 'Basic support' : null,
  ].filter((x): x is string => x !== null);
  const contactSales = plan.sales_model === 'CONTACT_SALES';
  return (
    <section className="sg-card" data-testid={`billing-plan-${plan.key}`}>
      <div className="sg-card__head">
        {plan.name}
        {plan.eligibility === 'ATS_SUBSCRIPTION' ? <span className="sg-card__end sg-tag sg-tag--blue">With Aramo ATS</span> : null}
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
        <div data-testid="billing-plan-price">
          {contactSales ? (
            <strong>Contact sales</strong>
          ) : plan.price !== null ? (
            <>
              {plan.reference_price !== null ? <s className="sg-muted" style={{ marginRight: 6 }}>{money({ ...plan.reference_price, interval: plan.price.interval ?? null })}</s> : null}
              <strong>{money(plan.price)}</strong>
              <div className="sg-muted">
                {plan.commitment_months !== null ? `${plan.commitment_months}-month commitment, billed monthly` : 'Month to month'} · plus applicable tax
              </div>
            </>
          ) : null}
        </div>
        {plan.description !== null ? <div className="sg-muted">{plan.description}</div> : null}
        {lines.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        {contactSales ? (
          salesUrl !== null ? (
            <a className="sg-btn" href={salesUrl} data-testid="billing-contact-sales">
              Contact sales
            </a>
          ) : (
            <p className="sg-help">Contact Aramo to arrange an Enterprise agreement.</p>
          )
        ) : null}
        {!contactSales && canBuy && plan.eligibility !== null && !plan.eligible ? (
          <p className="sg-help" data-testid="billing-plan-ineligible">
            For organizations with an Aramo ATS subscription.
          </p>
        ) : null}
        {!contactSales && canBuy && plan.eligible ? (
          <>
            <Btn variant="primary" disabled={busy || !plan.purchasable || (needsTerms && !termsAccepted)} onClick={onBuy} data-testid={`billing-subscribe-${plan.key}`}>
              {busy ? 'Opening checkout…' : 'Subscribe'}
            </Btn>
            {!plan.purchasable ? <p className="sg-help">Online checkout isn’t available yet.</p> : <p className="sg-help">Enter payment details on the secure Stripe checkout page.</p>}
          </>
        ) : null}
      </div>
    </section>
  );
}

export function BillingPanel({ onSending, pollMs = 3000 }: { onSending?: () => void; pollMs?: number } = {}) {
  const returned = checkoutReturn();
  const { account, error, waiting, gaveUp, reload } = useAccount(returned === 'success', pollMs);
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    billingApi
      .plans()
      .then(setCatalog)
      .catch(() => setCatalog({ plans: [], terms: null, sales_contact_url: null }));
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
  // Business organizations see the business plans; Free Personal is not offered here.
  const plans = (catalog?.plans ?? []).filter((p) => p.tenant_kind === 'BUSINESS' && p.status === 'ACTIVE');
  const needsTerms = catalog?.terms != null;

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
                {sub.list_price != null ? <span className="sg-muted"> · {money(sub.list_price)}</span> : null}
                {sub.source !== 'SELF_SERVICE' ? <span className="sg-muted"> · arranged with Aramo</span> : null}
              </div>
              {sub.commitment_end != null ? (
                <div className="sg-muted" data-testid="billing-commitment">
                  {sub.commitment_months ?? 12}-month commitment, billed monthly · commitment ends {fmtDate(sub.commitment_end)}
                </div>
              ) : null}
              {sub.status === 'PAST_DUE' && sub.grace_until !== null && sub.sending ? (
                <div className="sg-note">The latest payment failed. Sending continues until {fmtDate(sub.grace_until)}; update your payment method to keep sending.</div>
              ) : null}
              {sub.status === 'PAST_DUE' && !sub.sending ? (
                <div className="sg-note">The latest payment failed, so new envelopes can’t be sent. Envelopes already sent can still be signed.</div>
              ) : null}
              {sub.cancel_at_period_end && sub.current_period_end !== null ? (
                <div className="sg-note" data-testid="billing-cancel">
                  Cancellation requested; the subscription is set to end on {fmtDate(sub.current_period_end)}.
                  {sub.cancel_requested_within_commitment ? ' This is before the end of your 12-month commitment; Aramo will confirm how the commitment applies.' : ''}{' '}
                  Envelopes already sent can still be signed.
                </div>
              ) : null}
              {sub.eligibility_state === 'LAPSED' ? (
                <div className="sg-note" data-testid="billing-eligibility-lapsed">
                  This plan requires an Aramo ATS subscription, which is no longer active. Sending continues; contact Aramo or change to Standard Business.
                </div>
              ) : null}
              {sub.status === 'CANCELED' ? (
                <div className="sg-muted">
                  This subscription ended on {fmtDate(sub.ended_at)}.
                  {sub.export_access_until != null ? ` You can download completed documents until ${fmtDate(sub.export_access_until)}.` : ''}
                </div>
              ) : null}
            </>
          )}
          <Usage a={account} />
          {account.can_manage_billing && sub?.billing_managed === true ? (
            <div>
              <Btn disabled={busy} onClick={() => act(billingApi.portal)} data-testid="billing-manage">
                Manage billing
              </Btn>
              <p className="sg-help">Update your payment method or download invoices on the Stripe billing page.</p>
            </div>
          ) : null}
          {!account.can_manage_billing ? <p className="sg-help">Only an organization admin can change the plan.</p> : null}
          {!account.self_service_eligible ? <p className="sg-help">Plans for personal accounts aren’t available yet.</p> : null}
        </div>
      </section>

      {canBuy && plans.length > 0 ? (
        <>
          {needsTerms ? (
            <label className="sg-settings-row" data-testid="billing-terms">
              <Check checked={terms} onChange={(e) => setTerms(e.target.checked)} />
              <span>
                I agree to the{' '}
                <a href={catalog!.terms!.url} target="_blank" rel="noopener noreferrer">
                  Aramo Sign Terms of Service
                </a>{' '}
                (version {catalog!.terms!.version})
              </span>
            </label>
          ) : null}
          <div className="sg-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', alignItems: 'start' }}>
            {plans.map((p) => (
              <PlanCard
                key={p.key}
                plan={p}
                canBuy={canBuy}
                busy={busy}
                needsTerms={needsTerms}
                termsAccepted={terms}
                salesUrl={catalog?.sales_contact_url ?? null}
                onBuy={() => act(() => billingApi.checkout(p.key, needsTerms ? terms : undefined))}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
