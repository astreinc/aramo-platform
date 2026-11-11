import { useCallback, useEffect, useState } from 'react';
import { Button } from '@aramo/fe-foundation';

import { catalogApi, type BillingMismatchEntry, type BillingProductView } from './catalog-api';
import { PROVIDER_LABEL, billingStatusText, canRetry, formatMinor } from './billing-products-model';

// CCP Billing Products, One Catalog Across Web and Apps, Directive v1.0 (LOCKED) — the plan version's billing
// products on the version screen: each channel's permanent product id, whether it sells this version, the
// latest sync (with the provider's state and error), Retry for the owner (BP-14), and the price check for
// Finance (BP-12: catalog price vs each channel's live price, the US price included).

export function BillingProductsPanel(props: { versionId: string; canRetry: boolean; canReadBilling: boolean }) {
  const { versionId, canRetry: mayRetry, canReadBilling } = props;
  const [items, setItems] = useState<BillingProductView[] | null>(null);
  const [mismatch, setMismatch] = useState<BillingMismatchEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await catalogApi.getVersion(versionId);
      // An older platform-admin (rolling deploy) returns no billing_products: show none.
      setItems(d.billing_products ?? []);
      if (canReadBilling) setMismatch((await catalogApi.billingMismatchReport()).filter((m) => m.plan_version_id === versionId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Billing products couldn’t be loaded.');
    }
  }, [versionId, canReadBilling]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (syncId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await catalogApi.retryBillingSync(syncId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The retry couldn’t be queued.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pc-addons" data-testid="billing-products-panel">
      <div className="pc-caps pc-caps--16">Billing products</div>
      {items === null ? null : items.length === 0 ? (
        <p className="pc-addons__intro">No billing products yet. They are set when a version of this plan is published.</p>
      ) : (
        <div className="pc-diff" role="table" aria-label="Billing products of this version">
          {items.map((v) => {
            const s = billingStatusText(v);
            return (
              <div key={`${v.provider}:${v.interval}`} role="row" className={`pc-diff__row${s.tone === 'bad' ? ' pc-diff__row--changed' : ''}`}>
                <span role="cell" className="pc-diff__field">
                  {PROVIDER_LABEL[v.provider]}
                </span>
                <span role="cell" className="pc-diff__before">
                  {v.product_id}
                </span>
                <span role="cell" className="pc-diff__after">
                  {s.label}
                  {s.detail !== null ? <span className="pc-addons__intro">{` — ${s.detail}`}</span> : null}
                </span>
                <span role="cell" className="pc-diff__mark">
                  {mayRetry && canRetry(v) && v.sync !== null ? (
                    <Button unstyled type="button" className="pc-btn" disabled={busy} aria-label={`Retry the ${PROVIDER_LABEL[v.provider]} sync`} onClick={() => void retry(v.sync?.id ?? '')}>
                      Retry
                    </Button>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {mismatch !== null && mismatch.length > 0 ? (
        <>
          <div className="pc-caps pc-caps--16">Price check</div>
          <div className="pc-diff" role="table" aria-label="Catalog price compared with each channel">
            {mismatch.map((m) => (
              <div key={`${m.provider}:${m.country}`} role="row" className={`pc-diff__row${m.status === 'MATCH' ? '' : ' pc-diff__row--changed'}`}>
                <span role="cell" className="pc-diff__field">{`${PROVIDER_LABEL[m.provider]} · ${m.country}`}</span>
                <span role="cell" className="pc-diff__before">{formatMinor(m.catalog_amount_minor, m.currency)}</span>
                <span role="cell" className="pc-diff__after">
                  {m.live_amount_minor === null ? MISMATCH_TEXT[m.status] : `${formatMinor(m.live_amount_minor, m.currency)} · ${MISMATCH_TEXT[m.status]}`}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {error !== null ? (
        <p className="pc-alert" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const MISMATCH_TEXT: Record<BillingMismatchEntry['status'], string> = {
  MATCH: 'matches the catalog',
  MISMATCH: 'differs from the catalog',
  MISSING_IN_STORE: 'not set in the store',
  STORE_PRICE_UNAVAILABLE: 'live price unavailable',
};
