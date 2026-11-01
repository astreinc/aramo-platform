import { useEffect, useState } from 'react';

import { billingApi, type BillingUsage } from '../api';
import { fmtDate } from '../ui';

// Sign Feature Parity D-2 (A1) — the organization's metered usage this billing period (SMS and
// WhatsApp delivery, verification, qualified signatures, e-stamps), as the backend reports it from
// the usage ledger. Hidden while dark: nothing renders unless the backend answers enabled with a
// period that has at least one unit sold or used. A failed read also renders nothing (the plan
// panel above stays the source of the plan state).

export function usageMoney(amount_minor: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(amount_minor / 100);
}

export function UsageCharges() {
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  useEffect(() => {
    let live = true;
    billingApi
      .usage()
      .then((u) => {
        if (live) setUsage(u);
      })
      .catch(() => {
        if (live) setUsage(null);
      });
    return () => {
      live = false;
    };
  }, []);

  const period = usage?.enabled === true ? usage.period : null;
  if (period === null || period.units.length === 0) return null;
  return (
    <section className="sg-card" data-testid="billing-metered-usage">
      <div className="sg-card__head">
        Usage this period
        <span className="sg-card__end sg-muted">
          {fmtDate(period.start)} – {fmtDate(period.end)}
        </span>
      </div>
      <div className="sg-card__body sg-grid" style={{ gap: 8 }}>
        {period.units.map((u) => (
          <div key={u.unit_key} data-testid={`billing-metered-${u.unit_key}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <span>
              <strong>{u.name}</strong>
              <span className="sg-muted">
                {' '}
                · {u.quantity} {u.quantity === 1 ? u.quantity_label : `${u.quantity_label}s`}
                {u.unit_price_minor !== null ? ` × ${usageMoney(u.unit_price_minor, period.currency)}` : ' · no longer on your plan'}
              </span>
            </span>
            <span>{usageMoney(u.amount_minor, period.currency)}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between' }} data-testid="billing-metered-total">
          <strong>Total this period</strong>
          <strong>{usageMoney(period.total_amount_minor, period.currency)}</strong>
        </div>
        <p className="sg-help">Usage is billed per unit at your plan’s price, in addition to the plan. Amounts exclude tax.</p>
      </div>
    </section>
  );
}
