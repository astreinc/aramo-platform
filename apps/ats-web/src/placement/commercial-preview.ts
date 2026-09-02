import { MASKED_INDICATOR, periodSuffix } from './commercial-format';

// Slice #4 — the LIVE margin preview for the propose dialog. Before a proposal exists there
// is no server-derived margin, so the dialog previews the entered pay/bill against the
// CURRENT terms locally. Math is done in integer CENTS to avoid the float drift the memory
// rule warns against; percents are rounded to 2 decimal places.
//
// L7-D — EXPLICITLY NON-AUTHORITATIVE. This is a display-only preview and is NOT the
// commercial formula authority: the sole authority is @aramo/common deriveCommercialMetrics
// (decimal.js), which the backend applies before any value is persisted. This helper is
// intentionally NOT that function (the browser bundle stays free of decimal.js); it exists
// only to render an in-flight estimate. Once a proposal exists the BE margin object is
// authority and is rendered verbatim, never through this helper — so a preview/BE mismatch
// resolves to the BE value, never the reverse.
//
// A current side the actor may not view (masked → undefined) renders the non-leaking
// indicator, and every delta that depends on it collapses to the same indicator.

const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;

function toCents(value: string | undefined): number | null {
  if (value === undefined) return null;
  const t = value.trim();
  if (!MONEY_12_2.test(t)) return null;
  const [int, frac = ''] = t.split('.');
  return Number(int) * 100 + Number((frac + '00').slice(0, 2));
}

function centsToStr(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

// margin % = (bill − pay) / bill × 100, to 2dp. null on a zero bill (zero denominator).
function marginPct(payCents: number, billCents: number): number | null {
  if (billCents === 0) return null;
  return Math.round(((billCents - payCents) * 10000) / billCents) / 100;
}

function money(cents: number, currency: string, ratePeriod: string, signed = false): string {
  const body = centsToStr(cents);
  const withSign = signed && cents > 0 ? `+${body}` : body;
  return `${withSign} ${currency}${periodSuffix(ratePeriod)}`;
}

function percent(value: number | null): string {
  return value === null ? MASKED_INDICATOR : `${value.toFixed(2)}%`;
}

function pointDelta(current: number | null, proposed: number | null): string {
  if (current === null || proposed === null) return MASKED_INDICATOR;
  const delta = Math.round((proposed - current) * 100) / 100;
  const body = delta.toFixed(2);
  return delta > 0 ? `+${body}` : body;
}

export interface MarginPreviewSide {
  readonly pay: string;
  readonly bill: string;
  readonly margin: string;
}

export interface MarginPreview {
  readonly current: MarginPreviewSide;
  readonly proposed: MarginPreviewSide;
  readonly payDelta: string;
  readonly billDelta: string;
  readonly marginPointDelta: string;
}

export interface MarginPreviewInput {
  /** Current pay/bill are `undefined` when the actor's compensation scope masks them. */
  readonly currentPay: string | undefined;
  readonly currentBill: string | undefined;
  readonly currentCurrency: string;
  readonly currentRatePeriod: string;
  readonly proposedPay: string;
  readonly proposedBill: string;
  readonly proposedCurrency: string;
  readonly proposedRatePeriod: string;
}

// Returns `null` until BOTH entered (proposed) amounts are valid money — the dialog then
// shows nothing rather than a partial/garbage preview.
export function computeMarginPreview(input: MarginPreviewInput): MarginPreview | null {
  const proposedPayC = toCents(input.proposedPay);
  const proposedBillC = toCents(input.proposedBill);
  if (proposedPayC === null || proposedBillC === null) return null;

  const currentPayC = toCents(input.currentPay);
  const currentBillC = toCents(input.currentBill);
  const currentKnown = currentPayC !== null && currentBillC !== null;

  const currentMargin = currentKnown ? marginPct(currentPayC, currentBillC) : null;
  const proposedMargin = marginPct(proposedPayC, proposedBillC);

  const { currentCurrency: cc, currentRatePeriod: cp } = input;
  const { proposedCurrency: pc, proposedRatePeriod: pp } = input;

  return {
    current: {
      pay: currentPayC === null ? MASKED_INDICATOR : money(currentPayC, cc, cp),
      bill: currentBillC === null ? MASKED_INDICATOR : money(currentBillC, cc, cp),
      margin: currentKnown ? percent(currentMargin) : MASKED_INDICATOR,
    },
    proposed: {
      pay: money(proposedPayC, pc, pp),
      bill: money(proposedBillC, pc, pp),
      margin: percent(proposedMargin),
    },
    payDelta: currentPayC === null ? MASKED_INDICATOR : money(proposedPayC - currentPayC, pc, pp, true),
    billDelta: currentBillC === null ? MASKED_INDICATOR : money(proposedBillC - currentBillC, pc, pp, true),
    marginPointDelta: pointDelta(currentMargin, proposedMargin),
  };
}
