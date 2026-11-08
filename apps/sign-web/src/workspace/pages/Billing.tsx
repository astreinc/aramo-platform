import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '@aramo/fe-foundation';

import { billingApi, errorMessage, type BillingAccount, type BillingCatalog, type BillingPlan, type BillingSeats, type Money } from '../api';
import { MAX_SEATS, parseSeats, seatsUsedText } from '../catalog';
import { Btn, Check, ErrorBox, Loading, TextIn, fmtDate } from '../ui';
import { useOptionalWorkspace } from '../workspace';

import { CancelSubscription } from './CancelSubscription';
import { ComingSoon } from './ComingSoon';
import { UsageCharges } from './UsageCharges';

// Aramo Sign launch — the organization's plan, usage and self-service billing.
// Everything shown is the backend's view (GET /v1/sign/billing/*). The
// subscription opens only when the backend has verified the payment with the
// provider: a return from checkout never asserts it, so on `?checkout=success`
// this page waits for the backend instead of trusting the redirect.
//
// Commercial Plans Amendment A1 — the four-plan catalog: list prices with their
// commitment and tax wording; a comparison price only when the backend marks it
// substantiated; Standard Professional only for ATS-eligible organizations;
// Enterprise is "Contact sales"; unlimited usage is a count without a ceiling;
// storage is metered against the plan; terms are offered only once approved.
// A1 review: a plan entitlement that is not yet built (templates, forms, AI
// assist summary) is never advertised — only `available` capabilities show.
// Catalog v2 directive (fc755040…): prices are per organization; no comparison
// (strikethrough) price is ever shown (P-2); unbuilt features appear only in the
// separate "Coming soon" card (P-1).
// Sign Business per-seat directive (v1.0 LOCKED) §3.5: a plan whose `price_unit` is SEAT reads
// "$15 / user / month" (a per-account plan keeps "per organization"); checkout of a SEAT plan
// sends the seat count; the current SEAT subscription shows "N of M seats used" and, for the
// owner / an admin (`can_manage_seats`, O-3), Add a seat / Change seats (POST …/billing/seats:
// an increase is prorated now, a decrease applies at the period end, never below the seats in use).

const STATUS_LABEL: Record<string, [string, string]> = {
  TRIALING: ['Trial', 'blue'],
  ACTIVE: ['Active', 'ok'],
  PAST_DUE: ['Payment overdue', 'warn'],
  INCOMPLETE: ['Payment incomplete', 'warn'],
  CANCELED: ['Canceled', 'grey'],
};

const FEATURE_LABEL: Record<string, string> = {
  'sign.ai_assist_summary': 'AI assist summary',
  'sign.team_collaboration': 'Team collaboration',
  'sign.advanced_analytics': 'Advanced analytics',
  'sign.custom_domain': 'Custom domain',
};

function go(url: string): void {
  window.location.assign(url);
}

function amountText(m: Money): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, minimumFractionDigits: m.amount_minor % 100 === 0 ? 0 : 2 }).format(m.amount_minor / 100);
}

export function money(m: Money): string {
  const amount = amountText(m);
  return m.interval === 'MONTH' ? `${amount}/month` : amount;
}

/** Per-seat directive §3.5.1 — "$15 / user / month". */
export function perUserMoney(m: Money): string {
  return `${amountText(m)} / user${m.interval === 'MONTH' ? ' / month' : ''}`;
}

