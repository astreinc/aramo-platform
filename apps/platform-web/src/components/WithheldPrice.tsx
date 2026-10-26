import './finance-components.css';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.1, §13.10) — a LIST price the catalog cannot give for the
// row (contract-priced, a non-USD price, or no price): plain "Withheld" with "Reason: …". No chip,
// no lock: this is catalog data, not a Finance-scope redaction (see WithheldAmount).

export type WithheldPriceReason = 'contract-priced' | 'non-USD' | 'price missing';

export interface WithheldPriceProps {
  readonly reason: WithheldPriceReason;
  /** The currency of a non-USD price ("EUR"), shown as "non-USD (EUR)". */
  readonly currency?: string;
}

export function withheldPriceReason(reason: WithheldPriceReason, currency?: string): string {
  return reason === 'non-USD' && currency !== undefined ? `non-USD (${currency})` : reason;
}

export function WithheldPrice({ reason, currency }: WithheldPriceProps) {
  return (
    <span className="pw-wprice" data-testid="withheld-price">
      <span className="pw-wprice__v">Withheld</span>
      <div className="pw-wprice__sub">Reason: {withheldPriceReason(reason, currency)}</div>
    </span>
  );
}
