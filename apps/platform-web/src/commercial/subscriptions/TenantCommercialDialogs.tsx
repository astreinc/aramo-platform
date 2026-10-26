import { useEffect, useId, useMemo, useState } from 'react';
import { Input, Select } from '@aramo/fe-foundation';

import { ChainPreview, CommercialRequestDialog, RequestField, type CommercialCommitTone, type CommercialDiffRow } from '../../components';
import { catalogApi, type Catalog, type CatalogPlan, type CatalogVersion } from '../catalog/catalog-api';
import { planTitle } from '../catalog/catalog-model';
import type { SupportPolicy } from '../support-extensions/support-extension-api';

import {
  newRequestKey,
  subscriptionsApi,
  type ChangeRequestRef,
  type HeldFlag,
  type ProductCommercial,
  type SubscriptionFacts,
  type TenantActionType,
} from './subscriptions-api';
import { grantCapabilities, productLabel, refusalLine, revokeCapabilities } from './subscriptions-model';

// CCP-B3 — the Tenant › Commercial request dialogs (CCP-UI v1.0 handoff §5.9, §5.10;
// Commercial Control Plane v1.0.dc.html `dlgPlan` / `dlgSimple` :700-720). Each one CREATES A
// CHANGE REQUEST (CCP-A3 create, then submit unless saved as a draft): nothing is applied until
// its chain is signed and the requester applies it (PLATFORM-UX-1 Amendment A1-2; PBD §5.3 B3
// HALT "Any direct edit path"). The chain the server resolves for every action here is the
// Finance-only chain (PO ruling TD-A3-2), shown in the chain strip.

export type DialogKind = 'plan' | 'cancel' | 'grant' | 'revoke' | 'recon' | 'convert';

export interface TenantDialogProps {
  readonly kind: DialogKind;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly product: ProductCommercial;
  /** The flag a reconciliation release names (kind 'recon'). */
  readonly flag?: HeldFlag | null;
  /** The ACTIVE policy (number + approval window) for the chain strip; null = unknown. */
  readonly policy: Pick<SupportPolicy, 'version_number' | 'approval_expiry_hours'> | null;
  readonly onClose: () => void;
  readonly onDone: (request: ChangeRequestRef, submitted: boolean) => void;
}

