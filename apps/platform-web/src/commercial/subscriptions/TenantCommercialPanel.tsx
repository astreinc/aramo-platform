import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, Button, hasScope, useToast, type Session } from '@aramo/fe-foundation';

import { COMMERCIAL_PERMISSIONS as CP, EmptyState, PaymentDueIndicator, Pill, SkeletonPanel, WithheldAmount, paymentDueState } from '../../components';
import { ExceptionOverlay } from '../../components/ExceptionOverlay';
import { useIdentity } from '../../identity/identity';
import type { PlatformTenantSign } from '../../platform-api';
import { supportExtensionApi, type SupportExtension, type SupportExtensionList, type SupportExtensionOutcome } from '../support-extensions/support-extension-api';
import { breachLine, overlayView, roleLabels } from '../support-extensions/support-extension-model';
import { RequestExtensionDialog } from '../support-extensions/SupportExtensionDialogs';

import { subscriptionsApi, type BillingInvoiceLink, type ChangeRequestRef, type HeldFlag, type ProductCommercial, type TenantCommercial } from './subscriptions-api';
import {
  ENTITLEMENT_PILL,
  GOVERNED_HOLD,
  allowanceBar,
  approvalsHref,
  crRef,
  flagDetail,
  flagTitle,
  isStripeOwned,
  needsRelease,
  openRequestText,
  productLabel,
  provenanceText,
  refusalLine,
  releaseState,
  sourceBadge,
  subscriptionFacts,
  tenantActions,
  type TenantActionKey,
} from './subscriptions-model';
import { TenantRequestDialog, type DialogKind } from './TenantCommercialDialogs';

import '../support-extensions/support-extensions.css';
import './subscriptions.css';

// CCP-B3 (PBD §5.3 row B3: "tenant product tab actions (request change, cancel, grant or revoke
// product); held activations surfaced (Conv. C-8)"; CCP-UI v1.0 handoff §5.9; Commercial Control
// Plane v1.0.dc.html :360-400, :925-950) — Tenant › Commercial: one card per product with the
// entitlement and its provenance (A7), the base subscription's facts and pinned version (A4/A5),
// the allowance (counts only), a held activation's reconciliation flag (A6 hold, C-8) with its
// release (C2), the support-extension overlay (A8/B6), and the actions.
//
// EVERY action creates a change request (A3) and nothing else; a Stripe-owned (SELF_SERVICE) row
// is read-only here and changes only through a governed conversion (C2), whose Stripe side is a
// durable command (C1) shown "Sent to Stripe — awaiting confirmation" until the webhook. Apply is
// offered to the requester only, and only when the request read says `apply_actionable`
// (TD-B2-3). No money is shown (PLATFORM-UX-1 A1-4a). Tab gate `platform:subscription:read`.

export interface TenantCommercialPanelProps {
  readonly session: Session;
  readonly tenantId: string;
  readonly tenantName: string;
  /** The tenant's Aramo Sign read (TenantDetailView already loads it): the allowance counts. */
  readonly sign: PlatformTenantSign | null;
  /** Test seam: the clock. */
  readonly now?: () => Date;
}

type Load<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly value: T };

interface OpenDetail {
  readonly actionable: boolean;
  readonly pendingProvider: boolean;
}

const VIEW_ONLY = 'You can view this tenant’s commercial state. Requests need the Commercial ops role; support extensions need Support admin.';

function loadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Your account can’t read this tenant’s commercial state.';
  if (err instanceof ApiError && err.status === 404) return 'This tenant has no commercial record.';
  return 'The commercial state couldn’t be loaded. Try again.';
}