/** The price as the unit says: per user for SEAT, else the per-account price. */
export function priceText(m: Money, unit: string | null | undefined): string {
  return unit === 'SEAT' ? perUserMoney(m) : money(m);
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

/**
 * Remaining-Work Consolidated Directive (32e5e3e1) A1 — what happens after a Business plan's
 * commitment and how a cancellation works (ToS v2.0 B5.1, month to month). The same sentence is
 * shown at the Stripe checkout's submit button (businessCheckoutDisclosure, libs/subscription).
 */
export function businessRenewalText(commitment_months: number | null): string {
  const start = commitment_months !== null ? `Your plan starts with a ${commitment_months}-month commitment, billed monthly. After that it continues` : 'Your plan is billed monthly and continues';
  return `${start} month to month until you cancel in your billing settings; a cancellation takes effect at the end of the current monthly period.`;
}

function allowanceLine(p: BillingPlan, key: string, noun: string): string | null {
  const a = p.allowances.find((x) => x.allowance_key === key);
  if (a === undefined || a.available !== true) return null;
  return a.unlimited ? `Unlimited ${noun}` : `${a.included_quantity ?? 0} ${noun} per month`;
}

function capacityLine(p: BillingPlan, key: string, noun: (n: number) => string, unlimitedText: string): string | null {
  const c = p.capacities.find((x) => x.capacity_key === key);
  if (c === undefined || c.available !== true) return null;
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
  defaultSeats = 1,
}: {
  plan: BillingPlan;
  canBuy: boolean;
  /** `seats` is given for a SEAT plan only. */
  onBuy: (seats?: number) => void;
  busy: boolean;
  termsAccepted: boolean;
  needsTerms: boolean;
  salesUrl: string | null;
  defaultSeats?: number;
}) {
  const perSeat = plan.price_unit === 'SEAT';
  const seatsId = useId();
  const [seatsRaw, setSeatsRaw] = useState(String(Math.max(1, defaultSeats)));
  const seats = perSeat ? parseSeats(seatsRaw, 1) : null;
  const lines = [
    allowanceLine(plan, 'sign.envelopes', 'E-Signs'),
    allowanceLine(plan, 'sign.forms', 'forms'),
    capacityLine(plan, 'sign.templates', (n) => `${n} template${n === 1 ? '' : 's'}`, 'Unlimited templates'),
    capacityLine(plan, 'sign.storage_bytes', (n) => `${bytes(n)} storage`, 'Storage by agreement'),
    // Only entitlements that are built and operational are advertised.
    ...plan.features.filter((f) => f.enabled && f.available === true).map((f) => FEATURE_LABEL[f.feature_key] ?? f.feature_key),
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
              <strong>{priceText(plan.price, plan.price_unit)}</strong>
              {plan.tenant_kind === 'BUSINESS' && !perSeat ? <span className="sg-muted"> per organization</span> : null}
              <div className="sg-muted">
                {plan.commitment_months !== null ? `${plan.commitment_months}-month commitment, billed monthly` : 'Month to month'} · plus applicable tax
              </div>
              {plan.tenant_kind === 'BUSINESS' && plan.price.interval === 'MONTH' ? (
                <p className="sg-help" style={{ margin: '6px 0 0' }} data-testid="billing-plan-renewal">
                  {businessRenewalText(plan.commitment_months)}
                </p>
              ) : null}
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
            {perSeat && plan.purchasable ? (
              <div className="sg-grid" style={{ gap: 4 }}>
                <label htmlFor={seatsId}>
                  <strong>Seats</strong>
                </label>
                <TextIn
                  id={seatsId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_SEATS}
                  value={seatsRaw}
                  onChange={(e) => setSeatsRaw(e.target.value)}
                  aria-invalid={seats === null || undefined}
                  data-testid={`billing-seats-${plan.key}`}
                />
                <p className="sg-help" style={{ margin: 0 }}>
                  {seats === null
                    ? `Enter a number of seats from 1 to ${MAX_SEATS}.`
                    : plan.price !== null
                      ? `${seats} seat${seats === 1 ? '' : 's'} · ${money({ ...plan.price, amount_minor: plan.price.amount_minor * seats })}. Everyone who sends documents uses a seat, including you.`
                      : 'Everyone who sends documents uses a seat, including you.'}
                </p>
              </div>
            ) : null}
            <Btn
              variant="primary"
              disabled={busy || !plan.purchasable || (needsTerms && !termsAccepted) || (perSeat && seats === null)}
              onClick={() => onBuy(perSeat && seats !== null ? seats : undefined)}
              data-testid={`billing-subscribe-${plan.key}`}
            >
              {busy ? 'Opening checkout…' : 'Subscribe'}
            </Btn>
            {!plan.purchasable ? <p className="sg-help">Online checkout isn’t available yet.</p> : <p className="sg-help">Enter payment details on the secure Stripe checkout page.</p>}
          </>
        ) : null}
      </div>
    </section>
  );
}