/** "$59 / month" — the catalog list price of a version (USD minor units), or null when contract-priced. */
export function priceLabel(v: Pick<CatalogVersion, 'terms'> | null): string | null {
  if (v === null || v.terms.list_price_minor === null) return null;
  const n = v.terms.list_price_minor / 100;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} / month`;
}

function allowanceLabel(v: Pick<CatalogVersion, 'terms'> | null): string {
  if (v === null || !v.terms.envelopes_present) return '—';
  if (v.terms.envelopes_unlimited) return 'Unlimited envelopes';
  return `${(v.terms.envelopes_per_month ?? 0).toLocaleString('en-US')} envelopes`;
}

/** The plan versions a plan change may name: the newest PUBLISHED version of each list-priced plan of the product. */
export function planChoices(catalog: Catalog | null, product: string): { plan: CatalogPlan; version: CatalogVersion }[] {
  const plans = catalog?.products.find((p) => p.product_key === product)?.plans ?? [];
  const out: { plan: CatalogPlan; version: CatalogVersion }[] = [];
  for (const plan of [...plans].sort((a, b) => a.display_order - b.display_order)) {
    if (plan.status !== 'ACTIVE' || plan.sales_model === 'CONTACT_SALES' || plan.sales_model === 'FREE') continue;
    const version = plan.versions.find((v) => v.status === 'PUBLISHED');
    if (version) out.push({ plan, version });
  }
  return out;
}

function findVersion(catalog: Catalog | null, product: string, versionId: string): CatalogVersion | null {
  for (const plan of catalog?.products.find((p) => p.product_key === product)?.plans ?? []) {
    const v = plan.versions.find((x) => x.id === versionId);
    if (v) return v;
  }
  return null;
}

interface Spec {
  readonly title: string;
  readonly sub: string;
  readonly tone: CommercialCommitTone;
  readonly typed: string | null;
  readonly canDraft: boolean;
}

function specOf(kind: DialogKind, tenantName: string, product: string): Spec {
  const prod = productLabel(product);
  switch (kind) {
    case 'plan':
      return { title: `Request plan change · ${tenantName}`, sub: 'Plans pin a version. The new plan applies at its latest published version once every approval step is signed.', tone: 'terra', typed: null, canDraft: true };
    case 'cancel':
      // DV-B3-6: SUBSCRIPTION_END does not revoke the entitlement (A6 TD-A6-8; A7 TD-A7-5).
      return { title: `Request cancel · ${prod}`, sub: `Ends the MANUAL subscription once approved. The ${prod} entitlement is not revoked by a cancel; request a revoke separately.`, tone: 'danger', typed: tenantName, canDraft: true };
    case 'grant':
      return { title: `Grant product · ${prod}`, sub: `Grants the ${prod} entitlement. Provenance is recorded as this change request.`, tone: 'terra', typed: null, canDraft: true };
    case 'revoke':
      return { title: `Revoke product · ${prod}`, sub: `People in ${tenantName} lose access to ${prod} once approved. Data is kept.`, tone: 'danger', typed: tenantName, canDraft: true };
    case 'recon':
      return { title: `Request reconciliation release · ${tenantName}`, sub: 'Cancels the blocked self-service checkout in Stripe and keeps the MANUAL contract subscription. Stripe confirms by webhook.', tone: 'terra', typed: null, canDraft: true };
    case 'convert':
      return {
        title: `Request conversion to MANUAL · ${tenantName}`,
        sub: 'Ends the self-service subscription in Stripe, then opens a governed MANUAL subscription on the chosen plan version. The MANUAL row opens only after Stripe confirms the end.',
        tone: 'terra',
        typed: null,
        canDraft: true,
      };
  }
}

const ACTION_OF: Readonly<Record<DialogKind, TenantActionType>> = {
  plan: 'SUBSCRIPTION_CHANGE',
  cancel: 'SUBSCRIPTION_END',
  grant: 'ENTITLEMENT_GRANT',
  revoke: 'ENTITLEMENT_REVOKE',
  recon: 'CONVERSION',
  convert: 'CONVERSION',
};

const row = (field: string, before: string, after: string): CommercialDiffRow => ({ field, before, after, changed: before !== after });

/** The live "Before → after" rows of a dialog. */
export function diffRows(kind: DialogKind, input: { readonly product: ProductCommercial; readonly current: CatalogVersion | null; readonly next: { plan: CatalogPlan; version: CatalogVersion } | null; readonly currentPlanName: string }): CommercialDiffRow[] {
  const prod = productLabel(input.product.product_key);
  const s = input.product.subscription;
  switch (kind) {
    case 'plan': {
      if (s === null) return [];
      const n = input.next;
      return [
        row('Plan', planTitle({ name: input.currentPlanName }), n ? planTitle(n.plan) : planTitle({ name: input.currentPlanName })),
        row('Plan version', `v${s.plan_version.version_number}`, n ? `v${n.version.version_number}` : `v${s.plan_version.version_number}`),
        row('Price', priceLabel(input.current) ?? 'Negotiated', n ? (priceLabel(n.version) ?? 'Negotiated') : (priceLabel(input.current) ?? 'Negotiated')),
        row('Discount', 'None', 'None'),
        row('Allowance', allowanceLabel(input.current), n ? allowanceLabel(n.version) : allowanceLabel(input.current)),
      ];
    }
    case 'cancel':
      return [row('Subscription', 'Active', 'Ended'), row(`${prod} entitlement`, 'Active', 'Active (unchanged)')];
    case 'grant':
      return [row(`${prod} entitlement`, input.product.entitlement.state === 'REVOKED' ? 'Revoked' : 'Not granted', 'Active')];
    case 'revoke':
      return [row(`${prod} entitlement`, 'Active', 'Revoked')];
    case 'recon':
      return [row('Self-service checkout subscription', 'Held (not activated)', 'Cancelled in Stripe'), row('MANUAL subscription', 'Active', 'Active (unchanged)'), row('Reconciliation flag', 'Open', 'Released')];
    case 'convert': {
      const n = input.next;
      return [
        row('Source', 'Managed in Stripe', 'MANUAL (governed)'),
        row('Plan', s ? planTitle({ name: input.currentPlanName }) : '—', n ? planTitle(n.plan) : '—'),
        row('Plan version', s ? `v${s.plan_version.version_number}` : '—', n ? `v${n.version.version_number}` : '—'),
      ];
    }
  }
}

/** The payload of the change request a dialog creates (CCP-A3 / C2 closed key sets). */
export function payloadOf(kind: DialogKind, input: { readonly product: ProductCommercial; readonly flag: HeldFlag | null; readonly next: { plan: CatalogPlan; version: CatalogVersion } | null; readonly evidence: string }): Record<string, unknown> | null {
  const s: SubscriptionFacts | null = input.product.subscription;
  switch (kind) {
    case 'plan':
      return s && input.next ? { subscription_id: s.subscription_id, plan_key: input.next.plan.key, plan_version_id: input.next.version.id } : null;
    case 'cancel':
      if (s === null) return null;
      // CCP-B4: a contract-linked row's end names its contract (commercial-contract.ts:49).
      return s.contract ? { subscription_id: s.subscription_id, contract_end: { contract_id: s.contract.id, documents: [], evidence_ref: input.evidence.trim() } } : { subscription_id: s.subscription_id };
    case 'grant':
      return { capabilities: grantCapabilities(input.product.product_key) };
    case 'revoke':
      return { capabilities: revokeCapabilities(input.product.product_key) };
    case 'recon':
      return s && input.flag ? { direction: 'TO_GOVERNED', held_subscription_ref: input.flag.subscription_ref, governed_subscription_id: s.subscription_id } : null;
    case 'convert':
      return s && input.next ? { direction: 'TO_GOVERNED', subscription_id: s.subscription_id, plan_key: input.next.plan.key, plan_version_id: input.next.version.id } : null;
  }
}

export function TenantRequestDialog({ kind, tenantId, tenantName, product, flag = null, policy, onClose, onDone }: TenantDialogProps) {
  const spec = specOf(kind, tenantName, product.product_key);
  const needsCatalog = kind === 'plan' || kind === 'convert';
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [planVersion, setPlanVersion] = useState('');
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<string | null>(null);
  const selectId = useId();
  const discountId = useId();
  const key = useMemo(() => newRequestKey(`b3-${kind}`), [kind]);

  useEffect(() => {
    if (!needsCatalog) return;
    let cancelled = false;
    catalogApi.getCatalog().then(
      (c) => {
        if (cancelled) return;
        setCatalog(c);
        // Design `init: { plan: sub.plan }`: the current plan, at its latest published version.
        const cur = product.subscription;
        const choices = planChoices(c, product.product_key);
        const same = cur ? choices.find((x) => x.plan.id === cur.plan.id) : undefined;
        setPlanVersion((same ?? choices[0])?.version.id ?? '');
      },
      () => {
        if (!cancelled) setCatalogError('The catalog couldn’t be loaded, so no plan can be chosen.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsCatalog, product]);

  const choices = planChoices(catalog, product.product_key);
  const next = choices.find((x) => x.version.id === planVersion) ?? null;
  const current = product.subscription ? findVersion(catalog, product.product_key, product.subscription.plan_version.id) : null;
  const diff = diffRows(kind, { product, current, next, currentPlanName: product.subscription?.plan.name ?? '' });
  const payload = payloadOf(kind, { product, flag, next, evidence });
  const unchanged = kind === 'plan' && next !== null && product.subscription !== null && next.version.id === product.subscription.plan_version.id;
  const valid = payload !== null && !unchanged && reason.trim().length > 0 && evidence.trim().length > 0;

  const commit = async (submit: boolean): Promise<void> => {
    if (payload === null) return;
    setBusy(true);
    setAlert(null);
    try {
      const request = await subscriptionsApi.request({ action_type: ACTION_OF[kind], tenant_id: tenantId, payload, reason, evidence, submit, idempotency_key: key });
      onDone(request, submit);
    } catch (err) {
      setAlert(refusalLine(err));
      setBusy(false);
    }
  };

  const typedOk = spec.typed === null || typed === spec.typed;

  return (
    <CommercialRequestDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={spec.title}
      sub={spec.sub}
      diff={diff}
      chain={<ChainPreview label="Below threshold" steps={['Finance']} policy={policy ? `v${policy.version_number}` : '—'} window={policy ? `${policy.approval_expiry_hours} h` : '—'} />}
      typed={spec.typed === null ? null : { token: spec.typed, value: typed, onChange: setTyped }}
      alert={alert ?? catalogError}
      commitLabel="Submit for approval"
      tone={spec.tone}
      canCommit={valid}
      busy={busy}
      onCommit={() => void commit(true)}
      secondary={spec.canDraft ? { label: 'Save as draft', disabled: !valid || !typedOk, onClick: () => void commit(false) } : null}
    >
      {needsCatalog ? (
        <div className="pw-crd__field">
          <label className="pw-crd__label" htmlFor={selectId}>
            New plan
          </label>
          <Select unstyled id={selectId} className="cs-dlg-select" value={planVersion} onChange={(e) => setPlanVersion(e.target.value)}>
            {choices.map((c) => (
              <option key={c.version.id} value={c.version.id}>
                {`${planTitle(c.plan)} v${c.version.version_number}${priceLabel(c.version) ? ` · ${priceLabel(c.version)}` : ''}`}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {kind === 'plan' ? (
        // DV-B3-5: a plan change carries no discount (SUBSCRIPTION_CHANGE has no discount term; a
        // DISCOUNT is a billing request with no governed apply yet): the designed disabled field (R-13).
        <div className="pw-crd__field">
          <label className="pw-crd__label" htmlFor={discountId}>
            Discount (%)
          </label>
          <Input unstyled id={discountId} type="number" className="cs-dlg-num" value="0" disabled aria-describedby={`${discountId}-help`} title="A discount is a separate billing request and isn’t available on a plan change yet." onChange={() => undefined} />
          <span id={`${discountId}-help`} className="cs-dlg-help">
            Discounts are requested separately and aren’t available on a plan change yet.
          </span>
        </div>
      ) : null}
      <RequestField label="Reason" value={reason} onChange={setReason} placeholder="Why this change is needed" multiline />
      <RequestField label="Evidence" value={evidence} onChange={setEvidence} placeholder="Document, ticket or call notes reference" />
    </CommercialRequestDialog>
  );
}
