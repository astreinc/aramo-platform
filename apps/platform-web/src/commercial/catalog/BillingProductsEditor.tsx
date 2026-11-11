import { useState } from 'react';
import { Button, Checkbox, Input } from '@aramo/fe-foundation';

import { catalogApi, type BillingPreviewChannel } from './catalog-api';
import { BILLING_PRODUCTS_INTRO, PROVIDER_LABEL, billingEditorErrors, formatMinor, needsReviewScreenshot, type BillingEditorRow } from './billing-products-model';

// CCP Billing Products, One Catalog Across Web and Apps, Directive v1.0 (LOCKED) — the billing products of a
// publish request, inside the "Request publish" dialog: which channels sell this version (BP-2), their
// permanent ids (BP-3), the App Store review screenshot of a new App Store product (BP-7), and the exact
// price each channel will charge (BP-5 preview: never rounded; a missing store price blocks the request).

export function BillingProductsEditor(props: {
  planId: string;
  versionId: string;
  rows: BillingEditorRow[];
  onRows: (rows: BillingEditorRow[]) => void;
  screenshotId: string | null;
  onScreenshot: (id: string | null) => void;
}) {
  const { planId, versionId, rows, onRows, screenshotId, onScreenshot } = props;
  const [preview, setPreview] = useState<BillingPreviewChannel[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shotName, setShotName] = useState<string | null>(null);
  const errors = billingEditorErrors(rows, screenshotId);

  const set = (i: number, patch: Partial<BillingEditorRow>) => {
    onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setPreview(null);
  };

  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const base64 = await fileBase64(file);
      const out = await catalogApi.uploadReviewScreenshot(planId, { name: file.name, type: file.type, base64 });
      onScreenshot(out.id);
      setShotName(`${file.name} (${String(out.width)} × ${String(out.height)})`);
    } catch (e) {
      onScreenshot(null);
      setShotName(null);
      setError(e instanceof Error ? e.message : 'The screenshot couldn’t be uploaded.');
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await catalogApi.previewBilling(versionId, rows.filter((r) => r.selected).map((r) => ({ provider: r.provider, interval: r.interval, product_id: r.product_id.trim() }))));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The preview couldn’t be loaded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pc-addons" data-testid="billing-products-editor">
      <div className="pc-caps pc-caps--16">Billing products</div>
      <p className="pc-addons__intro">{BILLING_PRODUCTS_INTRO}</p>
      <div className="pc-diff" role="table" aria-label="Billing products">
        {rows.map((r, i) => (
          <div key={r.provider} role="row" className="pc-diff__row">
            <span role="cell" className="pc-diff__mark">
              <Checkbox unstyled aria-label={`Sell on ${PROVIDER_LABEL[r.provider]}`} checked={r.selected} disabled={busy} onChange={(e) => set(i, { selected: e.target.checked })} />
            </span>
            <span role="cell" className="pc-diff__field">
              {PROVIDER_LABEL[r.provider]}
            </span>
            <span role="cell" className="pc-diff__after">
              <Input
                unstyled
                className={`pc-input${r.locked ? '' : ' pc-input--editable'}`}
                aria-label={`${PROVIDER_LABEL[r.provider]} product id`}
                value={r.product_id}
                readOnly={r.locked}
                disabled={r.locked || !r.selected || busy}
                title={r.locked ? 'Permanent: a billing product id never changes.' : 'Set once; permanent after the first sync.'}
                onChange={(e) => set(i, { product_id: e.target.value })}
              />
              {r.sold && !r.selected ? <span className="pc-alert" role="note">{`Stops selling on ${PROVIDER_LABEL[r.provider]}`}</span> : null}
            </span>
          </div>
        ))}
      </div>
      {needsReviewScreenshot(rows) ? (
        <label className="pc-field" data-testid="review-screenshot">
          <span className="pc-field__label">App Store review screenshot (the in-app Plans screen, an iPhone screenshot)</span>
          <Input unstyled type="file" accept="image/png,image/jpeg" aria-label="App Store review screenshot" disabled={busy} onChange={(e) => void upload(e.target.files?.[0])} />
          {shotName !== null ? <span className="pc-addons__intro">{`Uploaded: ${shotName}`}</span> : null}
        </label>
      ) : null}
      <Button unstyled type="button" className="pc-btn" disabled={busy || errors.length > 0 || !rows.some((r) => r.selected)} onClick={() => void runPreview()}>
        Preview prices
      </Button>
      {preview !== null ? (
        <div className="pc-diff" role="table" aria-label="Price preview" data-testid="billing-preview">
          {preview.flatMap((c) =>
            !c.configured
              ? [
                  <div key={`${c.provider}-nc`} role="row" className="pc-diff__row">
                    <span role="cell" className="pc-diff__field">{PROVIDER_LABEL[c.provider]}</span>
                    <span role="cell" className="pc-diff__after">Not connected yet: the price is checked when it syncs.</span>
                  </div>,
                ]
              : c.error !== null
                ? [
                    <div key={`${c.provider}-err`} role="row" className="pc-diff__row pc-diff__row--changed">
                      <span role="cell" className="pc-diff__field">{PROVIDER_LABEL[c.provider]}</span>
                      <span role="cell" className="pc-diff__after">{c.error}</span>
                    </div>,
                  ]
                : c.prices.map((p) => (
                    <div key={`${c.provider}-${p.country}`} role="row" className={`pc-diff__row${p.available ? '' : ' pc-diff__row--changed'}`}>
                      <span role="cell" className="pc-diff__field">{`${PROVIDER_LABEL[c.provider]} · ${p.country}`}</span>
                      <span role="cell" className="pc-diff__after">
                        {p.available ? formatMinor(p.amount_minor, p.currency) : `${formatMinor(p.amount_minor, p.currency)} is not a store price. Nearest: ${p.nearest.map((n) => formatMinor(n, p.currency)).join(', ') || 'none'}`}
                      </span>
                    </div>
                  )),
          )}
        </div>
      ) : null}
      {[...errors, ...(error !== null ? [error] : [])].map((m) => (
        <p key={m} className="pc-alert" role="alert">
          {m}
        </p>
      ))}
    </div>
  );
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('The file couldn’t be read.'));
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.readAsDataURL(file);
  });
}
