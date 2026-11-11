import { useState } from 'react';
import { Button, Input, Select } from '@aramo/fe-foundation';

import type { CatalogRegionalPrice, CatalogVersion } from './catalog-api';
import { formatRegionalPrice, parseRegionalPriceInput, regionalRows } from './regional-prices-model';

// Sign Mobile M-A12 Amendment A1-3 — the regional price editor and display on the plan version screen.
// Every viewer sees the version's regional prices; only a catalog manager edits them, and only on a
// DRAFT (a published version's prices are immutable; a change is a new version approved Finance →
// Owner through "Request publish").

export const REGIONAL_PRICES_INTRO =
  'Regional list prices by country and interval (for example IN / INR). They also decide where the apps sell: the App Store and Google Play sell a plan in the US and in each country listed here, at exactly this price. Stripe stays US-only.';

export type RegionalPriceEdit = { country: string; interval: 'MONTH' | 'YEAR'; currency: string; amount_minor: number | null };

export function RegionalPricesEditor(props: { version: CatalogVersion; canDraft: boolean; onSave: (edits: RegionalPriceEdit[]) => Promise<void> }) {
  const { version, canDraft, onSave } = props;
  const editable = canDraft && version.status === 'DRAFT';
  const rows = regionalRows(version.terms.regional_prices);
  const [form, setForm] = useState<{ country: string; currency: string; interval: 'MONTH' | 'YEAR'; amount: string }>({ country: '', currency: '', interval: 'MONTH', amount: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (edits: RegionalPriceEdit[]): Promise<void> => {
    setBusy(true);
    try {
      await onSave(edits);
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const parsed = parseRegionalPriceInput(form);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    await save([parsed.edit]);
    setForm({ country: '', currency: '', interval: form.interval, amount: '' });
  };

  const remove = (r: CatalogRegionalPrice) => save([{ country: r.country, interval: r.interval, currency: r.currency, amount_minor: null }]);

  return (
    <div className="pc-addons" data-testid="regional-prices">
      <div className="pc-caps pc-caps--16">Regional prices (store billing)</div>
      <p className="pc-addons__intro">{REGIONAL_PRICES_INTRO}</p>
      {rows.length === 0 ? (
        <p className="pc-addons__intro" data-testid="regional-prices-empty">
          No regional prices on this version.
        </p>
      ) : (
        <div className="pc-diff" role="table" aria-label="Regional prices">
          {rows.map((r) => (
            <div key={`${r.country}:${r.interval}`} role="row" className="pc-diff__row">
              <span role="cell" className="pc-diff__field">
                {r.country}
              </span>
              <span role="cell" className="pc-diff__after">
                {formatRegionalPrice(r)}
              </span>
              <span role="cell" className="pc-diff__mark">
                {editable ? (
                  <Button unstyled type="button" className="pc-btn" disabled={busy} aria-label={`Remove the ${r.country} ${r.interval === 'YEAR' ? 'annual' : 'monthly'} price`} onClick={() => void remove(r)}>
                    Remove
                  </Button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      )}
      {editable ? (
        <div className="pc-fields" data-testid="regional-price-form">
          <label className="pc-field">
            <span className="pc-field__label">Country</span>
            <Input unstyled className="pc-input pc-input--editable" aria-label="Regional price country" maxLength={2} placeholder="IN" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
          </label>
          <label className="pc-field">
            <span className="pc-field__label">Currency</span>
            <Input unstyled className="pc-input pc-input--editable" aria-label="Regional price currency" maxLength={3} placeholder="INR" value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
          </label>
          <label className="pc-field">
            <span className="pc-field__label">Interval</span>
            <Select unstyled className="pc-input pc-input--editable" aria-label="Regional price interval" value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value === 'YEAR' ? 'YEAR' : 'MONTH' })}>
              <option value="MONTH">Monthly</option>
              <option value="YEAR">Annual</option>
            </Select>
          </label>
          <label className="pc-field">
            <span className="pc-field__label">Price</span>
            <Input unstyled type="text" inputMode="decimal" className="pc-input pc-input--editable" aria-label="Regional price amount" placeholder="899.00" value={form.amount} aria-invalid={error !== null || undefined} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </label>
          <Button unstyled type="button" className="pc-btn" disabled={busy} onClick={() => void add()}>
            Set price
          </Button>
          {error !== null ? (
            <p className="pc-alert" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
