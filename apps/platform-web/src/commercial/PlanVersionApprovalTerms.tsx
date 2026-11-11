import { useEffect, useState } from 'react';

import { PROVIDER_LABEL, formatMinor } from './catalog/billing-products-model';
import { catalogApi, type BillingPreviewChannel, type BillingProductsPayload, type CatalogMeteredUnit, type CatalogVersionDetail } from './catalog/catalog-api';
import { money, unitName, unitPriceText, versionTitle } from './catalog/catalog-model';

// Sign Feature Parity Amendments A3 (D1) / A4 (D2) — what Finance and the Owner approve on a
// PLAN_VERSION_PUBLISH request: the version's terms INCLUDING its add-on unit prices, and the
// content fingerprint the request snapshotted at creation (`target_content_checksum`). The apply
// publishes only that fingerprint (VERSION_CONTENT_CHANGED otherwise), so the screen says plainly
// when the draft changed after the request was made.

export const PLAN_TARGET_CHECKSUM_KEY = 'target_content_checksum';

export interface ApprovalTermRow {
  readonly field: string;
  readonly value: string;
}

export interface PlanVersionApprovalModel {
  readonly title: string;
  readonly rows: readonly ApprovalTermRow[];
  /** null when the request predates the snapshot (pre-A3). */
  readonly fingerprint: string | null;
  /** true when the version's content no longer equals the approved fingerprint. */
  readonly changed: boolean;
}

export function planVersionApprovalModel(d: CatalogVersionDetail, units: readonly CatalogMeteredUnit[], approvedChecksum: string | null): PlanVersionApprovalModel {
  const t = d.version.terms;
  const rows: ApprovalTermRow[] = [{ field: 'Price', value: t.list_price_minor === null ? 'Contract-priced' : `${money(t.list_price_minor)} / month` }];
  const prices = t.unit_prices ?? [];
  if (prices.length === 0) rows.push({ field: 'Add-on unit prices', value: 'None sold' });
  for (const u of prices) rows.push({ field: `Add-on · ${unitName(u.unit_key, units)}`, value: `${unitPriceText(u.unit_price_minor)} per unit` });
  return {
    title: versionTitle(d.plan, d.version),
    rows,
    fingerprint: approvedChecksum,
    changed: approvedChecksum !== null && approvedChecksum !== d.version.content_checksum,
  };
}

/**
 * CCP Billing Products (BP-5 / BP-10 / BP-11) — what the approver approves about the channels: each billing
 * product the publish links, every channel it stops selling on, and (from the preview) the exact price each
 * channel will charge per country. A request without billing products says so.
 */
export function billingApprovalRows(payload: Readonly<Record<string, unknown>>, preview: readonly BillingPreviewChannel[] | null): ApprovalTermRow[] {
  const bp = payload['billing_products'] as BillingProductsPayload | undefined;
  if (bp === undefined) return [{ field: 'Billing products', value: 'None in this request (the plan sells on no channel)' }];
  const rows: ApprovalTermRow[] = [];
  for (const p of bp.products) {
    const ch = preview?.find((c) => c.provider === p.provider && c.interval === p.interval);
    const prices = ch === undefined ? '' : !ch.configured ? ' · price checked when it syncs' : ch.error !== null ? ` · ${ch.error}` : ` · ${ch.prices.map((x) => `${x.country} ${formatMinor(x.amount_minor, x.currency)}${x.available ? '' : ' (not a store price)'}`).join(', ')}`;
    rows.push({ field: `Sells on ${PROVIDER_LABEL[p.provider]}`, value: `${p.product_id}${prices}` });
  }
  if (bp.products.length === 0) rows.push({ field: 'Billing products', value: 'Sold on no channel' });
  for (const s of bp.stop_selling ?? []) rows.push({ field: `Stops selling on ${PROVIDER_LABEL[s]}`, value: 'Yes: new purchases on this channel end with this version' });
  if (bp.listing !== undefined) rows.push({ field: 'Store listing', value: `${bp.listing.name} — ${bp.listing.description}` });
  if ((bp.stop_countries ?? []).length > 0) rows.push({ field: 'Stops selling in (stores)', value: `${(bp.stop_countries ?? []).join(', ')}: new store purchases there end with this version` });
  if (bp.apple_review_screenshot_asset_id !== undefined) rows.push({ field: 'App Store review screenshot', value: 'Attached' });
  return rows;
}

export function PlanVersionApprovalTerms({ payload }: { readonly payload: Readonly<Record<string, unknown>> }) {
  const versionId = typeof payload['plan_version_id'] === 'string' ? payload['plan_version_id'] : null;
  const approved = typeof payload[PLAN_TARGET_CHECKSUM_KEY] === 'string' ? (payload[PLAN_TARGET_CHECKSUM_KEY] as string) : null;
  const [model, setModel] = useState<PlanVersionApprovalModel | null>(null);
  const [failed, setFailed] = useState(false);
  const [preview, setPreview] = useState<BillingPreviewChannel[] | null>(null);
  const billing = payload['billing_products'] as BillingProductsPayload | undefined;

  useEffect(() => {
    if (versionId === null) return;
    let live = true;
    void Promise.all([catalogApi.getVersion(versionId), catalogApi.getCatalog().catch(() => null)])
      .then(([d, c]) => {
        const units = c?.metered_units?.find((m) => m.product_key === d.plan.product_key)?.units ?? [];
        if (live) setModel(planVersionApprovalModel(d, units, approved));
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    // BP-5 — the exact per-channel prices (best effort: the request is still approvable without them).
    if (billing !== undefined && billing.products.length > 0) {
      void catalogApi
        .previewBilling(versionId, billing.products)
        .then((p) => {
          if (live) setPreview(p);
        })
        .catch(() => undefined);
    }
    return () => {
      live = false;
    };
  }, [versionId, approved, billing]);

  if (versionId === null) return null;
  return (
    <div data-testid="cr-plan-version-terms">
      <div className="pw-ccp-caps">Terms you approve</div>
      {failed ? (
        <div className="pw-alert pw-alert--warn" role="status">
          The plan version’s terms couldn’t be loaded. Open it in the catalog before approving.
        </div>
      ) : model === null ? (
        <div className="pc-dr-facts">Loading the plan version…</div>
      ) : (
        <>
          <dl className="pc-dr-facts">
            <dt>Version</dt>
            <dd>{model.title}</dd>
            {[...model.rows, ...billingApprovalRows(payload, preview)].map((row) => (
              <FactRow key={row.field} row={row} />
            ))}
            <dt>Terms fingerprint</dt>
            <dd>{model.fingerprint === null ? 'Not recorded (request made before unit-price approval)' : `${model.fingerprint.slice(0, 12)}…`}</dd>
          </dl>
          {model.changed ? (
            <div className="pw-alert pw-alert--warn" role="alert" data-testid="cr-plan-version-changed">
              The draft changed after this request was made. It can’t be published with this request; ask the catalog manager to request publish again.
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function FactRow({ row }: { readonly row: ApprovalTermRow }) {
  return (
    <>
      <dt>{row.field}</dt>
      <dd>{row.value}</dd>
    </>
  );
}
