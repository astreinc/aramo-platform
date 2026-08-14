import { MASKED_INDICATOR } from './commercial-format';

// Track 6 / T6-B4 §4/§7 — the ONE dedicated renderer for a compensation figure the actor
// is not permitted to view. The global CompensationFieldMaskInterceptor OMITS the field
// (the key is absent from the JSON), so the value is `undefined` on the client. This
// renders a non-leaking em-dash indicator — never the value, never `undefined`, and never
// any structural hint of the hidden figure. The accessible label states only that the
// value is hidden (it does not leak the value). Used everywhere a maskable pay/bill/
// margin/markup figure is omitted, so the masked presentation is identical across the
// current-terms card and every revision row.
export interface CommercialMaskedValueProps {
  /** Optional testid so a specific masked cell can be asserted (e.g. commercials-pay-rate). */
  readonly 'data-testid'?: string;
}

export function CommercialMaskedValue({ 'data-testid': testId }: CommercialMaskedValueProps) {
  return (
    <span
      aria-label="Hidden — you do not have permission to view this figure"
      data-testid={testId}
      data-masked="true"
    >
      {MASKED_INDICATOR}
    </span>
  );
}