export function TenantCommercialPanel({ session, tenantId, tenantName, sign, now = () => new Date() }: TenantCommercialPanelProps) {
  const identity = useIdentity();
  const toast = useToast();
  const canSubscription = hasScope(session, 'platform:subscription:request');
  const canEntitlement = hasScope(session, 'platform:entitlement:request');
  const canSupport = hasScope(session, CP.subscriptionSupport);
  const canBilling = hasScope(session, 'platform:billing:read');
  // The console session is a signed-in person (service principals never hold a console session);
  // the server re-checks NOT_HUMAN on every governed act regardless.
  const human = true;
  const viewOnly = !(canSubscription || canEntitlement || canSupport) || !human;

  const [state, setState] = useState<Load<TenantCommercial>>({ status: 'loading' });
  const [support, setSupport] = useState<SupportExtensionList | null>(null);
  const [details, setDetails] = useState<Readonly<Record<string, OpenDetail>>>({});
  const [invoice, setInvoice] = useState<BillingInvoiceLink | null>(null);
  const [dialog, setDialog] = useState<{ readonly kind: DialogKind; readonly product: ProductCommercial; readonly flag?: HeldFlag } | null>(null);
  const [extending, setExtending] = useState(false);
  const [notice, setNotice] = useState<{ readonly tone: 'ok' | 'warn' | 'error'; readonly text: string; readonly requestId?: string } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState({ status: 'loading' });
    try {
      const value = await subscriptionsApi.tenantCommercial(tenantId);
      setState({ status: 'ready', value });
      // The open request of each product: `apply_actionable` (TD-B2-3) and, for a conversion,
      // whether its Stripe side is still awaiting confirmation (C1 / C-23).
      const pairs = await Promise.all(
        value.products
          .flatMap((p) => (p.open_request === null ? [] : [p.open_request]))
          .map(async (r): Promise<[string, OpenDetail]> => {
            const read = await subscriptionsApi.read(r.id).catch(() => null);
            const conv = r.action_type === 'CONVERSION' ? await subscriptionsApi.conversion(r.id).catch(() => null) : null;
            return [r.id, { actionable: read?.apply_actionable === true, pendingProvider: conv?.conversion.pending_provider === true }];
          }),
      );
      setDetails(Object.fromEntries(pairs));
      const signRow = value.products.find((p) => p.product_key === 'sign')?.subscription ?? null;
      // CCP-UI-V12 (AM-9): read for every open Sign row (the C5 tax state and the FA-4 due booleans);
      // the invoice link-out itself stays on the self-service box only.
      if (canBilling && signRow !== null && signRow.ended_at === null) {
        setInvoice(
          await subscriptionsApi.invoiceLink(tenantId).catch(() => ({ availability: 'BILLING_UNAVAILABLE', hosted_url: null, amount_withheld: false, payment_due: false, payment_overdue: false, tax: null })),
        );
      } else {
        setInvoice(null);
      }
    } catch (err) {
      setState({ status: 'error', message: loadError(err) });
    }
    setSupport(await supportExtensionApi.list(tenantId).catch(() => null));
  }, [tenantId, canBilling]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRequested = (request: ChangeRequestRef, submitted: boolean): void => {
    setDialog(null);
    setNotice({
      tone: 'ok',
      text: submitted ? 'Submitted for approval. Nothing applies until every step is signed and you apply it.' : 'Saved as a draft. Submit it for approval from the request.',
      requestId: request.id,
    });
    toast.show(submitted ? 'Change request submitted for approval.' : 'Change request saved as a draft.');
    void load();
  };

  const onExtended = (out: SupportExtensionOutcome): void => {
    setExtending(false);
    if (out.outcome === 'APPLIED') {
      toast.show('Extension applied as an exception — zero approvals, flagged in audit.');
      setNotice(null);
    } else {
      const why = out.decision ? breachLine(out.decision.breaches, out.decision.clause) : '';
      setNotice({ tone: 'warn', text: `Escalated to Finance — nothing was applied. ${why}`.trim(), requestId: out.request.id });
      toast.show('Submitted for approval. Nothing applies until Finance signs.');
    }
    void load();
  };

  const apply = async (p: ProductCommercial): Promise<void> => {
    const r = p.open_request;
    if (r === null) return;
    setApplying(r.id);
    try {
      if (r.action_type === 'CONVERSION') {
        const out = await subscriptionsApi.convert(r.id);
        toast.show(out.conversion.pending_provider ? 'Sent to Stripe — awaiting confirmation.' : out.request.state === 'APPLIED' ? 'Conversion applied.' : `Conversion ${out.conversion.status.toLowerCase().replace(/_/g, ' ')}.`);
      } else {
        const out = await subscriptionsApi.apply(r.id);
        toast.show(out.request.state === 'APPLIED' ? 'Change applied.' : `Apply ${out.request.state.toLowerCase().replace(/_/g, ' ')}.`);
      }
      setNotice(null);
    } catch (err) {
      setNotice({ tone: 'error', text: refusalLine(err), requestId: r.id });
    } finally {
      setApplying(null);
      void load();
    }
  };

  if (state.status === 'loading') {
    return (
      <section className="sx-card" aria-busy="true">
        <SkeletonPanel label="Loading commercial state…" lines={['100%', '80%', '90%', '60%']} />
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="sx-card">
        <EmptyState
          title="Couldn’t load"
          body={state.message}
          action={
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34" onClick={() => void load()}>
              Try again
            </Button>
          }
        />
      </section>
    );
  }

  const at = now();
  const signProduct = state.value.products.find((p) => p.product_key === 'sign') ?? null;

  return (
    <div className="cs-tab" data-testid="tenant-commercial">
      {viewOnly ? (
        // The design's view-only note, verbatim (.dc.html td.viewOnlyText).
        <div className="sx-viewonly cs-viewonly" role="note">
          <b>View only.</b>
          {` ${VIEW_ONLY}`}
        </div>
      ) : null}
      {notice ? (
        <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`sx-notice sx-notice--${notice.tone} cs-notice`}>
          {notice.text}
          {notice.requestId ? (
            <>
              {' '}
              <Link className="sx-ref" to={approvalsHref(notice.requestId)}>
                {crRef(notice.requestId)}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="cs-cards">
        {state.value.products.map((p) => (
          <ProductCard
            key={p.product_key}
            product={p}
            tenantName={tenantName}
            sign={p.product_key === 'sign' ? sign : null}
            support={p.product_key === 'sign' ? support : null}
            detail={p.open_request ? (details[p.open_request.id] ?? null) : null}
            invoice={p.product_key === 'sign' ? invoice : null}
            canSubscription={canSubscription}
            canEntitlement={canEntitlement}
            canSupport={canSupport}
            human={human}
            meId={session.sub}
            meName={identity.name}
            now={at}
            applying={applying}
            onAction={(key, flag) => {
              setNotice(null);
              if (key === 'extension') setExtending(true);
              else setDialog({ kind: key, product: p, ...(flag ? { flag } : {}) });
            }}
            onApply={() => void apply(p)}
          />
        ))}
      </div>

      {dialog ? (
        <TenantRequestDialog
          kind={dialog.kind}
          tenantId={tenantId}
          tenantName={tenantName}
          product={dialog.product}
          flag={dialog.flag ?? null}
          policy={support?.policy ?? null}
          onClose={() => setDialog(null)}
          onDone={onRequested}
        />
      ) : null}
      {extending && signProduct?.subscription && support?.subscriptions[0] ? (
        <RequestExtensionDialog
          open
          onOpenChange={(o) => !o && setExtending(false)}
          tenantId={tenantId}
          tenantName={tenantName}
          subscription={support.subscriptions[0]}
          policy={support.policy}
          prior={support.extensions}
          actorName={identity.name}
          actorRoles={identity.role ?? roleLabels([])}
          now={() => at}
          onDone={onExtended}
        />
      ) : null}
    </div>
  );
}

interface ProductCardProps {
  readonly product: ProductCommercial;
  readonly tenantName: string;
  readonly sign: PlatformTenantSign | null;
  readonly support: SupportExtensionList | null;
  readonly detail: OpenDetail | null;
  readonly invoice: BillingInvoiceLink | null;
  readonly canSubscription: boolean;
  readonly canEntitlement: boolean;
  readonly canSupport: boolean;
  readonly human: boolean;
  readonly meId: string;
  readonly meName: string;
  readonly now: Date;
  readonly applying: string | null;
  readonly onAction: (key: Exclude<TenantActionKey, 'extension'> | 'recon' | 'extension', flag?: HeldFlag) => void;
  readonly onApply: () => void;
}

function ProductCard(props: ProductCardProps) {
  const { product: p, sign, support, detail, invoice, now } = props;
  const s = p.subscription;
  const ent = ENTITLEMENT_PILL[p.entitlement.state];
  const badge = s ? sourceBadge(s, true) : null;
  const prov = provenanceText(p.entitlement);
  const actions = tenantActions({ product: p, canSubscription: props.canSubscription, canEntitlement: props.canEntitlement, canSupport: props.canSupport, human: props.human, now });
  const reasons = actions.filter((a) => a.domain !== '');
  // Counts only (A1-4a). An ended row (or a tenant with no sending account) has no current
  // allowance: the designed empty state of the same bar (R-13; DV-B3-7).
  const allowance = s === null ? null : sign && sign.allowance.subscribed ? allowanceBar(sign.allowance.used, sign.allowance.limit) : { text: 'No current allowance period', pct: 0, warn: false };
  const overlays: SupportExtension[] = support ? support.extensions.filter((e) => e.active === true) : [];
  const supportSub = support?.subscriptions[0] ?? null;
  const self = s !== null && s.ended_at === null && isStripeOwned(s);
  const open = p.open_request;
  const actionable = open !== null && detail?.actionable === true && (open.state === 'APPROVED' || open.state === 'APPLY_FAILED');
  const title = productLabel(p.product_key);
  const recon = (f: HeldFlag) => f.reason === GOVERNED_HOLD && needsRelease(f) && props.canSubscription && props.human && open === null;

  return (
    <section className="sx-card cs-card" aria-label={title} data-product={p.product_key}>
      <div className="sx-card__head">
        <h2 className="sx-card__title">{title}</h2>
        <Pill tone={ent.tone}>{ent.label}</Pill>
        {badge ? <span className={`sx-src${badge.stripe ? ' sx-src--stripe' : ''}`}>{badge.label}</span> : null}
        <span className="cs-prov">{prov}</span>
      </div>
      <div className="sx-card__body">
        {!p.registered ? <div className="sx-muted">No commercial plans yet — pricing not set. This product is granted as an entitlement only.</div> : null}
        {p.registered && s === null ? <div className="sx-muted">No open base subscription.</div> : null}
        {s !== null ? (
          <>
            <div className="sx-facts">
              {subscriptionFacts(s, now).map((f) => (
                <div key={f.k}>
                  <div className="sx-facts__k">{f.k}</div>
                  <div className={`sx-facts__v${f.tone && f.k === 'Status' ? ` cs-fact--${f.tone}` : ''}`}>{f.v}</div>
                  <div className="sx-facts__s">{f.s}</div>
                </div>
              ))}
              {/* CCP-UI-V12 (AM-9; C5): the designed disabled tax state, from the billing-status `tax` field. */}
              {p.product_key === 'sign' && props.invoice?.tax?.enabled === false ? (
                <div data-testid="fact-tax">
                  <div className="sx-facts__k">Tax</div>
                  <div className="sx-facts__v">Not enabled</div>
                  <div className="sx-facts__s">Pending Stripe Tax registration</div>
                </div>
              ) : null}
              {/* CCP-UI-V12 (v1.2 §17.2; FA-4): Payment (the server's due booleans, shown only when the
                  invoice read is AVAILABLE) and, when due or overdue, Amount due (withheld without amount-read). */}
              {p.product_key === 'sign' && props.invoice !== null && props.invoice.availability === 'AVAILABLE' ? (
                <>
                  <div data-testid="fact-payment">
                    <div className="sx-facts__k">Payment</div>
                    <div className="sx-facts__v" />
                    <div className="cs-fact__due">
                      <PaymentDueIndicator state={paymentDueState(props.invoice)} />
                    </div>
                    <div className="sx-facts__s">{props.invoice.amount_withheld ? 'Due status only' : ''}</div>
                  </div>
                  {paymentDueState(props.invoice) !== 'NOT_DUE' ? (
                    <div data-testid="fact-amount-due">
                      <div className="sx-facts__k">Amount due</div>
                      {props.invoice.amount_withheld ? (
                        <>
                          <div className="sx-facts__v" />
                          <div className="cs-fact__due">
                            <WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="cell" />
                          </div>
                          <div className="sx-facts__s">Finance access required</div>
                        </>
                      ) : (
                        <>
                          {/* C3 is NOT DELIVERED: the amount is not read for display (A1-4a). */}
                          <div className="sx-facts__v">Not yet available</div>
                          <div className="sx-facts__s">Invoice read pending provider configuration</div>
                        </>
                      )}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
            {allowance ? (
              <div className="cs-allow">
                <div className="cs-allow__head">
                  <span className="cs-allow__label">Allowance this period</span>
                  <span className="cs-allow__value">{allowance.text}</span>
                </div>
                <div className="cs-allow__track" role="meter" aria-label="Allowance this period" aria-valuemin={0} aria-valuemax={100} aria-valuenow={allowance.pct} aria-valuetext={allowance.text}>
                  <div className={allowance.warn ? 'cs-allow__fill cs-allow__fill--warn' : 'cs-allow__fill'} style={{ width: `${allowance.pct}%` }} />
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {/* Conversion Rule C-8 — a held activation, surfaced to operators (TD-A6-12: operator-only detail). */}
        {p.flags.map((f) => (
          <div key={f.id} role="alert" className="cs-recon" data-testid="held-activation">
            <b>{flagTitle(f)}</b> {flagDetail(f, s)}
            {f.reason === GOVERNED_HOLD ? ' The MANUAL subscription was not replaced.' : null}
            {f.reason === GOVERNED_HOLD ? (
              <div className="cs-recon__row">
                <span>{releaseState(f)}</span>
                {f.conversion ? (
                  <Link className="cs-recon__ref" to={approvalsHref(f.conversion.change_request_id)}>
                    {crRef(f.conversion.change_request_id)}
                  </Link>
                ) : null}
                {recon(f) ? (
                  <Button unstyled className="cs-recon__btn" onClick={() => props.onAction('recon', f)} data-action="recon">
                    Request reconciliation release…
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}

        {overlays.map((e) => {
          const v = overlayView(e, { all: support?.extensions ?? [], policy: support?.policy ?? null, subscription: supportSub, meId: props.meId, meName: props.meName, now });
          return (
            <div key={e.id} className="sx-overlay">
              <ExceptionOverlay
                exception={v.exception}
                title={v.title}
                reference={v.ref}
                rows={[
                  { label: 'Actor', value: v.actor },
                  { label: 'Roles at the time', value: v.roles },
                  { label: 'Policy clause', value: v.clause },
                  { label: `Uses in ${support?.policy?.clause.support_extension_frequency_window_days ?? 90}-day window`, value: v.uses },
                  { label: 'Cumulative days', value: v.cumulative },
                  { label: 'Stripe billing', value: v.billing },
                ]}
              />
            </div>
          );
        })}

        {self ? (
          <div className="cs-self" data-testid="managed-in-stripe">
            <span>
              <b>Managed in Stripe.</b> The tenant pays through self-service checkout. Aramo doesn't edit this subscription.
            </span>
            <span className="cs-self__links">
              {/* CCP-R3 (CCP-A1 Amendment A1): a holder of platform:billing:amount:read gets the link;
                  any other billing reader gets the withheld state and the due / overdue boolean only (FA-4). */}
              {invoice?.availability === 'AVAILABLE' && invoice.hosted_url ? (
                <a className="cs-self__link" href={invoice.hosted_url} target="_blank" rel="noopener noreferrer">
                  Invoices ↗
                </a>
              ) : invoice?.availability === 'AVAILABLE' && invoice.amount_withheld ? (
                <span className="cs-self__off" data-testid="invoices-withheld" title="Invoice amounts need the Finance amount permission.">
                  Invoices · withheld · {invoice.payment_overdue ? 'payment overdue' : invoice.payment_due ? 'payment due' : 'no payment due'}
                </span>
              ) : (
                <span className="cs-self__off" title="Stripe link-outs aren’t enabled yet.">
                  Invoices
                </span>
              )}
              {/* TD-C3-1: no operator link target is ruled for these three (a portal session would act as the tenant). */}
              {['Payment methods', 'Proration', 'Cancellation'].map((l) => (
                <span key={l} className="cs-self__off" title="No operator link to Stripe is available for this yet.">
                  {l}
                </span>
              ))}
            </span>
          </div>
        ) : null}

        {open !== null ? (
          <div className="sx-open" data-testid="open-request">
            <span>
              Open request{' '}
              <Link className="sx-open__ref" to={approvalsHref(open.id)}>
                {crRef(open.id)}
              </Link>{' '}
              · {openRequestText(open, detail?.pendingProvider === true)}
            </span>
            {actionable ? (
              <Button
                unstyled
                className={`pw-btn pw-btn--30 pw-btn--normal sx-open__apply${props.applying === open.id ? ' pw-btn--dim' : ''}`}
                disabled={props.applying === open.id}
                aria-busy={props.applying === open.id || undefined}
                onClick={props.onApply}
              >
                {open.state === 'APPLY_FAILED' ? 'Retry apply' : 'Apply'}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="sx-actions">
          {actions.map((a) => (
            <Button
              key={a.key}
              unstyled
              className={`pw-btn pw-btn--34 pw-btn--secondary${a.danger ? ' sx-btn-danger' : ''}${a.disabled ? ' pw-btn--dim' : ''}`}
              disabled={a.disabled}
              title={a.why || undefined}
              data-action={a.key}
              onClick={() => props.onAction(a.key)}
            >
              {a.label}
            </Button>
          ))}
        </div>
        {reasons.length > 0 ? (
          <ul className="sx-reasons">
            {reasons.map((a) => (
              <li key={a.key}>
                <b>{a.label.replace('…', '')}:</b> {a.domain}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
