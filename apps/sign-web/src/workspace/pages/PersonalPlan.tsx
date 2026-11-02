import { useCallback, useEffect, useState } from 'react';

import { billingApi, errorMessage, type BillingAccount, type BillingCatalog } from '../api';
import { FREE_PERSONAL_PLAN_KEY, STANDARD_PERSONAL_OFFER, usd } from '../catalog';
import { Btn, Check, ErrorBox, Loading, fmtDate } from '../ui';

import { checkoutReturn } from './Billing';
import { CancelSubscription } from './CancelSubscription';
import { ComingSoon } from './ComingSoon';
import { AllowanceChip, BUSINESS_SIGNUP_URL } from './PersonalAllowance';

// Aramo-Sign-Catalog-v2-Pricing-and-Features-Directive-v1_0-LOCKED §4.3 / §4.4 — the Personal
// account's plan: Free ($0, 5 a month, up to 2 a day, 15 MB, no templates) and the in-place
// upgrade to Standard ($10/month, 25 a month, no daily limit, 1 GB, 12-month commitment) through
// the Stripe checkout (POST /v1/sign/billing/checkout). The backend is the authority: a return
// from checkout never asserts the upgrade; the page waits for /account to report the new plan.
// Checkout needs the Personal terms accepted ({ plan_key, accept_terms: true }); `upgrade: null`
// on /account (feature off, or nothing to offer) hides the offer entirely.

const UNAVAILABLE_REASON: Readonly<Record<string, string>> = {
  not_available_in_country: 'Standard is available to US residents for now.',
};

function unavailableText(reason: string | null | undefined): string {
  return (reason != null ? UNAVAILABLE_REASON[reason] : undefined) ?? 'Upgrading to Standard isn’t available yet.';
}

function go(url: string): void {
  window.location.assign(url);
}

function useAccount(waitForUpgrade: boolean, intervalMs: number, maxTries: number) {
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
  const planKey = account?.subscription?.plan_key ?? (account?.allowance.subscribed === true ? account.allowance.plan_key : null);
  const upgraded = planKey !== null && planKey !== FREE_PERSONAL_PLAN_KEY;
  useEffect(() => {
    if (!waitForUpgrade || upgraded || tries >= maxTries) return;
    const t = setTimeout(() => {
      setTries((n) => n + 1);
      load();
    }, intervalMs);
    return () => clearTimeout(t);
  }, [waitForUpgrade, upgraded, tries, maxTries, intervalMs, load, account]);
  return { account, error, planKey, waiting: waitForUpgrade && !upgraded && tries < maxTries, gaveUp: waitForUpgrade && !upgraded && tries >= maxTries, reload: load };
}