/** Per-seat directive §3.5.1 — the change-seats confirmation after a successful POST …/billing/seats. */
export function seatsChangedText(r: { purchased: number; pending_purchased: number | null; effective: 'NOW' | 'PERIOD_END' }): string {
  if (r.effective === 'PERIOD_END' && r.pending_purchased !== null) return `Your seats drop to ${r.pending_purchased} at the end of the current billing period.`;
  return `You now have ${r.purchased} seat${r.purchased === 1 ? '' : 's'}. The added seats are charged for the rest of this billing period.`;
}

/**
 * Per-seat directive §3.5.1 — "N of M seats used" (+ the decrease scheduled for the period end) and,
 * for the owner / an admin, Add a seat / Change seats in a small dialog (min = the seats in use,
 * max 1000).
 */
function SeatsBlock({ seats, canManage, periodEnd, onChanged }: { seats: BillingSeats; canManage: boolean; periodEnd: string | null; onChanged: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const titleId = useId();
  const full = seats.used >= seats.purchased;
  const current = seats.pending_purchased ?? seats.purchased;
  const min = Math.max(1, seats.used);
  const value = parseSeats(raw, min);

  const openDialog = (start: number) => {
    setRaw(String(Math.min(MAX_SEATS, start)));
    setError(null);
    setOpen(true);
  };
  const submit = () => {
    if (value === null) return;
    setSending(true);
    setError(null);
    billingApi
      .seats(value)
      .then((r) => {
        setOpen(false);
        onChanged(seatsChangedText(r));
      })
      .catch((e: unknown) => setError(errorMessage(e, 'Could not change your seats.')))
      .finally(() => setSending(false));
  };

  return (
    <div className="sg-grid" style={{ gap: 8 }} data-testid="billing-seats">
      <div>
        <strong data-testid="billing-seats-used">{seatsUsedText(seats.used, seats.purchased)}</strong>
        {seats.pending_purchased !== null ? (
          <div className="sg-muted" data-testid="billing-seats-pending">
            Drops to {seats.pending_purchased} seat{seats.pending_purchased === 1 ? '' : 's'} {periodEnd !== null ? `on ${fmtDate(periodEnd)}` : 'at the end of the current billing period'}.
          </div>
        ) : null}
        <Meter used={seats.used} limit={seats.purchased} testId="billing-seats-meter" />
        <p className="sg-help">Everyone in your organization who can send documents uses a seat. Pending invitations and signers don’t.</p>
      </div>
      {canManage && !open ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {full ? (
            <Btn variant="primary" onClick={() => openDialog(current + 1)} data-testid="billing-seats-add">
              Add a seat
            </Btn>
          ) : null}
          <Btn onClick={() => openDialog(current)} data-testid="billing-seats-change">
            Change seats
          </Btn>
        </div>
      ) : null}
      {canManage && open ? (
        <div className="sg-note" role="dialog" aria-labelledby={titleId} data-testid="billing-seats-dialog">
          <strong id={titleId}>Change seats</strong>
          <div className="sg-grid" style={{ gap: 4, margin: '8px 0' }}>
            <label htmlFor={inputId}>Number of seats</label>
            <TextIn
              id={inputId}
              type="number"
              inputMode="numeric"
              min={min}
              max={MAX_SEATS}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              aria-invalid={value === null || undefined}
              data-testid="billing-seats-input"
            />
            <p className="sg-help" style={{ margin: 0 }}>
              {value === null
                ? `Enter a number from ${min} to ${MAX_SEATS}. ${seats.used} ${seats.used === 1 ? 'person is' : 'people are'} using seats.`
                : 'Added seats are charged now for the rest of the billing period. Removed seats end at the end of the period; there’s no refund.'}
            </p>
          </div>
          {error !== null ? <ErrorBox>{error}</ErrorBox> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="primary" disabled={sending || value === null || value === current} onClick={submit} data-testid="billing-seats-save">
              {sending ? 'Saving…' : 'Save'}
            </Btn>
            <Btn disabled={sending} onClick={() => setOpen(false)} data-testid="billing-seats-cancel">
              Cancel
            </Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Domain-Enforcement P3 §4 — a new subscription needs a verified (AUTHORITATIVE)
// organization email domain; checkout is refused with this reason until then.
const DOMAIN_REQUIRED_MESSAGE = 'Verify your organization’s email domain before subscribing. You can assign this to your IT administrator in Settings.';
// Plans offered here are business plans, so the workspace is always /sign.
export const DOMAIN_SETTINGS_HREF = '/sign/settings/domain';

function isDomainVerificationRequired(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'ESIGN_BILLING_CONFLICT' && e.details?.['reason'] === 'domain_verification_required';
}

export function BillingPanel({ onSending, pollMs = 3000 }: { onSending?: () => void; pollMs?: number } = {}) {
  const returned = checkoutReturn();
  const { account, error, waiting, gaveUp, reload } = useAccount(returned === 'success', pollMs);
  const [catalog, setCatalog] = useState<BillingCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [domainRequired, setDomainRequired] = useState(false);
  const [seatsNotice, setSeatsNotice] = useState<string | null>(null);
  // The workspace toast when the panel is inside the workspace (the setup page renders it without one).
  const workspace = useOptionalWorkspace();

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
    setDomainRequired(false);
    fn()
      .then((r) => go(r.url))
      .catch((e: unknown) => {
        if (isDomainVerificationRequired(e)) setDomainRequired(true);
        else setActionError(errorMessage(e));
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
      {domainRequired ? (
        <ErrorBox>
          <span data-testid="billing-domain-required">
            {DOMAIN_REQUIRED_MESSAGE}{' '}
            <a href={DOMAIN_SETTINGS_HREF} data-testid="billing-domain-settings-link">
              Go to Settings → Domain
            </a>
          </span>
        </ErrorBox>
      ) : null}

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
                {sub.list_price != null ? <span className="sg-muted"> · {priceText(sub.list_price, account.price_unit)}</span> : null}
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
          {account.seats != null ? (
            <SeatsBlock
              seats={account.seats}
              canManage={account.can_manage_seats === true}
              periodEnd={sub?.current_period_end ?? null}
              onChanged={(m) => {
                if (workspace !== null) workspace.toast(m);
                else setSeatsNotice(m);
                reload();
              }}
            />
          ) : null}
          {seatsNotice !== null ? (
            <div className="sg-note" role="status" data-testid="billing-seats-notice">
              {seatsNotice}
            </div>
          ) : null}
          <Usage a={account} />
          {account.can_manage_billing && sub?.billing_managed === true ? (
            <div>
              <Btn disabled={busy} onClick={() => act(billingApi.portal)} data-testid="billing-manage">
                Manage billing or cancel
              </Btn>
              <p className="sg-help">Update your payment method, download invoices or cancel on the Stripe billing page.</p>
            </div>
          ) : null}
          {account.can_manage_billing && sub?.billing_managed === true && sub.source === 'SELF_SERVICE' ? (
            <CancelSubscription personal={false} busy={busy} onKeep={() => act(billingApi.portal)} onChanged={reload} />
          ) : null}
          {!account.can_manage_billing ? <p className="sg-help">Only an organization admin can change the plan.</p> : null}
          {!account.self_service_eligible ? <p className="sg-help">Plans for personal accounts aren’t available yet.</p> : null}
        </div>
      </section>

      <UsageCharges />

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
                (version {catalog!.terms!.version}), including that my plan continues month to month after its commitment until I cancel.
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
                defaultSeats={account.seats?.used ?? 1}
                onBuy={(seats) => act(() => billingApi.checkout(p.key, needsTerms ? terms : undefined, seats))}
              />
            ))}
          </div>
        </>
      ) : null}
      <ComingSoon />
    </div>
  );
}