export function PersonalPlanPanel({ pollMs = 3000, maxTries = 20 }: { pollMs?: number; maxTries?: number } = {}) {
  const returned = checkoutReturn();
  const { account, error, planKey, waiting, gaveUp, reload } = useAccount(returned === 'success', pollMs, maxTries);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  // The Personal terms a checkout must accept (GET /plans is tenant-kind aware); undefined = loading.
  const [terms, setTerms] = useState<BillingCatalog['terms'] | undefined>(undefined);

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

  const onFree = planKey === null || planKey === FREE_PERSONAL_PLAN_KEY;
  // An older backend has no `upgrade` field: the offer is shown and checkout is the authority.
  const offer = account?.upgrade;
  const showUpgrade = account !== null && onFree && offer !== null;
  const upgradeOpen = offer === undefined || offer?.available === true;
  useEffect(() => {
    if (!showUpgrade || !upgradeOpen || terms !== undefined) return;
    billingApi
      .plans()
      .then((c) => setTerms(c.terms))
      .catch(() => setTerms(null));
  }, [showUpgrade, upgradeOpen, terms]);

  if (error !== null) return <ErrorBox>{error}</ErrorBox>;
  if (account === null) return <Loading label="Loading your plan…" />;

  const sub = account.subscription;
  const allowance = account.allowance.subscribed ? account.allowance : null;
  const price = offer?.price_minor ?? STANDARD_PERSONAL_OFFER.price_minor;
  const commitment = offer != null ? offer.commitment_months : STANDARD_PERSONAL_OFFER.commitment_months;
  const upgradeKey = offer?.plan_key ?? STANDARD_PERSONAL_OFFER.plan_key;

  return (
    <div className="sg-grid" data-testid="personal-plan-panel">
      {returned === 'success' && waiting ? (
        <div className="sg-note" data-testid="personal-plan-confirming">
          Payment received by Stripe. Confirming your upgrade with Aramo…
        </div>
      ) : null}
      {returned === 'success' && gaveUp ? (
        <div className="sg-note" data-testid="personal-plan-confirm-slow">
          Your upgrade hasn’t been confirmed yet. This can take a few minutes. <Btn size="sm" onClick={reload}>Check again</Btn>
        </div>
      ) : null}
      {returned === 'canceled' ? <div className="sg-note" data-testid="personal-plan-canceled">Checkout was canceled. You haven’t been charged.</div> : null}
      {actionError !== null ? <ErrorBox>{actionError}</ErrorBox> : null}

      <section className="sg-card" data-testid="personal-plan-current">
        <div className="sg-card__head">Current plan</div>
        <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
          <div>
            <strong>{onFree ? 'Free' : (sub?.plan_name ?? 'Standard')}</strong>
            <span className="sg-muted">{onFree ? ' · $0' : sub?.list_price != null ? ` · ${usd(sub.list_price.amount_minor)}/month` : ''}</span>
          </div>
          {onFree ? (
            <div className="sg-muted" data-testid="personal-plan-free-terms">
              5 documents a month, up to 2 a day · 15 MB storage · templates aren’t included
            </div>
          ) : null}
          {!onFree && sub?.commitment_end != null ? (
            <div className="sg-muted" data-testid="personal-plan-commitment">
              {sub.commitment_months ?? STANDARD_PERSONAL_OFFER.commitment_months}-month commitment, billed monthly · commitment ends {fmtDate(sub.commitment_end)}
            </div>
          ) : null}
          {allowance !== null && allowance.limit !== null ? (
            <div>
              <AllowanceChip used={allowance.used} limit={allowance.limit} daily={allowance.daily ?? null} />
              <span className="sg-muted"> · renews {fmtDate(allowance.period_end)}</span>
            </div>
          ) : null}
          {!onFree && sub?.cancel_at_period_end === true && sub.current_period_end !== null ? (
            <div className="sg-note" data-testid="personal-plan-cancel">
              Cancellation requested; Standard ends on {fmtDate(sub.current_period_end)} and your account then returns to the Free plan.
            </div>
          ) : null}
          {!onFree && sub?.billing_managed === true ? (
            <div>
              <Btn disabled={busy} onClick={() => act(billingApi.portal)} data-testid="personal-plan-manage">
                Manage billing or cancel
              </Btn>
              <p className="sg-help">Update your payment method, download invoices or cancel on the Stripe billing page.</p>
            </div>
          ) : null}
          {!onFree && sub?.billing_managed === true && sub.source === 'SELF_SERVICE' ? (
            <CancelSubscription personal busy={busy} onKeep={() => act(billingApi.portal)} onChanged={reload} />
          ) : null}
        </div>
      </section>

      {showUpgrade ? (
        <section className="sg-card" data-testid="personal-plan-upgrade">
          <div className="sg-card__head">
            Upgrade to {STANDARD_PERSONAL_OFFER.name}
            <span className="sg-card__end">
              <strong>{usd(price)}/month</strong>
            </span>
          </div>
          <div className="sg-card__body sg-grid" style={{ gap: 10 }}>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>{STANDARD_PERSONAL_OFFER.monthly_documents} documents a month</li>
              <li>No daily limit</li>
              <li>{STANDARD_PERSONAL_OFFER.storage} storage</li>
              <li>For individuals and sole proprietors</li>
            </ul>
            <div className="sg-muted" data-testid="personal-plan-upgrade-terms">
              {commitment !== null
                ? `${usd(price)}/month, ${commitment}-month commitment billed monthly. Renews month to month after the commitment. Cancel online in Settings, effective at the end of the commitment; no partial refunds. You then return to Free.`
                : `${usd(price)}/month, billed monthly. Cancel online in Settings; you then return to Free.`}{' '}
              Plus applicable tax. Your documents stay in this account.
            </div>
            {!upgradeOpen ? (
              <p className="sg-help" data-testid="personal-plan-upgrade-unavailable">
                {unavailableText(offer?.reason)}
              </p>
            ) : terms === undefined ? (
              <Loading label="Loading the terms…" />
            ) : terms === null ? (
              <p className="sg-help" data-testid="personal-plan-upgrade-unavailable">
                {unavailableText(null)}
              </p>
            ) : (
              <>
                <label className="sg-check" data-testid="personal-plan-terms">
                  <Check checked={agreed} onChange={(e) => setAgreed(e.target.checked)} data-testid="personal-plan-terms-agree" /> I agree to the{' '}
                  <a href={terms.url} target="_blank" rel="noreferrer" data-testid="personal-plan-terms-link">
                    Aramo Sign Personal terms
                  </a>{' '}
                  (version {terms.version}).
                </label>
                <Btn
                  variant="primary"
                  disabled={busy || !agreed}
                  onClick={() => act(() => billingApi.checkout(upgradeKey, true))}
                  data-testid="personal-plan-upgrade-btn"
                >
                  {busy ? 'Opening checkout…' : `Upgrade to ${STANDARD_PERSONAL_OFFER.name}`}
                </Btn>
                <p className="sg-help">Enter payment details on the secure Stripe checkout page.</p>
              </>
            )}
            <p className="sg-help" style={{ marginBottom: 0 }}>
              Sending for a team? <a href={BUSINESS_SIGNUP_URL}>Create a Business organization</a>.
            </p>
          </div>
        </section>
      ) : null}

      <ComingSoon />
    </div>
  );
}
